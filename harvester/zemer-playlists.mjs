// zemer-search — search engine and more for the Zemer app
// https://github.com/ZemerTeam/zemer-search
// Zemer app: https://github.com/ZemerTeam/zemer-app
// Copyright (C) 2026 alltechdev
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See the LICENSE file for details.

// Apply the Zemer-CURATED playlists file into corpus.db (offline — no network, runs anywhere).
//
//   data/zemer-playlists.json:
//     { "playlists": [ { "id": "shabbos", "title": "Shabbos", "videoIds": ["…"], "albumIds": ["MPRE…"] } ] }
//
// The JSON is the source of truth: every apply REPLACES the zemer_playlist tables wholesale (removing a
// playlist from the file removes it from the server). Album ids expand to their member tracks at read
// time, so a re-harvested album's new tracks appear without a re-apply. Writing corpus.db bumps its mtime,
// so the running API picks the change up on its next reload tick — no restart.
//
//   DRY=1 node harvester/zemer-playlists.mjs    # validate + report (incl. ids not in the corpus), no write
//   node harvester/zemer-playlists.mjs          # apply
import { openCorpus, loadZemerPlaylists, applyZemerPlaylists, ZEMER_PLAYLISTS_PATH } from "../corpus/store.mjs";

const DRY = process.env.DRY === "1";
const doc = loadZemerPlaylists();
console.log(`zemer-playlists: ${doc.playlists.length} playlist(s) in ${ZEMER_PLAYLISTS_PATH}${DRY ? "  [DRY]" : ""}`);
for (const p of doc.playlists)
  console.log(`  ${p.id} — "${p.title}"  (${(p.videoIds || []).length} track id(s) + ${(p.albumIds || []).length} album id(s))`);

const db = openCorpus();
const r = applyZemerPlaylists(db, doc, { dry: DRY });
if (r.missing.length) {
  console.warn(`\n⚠ ${r.missing.length} id(s) not in the corpus (typo, or not harvested yet — they serve nothing until they land):`);
  for (const m of r.missing) console.warn(`  ${m.playlist}: ${m.kind} ${m.id}`);
}
console.log(`\n${DRY ? "would apply" : "applied"}: ${r.playlists} playlist(s), ${r.items} item(s)${DRY ? "" : " → corpus.db (API reloads on its next tick)"}`);
