// zemer-search — search engine and more for the Zemer app
// https://github.com/ZemerTeam/zemer-search
// Zemer app: https://github.com/ZemerTeam/zemer-app
// Copyright (C) 2026 alltechdev
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See the LICENSE file for details.

// Reconcile the corpus against whitelist purity: re-parse every artist's cached pages (OFFLINE — cacheOnly,
// zero YouTube calls) and PURGE any stored track whose ROW artist channel is a non-whitelisted uploader.
//
// Why: YouTube Music's artist Songs/Videos shelves mix in rows uploaded by OTHER channels (foreign garbage
// like Tamil/Lil Wayne, third-party Jewish covers, and re-uploads). The harvest used to stamp the page
// artist on every shelf row, so that junk got stored under a whitelisted artist. core.mjs now drops such
// rows at harvest time (ownsRow); this one-time pass cleans what's already stored.
//
// SAFE: a track is purged ONLY if its cached row is found with a foreign (present, non-whitelisted)
// rowArtistId. Cache misses and rows with no captured artist are never touched. DRY=1 reports without writing.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openCorpus, whitelistedChannelIds, pruneBlocklisted, stats } from "../corpus/store.mjs";
import { postBrowse, parseArtistPage, parseArtistItems, parseArtistItemsContinuation, parsePlaylistPage } from "../harness/browse.mjs";

const DRY = process.env.DRY === "1";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const db = openCorpus();

// Whitelisted channel set = corpus music+regular channel ids ∪ the raw whitelist.json music ids.
let wlIds = [];
try { wlIds = JSON.parse(fs.readFileSync(path.join(HERE, "../data/whitelist.json"), "utf8")).map((a) => a.id).filter(Boolean); } catch { /* optional */ }
const wl = new Set([...whitelistedChannelIds(db), ...wlIds]);

const browse = async (a) => { const r = await postBrowse({ ...a, cacheOnly: true }); return r.miss ? {} : (r.json || {}); };

const artists = db.prepare("SELECT id, name, regularChannelId FROM artist WHERE name IS NOT NULL").all();
const foreign = new Set();
const perArtist = []; // {name, n} for reporting
let scanned = 0;

for (const a of artists) {
  const owned = new Set([a.id]); if (a.regularChannelId) owned.add(a.regularChannelId);
  const have = new Set(db.prepare("SELECT videoId FROM track WHERE artistId=?").all(a.id).map((r) => r.videoId));
  scanned++;
  if (!have.size) continue;
  const rowOf = new Map(); // videoId -> rowArtistId (from cached rows)
  const note = (s) => { if (s?.videoId && s.rowArtistId && !rowOf.has(s.videoId)) rowOf.set(s.videoId, s.rowArtistId); };
  try {
    const page = parseArtistPage(await browse({ browseId: a.id }));
    for (const s of page.sections) {
      if (s.kind === "songs") s.songs.forEach(note);
      if (s.kind === "carousel") s.items.filter((i) => i.kind === "song").forEach(note);
    }
    for (const s of page.sections) {
      if (!s.moreEndpoint || !/song|video/i.test(s.title)) continue;
      const isV = /video/i.test(s.title);
      let p = parseArtistItems(await browse({ browseId: s.moreEndpoint.browseId, params: s.moreEndpoint.params }), isV);
      const sink = (x) => { (x.songs || []).forEach(note); (x.items || []).filter((i) => i.kind === "song").forEach(note); };
      sink(p); let c = p.continuation, g = 0;
      while (c && g++ < 200) { const cp = parseArtistItemsContinuation(await browse({ continuation: c }), isV); sink(cp); c = cp.continuation; }
    }
    const albums = new Map();
    const collect = (items) => { for (const it of items) if (it.kind === "album" && it.browseId && it.playlistId && !albums.has(it.browseId)) albums.set(it.browseId, it.playlistId); };
    for (const s of page.sections) if (s.kind === "carousel") collect(s.items);
    for (const s of page.sections) {
      if (s.kind !== "carousel" || !s.moreEndpoint || !/album|single|ep|release/i.test(s.title)) continue;
      let p = parseArtistItems(await browse({ browseId: s.moreEndpoint.browseId, params: s.moreEndpoint.params }), false);
      collect(p.items || []); let c = p.continuation, g = 0;
      while (c && g++ < 80) { const cp = parseArtistItemsContinuation(await browse({ continuation: c }), false); collect(cp.items || []); c = cp.continuation; }
    }
    for (const [, plid] of albums) {
      let p = parsePlaylistPage(await browse({ browseId: "VL" + plid })); (p.songs || []).forEach(note);
      let c = p.continuation, g = 0;
      while (c && g++ < 80) { const cp = parseArtistItemsContinuation(await browse({ continuation: c }), false); (cp.songs || []).forEach(note); c = cp.continuation; }
    }
  } catch { /* cache gap for this artist → skip (never purge on missing data) */ }
  let n = 0;
  for (const [vid, rid] of rowOf) if (have.has(vid) && !owned.has(rid) && !wl.has(rid)) { foreign.add(vid); n++; }
  if (n) perArtist.push({ name: a.name, n });
  if (scanned % 250 === 0) console.log(`  …scanned ${scanned}/${artists.length}, foreign so far ${foreign.size}`);
}

perArtist.sort((a, b) => b.n - a.n);
console.log(`\nscanned ${scanned} artists; ${perArtist.length} have foreign rows; ${foreign.size} tracks to purge (non-whitelisted uploader)`);
console.log("top affected artists:"); perArtist.slice(0, 15).forEach((a) => console.log(`  ${String(a.n).padStart(4)}  ${a.name}`));

if (DRY) { console.log("\nDRY RUN — no changes written. Re-run without DRY=1 to purge."); process.exit(0); }
const before = stats(db);
const r = pruneBlocklisted(db, { videoIds: foreign, artistIds: new Set(), playlistIds: [] });
console.log(`\npurged ${r.tracks} tracks. corpus: ${before.tracks} → ${stats(db).tracks} tracks, ${stats(db).communityPlaylists} community playlists (counts re-synced).`);
