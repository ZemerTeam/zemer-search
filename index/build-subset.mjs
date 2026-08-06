// zemer-search — search engine and more for the Zemer app
// https://github.com/ZemerTeam/zemer-search
// Zemer app: https://github.com/ZemerTeam/zemer-app
// Copyright (C) 2026 alltechdev
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See the LICENSE file for details.

// Build the on-device fallback SNAPSHOT — full server parity MINUS audio playback — as content-addressed,
// gzipped SHARDS + a manifest. The app mirrors the whole read layer offline (search + artist/album/home/
// new/zemer/community) and, on update, pulls ONLY changed shards (so a daily refresh is kilobytes, not the
// whole file). The two big tables (tracks, album_track, albums) are hash-bucketed so one new release dirties
// only a shard or two; small/volatile tables (home_rank, zemer, community…) are one shard each. Served by
// server/api.mjs: GET /subset/manifest + GET /subset/<shard>. See handoff zemer-app-ondevice-fallback-subset.md.
//
//   node index/build-subset.mjs                 # → data/subset/{manifest.json, *.json.gz}
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { openCorpus, loadBlockedIds, DB_PATH } from "../corpus/store.mjs";
import { ensurePodcastSchema, allPodcastChannels, makeShowArtResolver } from "../corpus/podcasts.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Default OUT = <corpus-dir>/subset — the SAME derivation server/api.mjs uses for SUBSET_DIR, so a
// CORPUS_DB override can never make the build write where the server doesn't read. SUBSET_OUT overrides (tests).
const OUT = process.env.SUBSET_OUT ? path.resolve(process.env.SUBSET_OUT) : path.join(path.dirname(DB_PATH), "subset");
const db = openCorpus();

// hash-bucket a big table so a single-row change re-hashes to the SAME shard name (deterministic on the key),
// dirtying only that shard's content — the app re-downloads just it. Buckets sized so each stays small.
const NB = { tracks: 16, albumtracks: 16, albums: 8, podcastepisodes: 16 };
const bucket = (id, n) => { let h = 0; const s = String(id); for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0; return h % n; };

const shards = {};
const one = (name, payload) => { shards[name] = payload; };
const sharded = (prefix, rows, n, keyOf) => {
  const b = Array.from({ length: n }, () => []);
  for (const r of rows) b[bucket(keyOf(r), n)].push(r);
  b.forEach((rows, i) => (shards[`${prefix}-${i}`] = rows));
};

// Raw column-scoped reads (full control over the on-device payload; independent of the denormalized allX
// shapes). Every read carries an explicit ORDER BY: SQLite scan order is unspecified, so without it a VACUUM
// or a rebuild on a differently-ordered corpus copy would reshuffle rows and change a shard's content hash
// with an identical row set — forcing the app to re-download shards that didn't actually change.
// altName/altTitle (appended LAST on their rows, nullable): the artist's name / song's title in the other
// script. On-device search must match the server's cross-script behaviour — without them the offline
// fallback silently answers Hebrew queries worse than production. Appended, so an older app reading by
// index is unaffected.
one("artists", db.prepare("SELECT id,name,thumbnail,isFemale,isChasid,isKidZone,isDJ,isAmerican,isFamous,altName FROM artist ORDER BY id").all()
  .map((a) => [a.id, a.name, a.thumbnail ?? null, (a.isFemale ? 1 : 0) | (a.isChasid ? 2 : 0) | (a.isKidZone ? 4 : 0) | (a.isDJ ? 8 : 0) | (a.isAmerican ? 16 : 0) | (a.isFamous ? 32 : 0), a.altName ?? null]));
sharded("tracks", db.prepare("SELECT videoId,title,altTitle,genres,energy,artistId,isVideo,explicit,durationSec,playCount,uploadDate FROM track ORDER BY videoId").all()
  .map((t) => [t.videoId, t.title, t.artistId, (t.isVideo ? 1 : 0) | (t.explicit ? 2 : 0), t.durationSec ?? null, t.playCount ?? null, t.uploadDate ?? null, t.altTitle ?? null, t.genres ?? null, t.energy ?? null]), NB.tracks, (r) => r[0]);
sharded("albums", db.prepare("SELECT id,playlistId,title,artistId,type,year,thumbnail,uploadDate FROM album ORDER BY id").all()
  .map((al) => [al.id, al.playlistId ?? null, al.title, al.artistId, al.type, al.year ?? null, al.thumbnail ?? null, al.uploadDate ?? null]), NB.albums, (r) => r[0]);
sharded("albumtracks", db.prepare("SELECT albumId,videoId,pos FROM album_track ORDER BY albumId,pos,videoId").all()
  .map((r) => [r.albumId, r.videoId, r.pos]), NB.albumtracks, (r) => r[0]);
one("playlists", db.prepare("SELECT id,title,artistId,thumbnail FROM playlist ORDER BY id").all()
  .map((p) => [p.id, p.title, p.artistId, p.thumbnail ?? null]));
one("community", db.prepare("SELECT id,title,author,thumbnail,total,whitelisted,viewCount FROM community_playlist ORDER BY id").all()
  .map((c) => [c.id, c.title, c.author ?? null, c.thumbnail ?? null, c.total, c.whitelisted, c.viewCount ?? null]));
one("communitytracks", db.prepare("SELECT playlistId,videoId,pos,artistId FROM community_playlist_track ORDER BY playlistId,pos,videoId").all()
  .map((r) => [r.playlistId, r.videoId, r.pos, r.artistId ?? null]));
one("zemer", { playlists: db.prepare("SELECT id,title,pos,year FROM zemer_playlist ORDER BY id").all(),
               items: db.prepare("SELECT playlistId,kind,refId,pos FROM zemer_playlist_item ORDER BY playlistId,pos,refId").all() });
