// zemer-search — search engine and more for the Zemer app
// https://github.com/ZemerTeam/zemer-search
// Zemer app: https://github.com/ZemerTeam/zemer-app
// Copyright (C) 2026 alltechdev
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See the LICENSE file for details.

// PILOT — discover community-built YTM playlists and admit them, surfacing community curation while NEVER
// serving a non-whitelisted track. Two independent guarantees:
//
//   PURITY (hard, already enforced elsewhere): the /playlist endpoint re-fetches a playlist live and keeps
//     only its whitelisted tracks (corpus.tracksByIds ∪ whitelistedChannelIds). So opening ANY playlist —
//     community or not — can only ever render whitelisted tracks. This harvester does not change that.
//   ADMISSION (quality, here): we only *index* a community playlist if its whitelisted subset is large
//     enough to be a coherent list — ≥ MIN_WL_TRACKS whitelisted AND ≥ MIN_WL_RATIO whitelisted (a list
//     that's 4% whitelisted, even after filtering, is just a fragment, not a "community playlist").
//
// Discovery has no global "all playlists" enumeration on YouTube — we SEED from search: curated topical
// terms (data/playlist-seeds.json) and optionally whitelisted artist names, searched with the
// community-playlist SearchFilter. All traffic is IP-safe (cached, paced, aborts on the first anti-bot
// block → exit 75) via net.mjs. Re-runs are free (cache replay) and skip already-known playlists.
//
//   node harvester/playlists.mjs
//   SEEDS=topics|artists|both  N=40  PAGES=1  CAP=300  MIN_WL_TRACKS=4  MIN_WL_RATIO=0.5  RECHECK=1
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { postSearch, parseSearchShelf, playlistFromRow, FILTERS } from "../harness/search.mjs";
import { postBrowse, parsePlaylistPage, parseArtistItemsContinuation } from "../harness/browse.mjs";
import { netStats } from "../harness/net.mjs";
import { BlockError } from "./core.mjs";
import { setStatus } from "./status.mjs";
import {
  openCorpus, allArtists, tracksByIds, whitelistedChannelIds, blocklist,
  upsertCommunityPlaylist, removeCommunityPlaylist, communityPlaylistIds, communityPlaylistList, stats,
} from "../corpus/store.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, "../data");

// ---- pure helpers (exported for tests) ----------------------------------------------------------

// The quality gate. PURITY is independent (serving only ever shows whitelisted tracks); this decides
// whether a playlist has ENOUGH whitelisted content to be worth surfacing as a community playlist.
export function admitPlaylist({ total, whitelisted }, { minTracks = 4, minRatio = 0.5 } = {}) {
  if (whitelisted < minTracks) return { ok: false, reason: "too-few-whitelisted" };
  if (total > 0 && whitelisted / total < minRatio) return { ok: false, reason: "too-impure" };
  return { ok: true, reason: "admitted" };
}

// Metadata screen for a playlist's TITLE + CURATOR name (the user-generated text we display). Returns the
// matched term (truthy) if any blocklist `playlistTerms` substring appears, else null. Note: this only
// guards the displayed text — the audio is already whitelist-pure via serve-time filtering. The cover
// IMAGE is handled separately (store derives it from a whitelisted track, never the curator's cover).
export function screenText(title, author, terms = []) {
  if (!terms || !terms.length) return null;
  const hay = `${title || ""} ${author || ""}`.toLowerCase();
  return terms.find((t) => t && hay.includes(t)) || null;
}

// Build the seed query list: curated topical terms (+ optionally whitelisted artist names, and each
// artist's FIRST name as its own broader seed), deduped (case-insensitive) + capped to n.
//   firstNames=true also seeds the leading token of each multi-word artist name ("Avraham Fried" →
//   "Avraham"), which surfaces playlists that group an artist by first name or across same-first-name
//   artists. Whitelist filtering + the admission gate keep the broader hits honest.
export function buildSeeds({ topics = [], artistNames = [] }, { mode = "both", n = 40, firstNames = false } = {}) {
  const seen = new Set(), out = [];
  const add = (q) => { const t = (q || "").trim(); const k = t.toLowerCase(); if (t && !t.startsWith("_") && !seen.has(k)) { seen.add(k); out.push(t); } };
  if (mode === "topics" || mode === "both") topics.forEach(add);
  if (mode === "artists" || mode === "both") {
    for (const name of artistNames) {
      add(name);
      if (firstNames) { const first = (name || "").trim().split(/\s+/)[0]; if (first && first.length >= 3) add(first); }
    }
  }
  return out.slice(0, Math.max(0, n));
}

