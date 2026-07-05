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
import { fileURLToPath } from "node:url";
import { openCorpus, DB_PATH, allTracks, allArtists, allAlbums, allPlaylists, allCommunityPlaylists, communityPlaylistMeta, communityPlaylistList, communityKeptCounts, zemerPlaylistList, zemerPlaylistDetail, artistDetail, albumDetail, tracksByIds, whitelistedChannelIds, recentTracks, recentAlbums, stats, setFemaleSet, loadBlockedIds, BLOCKED_IDS_PATH } from "../corpus/store.mjs";
import { buildCategories, searchCategories } from "../index/categories.mjs";
import { buildFemaleMatcher, collectFemaleVideoIds } from "../index/credits.mjs";
import { loadDefaultSynonyms } from "../index/synonyms.mjs";
import { postBrowse, parsePlaylistPage, parseArtistItemsContinuation } from "../harness/browse.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 7700);
const HOST = process.env.HOST || "0.0.0.0"; // set HOST=127.0.0.1 in production (behind a reverse proxy)
const RELOAD_MS = Number(process.env.RELOAD_MS || 30000);
// New Releases feed (real /player dates, maintained off-datacenter). Just for the web UI's New Releases
// view to display; cached briefly, with a corpus fallback if unreachable.
const RELEASES_FEED = process.env.RELEASES_FEED || "https://api.flipphoneguy.duckdns.org/zemer/recent-releases.json";
const FEED_TTL_MS = Number(process.env.FEED_TTL_MS || 300000); // ~5 min
const CACHE_MAX = Number(process.env.CACHE_MAX || 5000);
// WORKERS=0/"auto" → one per core; default 1 (dev). Production: set to the core count.
const WORKERS = process.env.WORKERS === "auto" ? os.availableParallelism() : Number(process.env.WORKERS || 1);
const CORS = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json; charset=utf-8" };
const UI = fs.readFileSync(path.join(HERE, "ui.html"));

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
  let cats, indexedCount = 0, indexedAt = 0, whitelistTotal = 0;
  let lastSig = null;
  // Rebuild the in-memory index ONLY when the corpus actually changed (a fresh corpus.db is synced, or a
  // local harvest wrote to the WAL). The periodic tick then just stats the files — cheap — so a steady
  // server never pays the rebuild stall. `force` (initial build + POST /reload) always rebuilds.
  function reload(force = false) {
    let sig = null;
    try {
      const a = fs.statSync(DB_PATH);
      let w = 0; try { w = fs.statSync(DB_PATH + "-wal").mtimeMs; } catch { /* no -wal */ }
      let bi = 0; try { bi = fs.statSync(BLOCKED_IDS_PATH).mtimeMs; } catch { /* no blocked-ids.json */ }
      sig = `${a.mtimeMs}:${a.size}:${w}:${bi}`; // a fresh override fetch (its own timer) re-applies on the next tick
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

  const send = (res, code, obj) => { const body = JSON.stringify(obj); res.writeHead(code, CORS); res.end(body); return body; };
  const cacheSet = (key, body) => { cache.set(key, body); if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value); };
  const CACHEABLE = new Set(["/search", "/artist", "/album", "/playlist", "/community", "/zemer-playlists"]); // /new self-caches via the feed TTL

  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, "http://localhost");
      if (u.pathname === "/" || u.pathname === "/ui.html") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(UI); }
      if (u.pathname === "/health") return send(res, 200, { ok: true, ...stats(liveDb), indexed: indexedCount, indexedAt, worker: wIndex, whitelistTotal, maintenance: maintenance() });
      if (u.pathname === "/reload" && req.method === "POST") return send(res, 200, { ok: true, tracks: reload(true) });

      // LRU cache for the hot read endpoints (cleared on reload, so never stale beyond one cycle).
      if (req.method === "GET" && CACHEABLE.has(u.pathname)) {
        const hit = cache.get(req.url);
        if (hit !== undefined) { cache.delete(req.url); cache.set(req.url, hit); res.writeHead(200, CORS); return res.end(hit); }
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
          return d ? cacheSet(req.url, send(res, 200, d)) : send(res, 404, { error: "playlist not found" });
        }
        const playlists = zemerPlaylistList(liveDb, cf, dropId).filter((p) => !dropId(p.id));
        return cacheSet(req.url, send(res, 200, { count: playlists.length, playlists }));
      }
      if (u.pathname === "/artist") {
        const id = u.searchParams.get("id"), cf = contentFlags(u.searchParams);
        const d = id && !idDropped(id, cats.blocked, cf.allowFemale) && artistDetail(liveDb, id, cf);
        if (d) for (const key of ["songs", "videos", "albums", "singles", "playlists"]) d[key] = d[key].filter((it) => !idDropped(it.videoId || it.id, cats.blocked, cf.allowFemale));
        return d ? cacheSet(req.url, send(res, 200, d)) : send(res, 404, { error: "artist not found" });
      }
      if (u.pathname === "/album") {
        const id = u.searchParams.get("id"), cf = contentFlags(u.searchParams);
        const d = id && !idDropped(id, cats.blocked, cf.allowFemale) && albumDetail(liveDb, id, cf);
        if (d) d.tracks = d.tracks.filter((t) => !idDropped(t.videoId, cats.blocked, cf.allowFemale));
        return d ? cacheSet(req.url, send(res, 200, d)) : send(res, 404, { error: "album not found" });
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
