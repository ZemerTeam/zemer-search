// zemer-search — search engine and more for the Zemer app
// https://github.com/ZemerTeam/zemer-search
// Zemer app: https://github.com/ZemerTeam/zemer-app
// Copyright (C) 2026 alltechdev
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See the LICENSE file for details.

// Initial harvest: for the first N whitelisted artists, fetch their COMPLETE catalog (Songs + Videos +
// every album) via the shared per-artist logic in core.mjs, and upsert ONE artist per transaction into
// the SQLite corpus store (corpus/store.mjs) — so a long harvest checkpoints durably (crash/kill safe),
// not only at the end. IP-safe (cached + paced via harness/net.mjs; aborts on the first anti-bot block).
// Re-runs are served from the gzipped cache (free + resumable).
//
//   N=20 node harvester/harvest.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { postBrowse } from "../harness/browse.mjs";
import { netStats } from "../harness/net.mjs";
import { harvestArtist, makeBrowse, BlockError } from "./core.mjs";
import { openCorpus, upsertArtistCatalog, stats } from "../corpus/store.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, "../data");
const N = Number(process.env.N || 20);

const whitelist = JSON.parse(fs.readFileSync(path.join(DATA, "whitelist.json"), "utf8"));
const browse = makeBrowse(postBrowse);
const db = openCorpus();
const artists = whitelist.filter((a) => /^UC/.test(a.id || "")).slice(0, N);
const wlChannels = new Set(whitelist.map((a) => a.id).filter(Boolean)); // whitelist-purity guard: drop foreign-channel shelf rows
let aborted = false;

for (const a of artists) {
  if (aborted) break;
  try {
    const got = await harvestArtist(a, browse, { whitelist: wlChannels }); // forever-cache (no TTL)
    upsertArtistCatalog(db, a, got);            // durable per-artist checkpoint
    console.log(`${a.name.padEnd(32).slice(0, 32)}  +${got.tracks.length}t ${got.albums.length}al ${got.playlists.length}pl`);
  } catch (e) {
    if (e instanceof BlockError) { console.warn("  ⚠ anti-bot block — STOPPING to protect the IP (resume later from cache)"); aborted = true; }
    else console.warn(`  error on ${a.name}: ${e.message}`);
  }
}

const s = stats(db);
db.close();
const ns = netStats();
console.log(`\ncorpus.db now: ${s.tracks} tracks, ${s.artists} artists (${s.videos} videos), ${s.albums} albums, ${s.singles} singles, ${s.playlists} playlists`);
console.log(`${aborted ? "ABORTED on block; " : ""}net: ${ns.liveCount} live, ${ns.cacheHits} cached, ${ns.blockedCount} blocks`);