// Render the non-whitelisted artist tally (channelId -> {name,count,sample}) to a reviewable JSON report.
// Most-seen first → the strongest whitelist-review candidates lead. `count` = how many of this channel's
// tracks were dropped (not whitelisted) across the processed community playlists.
export function formatRejectedArtists(map) {
  const artists = [...map.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .map(([id, e]) => ({
      count: e.count,
      name: e.name || null,
      channelId: id,
      url: `https://music.youtube.com/channel/${id}`,
      sample: e.sample || null,
    }));
  return JSON.stringify({
    description: "Non-whitelisted artist channels found inside community playlists — candidates for whitelist review, sorted by dropped-track count.",
    count: artists.length,
    artists,
  }, null, 2) + "\n";
}

// ---- live pipeline (IP-safe; throws BlockError on an anti-bot page) ------------------------------

async function searchPlaylists(query, pages, maxAgeMs) {
  const found = new Map(); // id -> {id,title,author,thumbnail}
  let res = await postSearch({ query, params: FILTERS.FILTER_COMMUNITY_PLAYLIST, maxAgeMs });
  if (res.blocked) throw new BlockError();
  for (let p = 0; p < pages; p++) {
    const { rows, continuation } = parseSearchShelf(res.json || {});
    for (const r of rows) { const pl = playlistFromRow(r); if (pl && !found.has(pl.id)) found.set(pl.id, pl); }
    if (!continuation || p + 1 >= pages) break;
    res = await postSearch({ continuation, maxAgeMs });
    if (res.blocked) throw new BlockError();
  }
  return [...found.values()];
}

// Mirrors server/api.mjs fetchPlaylistTracks (live VL browse + continuation), routed through net.mjs.
async function fetchPlaylistTracks(playlistId, cap) {
  const first = await postBrowse({ browseId: "VL" + playlistId });
  if (first.blocked) throw new BlockError();
  if (!first.json) return null;
  const p0 = parsePlaylistPage(first.json);
  const songs = [...(p0.songs || [])];
  let cont = p0.continuation, guard = 0;
  while (cont && songs.length < cap && guard++ < 20) {
    const r = await postBrowse({ continuation: cont });
    if (r.blocked) throw new BlockError();
    if (!r.json) break;
    const cp = parseArtistItemsContinuation(r.json, false);
    songs.push(...(cp.songs || []));
    cont = cp.continuation;
  }
  return songs;
}

async function main() {
  const MODE = process.env.SEEDS || "both";
  const N = Number(process.env.N || 40);
  const PAGES = Math.max(1, Number(process.env.PAGES || 1));
  const CAP = Math.max(1, Number(process.env.CAP || 300));
  const MIN_WL_TRACKS = Number(process.env.MIN_WL_TRACKS || 4);
  const MIN_WL_RATIO = Number(process.env.MIN_WL_RATIO || 0.5);
  const RECHECK = process.env.RECHECK === "1";       // re-validate re-discovered playlists (remove failures)
  const REVALIDATE = process.env.REVALIDATE === "1"; // re-validate EVERY stored playlist, even if not re-found
  const DRY = process.env.DRY === "1"; // PREVIEW: full discovery/validation pass (fetches run, cached as ever) but ZERO DB writes — counts report what WOULD happen
  const FIRSTNAMES = process.env.FIRSTNAMES === "1"; // also seed each artist's first name (broader sweep)
  // Discovery searches are forever-cached by default (a re-run finds nothing new). SEARCH_MAX_AGE_H makes
  // them re-fetch when older than N hours — set it on the scheduled timer so each run surfaces NEW playlists.
  const SEARCH_MAX_AGE_MS = process.env.SEARCH_MAX_AGE_H ? Number(process.env.SEARCH_MAX_AGE_H) * 3600000 : undefined;

  const db = openCorpus();
  const topics = (() => { try { return JSON.parse(fs.readFileSync(path.join(DATA, "playlist-seeds.json"), "utf8")).topics || []; } catch { return []; } })();
  const artistNames = allArtists(db).map((a) => a.name).filter(Boolean);
  const seeds = buildSeeds({ topics, artistNames }, { mode: MODE, n: N, firstNames: FIRSTNAMES });
  const wlChannels = whitelistedChannelIds(db);
  // channel (music OR regular) → whitelisted artist id, to record each member's artist so the content filter
  // knows its gender even when the member's track isn't harvested (see store.mjs community_playlist_track.artistId).
  const channelToArtist = new Map();
  for (const r of db.prepare("SELECT id, regularChannelId FROM artist").all()) { channelToArtist.set(r.id, r.id); if (r.regularChannelId) channelToArtist.set(r.regularChannelId, r.id); }
  const bl = blocklist();                                          // playlistIds + title/curator term screen
  const existing = communityPlaylistIds(db);                       // what we already hold (for remove-on-fail)
  const already = (RECHECK || REVALIDATE) ? new Set() : existing;  // re-check modes don't skip known ids

  console.log(`playlists pilot: ${seeds.length} seed queries (mode=${MODE}${FIRSTNAMES ? "+firstnames" : ""}), ${PAGES} page(s) each; gate: ≥${MIN_WL_TRACKS} whitelisted AND ≥${Math.round(MIN_WL_RATIO * 100)}% whitelisted`);

  // Phase 1 — discover candidate playlist ids from the seeds.
  let aborted = false;
  const cand = new Map(); // id -> {id,title,author,thumbnail}
  if (seeds.length) setStatus({ phase: "playlists", mode: "discover", done: 0, total: seeds.length, newTracks: 0, blocks: 0, startedAt: Date.now() });
  try {
    let s = 0;
    for (const q of seeds) {
      for (const pl of await searchPlaylists(q, PAGES, SEARCH_MAX_AGE_MS)) if (!already.has(pl.id) && !cand.has(pl.id)) cand.set(pl.id, pl);
      if (seeds.length) setStatus({ done: ++s });
    }
  } catch (e) {
    if (e instanceof BlockError) { aborted = true; setStatus({ blocks: 1 }); }
    else throw e;
  }
  console.log(`discovered ${cand.size} new candidate playlists${already.size ? ` (skipped ${already.size} already known)` : ""}${aborted ? " — ABORTED on block during discovery" : ""}`);

  // Phase 2 — for each candidate, fetch tracks, intersect with the corpus, apply the gate, store the keepers.
  let admitted = 0, rejected = 0, removed = 0, wlTotal = 0;
  const reasons = {};
  const rejectedArtists = new Map(); // channelId -> {name,count,sample}: non-whitelisted tracks' artists (for review)
  const candList = [...cand.values()];
  // REVALIDATE: also re-check every stored playlist that wasn't re-discovered, so stale ones get pruned.
  if (REVALIDATE && !aborted) {
    const have = new Set(candList.map((p) => p.id));
    for (const p of communityPlaylistList(db, 1e6)) if (!have.has(p.id)) candList.push({ id: p.id, title: p.title, author: p.artist, thumbnail: p.thumbnail });
    console.log(`revalidate: ${candList.length} total to check (incl. ${candList.length - cand.size} already stored)`);
  }
  if (!aborted && candList.length) setStatus({ phase: "playlists", mode: "check", done: 0, total: candList.length });
  let i = 0;
  for (const pl of candList) {
    if (aborted) break;
    // Cheap metadata screens first (no fetch): explicit playlist-id blocklist + title/curator term screen.
    const screenedTerm = screenText(pl.title, pl.author, bl.playlistTerms);
    if (bl.playlistIds.has(pl.id) || screenedTerm) {
      const why = bl.playlistIds.has(pl.id) ? "blocklisted" : "screened";
      rejected++; reasons[why] = (reasons[why] || 0) + 1;
      if (existing.has(pl.id)) { if (!DRY) removeCommunityPlaylist(db, pl.id); removed++; }
      if (candList.length) setStatus({ done: ++i });
      continue;
    }
    try {
      const songs = await fetchPlaylistTracks(pl.id, CAP);
      if (!songs) { reasons.unavailable = (reasons.unavailable || 0) + 1; rejected++; } // transient — never remove on this
      else {
        const corpus = tracksByIds(db, songs.map((x) => x.videoId));
        // A track is whitelisted exactly as the /playlist endpoint serves it: we hold the videoId, OR it was
        // uploaded to a whitelisted artist's (music or regular) channel.
        const wl = [];
        for (const x of songs) {
          if (corpus.has(x.videoId) || (x.rowArtistId && wlChannels.has(x.rowArtistId))) { wl.push(x); continue; }
          if (x.rowArtistId) { // non-whitelisted track → record its YT Music artist channel for whitelist review
            const e = rejectedArtists.get(x.rowArtistId) || { name: "", count: 0, sample: "" };
            e.count++; if (!e.name && x.rowArtistName) e.name = x.rowArtistName; if (!e.sample && x.title) e.sample = x.title;
            rejectedArtists.set(x.rowArtistId, e);
          }
        }
        const verdict = admitPlaylist({ total: songs.length, whitelisted: wl.length }, { minTracks: MIN_WL_TRACKS, minRatio: MIN_WL_RATIO });
        if (verdict.ok) {
          if (!DRY) upsertCommunityPlaylist(db, { id: pl.id, title: pl.title, author: pl.author, thumbnail: pl.thumbnail, total: songs.length },
            // record each member's resolved artist (for un-harvested members the track join can't supply gender);
            // corpus members keep null — their corpus track's artist is authoritative.
            wl.map((x, pos) => ({ videoId: x.videoId, pos, artistId: corpus.has(x.videoId) ? null : (channelToArtist.get(x.rowArtistId) || null) })));
          admitted++; wlTotal += wl.length;
          console.log(`+ ${(pl.title || pl.id).slice(0, 40).padEnd(40)} ${wl.length}/${songs.length} wl  ${pl.author || ""}`);
        } else {
          rejected++; reasons[verdict.reason] = (reasons[verdict.reason] || 0) + 1;
          if (existing.has(pl.id)) { if (!DRY) removeCommunityPlaylist(db, pl.id); removed++; } // "remove what's not"
        }
      }
    } catch (e) {
      if (e instanceof BlockError) { aborted = true; setStatus({ blocks: 1 }); }
      else { reasons.error = (reasons.error || 0) + 1; rejected++; }
    }
    if (candList.length) setStatus({ done: ++i });
  }
  setStatus({ phase: aborted ? "blocked" : "done", done: i });

  // Write the non-whitelisted artist channels seen inside the processed playlists — for whitelist review.
  if (rejectedArtists.size) {
    if (DRY) console.log(`[DRY] ${rejectedArtists.size} non-whitelisted artist channels seen (report not written in DRY)`);
    else {
      const file = path.join(DATA, "rejected-artists.json");
      fs.writeFileSync(file, formatRejectedArtists(rejectedArtists));
      console.log(`wrote ${rejectedArtists.size} non-whitelisted artist channels → data/rejected-artists.json`);
    }
  }

  const s = stats(db);
  db.close();
  const ns = netStats();
  console.log(`\nYIELD${DRY ? " [DRY — nothing written]" : ""}: ${DRY ? "would admit" : "admitted"} ${admitted}, rejected ${rejected}${removed ? `, ${DRY ? "would remove" : "removed"} ${removed} stale` : ""} (${Object.entries(reasons).map(([k, v]) => `${k}:${v}`).join(", ") || "none"})`);
  console.log(`captured ${wlTotal} whitelisted track-slots across admitted playlists; corpus now holds ${s.communityPlaylists} community playlists`);
  console.log(`${aborted ? "ABORTED on anti-bot block; " : ""}net: ${ns.liveCount} live, ${ns.cacheHits} cached, ${ns.blockedCount} blocks`);
  if (aborted) process.exitCode = 75; // EX_TEMPFAIL — a block is a (resumable) failure
}

// Run only when invoked directly (so tests can import the pure helpers without side effects).
if (import.meta.url === `file://${process.argv[1]}`) await main();
