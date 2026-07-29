// zemer-search — search engine and more for the Zemer app
// https://github.com/ZemerTeam/zemer-search
// Zemer app: https://github.com/ZemerTeam/zemer-app
// Copyright (C) 2026 alltechdev
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See the LICENSE file for details.

// Zemer Radio — corpus-native, whitelist-pure "what plays next" (replaces YouTube.next() on the app's
// artist/album/song radio + Home shuffle). PURE DATA (no DB, no platform deps) so it ports on-device
// identically, like the rest of index/. Playback audio still comes from YouTube; radio only chooses the
// SEQUENCE of whitelisted videoIds.
//
// Ranking (validated by bench/radio.mjs against held-out next-track listening — a co-occurrence blend beats
// popularity 7× and same-artist ~1.5×, and wins on rare/non-hit tracks too):
//   score(candidate) = 2.0·session-cooc + 1.25·library-cooc + 0.2·same-artist(shrunk-reach)   (+ tie jitter)
// where the two co-occurrence graphs come from zemer-stats (data/radio-graph.json, built from live plays +
// backfilled libraries + favorites/downloads; see harvester/radio-graph.mjs). Then popularity backfill makes
// the queue endless, and a diversity cap keeps one artist from dominating.
//
// COLD SEEDS (no telemetry for the exact seed) degrade gracefully, never empty, never off-whitelist:
//   song with no cooc → its ARTIST's co-listening profile (artist-level cooc) → same-artist catalog →
//   era/content-class-leaning popularity. A brand-new single by a brand-new artist still yields a coherent
//   kosher station (that track → era/class-mates → popular whitelisted music).
import { buildFemaleMatcher, isFemaleInvolved } from "./credits.mjs";

const PRIOR = 3;
// RELART (the artist-level coverage tier) must stay BELOW ART: bench-measured (zemer-stats bench/radio-eval),
// sub-same-artist weights are safe on every cut and lift the no-track-cooc fallback zone; higher weights
// drown the seed artist's own catalog and collapse it.
const W = { SESS: 2.0, LIB: 1.25, ART: 0.2, RELART: 0.08 };
const RELART_TOPK = 15;       // related artists considered per seed artist
const RELART_TRACKS = 5;      // top tracks pulled per related artist
const JIT_TIE = 0.03;         // within-tier variety across sessions (seeded kinds)
const JIT_SHUFFLE = 0.35;     // stronger for kind=shuffle → popularity-weighted walk, not a fixed Top-N
const ARTIST_SEED_TOPK = 8;   // artist / cold-song fallback: use the artist's top-K tracks as cooc seeds
const PLAYLIST_SEED_CAP = 50; // kind=playlist: cap member tracks used as cooc seeds (bounds the aggregation)
const SHUFFLE_POOL = 3000;    // shuffle weights over the meaningful head, then extends by popularity
const STATION = 500;          // canonical (diversified) station length — offset-independent so paging is a
                              // pure prefix slice; a 500-track queue is ~30h, extended beyond only if paged past
const MAX_LEN = 5000;         // hard cap on one station's materialized length
const MAX_RUN = 2;            // ≤ this many of the same artist in a row

// Shared by the radio engine AND the station scheduler (index/station.mjs) — ONE tuned mechanism, not two
// copies that could drift: the shrunk-reach curve and the skip dock (shrunk listen-through multiplier;
// docked, never excluded — see docs/radio.md).
export const shrinkReach = (r) => (r > 0 ? r / (r + PRIOR) : 0);
export const makeSkipMul = (skip = {}) => (v) => { const s = skip[v]; if (!s) return 1; const rate = (s[0] + 2.5) / (s[1] + 5); return Math.max(0.35, Math.min(1, rate / 0.5)); };
const shrink = shrinkReach;
const yearOf = (iso) => { const y = iso && +String(iso).slice(0, 4); return y >= 1900 && y <= 2100 ? y : null; };
// fnv-1a(id) mixed with rngSeed → [0,1); deterministic (no Math.random → same page every recompute)
function h01(id, seed) { let x = (2166136261 ^ (seed >>> 0)) >>> 0; const s = String(id); for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619) >>> 0; } return (x >>> 8) / 0x1000000; }

