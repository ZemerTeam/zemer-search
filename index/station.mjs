// zemer-search — search engine and more for the Zemer app
// https://github.com/ZemerTeam/zemer-search
// Zemer app: https://github.com/ZemerTeam/zemer-app
// Copyright (C) 2026 alltechdev
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See the LICENSE file for details.

// Zemer Stations — the SYNCHRONIZED-broadcast scheduler (feasibility doc product #2): one shared,
// wall-clock program per station, so every listener hears the SAME track at the SAME moment (a real
// radio station, not personalized radio — that's /radio). PURE DATA like the rest of index/.
//
// The schedule is APPEND-ONLY: extendSchedule() only ever adds entries after the last one, never
// rewrites published ones — so a regeneration can never jump a live listener mid-song. Selection is
// fully deterministic (an LCG seeded in the persisted state): two concurrent generators extending the
// same state produce byte-identical output. Programming per pick:
//   score = (shrunk reach + floor) × skipMul × (1 + COOC bonus vs the PREVIOUS track) × jitter
// with no-repeat memory (a track can't return until ~half the pool has played) and an artist-spacing
// window (no artist within MIN_ARTIST_GAP consecutive slots). The co-occurrence bonus chains related
// tracks (graph lib+sess neighbors) so the station flows instead of shuffling.

import { shrinkReach, makeSkipMul } from "./radio.mjs"; // ONE shared reach curve + skip dock (never fork the tuning)

const POW = 1.6;              // contrast: the station leans hard toward what listeners ACTUALLY play…
const FLOOR = 0.015;          // …but every pool track keeps a small discovery chance (never a closed loop)
const COOC_BONUS = 3;         // ×(1 + 3·coocScore) — a strong neighbor of the previous track is preferred
const JITTER = 0.5;           // deterministic per-pick variety on top of the base score
const MIN_ARTIST_GAP = 3;     // no artist within this many consecutive slots (stronger than "not in a row")
const MIN_DUR = 30;           // ignore stub tracks; a schedule needs real durations

const shrink = shrinkReach;

// deterministic PRNG — the state carries `seed` forward so continuation is reproducible
const nextRand = (state) => {
  state.seed = (Math.imul(state.seed, 1664525) + 1013904223) >>> 0;
  return state.seed / 4294967296;
};

// pool: [{videoId, artistId, durationSec}] (pre-filtered by the generator: tag, purity, audio-only).
// graph: the radio graph ({pop, lib, sess, skip}) for reach/cooc/skip — optional pieces degrade to flat.
// entries: existing schedule [[videoId, startMs, durationSec], …] (append target; may be empty).
// state: { seed, recentTracks: [], recentArtists: [] } — persisted alongside the entries.
// Appends until the schedule covers untilMs; first-ever entry starts at startAtMs.
export function extendSchedule({ pool, graph = {}, entries = [], state, untilMs, startAtMs }) {
  const usable = pool.filter((p) => p.videoId && p.artistId && (p.durationSec || 0) >= MIN_DUR);
  if (!usable.length) return { entries, state };
  const reach = graph.pop || {}, lib = graph.lib || {}, sess = graph.sess || {};
  const skipMul = makeSkipMul(graph.skip);
  const base = new Map(usable.map((p) => [p.videoId, (Math.pow(shrink(reach[p.videoId] || 0), POW) + FLOOR) * skipMul(p.videoId)]));
  const byId = new Map(usable.map((p) => [p.videoId, p]));
  const noRepeat = Math.min(Math.floor(usable.length / 2), 4000); // a track can't return until ~half the pool played
  const recentT = new Set(state.recentTracks || []);
  const recentTQ = (state.recentTracks || []).slice();
  const recentA = (state.recentArtists || []).slice();

  let cursor = entries.length ? entries[entries.length - 1][1] + entries[entries.length - 1][2] * 1000 : startAtMs;
  let last = entries.length ? entries[entries.length - 1][0] : null;

  while (cursor < untilMs) {
    // cooc neighbors of the previous track (within the pool) — the flow bonus
    const nbr = new Map();
    if (last) {
      for (const [b, s] of (sess[last] || [])) if (byId.has(b)) nbr.set(b, Math.max(nbr.get(b) || 0, 2 * s));
      for (const [b, s] of (lib[last] || [])) if (byId.has(b)) nbr.set(b, Math.max(nbr.get(b) || 0, s));
    }
    const blockedA = new Set(recentA.slice(-MIN_ARTIST_GAP));
    // deterministic weighted pick over the eligible pool
    let total = 0; const cand = [];
    for (const p of usable) {
      if (recentT.has(p.videoId) || blockedA.has(p.artistId)) continue;
      const w = base.get(p.videoId) * (1 + COOC_BONUS * (nbr.get(p.videoId) || 0)) * (1 + JITTER * nextRand(state));
      cand.push([p, w]); total += w;
    }
    if (!cand.length) { // pool exhausted by the memory windows — relax BOTH memories, not just tracks:
      // with ≤ MIN_ARTIST_GAP distinct artists the spacing window alone blocks every candidate forever
      // (confirmed infinite loop before this: a 3-artist pool never returned). Correct programming beats
      // spacing on degenerate pools — clear the artist window too and re-pick.
      recentT.clear(); recentTQ.length = 0; recentA.length = 0; continue;
    }
    let r = nextRand(state) * total, pick = cand[cand.length - 1][0];
    for (const [p, w] of cand) { r -= w; if (r <= 0) { pick = p; break; } }
    entries.push([pick.videoId, cursor, pick.durationSec]);
    cursor += pick.durationSec * 1000;
    last = pick.videoId;
    recentT.add(pick.videoId); recentTQ.push(pick.videoId);
    while (recentTQ.length > noRepeat) recentT.delete(recentTQ.shift());
    recentA.push(pick.artistId);
    while (recentA.length > MIN_ARTIST_GAP * 4) recentA.shift();
  }
  state.recentTracks = recentTQ.slice(-noRepeat);
  state.recentArtists = recentA.slice(-MIN_ARTIST_GAP * 4);
  return { entries, state };
}

// The entry playing at `nowMs` (binary search — schedules are contiguous and sorted) + its index.
export function scheduleAt(entries, nowMs) {
  let lo = 0, hi = entries.length - 1, hit = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, [, s, d] = entries[mid];
    if (nowMs < s) hi = mid - 1;
    else if (nowMs >= s + d * 1000) lo = mid + 1;
    else { hit = mid; break; }
  }
  return hit;
}
