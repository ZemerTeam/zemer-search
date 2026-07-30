// zemer-search — search engine and more for the Zemer app
// https://github.com/ZemerTeam/zemer-search
// Zemer app: https://github.com/ZemerTeam/zemer-app
// Copyright (C) 2026 alltechdev
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See the LICENSE file for details.

// The search API (primary path) + a tiny live web UI — SQLite corpus + the proven in-memory matcher.
// Built to scale to thousands of concurrent users:
//   • multi-core cluster   — WORKERS=N forks N worker processes (Node is single-threaded); the OS load-
//                            balances connections across them. Each worker holds its own in-memory index
//                            (the corpus is small). Horizontally scalable too: stateless + read-only DB.
//   • LRU query cache      — as-you-type hammers the same prefixes; identical queries return instantly.
//                            Cleared on each index reload so results never go stale.
//   • staggered reloads    — workers rebuild the index at offset times so they don't all stall together.
//
//   GET /  /search  /artist  /album  /playlist  /community  /zemer-playlists  /new  /health      POST /reload
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import cluster from "node:cluster";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { openCorpus, DB_PATH, allTracks, allArtists, allAlbums, allPlaylists, allCommunityPlaylists, communityPlaylistMeta, communityPlaylistList, communityKeptCounts, zemerPlaylistList, zemerPlaylistDetail, homeRows, artistDetail, albumDetail, tracksByIds, trackAlbumInfo, allAlbumTracks, whitelistedChannelIds, recentTracks, recentAlbums, stats, setFemaleSet, loadBlockedIds, loadRadioGraph, claimArtistRefresh, createUserPlaylist, getUserPlaylist, countUserPlaylistsByDevice, blocklist, BLOCKED_IDS_PATH, RADIO_GRAPH_PATH, STATIONS_PATH, AUTO_HISTORY_PATH, ZEMER_PLAYLISTS_PATH, ACAPELLA_AUTO_PATH } from "../corpus/store.mjs";
import { pickAnchor, applyBadges, applyRanks, chartedBefore, firstCharted, formulaOf, chartWeek } from "./chart-badges.mjs";
import { buildCategories, searchCategories } from "../index/categories.mjs";
import { buildRadioIndex, radio } from "../index/radio.mjs";
import { scheduleAt } from "../index/station.mjs";
import { inThreeWeeks } from "../corpus/season.mjs";
import { buildFemaleMatcher, collectFemaleVideoIds } from "../index/credits.mjs";
import { loadDefaultSynonyms } from "../index/synonyms.mjs";
import { postBrowse, parsePlaylistPage, parseArtistItemsContinuation } from "../harness/browse.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, ".."); // repo root — cwd for the on-open refresh spawn (harvester/refresh-one.mjs)
const ZEMER_LOCK = process.env.ZEMER_LOCK || "/tmp/zemer-maintain.lock"; // same maintenance flock maintain.sh uses
const REFRESH_STALE_MS = Number(process.env.REFRESH_STALE_H || 6) * 3600 * 1000; // demand-driven: re-harvest a viewed artist at most this often
const PORT = Number(process.env.PORT || 7700);
const HOST = process.env.HOST || "0.0.0.0"; // set HOST=127.0.0.1 in production (behind a reverse proxy)
const RELOAD_MS = Number(process.env.RELOAD_MS || 30000);
// New Releases feed (real /player dates, maintained off-datacenter). Just for the web UI's New Releases
// view to display; cached briefly, with a corpus fallback if unreachable.
const RELEASES_FEED = process.env.RELEASES_FEED || "https://api.flipphoneguy.duckdns.org/zemer/recent-releases.json";
// Public host for URLs we mint (share links). Fixed/env-configured — never derived from request headers.
const PUBLIC_HOST = process.env.PUBLIC_HOST || "search.zemer.io";
const FEED_TTL_MS = Number(process.env.FEED_TTL_MS || 300000); // ~5 min
const CACHE_MAX = Number(process.env.CACHE_MAX || 5000);
// rank-history sidecar — the source of the auto playlists' chart-movement badges. The path is exported
// by corpus/store.mjs so this reader and the harvester writer can never diverge (separate systemd units).
const HISTORY_PATH = AUTO_HISTORY_PATH;
const SUBSET_DIR = path.join(path.dirname(DB_PATH), "subset"); // on-device fallback shards (build-subset.mjs)
// In-memory cache of the on-device snapshot, keyed on manifest.json mtime: load shards + their (build-time)
// manifest hashes once per build, then serve from memory — no per-request disk read or re-hash. Serves the
// last-good cache across a build's brief rm+rename swap (manifest momentarily absent). null until first build.
let _subsetCache = null;
function subset() {
  let mtime;
  try { mtime = fs.statSync(path.join(SUBSET_DIR, "manifest.json")).mtimeMs; }
  catch { return _subsetCache; } // manifest gone mid-swap → last-good (null if never built)
  if (_subsetCache && _subsetCache.mtime === mtime) return _subsetCache;
  try {
    const manifestBuf = fs.readFileSync(path.join(SUBSET_DIR, "manifest.json"));
    const shards = new Map();
    for (const s of (JSON.parse(manifestBuf).shards || [])) {
      try { shards.set(s.name, { buf: fs.readFileSync(path.join(SUBSET_DIR, `${s.name}.json.gz`)), hash: s.hash }); } catch { /* skip a missing shard */ }
    }
    _subsetCache = { mtime, manifestBuf, shards };
  } catch { /* torn/half-written manifest → keep last-good */ }
  return _subsetCache;
}
// Zemer Stations schedule (data/stations.json, written atomically by harvester/stations.mjs) — cached on
// mtime like the subset; a torn/missing file keeps last-good so a generator swap never 500s a tune-in.
let _stationsCache = null;
function stationsDoc() {
  let mtime;
  try { mtime = fs.statSync(STATIONS_PATH).mtimeMs; } catch { return _stationsCache; }
  if (_stationsCache && _stationsCache.mtime === mtime) return _stationsCache;
  try { _stationsCache = { mtime, doc: JSON.parse(fs.readFileSync(STATIONS_PATH, "utf8")) }; } catch { /* keep last-good */ }
  return _stationsCache;
}

// WORKERS=0/"auto" → one per core; default 1 (dev). Production: set to the core count.
const WORKERS = process.env.WORKERS === "auto" ? os.availableParallelism() : Number(process.env.WORKERS || 1);
const CORS = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json; charset=utf-8" };
const UI = fs.readFileSync(path.join(HERE, "ui.html"));
// content hash of the page — lets a revalidation answer 304 instead of re-sending the whole UI
const UI_ETAG = `"${crypto.createHash("sha1").update(UI).digest("hex").slice(0, 16)}"`;

// Per-request content filters (the app forwards the user's Firebase settings as these query params).
// Semantics are DEFAULT-OPEN: an absent param = no filtering (so the web demo + other callers get the full
// catalog). The app must send all three explicitly for a restricted user (gotcha #7). Applied uniformly by
// /search /new /artist /album /playlist so nothing leaks on drill-in.
const contentFlags = (sp) => ({
  allowFemale: sp.get("allowFemale") !== "0", // allowFemale=0 → drop female artists
  kidZoneOnly: sp.get("kidZone") === "1",     // kidZone=1   → only KidZone artists
  blockVideos: sp.get("blockVideos") === "1", // blockVideos=1 → drop video tracks/category
});
// Server-curated id override (Firestore blockedContentIds → cats.blocked): `global` ids dropped always,
// `female` ids when female is blocked. Matches a result's videoId / playlistId / channelId / browseId.
const idDropped = (id, blocked, allowFemale) => !!id && (blocked.global.has(id) || (allowFemale === false && blocked.female.has(id)));
// /radio continuation: an opaque, self-contained token (kind+seed+flags+rngSeed+offset) — no server session
// state, so it survives the cluster + restarts. Not signed: it only scopes a user's OWN queue, no authority.
const encTok = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const decTok = (t) => { try { const d = JSON.parse(Buffer.from(String(t), "base64url").toString("utf8")); return (d && ["artist", "album", "song", "shuffle", "playlist"].includes(d.k)) ? d : null; } catch { return null; } };

