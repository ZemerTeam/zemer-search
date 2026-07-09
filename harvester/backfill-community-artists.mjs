// zemer-search — search engine and more for the Zemer app
// https://github.com/ZemerTeam/zemer-search
// Zemer app: https://github.com/ZemerTeam/zemer-app
// Copyright (C) 2026 alltechdev
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See the LICENSE file for details.

// One-time backfill for community_playlist_track.artistId. A community-playlist member whose TRACK isn't
// harvested (e.g. it lives on the artist's regular channel — issue #108) has no corpus row, so the content
// filter couldn't tell its gender and an all-female playlist with one such member wrongly "failed open"
// (showed, then opened empty). Discovery now records each member's resolved artist; this fills it in for
// already-stored playlists by re-parsing their CACHED pages (offline, zero YouTube calls) and resolving
// each un-harvested member's uploader channel → whitelisted artist. SAFE: only sets artistId for members
// NOT in the corpus (corpus members keep null — their track's artist is authoritative) and only where it's
// still NULL; never clears anything. DRY=1 reports without writing. Re-run after a discovery sweep too.
import { openCorpus } from "../corpus/store.mjs";
import { postBrowse, parsePlaylistPage, parseArtistItemsContinuation } from "../harness/browse.mjs";

const DRY = process.env.DRY === "1";
const db = openCorpus();
const channelToArtist = new Map();
for (const r of db.prepare("SELECT id, regularChannelId FROM artist").all()) { channelToArtist.set(r.id, r.id); if (r.regularChannelId) channelToArtist.set(r.regularChannelId, r.id); }
const corpus = new Set(db.prepare("SELECT videoId FROM track").all().map((r) => r.videoId));
const browse = async (x) => { const r = await postBrowse({ ...x, cacheOnly: true }); return r.miss ? null : (r.json || null); };

const playlists = db.prepare("SELECT id FROM community_playlist").all();
const upd = db.prepare("UPDATE community_playlist_track SET artistId=? WHERE playlistId=? AND videoId=? AND artistId IS NULL");
let scanned = 0, miss = 0, resolved = 0;

for (const pl of playlists) {
  const j = await browse({ browseId: "VL" + pl.id });
  if (!j) { miss++; if (++scanned % 200 === 0) console.log(`  …scanned ${scanned}/${playlists.length}, resolved ${resolved}`); continue; }
  const p0 = parsePlaylistPage(j);
  const songs = [...(p0.songs || [])];
  let cont = p0.continuation, g = 0;
  while (cont && g++ < 20) { const r = await browse({ continuation: cont }); if (!r) break; const cp = parseArtistItemsContinuation(r, false); songs.push(...(cp.songs || [])); cont = cp.continuation; }
  const updates = [];
  for (const x of songs) {
    if (!x.videoId || corpus.has(x.videoId)) continue;          // corpus members: track's artist is authoritative
    const aid = channelToArtist.get(x.rowArtistId);             // un-harvested but on a whitelisted channel → resolve
    if (aid) updates.push([aid, pl.id, x.videoId]);
  }
  if (DRY) resolved += updates.length;
  else { const tx = db.transaction((u) => { for (const a of u) resolved += upd.run(...a).changes; }); tx(updates); }
  if (++scanned % 200 === 0) console.log(`  …scanned ${scanned}/${playlists.length}, resolved ${resolved}`);
}
console.log(`scanned ${scanned} playlists (${miss} cache-miss); ${DRY ? "would resolve" : "resolved"} artistId for ${resolved} un-harvested member rows`);