export function buildRadioIndex({ tracks = [], artists = [], albumTracks = [], graph = {}, matcher = null, blocked = null }) {
  const m = matcher || buildFemaleMatcher(artists);
  const g = { pop: graph.pop || {}, lib: graph.lib || {}, sess: graph.sess || {}, art: graph.art || {}, skip: graph.skip || {} };
  const byId = new Map();
  for (const t of tracks) {
    const fi = t.femaleInvolved !== undefined ? t.femaleInvolved : isFemaleInvolved(t.title, t.artistName, t.isFemale, m);
    byId.set(t.videoId, { videoId: t.videoId, title: t.title, artistId: t.artistId, artistName: t.artistName, isVideo: !!t.isVideo, explicit: !!t.explicit, durationSec: t.durationSec ?? null, releaseDate: t.releaseDate || null, isKidZone: !!t.isKidZone, isChasid: !!t.isChasid, femaleInvolved: fi, year: yearOf(t.releaseDate), playCount: t.playCount || 0 });
  }
  const reach = (v) => g.pop[v] || 0;
  // SKIP DOCK — a track users bail on (any surface) is docked in every radio ordering. Shrunk listen-through
  // rate: (listened + K·0.5) / (total + K), K=5 — a thin sample can't tank a track. Average-or-better
  // (≥50% listen-through) keeps full score; worse docks proportionally, floored (never a hard exclusion —
  // exclusion is the content filters' job). Multiplier, so cooc/artist/popularity tiers all feel it equally.
  const skipMul = makeSkipMul(g.skip);
  // popularity order: device reach first, YouTube playCount as tiebreak/tail (different scales, so reach
  // strictly dominates and playCount only orders the never-reached long tail).
  const popSorted = [...byId.keys()].sort((a, b) => (reach(b) - reach(a)) || (byId.get(b).playCount - byId.get(a).playCount));
  const artistTracks = new Map(); // reach-sorted (popSorted order preserves it)
  for (const v of popSorted) { const a = byId.get(v).artistId; let arr = artistTracks.get(a); if (!arr) artistTracks.set(a, arr = []); arr.push(v); }
  const albumTrackIds = new Map(); // albumId -> [videoId] in pos order
  for (const r of albumTracks) { let arr = albumTrackIds.get(r.albumId); if (!arr) albumTrackIds.set(r.albumId, arr = []); arr.push(r.videoId); }
  return { byId, graph: g, reach, skipMul, popSorted, artistTracks, albumTrackIds, blocked };
}

// Greedy diversity: never more than MAX_RUN of the same artist consecutively (skips ahead to the next
// differing artist when the run would be exceeded). Bounded input (the scored head), so O(n²) is fine.
function diversify(ids, byId) {
  const out = [], pend = ids.slice();
  while (pend.length) {
    let i = 0;
    if (out.length >= MAX_RUN) {
      const a = byId.get(out[out.length - 1])?.artistId;
      let run = true; for (let k = 1; k <= MAX_RUN; k++) if (byId.get(out[out.length - k])?.artistId !== a) { run = false; break; }
      if (run) { const j = pend.findIndex((v) => byId.get(v)?.artistId !== a); if (j > 0) i = j; }
    }
    out.push(pend.splice(i, 1)[0]);
  }
  return out;
}