if (cluster.isPrimary && WORKERS > 1) {
  console.log(`zsearch primary (pid ${process.pid}) → forking ${WORKERS} workers on :${PORT}`);
  for (let i = 0; i < WORKERS; i++) cluster.fork({ WORKER_INDEX: String(i) });
  cluster.on("exit", (w, code) => { console.warn(`worker ${w.process.pid} exited (${code}); respawning`); cluster.fork(); });
} else {
  startServer();
}

async function startServer() {
  const liveDb = openCorpus(); // persistent WAL reader → sees the harvest's latest per-artist commits
  const WL_PATH = path.join(HERE, "../data/whitelist.json");
  const STATUS_PATH = process.env.MAINTAIN_STATUS || path.join(HERE, "../data/.maintain-status.json");
  // Total whitelisted artists (the harvest target) — re-read on each reload so a freshly-fetched
  // whitelist isn't stale beyond one cycle.
  const countWhitelist = () => { try { return JSON.parse(fs.readFileSync(WL_PATH, "utf8")).filter((a) => /^UC/.test(a.id || "")).length; } catch { return 0; } };
  // Live maintenance progress written by the harvest/refresh steps; surfaced only while a run is active
  // (a status file older than 90 s is ignored, so the indicator clears itself when a run ends).
  let _maint = { at: 0, val: null }; // throttle the per-request status file read
  const maintenance = () => {
    const now = Date.now();
    if (now - _maint.at < 2000) return _maint.val; // read the file at most ~every 2s, not every request
    let val = null;
    try {
      const m = JSON.parse(fs.readFileSync(STATUS_PATH, "utf8"));
      // surface ONLY an actively-running pass; terminal/stale phases → null (docs: maintenance is null when idle)
      const active = m.phase && m.phase !== "done" && m.phase !== "blocked" && m.phase !== "idle";
      if (active && m.updatedAt && now - m.updatedAt <= 600000) {
        const total = m.total || 0;
        const done = total ? Math.min(m.done || 0, total) : (m.done || 0); // clamp: progress can't exceed 100%
        val = { phase: m.phase, mode: m.mode || null, done, total,
          pct: total ? Math.min(100, Math.round((100 * done) / total)) : null, newTracks: m.newTracks || 0, blocks: m.blocks || 0 };
      }
    } catch { /* missing/invalid status → null */ }
    _maint = { at: now, val };
    return val;
  };
  const cache = new Map();     // url -> response body (LRU; cleared on reload)

  // ── chart-movement badges: state + their OWN invalidation, deliberately separate from the index gate ──
  // The badges change on two events the corpus knows nothing about: the sidecar being appended (every
  // auto-playlists run, twice daily, even a no-op that writes zero corpus rows) and the weekly anchor
  // rolling over on Sunday 00:00 UTC (no file changes at all). Folding those into the index signature
  // would re-run the full index rebuild (~3s of blocking CPU over the whole corpus) and wipe every warm
  // /search entry twice a day for nothing — so instead this evicts ONLY the /zemer-playlists responses,
  // which are the only ones carrying badge data.
  let anchorCache = { key: "", runs: null }, lastBadgeSig = null;
  function refreshBadges() {
    let hi = 0; try { hi = fs.statSync(HISTORY_PATH).mtimeMs; } catch { /* no sidecar → badges absent */ }
    const bsig = `${hi}:${chartWeek(Date.now())}`;
    if (bsig === lastBadgeSig) return;
    lastBadgeSig = bsig;
    anchorCache = { key: "", runs: null };
    for (const k of cache.keys()) if (k.startsWith("/zemer-playlists")) cache.delete(k);
  }
  // The anchor: the sidecar's last-completed-week ordering. Cached on (mtime, chart week) — the same two
  // inputs as the eviction above, so a hit here can never outlive its cached responses.
  const chartAnchor = (playlistId) => {
    try {
      const key = `${fs.statSync(HISTORY_PATH).mtimeMs}:${chartWeek(Date.now())}`;
      if (key !== anchorCache.key) {
        const parsed = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8"))?.runs;
        // Keep ONLY the fields the badges read. Each run also carries a topPlays7d reach snapshot ~4x the
        // size of its orderings, which the API never touches — retaining the whole 60-day file per worker
        // would be megabytes of dead heap held until the next sidecar write.
        const runs = (Array.isArray(parsed) ? parsed : []).map((r) =>
          (r && typeof r === "object" ? { t: r.t, applied: r.applied, formula: r.formula, formulas: r.formulas, lists: r.lists } : r));
        anchorCache = { key, runs };
      }
    } catch { anchorCache = { key: "", runs: null }; } // no/corrupt sidecar — badges simply absent
    // The anchor is chosen PER PLAYLIST: each chart carries its own ranking-formula signature, so one
    // chart's formula change must not blank another's badges.
    return pickAnchor(anchorCache.runs, Date.now(), playlistId);
  };
  let cats, radioIndex, indexedCount = 0, indexedAt = 0, whitelistTotal = 0;
  let lastSig = null;
  // Rebuild the in-memory index ONLY when the corpus actually changed (a fresh corpus.db is synced, or a
  // local harvest wrote to the WAL). The periodic tick then just stats the files — cheap — so a steady
  // server never pays the rebuild stall. `force` (initial build + POST /reload) always rebuilds.
  function reload(force = false) {
    refreshBadges();
    let sig = null;
    try {
      const a = fs.statSync(DB_PATH);
      let w = 0; try { w = fs.statSync(DB_PATH + "-wal").mtimeMs; } catch { /* no -wal */ }
      let bi = 0; try { bi = fs.statSync(BLOCKED_IDS_PATH).mtimeMs; } catch { /* no blocked-ids.json */ }
      let rg = 0; try { rg = fs.statSync(RADIO_GRAPH_PATH).mtimeMs; } catch { /* no radio-graph.json */ }
      sig = `${a.mtimeMs}:${a.size}:${w}:${bi}:${rg}`; // a fresh override/graph fetch (own timers) re-applies on the next tick
    } catch { /* stat failed → fall through and rebuild */ }
    if (!force && sig && sig === lastSig) return indexedCount; // unchanged → keep the current index
    const tracks = allTracks(liveDb);
    const artists = allArtists(liveDb);
    // Compute "female-involved" (primary OR featured female; see index/credits.mjs) once over the corpus,
    // and publish it to the connection's `_female` set BEFORE community is loaded — so the community
    // clsMask + every SQL female filter agree exactly with the in-memory category filter. (No-op if empty.)
    const matcher = buildFemaleMatcher(artists);
    // Server-curated id overrides (Firestore blockedContentIds → data/blocked-ids.json). `female`-tagged
    // videoIds also join the _female set so community member counts treat them as female; the full list
    // (incl. playlist/channel ids) is applied per-result by searchCategories + the endpoints below.
    const blocked = loadBlockedIds();
    setFemaleSet(liveDb, [...collectFemaleVideoIds(tracks, matcher), ...blocked.female]);
    // Artist-owned playlists and community-discovered playlists are indexed separately → separate chips.
    cats = buildCategories({ tracks, artists, albums: allAlbums(liveDb), playlists: allPlaylists(liveDb), community: allCommunityPlaylists(liveDb) }, loadDefaultSynonyms(), matcher);
    cats.blocked = blocked; // consumed by searchCategories; also reused by the detail endpoints (dropId)
    // Zemer Radio index — co-occurrence graph (data/radio-graph.json, its own fetch timer) + corpus, reusing
    // the same female matcher + blocked-ids so radio filters identically. Missing graph → same-artist+pop fallback.
    // Radio's acapella exclusion set (product rule — no acapella outside the Three Weeks / explicit seeds):
    // the master curated set + auto-detected list + the strict clear-label title marker, same as stations.
    const acapella = new Set();
    try { for (const v of ((JSON.parse(fs.readFileSync(ZEMER_PLAYLISTS_PATH, "utf8")).playlists || []).find((p) => p?.id === "acapella")?.videoIds || [])) acapella.add(v); } catch { /* none */ }
    try { for (const v of (JSON.parse(fs.readFileSync(ACAPELLA_AUTO_PATH, "utf8")).videoIds || [])) acapella.add(v); } catch { /* none */ }
    const CLEAR_ACAP = /a[\s-]?c+app?ell?a|\bvocal\s+version\b|\(\s*vocal\s*\)|ווקאל|וואקאל|אקפלה/i;
    for (const t of tracks) if (CLEAR_ACAP.test(t.title || "")) acapella.add(t.videoId);
    radioIndex = buildRadioIndex({ tracks, artists, albumTracks: allAlbumTracks(liveDb), graph: loadRadioGraph(), matcher, blocked, acapella });
    indexedCount = tracks.length; indexedAt = Date.now();
    whitelistTotal = countWhitelist();
    cache.clear();
    lastSig = sig;
    return tracks.length;
  }
  reload(true);
  // Stagger reloads across workers so only one rebuilds (and briefly stalls) at a time.
  const wIndex = Number(process.env.WORKER_INDEX || 0);
  setTimeout(() => setInterval(reload, RELOAD_MS).unref(), Math.floor((RELOAD_MS * wIndex) / Math.max(1, WORKERS)));

  // Demand-driven freshness: when a viewed artist/album is STALE, kick a background single-artist re-harvest so
  // the next view is current (the response itself is served immediately from the corpus — never blocked). The
  // claim is atomic across cluster workers (only one triggers), and the harvest runs as a detached child under
  // the maintenance flock (`flock -n -E 0`) so it never contends with maintain.sh on the single-writer DB and
  // is IP-safe (net.mjs). A burst of opens collapses to one harvest per artist per REFRESH_STALE window.
  function maybeRefreshArtist(artistId) {
    if (!artistId) return;
    try {
      if (!claimArtistRefresh(liveDb, artistId, Date.now() - REFRESH_STALE_MS)) return; // fresh, or another worker already claimed
      const child = spawn("flock", ["-n", "-E", "0", ZEMER_LOCK, process.execPath, "harvester/refresh-one.mjs", artistId],
        { cwd: REPO, detached: true, stdio: "ignore" });
      child.on("error", () => {}); // flock/node missing → ignore (the sweep + feed pre-harvest still cover it)
      child.unref();
    } catch { /* SQLITE_BUSY (a maintenance write in flight) or spawn failure → skip; other layers cover it */ }
  }

  // Fetch the releases feed, cached ~5 min; on any failure keep serving the last-good copy (null until first success).
  let feedCache = { at: 0, data: null };
  async function getReleasesFeed() {
    if (feedCache.data && Date.now() - feedCache.at < FEED_TTL_MS) return feedCache.data;
    try {
      const r = await fetch(RELEASES_FEED, { signal: AbortSignal.timeout(6000) });
      if (r.ok) feedCache = { at: Date.now(), data: await r.json() };
    } catch { /* unreachable → keep last-good (or null → corpus fallback) */ }
    return feedCache.data;
  }

  async function fetchPlaylistTracks(playlistId, cap = 300) {
    const first = await postBrowse({ browseId: "VL" + playlistId });
    if (!first.json) return null;
    const p0 = parsePlaylistPage(first.json);
    const songs = [...(p0.songs || [])];
    let cont = p0.continuation, guard = 0;
    while (cont && songs.length < cap && guard++ < 12) {
      const r = await postBrowse({ continuation: cont });
      if (!r.json) break;
      const cp = parseArtistItemsContinuation(r.json, false);
      songs.push(...(cp.songs || []));
      cont = cp.continuation;
    }
    return songs;
  }

  // Generated text cover for a Zemer-CURATED playlist — these are editorial categories, not albums, so
  // they get a branded title card instead of a member track's album art (which would wrongly spotlight one
  // artist). Pure SVG string (no image deps, crisp at any size); the gradient is picked deterministically
  // from the playlist id so each playlist keeps a stable, distinct color. Served by
  // GET /zemer-playlists/cover?id=… and referenced by the (relative) `thumbnail` on /zemer-playlists rows.
  const xmlEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  // Each playlist gets a STABLE, VIVID, MAXIMALLY-DISTINCT color keyed to its id. The 8-color set is validated
  // colorblind-safe (worst adjacent CVD ΔE 20 — clearly different, not muddy near-duplicates like evenly-spaced
  // dark hues were). Stable per id → a cover never changes color when playlists are added/removed (no stale
  // caches). Known lists get fixed colors; any other id hashes into the same distinct set.
  const COVER_COLORS = ["#1f66c2", "#d13b3a", "#c93f86", "#5b41c7", "#d9591f", "#0b7a43", "#0a9d8f", "#b5860f"]; // blue red magenta violet orange green teal gold
  // ONE color system for every generated cover — playlists AND stations share this map + palette (same
  // stability rule: keyed to the id, never collides within its surface, never shifts when the set changes).
  const FIXED_COLOR = { "auto-top-50": "#1f66c2", "auto-trending": "#d13b3a", "auto-favorites": "#c93f86", "auto-downloaded": "#0e8a8a", "auto-acapella-top-50": "#5b41c7", "acapella": "#d9591f",
    "station:chasidish": "#5b41c7", "station:dj": "#d9591f", "station:israeli": "#1f66c2" };
  const darken = (hex, f) => "#" + hex.slice(1).match(/../g).map((x) => Math.round(parseInt(x, 16) * (1 - f)).toString(16).padStart(2, "0")).join("");
  function coverColor(id) {
    if (FIXED_COLOR[id]) return FIXED_COLOR[id];
    if (String(id).startsWith("auto-year-")) return "#0b7a43"; // "Year of ‹Y›" — green, whatever the year
    let h = 0; for (const ch of String(id)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return COVER_COLORS[h % COVER_COLORS.length];
  }
  function zemerCoverSvg(id, title) {
    const base = coverColor(id), c1 = darken(base, 0.34), c2 = base; // depth: darker corner → vivid base
    // FIXED font size on every cover (never scaled to the title) — a long title wraps into MORE lines
    // instead of shrinking, and the block is vertically centered so it always looks tidy.
    const FS = 62, LH = 72, WRAP = 11; // ~11 chars/line fits 512px at this bold size
    const words = String(title).trim().split(/\s+/);
    const lines = [];
    for (const w of words) {
      if (lines.length && (lines[lines.length - 1] + " " + w).length <= WRAP) lines[lines.length - 1] += " " + w;
      else lines.push(w);
    }
    const fs = FS, lh = LH;
    const startY = 262 - Math.round(((lines.length - 1) * lh) / 2);
    const font = "font-family=\"'Segoe UI',Roboto,'Helvetica Neue','Noto Sans Hebrew',Arial,sans-serif\"";
    // drop-shadow keeps the white title legible on every color (even the lighter orange/gold)
    const text = lines.map((l, i) => `<text x="256" y="${startY + i * lh}" ${font} font-size="${fs}" font-weight="800" fill="#ffffff" text-anchor="middle" filter="url(#ts)">${xmlEsc(l)}</text>`).join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">` +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient>` +
      `<filter id="ts" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="#000000" flood-opacity="0.5"/></filter></defs>` +
      `<rect width="512" height="512" fill="url(#g)"/>` +
      `<circle cx="432" cy="84" r="190" fill="#ffffff" opacity="0.10"/>` +
      `<circle cx="56" cy="450" r="150" fill="#000000" opacity="0.14"/>` +
      `<text x="428" y="158" ${font} font-size="150" fill="#ffffff" opacity="0.16" text-anchor="middle">♪</text>` +
      text +
      `<rect x="216" y="418" width="80" height="3" rx="1.5" fill="#ffffff" opacity="0.55"/>` +
      `<text x="256" y="462" ${font} font-size="24" font-weight="600" letter-spacing="8" fill="#ffffff" opacity="0.9" text-anchor="middle">ZEMER</text>` +
      `</svg>`;
  }
  const zemerCoverUrl = (id) => `/zemer-playlists/cover?id=${encodeURIComponent(id)}`;

  // Station cover — SAME design language AND the same color rules as the playlist covers (the shared
  // coverColor(): FIXED_COLOR entries under "station:<id>", validated palette, id-keyed hash for any
  // future station) but a BROADCAST composition: concentric on-air waves + the red beacon instead of the
  // ♪ disc, so a station card reads as radio at a glance.
  function stationCoverSvg(id, title) {
    const base = coverColor("station:" + id);
    const c1 = darken(base, 0.38), c2 = base;
    const FS = 56, LH = 66, WRAP = 12;
    const words = String(title).trim().split(/\s+/);
    const lines = [];
    for (const w of words) {
      if (lines.length && (lines[lines.length - 1] + " " + w).length <= WRAP) lines[lines.length - 1] += " " + w;
      else lines.push(w);
    }
    const startY = 300 - Math.round(((lines.length - 1) * LH) / 2);
    const font = "font-family=\"'Segoe UI',Roboto,'Helvetica Neue','Noto Sans Hebrew',Arial,sans-serif\"";
    const text = lines.map((l, i) => `<text x="256" y="${startY + i * LH}" ${font} font-size="${FS}" font-weight="800" fill="#ffffff" text-anchor="middle" filter="url(#ts)">${xmlEsc(l)}</text>`).join("");
    // a drawn RADIO (pure vector, self-contained): rounded body with speaker + dial + tuning knob, slanted
    // antenna whose tip carries the red on-air light with two small broadcast arcs
    const radio =
      `<g transform="translate(51.2,-8.8) scale(0.8)">` + // 80% size, x-centered, raised well clear of the title
      `<g filter="url(#ts)" stroke="#ffffff" stroke-width="7" stroke-linecap="round" fill="none">` +
      `<line x1="298" y1="136" x2="346" y2="80"/>` +                                            // antenna
      `<rect x="160" y="136" width="192" height="86" rx="15" fill="#ffffff" fill-opacity="0.12"/>` + // body
      `<circle cx="206" cy="179" r="26"/>` +                                                    // speaker
      `<line x1="252" y1="163" x2="326" y2="163"/>` +                                           // dial bar
      `<circle cx="318" cy="196" r="10"/>` +                                                    // tuning knob
      `<line x1="252" y1="196" x2="286" y2="196" opacity="0.7"/>` +                             // band switch
      `</g>` +
      `<path d="M 330 60 A 26 26 0 0 1 366 64" fill="none" stroke="#ffffff" stroke-width="5" stroke-linecap="round" opacity="0.55"/>` +
      `<path d="M 322 44 A 42 42 0 0 1 378 51" fill="none" stroke="#ffffff" stroke-width="5" stroke-linecap="round" opacity="0.35"/>` +
      `<circle cx="346" cy="80" r="9" fill="#ff5252" stroke="#ffffff" stroke-width="3" filter="url(#ts)"/>` + // on-air light
      `</g>`;
    // background = EXACTLY the playlist-cover composition (same gradient direction, same light/dark
    // accent circles) so the two cover families read as one system side by side on Home
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">` +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient>` +
      `<filter id="ts" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="#000000" flood-opacity="0.5"/></filter></defs>` +
      `<rect width="512" height="512" fill="url(#g)"/>` +
      `<circle cx="432" cy="84" r="190" fill="#ffffff" opacity="0.10"/>` +
      `<circle cx="56" cy="450" r="150" fill="#000000" opacity="0.14"/>` +
      `<text x="428" y="158" ${font} font-size="150" fill="#ffffff" opacity="0.16" text-anchor="middle">♪</text>` + // same faint note as the playlist covers
      radio +
      text +
      // single quiet wordmark line — "ZEMER LIVE". The +4 x-offset compensates the TRAILING
      // letter-spacing (an anchored-middle text box includes it, shifting glyphs visually left).
      `<text x="260" y="472" ${font} font-size="21" font-weight="600" letter-spacing="8" fill="#ffffff" opacity="0.9" text-anchor="middle">ZEMER LIVE</text>` +
      `</svg>`;
  }


  const send = (res, code, obj) => { const body = JSON.stringify(obj); res.writeHead(code, CORS); res.end(body); return body; };
  const cacheSet = (key, body) => { cache.set(key, body); if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value); };
  const CACHEABLE = new Set(["/search", "/artist", "/album", "/playlist", "/community", "/zemer-playlists", "/home-rows"]); // /new self-caches via the feed TTL

  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, "http://localhost");
      // no-cache = "store it, but ALWAYS revalidate": the page carries the whole UI inline, so without
      // this a browser's heuristic cache can keep serving a pre-deploy copy (a shipped UI change then
      // looks like it never deployed). ETag makes the revalidation a cheap 304, not a re-download.
      if (u.pathname === "/" || u.pathname === "/ui.html") {
        if (req.headers["if-none-match"] === UI_ETAG) { res.writeHead(304, { ETag: UI_ETAG, "Cache-Control": "no-cache" }); return res.end(); }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", ETag: UI_ETAG });
        return res.end(UI);
      }
      if (u.pathname === "/health") {
        // radioGraphAgeSec: freshness watchdog for the radio graph — the autoplaylists unit's ExecStarts are
        // '-'-prefixed for step independence (never enters failed state), so staleness must be observable here.
        let rgAge = null; try { rgAge = Math.round((Date.now() - fs.statSync(RADIO_GRAPH_PATH).mtimeMs) / 1000); } catch { /* no graph yet */ }
        return send(res, 200, { ok: true, ...stats(liveDb), indexed: indexedCount, indexedAt, worker: wIndex, whitelistTotal, radioGraphAgeSec: rgAge, maintenance: maintenance() });
      }
      if (u.pathname === "/reload" && req.method === "POST") return send(res, 200, { ok: true, tracks: reload(true) });

      // On-device fallback snapshot (build-subset.mjs → SUBSET_DIR). The manifest lists content-hashed shards;
      // the app diffs hashes and fetches only changed shards (incremental — replace-not-merge, so adds AND
      // removes propagate). Served from an in-memory cache keyed on manifest mtime: shards + their manifest
      // hashes are loaded once per build (no per-request read or re-hash), and the last-good cache is served
      // across a build's brief atomic swap. ETag = the manifest hash. See docs/corpus-freshness.md / handoff.
      if (u.pathname === "/subset/manifest") {
        const c = subset();
        if (!c) return send(res, 404, { error: "no subset built" });
        res.writeHead(200, { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" });
        return res.end(c.manifestBuf);
      }
      if (u.pathname.startsWith("/subset/")) {
        const name = u.pathname.slice(8); // after "/subset/"; path-safety: lowercase alnum + hyphen only
        if (!/^[a-z0-9-]+$/.test(name)) return send(res, 400, { error: "bad shard name" });
        const c = subset();
        const sh = c && c.shards.get(name);
        if (!sh) return send(res, 404, { error: "no such shard" });
        const inm = (req.headers["if-none-match"] || "").replace(/"/g, ""); // tolerate quoted or raw manifest hash
        if (inm === sh.hash) { res.writeHead(304, { ...CORS, etag: `"${sh.hash}"` }); return res.end(); }
        res.writeHead(200, { "Access-Control-Allow-Origin": "*", "content-type": "application/gzip", "cache-control": "public, max-age=3600", etag: `"${sh.hash}"` });
        return res.end(sh.buf);
      }

      // LRU cache for the hot read endpoints (cleared on reload, so never stale beyond one cycle).
      // /home-rows folds the UTC day into its cache key: topCommunity rotates daily (store.homeRows dayKey),
      // and without this a warm cache would serve yesterday's set past midnight until an unrelated reload.
      const cKey = u.pathname === "/home-rows" ? `${req.url}|d${Math.floor(Date.now() / 86400000)}` : req.url;
      if (req.method === "GET" && CACHEABLE.has(u.pathname)) {
        const hit = cache.get(cKey);
        if (hit !== undefined) { cache.delete(cKey); cache.set(cKey, hit); res.writeHead(200, CORS); return res.end(hit); }
      }

      if (u.pathname === "/search") {
        const q = (u.searchParams.get("q") || "").replace(/^\s+/, ""); // keep a TRAILING space — it signals a completed last word
        if (!q.trim()) return send(res, 400, { error: "missing q" });
        const o = { ...contentFlags(u.searchParams), k: Math.min(200, Math.max(1, Number(u.searchParams.get("k") || 8))) };
        const categories = searchCategories(cats, q, o);
        // Reduce each community playlist's count to its post-filter total AND swap its cover to the first
        // SURVIVING member's art (so a filtered card never shows a dropped/female member's count or cover,
        // matching /community + what actually plays). No-op when no filter is active.
        if (categories.community?.length) {
          const counts = communityKeptCounts(liveDb, categories.community.map((p) => p.id), o);
          if (counts) for (const p of categories.community) { const c = counts.get(p.id); if (c) { p.whitelisted = c.kept; if (c.cover) p.thumbnail = c.cover; } }
        }
        return cacheSet(req.url, send(res, 200, { q, count: Object.values(categories).reduce((n, a) => n + a.length, 0), categories }));
      }
      if (u.pathname === "/new") {
        const k = Math.min(300, Math.max(1, Number(u.searchParams.get("k") || 100)));
        const { allowFemale, kidZoneOnly, blockVideos } = contentFlags(u.searchParams);
        // New Releases = only items with a REAL release date within the window (default 7 days). Undated
        // items (no /player date yet) can't be confirmed recent, so they're excluded — this is what keeps
        // "not-really-new" catalog out of the view. `days` overrides the window.
        const days = Math.min(3650, Math.max(1, Number(u.searchParams.get("days") || 10)));
        const cutoff = Date.now() - days * 86400000;

        // PRIMARY: the releases feed (real /player dates, maintained off-datacenter; same Firestore whitelist).
        const feed = await getReleasesFeed();
        if (feed && Array.isArray(feed.releases)) {
          const flags = new Map(allArtists(liveDb).map((a) => [a.id, a])); // content flags by artistId
          const keep = (r) => {
            if (!r.uploadDate || Date.parse(r.uploadDate) < cutoff) return false;
            const f = flags.get(r.artistId) || {};
            return (allowFemale || !f.isFemale) && (!kidZoneOnly || f.isKidZone);
          };
          const rel = feed.releases.filter(keep).sort((a, b) => new Date(b.uploadDate) - new Date(a.uploadDate));
          const row = (r) => ({ id: r.browseId, playlistId: r.playlistId, title: r.title, artist: r.artistName,
            year: r.year, thumbnail: r.thumbnail, addedAt: Date.parse(r.uploadDate), releaseDate: r.uploadDate, trackCount: r.trackCount });
          const categories = {
            songs: [], videos: [],
            albums: rel.filter((r) => (r.trackCount || 1) > 1).slice(0, k).map(row),
            singles: rel.filter((r) => (r.trackCount || 1) === 1).slice(0, k).map(row),
          };
          for (const key of Object.keys(categories)) categories[key] = categories[key].filter((it) => !idDropped(it.videoId || it.id, cats.blocked, allowFemale));
          const count = categories.albums.length + categories.singles.length;
          return send(res, 200, { count, categories, source: "feed", feedGeneratedAt: feed.generatedAt || null, windowDays: days });
        }

        // FALLBACK (feed unreachable): corpus recent, by real album.uploadDate where we have it.
        const fresh = (x) => x.releaseDate && Date.parse(x.releaseDate) >= cutoff;
        const keepArtist = (x) => (allowFemale || !x.isFemale) && (!kidZoneOnly || x.isKidZone);
        const tracks = recentTracks(liveDb, k * 8).filter(keepArtist).filter(fresh);
        const albums = recentAlbums(liveDb, k * 8).filter(keepArtist).filter(fresh);
        const song = (t) => ({ videoId: t.videoId, title: t.title, artist: t.artist, explicit: t.explicit, isVideo: t.isVideo, addedAt: t.addedAt, releaseDate: t.releaseDate });
        const al = (a) => ({ id: a.id, playlistId: a.playlistId, title: a.title, artist: a.artist, year: a.year, thumbnail: a.thumbnail, addedAt: a.addedAt, releaseDate: a.releaseDate });
        const categories = {
          songs: tracks.filter((t) => !t.isVideo).slice(0, k).map(song),
          videos: blockVideos ? [] : tracks.filter((t) => t.isVideo).slice(0, k).map(song),
          albums: albums.filter((a) => a.type !== "single").slice(0, k).map(al),
          singles: albums.filter((a) => a.type === "single").slice(0, k).map(al),
        };
        for (const key of Object.keys(categories)) categories[key] = categories[key].filter((it) => !idDropped(it.videoId || it.id, cats.blocked, allowFemale));
        const count = Object.values(categories).reduce((n, a) => n + a.length, 0);
        return send(res, 200, { count, categories, source: "corpus" });
      }
      if (u.pathname === "/community") {
        // Browse ALL community playlists (no query) — powers the Community chip's "show all" view.
        // Defaults to every playlist (cap is just a sanity bound), so the UI isn't silently truncated.
        const k = Math.min(100000, Math.max(1, Number(u.searchParams.get("k") || 100000)));
        const cf = contentFlags(u.searchParams);
        const playlists = communityPlaylistList(liveDb, k, cf).filter((p) => !idDropped(p.id, cats.blocked, cf.allowFemale));
        return cacheSet(req.url, send(res, 200, { count: playlists.length, playlists }));
      }
      if (u.pathname === "/zemer-playlists") {
        // Zemer-CURATED playlists (data/zemer-playlists.json → zemer_playlist tables, applied by
        // harvester/zemer-playlists.mjs). Pure corpus reads — no live fetch. The app plugs this in as a
        // "Zemer playlists" section: no id = the browseable card list; ?id= = one playlist's tracks.
        // Content filters + blocked-ids apply INSIDE the store reads (dropId), so counts/covers/durations
        // are post-filter and a playlist with no surviving member is hidden/404 (gotcha #7).
        const cf = contentFlags(u.searchParams);
        const dropId = (x) => idDropped(x, cats.blocked, cf.allowFemale);
        const id = u.searchParams.get("id");
        if (id) {
          const d = !dropId(id) && zemerPlaylistDetail(liveDb, id, cf, dropId);
          if (d) d.playlist.thumbnail = zemerCoverUrl(d.playlist.id); // generated text cover, never album art
          if (d && id.startsWith("auto-")) {
            // `rank` = the position on the RAW stored chart, emitted whenever an ordering exists (a
            // filtered response's row index is NOT the chart position). Then the chart-movement badges
            // (additive prevRank/delta/new/reentry) against the fixed weekly anchor from the rank-history
            // sidecar — raw order on both sides, so filters never fabricate movement. No sidecar → no badges.
            const raw = liveDb.prepare("SELECT refId FROM zemer_playlist_item WHERE playlistId=? AND kind='track' ORDER BY pos").all(id).map((r) => r.refId);
            if (raw.length) applyRanks(d.tracks, raw);
            const anchor = chartAnchor(id);
            if (raw.length && anchor?.lists?.[id]) {
              // everCharted separates a first-ever entry from a returning one (`reentry`); firstCharted
              // time-limits NEW to ≤24h after first appearance (older first-timers stay unbadged till Sunday)
              applyBadges(d.tracks, raw, anchor.lists[id],
                chartedBefore(anchorCache.runs, id, Date.parse(anchor.t), formulaOf(anchor, id)),
                firstCharted(anchorCache.runs, id, formulaOf(anchor, id)));
              d.playlist.anchorDate = anchor.t.slice(0, 10); // "movement since" — for UI labeling
            }
          }
          return d ? cacheSet(req.url, send(res, 200, d)) : send(res, 404, { error: "playlist not found" });
        }
        const playlists = zemerPlaylistList(liveDb, cf, dropId).filter((p) => !dropId(p.id))
          .map((p) => ({ ...p, thumbnail: zemerCoverUrl(p.id) })); // generated text cover, never album art
        return cacheSet(req.url, send(res, 200, { count: playlists.length, playlists }));
      }
      if (u.pathname === "/home-rows") {
        // Home rows — the app swaps its YouTube-scraped featured rows for these. Pure corpus reads:
        // topAlbums/topVideos/topArtists come from the home_rank table (device-reach ranked, written twice
        // daily by harvester/auto-playlists.mjs); topCommunity is ranked live by each playlist's own YouTube
        // view count (community_playlist.viewCount — no telemetry). Content flags + blocked-ids applied INSIDE
        // the read; each card carries artistId so the app's famous/american/israeli gate + one-per-artist
        // dedup work (the app maps our artist names to null ids otherwise). A thin/empty row is the app's cue
        // to fall back to its scrape for that row.
        const cf = contentFlags(u.searchParams);
        const dropId = (x) => idDropped(x, cats.blocked, cf.allowFemale);
        return cacheSet(cKey, send(res, 200, homeRows(liveDb, cf, dropId)));
      }
      if (u.pathname === "/zemer-playlists/cover") {
        // Branded SVG title card for a curated playlist (see zemerCoverSvg). Relative-linked from the
        // `thumbnail` fields above; resolves against whatever host serves the API.
        const id = u.searchParams.get("id") || "";
        const p = liveDb.prepare("SELECT title FROM zemer_playlist WHERE id=?").get(id);
        if (!p) return send(res, 404, { error: "playlist not found" });
        res.writeHead(200, { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "public, max-age=3600", "Access-Control-Allow-Origin": "*" });
        return res.end(zemerCoverSvg(id, p.title));
      }
      if (u.pathname === "/artist") {
        const id = u.searchParams.get("id"), cf = contentFlags(u.searchParams);
        const d = id && !idDropped(id, cats.blocked, cf.allowFemale) && artistDetail(liveDb, id, cf);
        if (d) for (const key of ["songs", "videos", "albums", "singles", "playlists"]) d[key] = d[key].filter((it) => !idDropped(it.videoId || it.id, cats.blocked, cf.allowFemale));
        if (id) maybeRefreshArtist(id); // demand-driven freshness (background; response served now)
        return d ? cacheSet(req.url, send(res, 200, d)) : send(res, 404, { error: "artist not found" });
      }
      if (u.pathname === "/album") {
        const id = u.searchParams.get("id"), cf = contentFlags(u.searchParams);
        const d = id && !idDropped(id, cats.blocked, cf.allowFemale) && albumDetail(liveDb, id, cf);
        if (d) d.tracks = d.tracks.filter((t) => !idDropped(t.videoId, cats.blocked, cf.allowFemale));
        if (d) maybeRefreshArtist(liveDb.prepare("SELECT artistId FROM album WHERE id=?").get(id)?.artistId); // refresh the album's artist
        return d ? cacheSet(req.url, send(res, 200, d)) : send(res, 404, { error: "album not found" });
      }
      if (u.pathname === "/user-playlist" && req.method === "POST") {
        // Create a SHARED user playlist (zemer-app#176): the app posts {title, videoIds, device?} and gets
        // back an unguessable link. Person-to-person capability, NOT a public index — no browse surface,
        // no moderation; members are validated against the corpus (whitelist-pure by construction).
        const chunks = []; let bytes = 0;
        req.on("error", () => { /* client abort mid-body (ECONNRESET) — review-caught: unlistened, it crashed the worker */ });
        req.on("data", (c) => { bytes += c.length; if (bytes > 262144) req.destroy(); else chunks.push(c); });
        req.on("end", () => {
          try { // async escape hatch: a throw in here is outside the outer request try/catch
            let j; try { j = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return send(res, 400, { error: "bad json" }); }
            const title = String(j.title || "").trim().slice(0, 120);
            if (!title) return send(res, 400, { error: "missing title" });
            // optional sharer display name — free text shown to receivers, so it gets the same term screen
            // the community titles/curators get (blocklist.playlistTerms); a screened name just drops silently
            let sharedBy = String(j.sharedBy || "").trim().slice(0, 40) || null;
            if (sharedBy) { const low = sharedBy.toLowerCase(); if (blocklist().playlistTerms.some((t) => low.includes(t))) sharedBy = null; }
            if (!Array.isArray(j.videoIds) || !j.videoIds.length || j.videoIds.length > 500) return send(res, 400, { error: "videoIds must be 1..500" });
            const device = typeof j.device === "string" && /^[0-9a-f-]{36}$/i.test(j.device) ? j.device.toLowerCase() : null;
            // storage hygiene (not security): per-device + global daily brakes on permanent rows
            if (device && countUserPlaylistsByDevice(liveDb, device, Date.now() - 86400000) >= 50) return send(res, 429, { error: "daily share limit reached" });
            if (liveDb.prepare("SELECT COUNT(*) c FROM user_playlist WHERE createdAt>=?").get(Date.now() - 86400000).c >= 2000) return send(res, 429, { error: "busy, try later" });
            // keep only corpus members, order preserved — the link can never carry a non-whitelisted track.
            // GLOBALLY-blocked ids also drop at create (app-side reply Q3: covers the ~10-min window before a
            // block reaches the corpus; folded into `dropped`). `female`-tagged blocks stay in the snapshot —
            // they're receiver-conditional and filtered per-request at open, like everywhere else.
            const valid = j.videoIds.filter((v) => typeof v === "string" && /^[\w-]{11}$/.test(v) && radioIndex.byId.has(v) && !cats.blocked.global.has(v));
            if (!valid.length) return send(res, 400, { error: "no whitelisted tracks in playlist" });
            const id = crypto.randomBytes(12).toString("base64url").replace(/[-_]/g, "").slice(0, 14); // unguessable capability
            createUserPlaylist(liveDb, { id, title, tracks: valid, device, sharedBy });
            return send(res, 200, { id, url: `https://${PUBLIC_HOST}/user_playlist/${id}`, kept: valid.length, dropped: j.videoIds.length - valid.length });
          } catch (e) { console.error("user-playlist create failed:", e.message); try { send(res, 500, { error: "server error" }); } catch { /* res gone */ } }
        });
        return;
      }
      if (u.pathname.startsWith("/user_playlist")) {
        // Open a shared playlist. JSON for the app; a branded HTML landing for browsers (the same URL the
        // app deep-links on). Receiver's content flags + blocked-ids apply per-request; members that left
        // the corpus since sharing are silently dropped (whitelist purity outlives the snapshot).
        const id = u.pathname.startsWith("/user_playlist/") ? u.pathname.slice(15) : (u.searchParams.get("id") || "");
        if (!/^[A-Za-z0-9]{8,20}$/.test(id)) return send(res, 400, { error: "bad id" });
        const up = getUserPlaylist(liveDb, id);
        if (!up) return send(res, 404, { error: "playlist not found" });
        const cf = contentFlags(u.searchParams);
        const kept = up.tracks.filter((v) => {
          const t = radioIndex.byId.get(v);
          if (!t) return false;
          if (!cf.allowFemale && t.femaleInvolved) return false;
          if (cf.kidZoneOnly && !t.isKidZone) return false;
          if (cf.blockVideos && t.isVideo) return false;
          return !idDropped(v, cats.blocked, cf.allowFemale);
        });
        const wantsHtml = String(req.headers.accept || "").includes("text/html") && u.searchParams.get("format") !== "json";
        const ai = trackAlbumInfo(liveDb, kept);
        const rows = kept.map((v) => { const t = radioIndex.byId.get(v), a = ai.get(v); return { videoId: v, title: t.title, artist: t.artistName, artistId: t.artistId, thumbnail: a?.thumbnail ?? null, durationSec: t.durationSec, explicit: t.explicit, isVideo: t.isVideo }; });
        // playlist header metadata: track-derived COVER (first surviving member's album art — same
        // convention as community playlists, gotcha #14) + total runtime over the surviving tracks
        const cover = rows.find((r) => r.thumbnail)?.thumbnail ?? null;
        const totalDurationSec = rows.reduce((s, r) => s + (r.durationSec || 0), 0);
        if (!wantsHtml) return send(res, 200, { playlist: { id: up.id, title: up.title, sharedBy: up.sharedBy, createdAt: up.createdAt, trackCount: rows.length, thumbnail: cover, totalDurationSec }, tracks: rows, source: "zemer-user" });
        const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        const fmtDur = (t) => (t.durationSec ? `${Math.floor(t.durationSec / 60)}:${String(t.durationSec % 60).padStart(2, "0")}` : "");
        const items = rows.slice(0, 200).map((t, i) => `<li><span class="n">${i + 1}</span>${t.thumbnail ? `<img class="art" src="${esc(t.thumbnail)}" loading="lazy" alt="">` : `<span class="art ph"></span>`}<span class="tt"><span class="t">${esc(t.title)}</span><span class="a">${esc(t.artist || "")}</span></span><span class="d">${fmtDur(t)}</span></li>`).join("");
        const mins = Math.round(totalDurationSec / 60);
        // In-browser "Open in the app": a plain https link to the SAME page never re-triggers App Links
        // (they only fire on taps from OTHER apps) — Android needs an intent:// URI with the package. Other
        // platforms keep the https link (harmless no-op pre-App-Links, correct after).
        const isAndroid = /android/i.test(String(req.headers["user-agent"] || ""));
        const openHref = isAndroid
          ? `intent://${PUBLIC_HOST}/user_playlist/${esc(up.id)}#Intent;scheme=https;package=com.jtech.zemer;end`
          : `https://${PUBLIC_HOST}/user_playlist/${esc(up.id)}`;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
        return res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(up.title)} · Zemer</title>
<meta property="og:title" content="${esc(up.title)}"><meta property="og:description" content="${rows.length} songs · ${mins} min${up.sharedBy ? ` · shared by ${esc(up.sharedBy)}` : ""} · on Zemer">${cover ? `<meta property="og:image" content="${esc(cover)}">` : ""}<style>
body{margin:0;font-family:'Segoe UI',Roboto,Arial,sans-serif;background:linear-gradient(135deg,#132a4d,#1f66c2);color:#fff;min-height:100vh}
.wrap{max-width:560px;margin:0 auto;padding:32px 20px 60px}
.hdr{display:flex;gap:16px;align-items:center;margin-top:14px}
.cover{width:96px;height:96px;border-radius:14px;object-fit:cover;box-shadow:0 6px 18px rgba(0,0,0,.35);flex:none}
h1{font-size:1.55rem;margin:0 0 4px}.sub{opacity:.75}
.open{display:block;text-align:center;background:#fff;color:#1f66c2;font-weight:700;text-decoration:none;border-radius:12px;padding:14px;margin:20px 0 26px;font-size:1.05rem}
ol{list-style:none;margin:0;padding:0}li{display:flex;gap:10px;align-items:center;padding:8px 2px;border-bottom:1px solid rgba(255,255,255,.12)}
.n{opacity:.5;min-width:20px;text-align:right;font-size:.85rem}
.art{width:40px;height:40px;border-radius:7px;object-fit:cover;flex:none}.art.ph{background:rgba(255,255,255,.12);display:inline-block}
.tt{flex:1;min-width:0;display:flex;flex-direction:column}.t{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.a{opacity:.7;font-size:.82rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.d{opacity:.6;font-size:.82rem;font-variant-numeric:tabular-nums}
.brand{margin-top:30px;text-align:center;letter-spacing:6px;font-weight:600;opacity:.8;font-size:.85rem}</style></head><body><div class="wrap">
<div class="brand">ZEMER</div>
<div class="hdr">${cover ? `<img class="cover" src="${esc(cover)}" alt="">` : ""}<div><h1>${esc(up.title)}</h1><div class="sub">${rows.length} songs · ${mins} min${up.sharedBy ? ` · shared by ${esc(up.sharedBy)}` : " · shared playlist"}</div></div></div>
<a class="open" href="${openHref}">Open in the Zemer app</a>
<ol>${items}</ol><div class="brand">ZEMER</div></div></body></html>`);
      }
      if (u.pathname === "/.well-known/assetlinks.json") {
        // Android App Links: lets a tap on search.zemer.io/user_playlist/<id> open the Zemer app directly.
        // Content (package + signing-cert SHA256) comes from the app team → data/assetlinks.json; absent → 404.
        try {
          const body = fs.readFileSync(path.join(path.dirname(DB_PATH), "assetlinks.json"));
          res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600", "Access-Control-Allow-Origin": "*" });
          return res.end(body);
        } catch { return send(res, 404, { error: "not configured" }); }
      }
      if (u.pathname === "/stations/cover") {
        // Branded broadcast-style SVG cover for one station (same palette/design language as the
        // playlist covers; LIVE badge + on-air waves). Stable per id; unknown id → 404.
        const id = u.searchParams.get("id");
        const st = stationsDoc()?.doc?.stations?.[id];
        if (!st) return send(res, 404, { error: "station not found" });
        res.writeHead(200, { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "public, max-age=3600", "Access-Control-Allow-Origin": "*" });
        return res.end(stationCoverSvg(id, st.title));
      }
      if (u.pathname === "/stations" || u.pathname === "/station") {
        // Zemer Stations — SYNCHRONIZED broadcast (one shared wall-clock program per station; every
        // listener hears the same track at the same moment). Schedule is the append-only artifact from
        // harvester/stations.mjs; this endpoint only does clock math + track enrichment. docs/stations.md.
        const sc = stationsDoc();
        const nowMs = Date.now();
        // SERVE-TIME purity (gotcha #7 applies to every result endpoint): a scheduled entry whose id has
        // since been blocked (global OR curated-female — station pools are female-free by policy) or whose
        // track left the corpus (de-whitelisted between generator runs) is skipped here, honoring the
        // ~10-min takedown SLA the overrides timer provides. The generator also purges such entries from
        // the un-aired future each run; this is the immediate layer.
        const servable = (vid) => radioIndex.byId.has(vid) && !cats.blocked.global.has(vid) && !cats.blocked.female.has(vid);
        const enrichAll = (list) => { // ONE batched art lookup for the whole response (finding: no per-track queries)
          const ai = trackAlbumInfo(liveDb, list.map(([v]) => v));
          return list.map(([vid, startMs, durSec]) => { const t = radioIndex.byId.get(vid), a = ai.get(vid); return { videoId: vid, title: t?.title ?? null, artist: t?.artistName ?? null, artistId: t?.artistId ?? null, thumbnail: a?.thumbnail ?? null, durationSec: durSec, startMs, endMs: startMs + durSec * 1000 }; });
        };
        // the live entry, advanced past any unservable ones: if the wall-clock entry was taken down, the
        // broadcast is momentarily "between tracks" — the next servable entry is served as `now` with a
        // NEGATIVE offsetMs (starts in |offset| ms; contract-documented, the app waits or starts at 0).
        const stationNow = (s) => {
          const entries = s.entries || [];
          let i = scheduleAt(entries, nowMs);
          if (i < 0) return null;
          while (i < entries.length && !servable(entries[i][0])) i++;
          return i < entries.length ? i : null;
        };
        if (u.pathname === "/stations") {
          const out = [];
          for (const [id, s] of Object.entries(sc?.doc?.stations || {})) {
            const i = stationNow(s);
            const np = i != null ? enrichAll([s.entries[i]])[0] : null;
            out.push({ id, title: s.title, thumbnail: `/stations/cover?id=${encodeURIComponent(id)}`, live: i != null, nowPlaying: np ? { title: np.title, artist: np.artist, thumbnail: np.thumbnail } : null });
          }
          return send(res, 200, { count: out.length, stations: out, serverTimeMs: nowMs });
        }
        const id = u.searchParams.get("id");
        const s = sc?.doc?.stations?.[id];
        if (!s) return send(res, 404, { error: "station not found" });
        const i = stationNow(s);
        if (i == null) return send(res, 503, { error: "station offline" }); // schedule ran out — generator down; app hides the card
        const wantNext = Math.min(10, Math.max(1, Number(u.searchParams.get("next")) || 5));
        const upcomingRaw = s.entries.slice(i + 1).filter(([v]) => servable(v)).slice(0, wantNext);
        const [nowE, ...nextE] = enrichAll([s.entries[i], ...upcomingRaw]);
        const lastE = s.entries[s.entries.length - 1];
        return send(res, 200, { station: { id, title: s.title, thumbnail: `/stations/cover?id=${encodeURIComponent(id)}` }, serverTimeMs: nowMs,
          horizonMs: lastE ? lastE[1] + lastE[2] * 1000 - nowMs : 0, now: { ...nowE, offsetMs: nowMs - nowE.startMs }, next: nextE });
      }
      if (u.pathname === "/radio") {
        // Zemer Radio — corpus-native "what plays next" (index/radio.mjs). Either a fresh seed
        // (kind + seed) or an opaque `continuation` token (kind+seed+flags+rngSeed+offset) → deterministic
        // slice, so the queue is endless with no server session state. Whitelist-pure + filtered in-engine.
        const cont = u.searchParams.get("continuation");
        let p;
        if (cont) {
          const d = decTok(cont);
          if (!d) return send(res, 400, { error: "bad continuation" });
          p = { kind: d.k, seed: d.s, allowFemale: !!d.af, blockVideos: !!d.bv, kidZoneOnly: !!d.kz, rngSeed: d.r | 0, offset: Math.max(0, d.o | 0) };
        } else {
          const kind = u.searchParams.get("kind") || "shuffle";
          if (!["artist", "album", "song", "shuffle", "playlist"].includes(kind)) return send(res, 400, { error: "bad kind" });
          const seed = u.searchParams.get("seed") || null;
          if (kind !== "shuffle" && !seed) return send(res, 400, { error: "missing seed" });
          const cf = contentFlags(u.searchParams);
          p = { kind, seed, allowFemale: cf.allowFemale, blockVideos: cf.blockVideos, kidZoneOnly: cf.kidZoneOnly, rngSeed: (Math.random() * 0x7fffffff) | 0, offset: 0 };
        }
        // absent → Number(null)=0, non-numeric → NaN; `|| 25` maps both (and an explicit 0) to the default
        const limit = Math.min(50, Math.max(1, Number(u.searchParams.get("limit")) || 25));
        // album seed may arrive as a playlistId → resolve to the corpus albumId the engine indexes by
        let rseed = p.seed;
        if (p.kind === "album" && rseed && !radioIndex.albumTrackIds.has(rseed)) {
          const row = liveDb.prepare("SELECT id FROM album WHERE playlistId=?").get(rseed);
          if (row) rseed = row.id;
        }
        // kind=playlist: aggregate the cooc neighbors of the playlist's MEMBER tracks. Community playlists
        // have stored (whitelisted) membership → pure corpus; anything else (artist-owned) → one IP-safe live
        // fetch (cached), same as /playlist. Non-corpus members are dropped in-engine, so radio stays pure.
        let seedTracks = null;
        if (p.kind === "playlist" && p.seed) {
          seedTracks = liveDb.prepare("SELECT videoId FROM community_playlist_track WHERE playlistId=? ORDER BY pos").all(p.seed).map((r) => r.videoId);
          if (!seedTracks.length) { const songs = await fetchPlaylistTracks(p.seed); if (songs) seedTracks = songs.map((s) => s.videoId); }
        }
        const { ids, nextOffset } = radio(radioIndex, { ...p, seed: rseed, seedTracks, limit, acapellaOk: inThreeWeeks() }); // acapella allowed in-season (or on acapella seeds, engine-side)
        const ai = trackAlbumInfo(liveDb, ids);
        const tracks = ids.map((v) => { const t = radioIndex.byId.get(v), a = ai.get(v); return { videoId: v, title: t.title, artist: t.artistName, artistId: t.artistId, thumbnail: a?.thumbnail ?? null, durationSec: t.durationSec, explicit: t.explicit, isVideo: t.isVideo, releaseDate: t.releaseDate, album: a ? { id: a.albumId, name: a.albumName } : null }; });
        const continuation = nextOffset == null ? null : encTok({ k: p.kind, s: p.seed, af: p.allowFemale ? 1 : 0, bv: p.blockVideos ? 1 : 0, kz: p.kidZoneOnly ? 1 : 0, r: p.rngSeed, o: nextOffset });
        return send(res, 200, { tracks, continuation });
      }
      if (u.pathname === "/playlist") {
        const id = u.searchParams.get("id");
        if (!id) return send(res, 400, { error: "missing id" });
        const cf = contentFlags(u.searchParams);
        if (idDropped(id, cats.blocked, cf.allowFemale)) return send(res, 200, { playlist: { id, title: "Playlist", artist: "", thumbnail: null }, tracks: [], total: 0, whitelisted: 0 });
        let meta = liveDb.prepare("SELECT pl.title,pl.thumbnail,a.name artistName FROM playlist pl JOIN artist a ON a.id=pl.artistId WHERE pl.id=?").get(id);
        const isCommunity = !meta; // community playlist covers are derived from a member, so make them filter-aware below
        if (!meta) { const c = communityPlaylistMeta(liveDb, id); if (c) meta = { title: c.title, thumbnail: c.thumbnail, artistName: c.author || "Community playlist" }; }
        const playlist = { id, title: meta?.title || "Playlist", artist: meta?.artistName || "", thumbnail: meta?.thumbnail || null };
        const songs = await fetchPlaylistTracks(id);
        if (songs === null) return send(res, 200, { playlist, tracks: [], note: "playlist contents unavailable" });
        const corpus = tracksByIds(liveDb, songs.map((s) => s.videoId));
        const wl = whitelistedChannelIds(liveDb);
        const aflags = new Map(allArtists(liveDb).map((a) => [a.id, a])); // content flags for fallback (non-corpus) tracks
        const pass = (isFemale, isKidZone, isVideo) => (cf.allowFemale || !isFemale) && (!cf.kidZoneOnly || isKidZone) && (!cf.blockVideos || !isVideo);
        const tracks = [];
        for (const s of songs) {
          if (idDropped(s.videoId, cats.blocked, cf.allowFemale)) continue; // server-curated id override
          const c = corpus.get(s.videoId);
          if (c) { // in corpus → real per-track flags
            if (pass(c.isFemale, c.isKidZone, c.isVideo)) tracks.push({ videoId: c.videoId, title: c.title, artist: c.artist, explicit: c.explicit, durationSec: c.durationSec ?? null });
          } else if (s.rowArtistId && wl.has(s.rowArtistId)) { // whitelisted channel, not in corpus: filter by artist flags (isVideo unknown → kept)
            const f = aflags.get(s.rowArtistId) || {};
            if (pass(!!f.isFemale, !!f.isKidZone, false)) tracks.push({ videoId: s.videoId, title: s.title, artist: s.rowArtistName, explicit: !!s.explicit });
          }
        }
        // Community covers are derived from a member track — use the first SURVIVING track so the header
        // never shows a filtered-out (e.g. female) member's art. Artist-owned playlists keep their own cover.
        if (isCommunity && tracks.length) playlist.thumbnail = `https://i.ytimg.com/vi/${tracks[0].videoId}/mqdefault.jpg`;
        return cacheSet(req.url, send(res, 200, { playlist, tracks, total: songs.length, whitelisted: tracks.length }));
      }
      send(res, 404, { error: "not found" });
    } catch (e) { send(res, 500, { error: e.message }); }
  });

  server.listen(PORT, HOST, () => console.log(`zsearch worker ${wIndex} (pid ${process.pid}) → http://${HOST}:${PORT}  (corpus ${stats(liveDb).tracks} tracks)`));
  setTimeout(() => getReleasesFeed().catch(() => {}), 500); // warm the releases-feed cache so the first /new isn't a cold corpus fallback
}
