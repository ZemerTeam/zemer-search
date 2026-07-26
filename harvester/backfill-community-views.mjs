// zemer-search — search engine and more for the Zemer app
// https://github.com/ZemerTeam/zemer-search
// Zemer app: https://github.com/ZemerTeam/zemer-app
// Copyright (C) 2026 alltechdev
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See the LICENSE file for details.

// One-time backfill for community_playlist.viewCount — the playlist's OWN YouTube view count (intrinsic
// popularity, no user telemetry), which drives the Top Community home row. Discovery now stores it going
// forward; this fills it in for already-stored playlists by re-parsing their CACHED browse header (offline,
// zero YouTube calls). SAFE: only sets viewCount where the cached page yields a number; never clears a value
// (an unparseable/absent count leaves the existing one untouched). DRY=1 reports without writing.
import { openCorpus } from "../corpus/store.mjs";
import { postBrowse, parsePlaylistPage } from "../harness/browse.mjs";

const DRY = process.env.DRY === "1";
const db = openCorpus();
const browse = async (x) => { const r = await postBrowse({ ...x, cacheOnly: true }); return r.miss ? null : (r.json || null); };

const playlists = db.prepare("SELECT id FROM community_playlist").all();
const upd = db.prepare("UPDATE community_playlist SET viewCount=? WHERE id=?");
let scanned = 0, miss = 0, noViews = 0, set = 0;

for (const pl of playlists) {
  const j = await browse({ browseId: "VL" + pl.id });
  if (!j) { miss++; if (++scanned % 200 === 0) console.log(`  …scanned ${scanned}/${playlists.length}, set ${set}`); continue; }
  const v = parsePlaylistPage(j).viewCount;
  if (v == null) noViews++;                                      // header had no parseable "N views" — leave as-is
  else { if (DRY) set++; else set += upd.run(v, pl.id).changes; }
  if (++scanned % 200 === 0) console.log(`  …scanned ${scanned}/${playlists.length}, set ${set}`);
}
console.log(`scanned ${scanned} playlists (${miss} cache-miss, ${noViews} no parseable views); ${DRY ? "would set" : "set"} viewCount on ${set}`);