// Returns { ids: [videoId] for this page, nextOffset: number|null }. Deterministic for a given
// (kind, seed, flags, rngSeed) → paging is a pure slice of the same ordering (stateless continuation).
export function radio(idx, { kind = "shuffle", seed = null, seedTracks = null, allowFemale = true, blockVideos = false, kidZoneOnly = false, rngSeed = 0, offset = 0, limit = 25 } = {}) {
  const { byId, graph: g, artistTracks, albumTrackIds, popSorted, blocked } = idx;
  const pass = (v) => {
    const t = byId.get(v); if (!t) return false;
    if (!allowFemale && t.femaleInvolved) return false;
    if (kidZoneOnly && !t.isKidZone) return false;
    if (blockVideos && t.isVideo) return false;
    if (blocked) { if (blocked.global.has(v)) return false; if (!allowFemale && blocked.female.has(v)) return false; }
    return true;
  };
  const hasCooc = (v) => (g.sess[v] && g.sess[v].length) || (g.lib[v] && g.lib[v].length);

  // ---- resolve seed set (cooc seeds), opening run (exact placed ids), and seed artist ----
  let seedSet = [], opening = [], seedArtist = null;
  const exclude = new Set();
  if (kind === "song" && byId.has(seed)) {
    seedArtist = byId.get(seed).artistId;
    if (pass(seed)) { opening = [seed]; exclude.add(seed); } // THE seed song plays first, then radio-continue
    seedSet = hasCooc(seed) ? [seed] : [seed, ...(artistTracks.get(seedArtist) || []).slice(0, ARTIST_SEED_TOPK)]; // cold song → artist-level cooc
  } else if (kind === "artist") {
    seedArtist = seed;
    const own = (artistTracks.get(seed) || []).filter(pass);
    // lead with one of the ARTIST'S OWN songs (popularity-leaning, jittered so it varies by session), then expand
    if (own.length) { const lead = own.reduce((a, b) => (shrink(idx.reach(b)) + JIT_SHUFFLE * h01(b, rngSeed) > shrink(idx.reach(a)) + JIT_SHUFFLE * h01(a, rngSeed) ? b : a)); opening = [lead]; exclude.add(lead); }
    seedSet = own.slice(0, ARTIST_SEED_TOPK);
  } else if (kind === "album") {
    opening = (albumTrackIds.get(seed) || []).filter(pass); // the album plays through first
    for (const v of opening) exclude.add(v);
    seedArtist = opening.length ? byId.get(opening[0]).artistId : null;
    seedSet = opening.slice(0, ARTIST_SEED_TOPK);
  } else if (kind === "playlist") {
    // Radio EXPANDS from the playlist's taste: aggregate the cooc neighbors of its member tracks (the server
    // resolves membership → seedTracks). No single seedArtist (mixed), no opening run. Members can reappear
    // (they're on-taste); cold/empty → popularity fallback like any other kind.
    seedSet = (seedTracks || []).filter((v) => byId.has(v)).slice(0, PLAYLIST_SEED_CAP);
  } // kind === "shuffle" → no seed

  // ---- score candidates from the co-occurrence blend + same-artist ----
  const score = new Map();
  const bump = (v, s) => { if (v === seed || exclude.has(v)) return; score.set(v, (score.get(v) || 0) + s); };
  for (const sv of seedSet) {
    for (const [b, sc] of (g.sess[sv] || [])) bump(b, W.SESS * sc);
    for (const [b, sc] of (g.lib[sv] || [])) bump(b, W.LIB * sc);
  }
  if (seedArtist) for (const v of (artistTracks.get(seedArtist) || [])) bump(v, W.ART * shrink(idx.reach(v)));
  // artist-level coverage tier: RELATED artists' top tracks (below same-artist) — gives the ~2.4×-wider
  // artist graph a voice where track-level cooc is thin, replacing popularity filler with related content.
  if (seedArtist) for (const [ra, s] of (g.art[seedArtist] || []).slice(0, RELART_TOPK))
    for (const v of (artistTracks.get(ra) || []).slice(0, RELART_TRACKS)) bump(v, W.RELART * s * shrink(idx.reach(v)));

  // ---- ordered head (scored, filtered, jittered); diversity is applied once to the whole station below ----
  const head = [...score.keys()].filter(pass).map((v) => [v, score.get(v) * idx.skipMul(v) + JIT_TIE * h01(v, rngSeed)]);
  head.sort((a, b) => b[1] - a[1]);
  const headIds = head.map((x) => x[0]);

  // ---- assemble: opening run (exempt from diversity — the album plays through) → the scored head + a
  // popularity backfill, diversified together so the artist-run cap holds across the head↔backfill seam ----
  const placed = new Set([seed, ...exclude, ...headIds]);
  // Canonical station length is FIXED (offset-independent) so diversify() produces the same ordering for
  // every page → paging is a pure prefix slice (no dup/skip). Deep paging past STATION extends with a
  // stable popularity tail (no reordering), so it stays consistent too.
  const canonNeed = Math.max(0, Math.min(MAX_LEN, STATION) - opening.length);
  let rest = headIds.slice();
  if (rest.length < canonNeed) {
    if (kind === "shuffle") {
      // popularity-weighted shuffle over the meaningful head (deterministic in rngSeed), then raw popularity
      const pool = popSorted.slice(0, SHUFFLE_POOL).filter((v) => !placed.has(v) && pass(v))
        .map((v) => [v, shrink(idx.reach(v)) * idx.skipMul(v) + JIT_SHUFFLE * h01(v, rngSeed)]).sort((a, b) => b[1] - a[1]).map((x) => x[0]);
      for (const v of pool) { if (rest.length >= canonNeed) break; rest.push(v); placed.add(v); }
      for (const v of popSorted) { if (rest.length >= canonNeed) break; if (!placed.has(v) && pass(v)) { rest.push(v); placed.add(v); } }
    } else {
      // seeded backfill: popularity, lightly leaning to the seed's era + content-class so a cold tail still
      // feels of-a-piece (only orders the unvalidated fallback tail — the cooc head above is untouched).
      const st = seed && byId.get(seed); const sy = st ? st.year : null, sc = st ? st.isChasid : null;
      const key = (v) => { const t = byId.get(v); let k = shrink(idx.reach(v)); if (sy && t.year) k += 0.15 * Math.exp(-Math.abs(t.year - sy) / 8); if (sc != null && t.isChasid === sc) k += 0.05; return k * idx.skipMul(v); };
      const pool = popSorted.filter((v) => !placed.has(v) && pass(v));
      pool.sort((a, b) => key(b) - key(a));
      for (const v of pool) { if (rest.length >= canonNeed) break; rest.push(v); placed.add(v); }
    }
  }
  const full = [...opening, ...diversify(rest, byId)]; // canonical station (fixed length)
  // extend only if the caller paged beyond the canonical station — stable popularity order, no reordering
  const peek = Math.min(MAX_LEN, offset + limit + 1);
  for (const v of popSorted) { if (full.length >= peek) break; if (!placed.has(v) && pass(v)) { full.push(v); placed.add(v); } }

  const page = full.slice(offset, offset + limit);
  const nextOffset = (full.length > offset + limit && offset + limit < MAX_LEN) ? offset + limit : null;
  return { ids: page, nextOffset };
}
