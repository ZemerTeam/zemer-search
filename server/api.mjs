// The search API (primary path) + a tiny live web UI — SQLite corpus + the proven in-memory matcher.
// Built to scale to thousands of concurrent users:
//   • multi-core cluster   — WORKERS=N forks N worker processes (Node is single-threaded); the OS load-
//                            balances connections across them. Each worker holds its own in-memory index
//                            (the corpus is small). Horizontally scalable too: stateless + read-only DB.
//   • LRU query cache      — as-you-type hammers the same prefixes; identical queries return instantly.
//                            Cleared on each index reload so results never go stale.
//   • staggered reloads    — workers rebuild the index at offset times so they don't all stall together.
//
//   GET /  /search  /artist  /album  /playlist  /health      POST /reload
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import cluster from "node:cluster";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { openCorpus, allTracks, allArtists, allAlbums, allPlaylists, artistDetail, albumDetail, tracksByIds, whitelistedChannelIds, stats } from "../corpus/store.mjs";
import { buildCategories, searchCategories } from "../index/categories.mjs";
import { loadDefaultSynonyms } from "../index/synonyms.mjs";
import { postBrowse, parsePlaylistPage, parseArtistItemsContinuation } from "../harness/browse.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 7700);
const RELOAD_MS = Number(process.env.RELOAD_MS || 30000);
const CACHE_MAX = Number(process.env.CACHE_MAX || 5000);
// WORKERS=0/"auto" → one per core; default 1 (dev). Production: set to the core count.
const WORKERS = process.env.WORKERS === "auto" ? os.availableParallelism() : Number(process.env.WORKERS || 1);
const CORS = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json; charset=utf-8" };
const UI = fs.readFileSync(path.join(HERE, "ui.html"));

if (cluster.isPrimary && WORKERS > 1) {
  console.log(`zsearch primary (pid ${process.pid}) → forking ${WORKERS} workers on :${PORT}`);
  for (let i = 0; i < WORKERS; i++) cluster.fork({ WORKER_INDEX: String(i) });
  cluster.on("exit", (w, code) => { console.warn(`worker ${w.process.pid} exited (${code}); respawning`); cluster.fork(); });
} else {
  startServer();
}

async function startServer() {
  const liveDb = openCorpus(); // persistent WAL reader → sees the harvest's latest per-artist commits
  // Total whitelisted artists (the harvest target) — lets the UI show live harvest progress.
  const whitelistTotal = (() => { try { return JSON.parse(fs.readFileSync(path.join(HERE, "../data/whitelist.json"), "utf8")).filter((a) => /^UC/.test(a.id || "")).length; } catch { return 0; } })();
  const cache = new Map();     // url -> response body (LRU; cleared on reload)
  let cats, indexedCount = 0, indexedAt = 0;
  function reload() {
    const tracks = allTracks(liveDb);
    cats = buildCategories({ tracks, artists: allArtists(liveDb), albums: allAlbums(liveDb), playlists: allPlaylists(liveDb) }, loadDefaultSynonyms());
    indexedCount = tracks.length; indexedAt = Date.now();
    cache.clear();
    return tracks.length;
  }
  reload();
  // Stagger reloads across workers so only one rebuilds (and briefly stalls) at a time.
  const wIndex = Number(process.env.WORKER_INDEX || 0);
  setTimeout(() => setInterval(reload, RELOAD_MS).unref(), Math.floor((RELOAD_MS * wIndex) / Math.max(1, WORKERS)));

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
  const CACHEABLE = new Set(["/search", "/artist", "/album", "/playlist"]);

  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, "http://localhost");
      if (u.pathname === "/" || u.pathname === "/ui.html") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(UI); }
      if (u.pathname === "/health") return send(res, 200, { ok: true, ...stats(liveDb), indexed: indexedCount, indexedAt, worker: wIndex, whitelistTotal });
      if (u.pathname === "/reload" && req.method === "POST") return send(res, 200, { ok: true, tracks: reload() });

      // LRU cache for the hot read endpoints (cleared on reload, so never stale beyond one cycle).
      if (req.method === "GET" && CACHEABLE.has(u.pathname)) {
        const hit = cache.get(req.url);
        if (hit !== undefined) { cache.delete(req.url); cache.set(req.url, hit); res.writeHead(200, CORS); return res.end(hit); }
      }

      if (u.pathname === "/search") {
        const q = (u.searchParams.get("q") || "").replace(/^\s+/, ""); // keep a TRAILING space — it signals a completed last word
        if (!q.trim()) return send(res, 400, { error: "missing q" });
        const o = {
          allowFemale: u.searchParams.get("allowFemale") !== "0",
          kidZoneOnly: u.searchParams.get("kidZone") === "1",
          blockVideos: u.searchParams.get("blockVideos") === "1",
          k: Math.min(200, Math.max(1, Number(u.searchParams.get("k") || 8))),
        };
        const categories = searchCategories(cats, q, o);
        return cacheSet(req.url, send(res, 200, { q, count: Object.values(categories).reduce((n, a) => n + a.length, 0), categories }));
      }
      if (u.pathname === "/artist") {
        const d = u.searchParams.get("id") && artistDetail(liveDb, u.searchParams.get("id"));
        return d ? cacheSet(req.url, send(res, 200, d)) : send(res, 404, { error: "artist not found" });
      }
      if (u.pathname === "/album") {
        const d = u.searchParams.get("id") && albumDetail(liveDb, u.searchParams.get("id"));
        return d ? cacheSet(req.url, send(res, 200, d)) : send(res, 404, { error: "album not found" });
      }
      if (u.pathname === "/playlist") {
        const id = u.searchParams.get("id");
        if (!id) return send(res, 400, { error: "missing id" });
        const meta = liveDb.prepare("SELECT pl.id,pl.title,pl.thumbnail,a.name artistName FROM playlist pl JOIN artist a ON a.id=pl.artistId WHERE pl.id=?").get(id);
        const playlist = { id, title: meta?.title || "Playlist", artist: meta?.artistName || "", thumbnail: meta?.thumbnail || null };
        const songs = await fetchPlaylistTracks(id);
        if (songs === null) return send(res, 200, { playlist, tracks: [], note: "playlist contents unavailable" });
        const corpus = tracksByIds(liveDb, songs.map((s) => s.videoId));
        const wl = whitelistedChannelIds(liveDb);
        const tracks = songs.map((s) =>
          corpus.get(s.videoId) ||
          (s.rowArtistId && wl.has(s.rowArtistId) ? { videoId: s.videoId, title: s.title, artist: s.rowArtistName, explicit: !!s.explicit } : null)
        ).filter(Boolean);
        return cacheSet(req.url, send(res, 200, { playlist, tracks, total: songs.length, whitelisted: tracks.length }));
      }
      send(res, 404, { error: "not found" });
    } catch (e) { send(res, 500, { error: e.message }); }
  });

  server.listen(PORT, () => console.log(`zsearch worker ${wIndex} (pid ${process.pid}) → http://localhost:${PORT}  (corpus ${stats(liveDb).tracks} tracks)`));
}