one("homerank", db.prepare("SELECT row,kind,refId,artistId,pos,score FROM home_rank ORDER BY row,pos,refId").all());
const bl = loadBlockedIds();
one("blocked", { global: [...bl.global], female: [...bl.female] });

// ---- Podcasts (channel-level; offline mirror of the online podcast read layer) ----------------------
// Added under the SAME manifest schema (v:2) so an app WITHOUT podcast decoders IGNORES these shards
// (SubsetDecoder "unknown shard → ignored"); an app WITH them decodes by the pinned positions below. The
// snapshot is pre-gated to APPROVED channels (a show is included iff its host UC is an approved publisher,
// or it is a grandfathered channel-less show), mirroring the serve-time channel-membership gate at build
// time. Show art is resolved to a DURABLE url here (dead pl_c/podcasts_artwork → channel avatar / episode
// thumbnail), exactly like the endpoints. Female/KidZone stay per item: a WHOLLY female/kids channel carries
// the flag (podcastchannels row), and per-show exceptions ride the `blocked` shard — the app filters offline
// exactly as the server filters online. Pinned row layouts (append-only, like the music shards):
//   podcastchannels : [ id(UC), name, thumbnail(durable), flags(bit0 isFemale|bit1 isKidZone|bit2 isVerified), showCount, episodeCount ]
//   podcasts        : [ id(MPSP), name, author, channelId(UC), thumbnail(durable), episodeCountText, genres(csv) ]
//   podcastepisodes : [ videoId, showId(MPSP), title, thumbnail, durationSec, publishedAt ]   (sharded by videoId)
try {
  ensurePodcastSchema(db); // idempotent — safe on a corpus that predates the podcast tables
  let pw = { podcasts: [] };
  try { pw = JSON.parse(fs.readFileSync(path.join(HERE, "../data/podcasts-whitelist.json"), "utf8")); } catch { /* no whitelist file → no podcasts in the snapshot */ }
  const byCh = new Map(), grandfathered = new Set();
  for (const p of (pw.podcasts || [])) {
    if (!p.channelId) { grandfathered.add(p.id); continue; }
    if (!byCh.has(p.channelId)) byCh.set(p.channelId, []);
    byCh.get(p.channelId).push(p);
  }
  const approved = new Set(byCh.keys());
  const chFlags = new Map();
  for (const [cid, ss] of byCh) chFlags.set(cid, (ss.every((s) => s.isFemale) ? 1 : 0) | (ss.every((s) => s.isKidZone) ? 2 : 0) | (ss.some((s) => s.isVerified) ? 4 : 0));

  // channel grid (durable avatars + counts), with the aggregate content flags merged in
  one("podcastchannels", allPodcastChannels(db, approved)
    .map((c) => [c.id, c.name ?? null, c.thumbnail ?? null, chFlags.get(c.id) ?? 0, c.showCount, c.episodeCount]));

  // shows on approved channels (+ grandfathered), art resolved to a durable url
  const art = makeShowArtResolver(db);
  const showRows = db.prepare("SELECT id,name,author,channelId,thumbnail,episodeCountText,genres FROM podcast_show ORDER BY id").all()
    .filter((s) => (s.channelId && approved.has(s.channelId)) || grandfathered.has(s.id))
    .map((s) => [s.id, s.name, s.author ?? null, s.channelId ?? null, art(s) ?? null, s.episodeCountText ?? null, s.genres ?? null]);
  one("podcasts", showRows);

  // their episodes, hash-bucketed by videoId like tracks
  const keep = new Set(showRows.map((r) => r[0]));
  const epRows = db.prepare("SELECT videoId,showId,title,thumbnail,durationSec,publishedAt FROM podcast_episode ORDER BY videoId").all()
    .filter((e) => keep.has(e.showId))
    .map((e) => [e.videoId, e.showId, e.title, e.thumbnail ?? null, e.durationSec ?? null, e.publishedAt ?? null]);
  sharded("podcastepisodes", epRows, NB.podcastepisodes, (r) => r[0]);
} catch (e) {
  console.warn(`subset: podcasts skipped (${e.message})`); // never let a podcast issue break the music snapshot
}

// Emit: each shard gzipped, content-hashed (the version key — unchanged content ⇒ same hash ⇒ app skips it).
// Build into a TMP dir then swap, so a live server never serves a half-built/torn set (manifest written last
// into TMP; the swap window is a single rm+rename, ~ms, and the server serves its last-good cache across it).
const TMP = OUT + ".tmp";
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
const manifest = { v: 2, builtAt: new Date().toISOString(), shards: [] };
for (const [name, payload] of Object.entries(shards).sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
  const gz = zlib.gzipSync(JSON.stringify(payload), { level: 9 });
  const hash = crypto.createHash("sha256").update(gz).digest("hex").slice(0, 16);
  fs.writeFileSync(path.join(TMP, `${name}.json.gz`), gz);
  manifest.shards.push({ name, hash, bytes: gz.length });
}
fs.writeFileSync(path.join(TMP, "manifest.json"), JSON.stringify(manifest)); // manifest last = TMP is complete before the swap
fs.rmSync(OUT, { recursive: true, force: true });
fs.renameSync(TMP, OUT);
const total = manifest.shards.reduce((s, x) => s + x.bytes, 0);
console.log(`subset: ${manifest.shards.length} shards, ${(total / 1024 / 1024).toFixed(2)} MB gzipped → data/subset/`);
for (const s of manifest.shards) console.log(`  ${s.name.padEnd(16)} ${(s.bytes / 1024).toFixed(1).padStart(8)} KB  ${s.hash}`);
