// zemer-search — search engine and more for the Zemer app
// https://github.com/ZemerTeam/zemer-search
// Zemer app: https://github.com/ZemerTeam/zemer-search
// Copyright (C) 2026 alltechdev
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See the LICENSE file for details.

// Apply data/song-genres.json → track.genres (comma-separated Zemer style slugs).
//
// WHY ALBUM-ANCHORED: a genre is a property of a RELEASE, and album identity is the only thing that
// distinguishes an acapella cut from the regular one — both run the same length, so duration cannot.
// Each genre therefore rides an album↔album identification (unique artist+title, corroborated by ≥2
// member tracks agreeing on name AND duration), never a bare track guess.
//
// The harvest can never produce this field (browse pages carry no genre), so the track upsert leaves the
// column alone and this step re-applies it from the durable JSON. Idempotent; DRY=1 previews.
//
//   node harvester/song-genres.mjs        # apply
//   DRY=1 node harvester/song-genres.mjs  # preview only
import fs from "node:fs";
import { openCorpus, SONG_GENRES_PATH } from "../corpus/store.mjs";

const DRY = process.env.DRY === "1";
const SLUGS = new Set(["acapella", "chasidish", "yiddish", "israeli", "english", "mizrachi", "yemenite",
  "chazzanus", "carlebach", "instrumental", "dance", "calm", "kids", "wedding"]);
let doc;
try { doc = JSON.parse(fs.readFileSync(SONG_GENRES_PATH, "utf8")); }
catch { console.log(`song-genres: no ${SONG_GENRES_PATH} — nothing to apply`); process.exit(0); }
const items = Array.isArray(doc) ? doc : (doc.items || []);
if (!items.length) { console.log("song-genres: file has no items — nothing to apply"); process.exit(0); }

const db = openCorpus();
const known = new Set(db.prepare("SELECT videoId FROM track").all().map((r) => r.videoId));
const upd = db.prepare("UPDATE track SET genres=? WHERE videoId=? AND (genres IS NULL OR genres<>?)");
let changed = 0, missing = 0, skipped = 0;
db.transaction(() => {
  for (const it of items) {
    const v = it?.videoId;
    const gs = (it?.genres || []).filter((g) => SLUGS.has(g)).sort(); // unknown slug = data error, dropped
    if (!v || !gs.length) { skipped++; continue; }
    if (!known.has(v)) { missing++; continue; }
    if (!DRY) changed += upd.run(gs.join(","), v, gs.join(",")).changes;
  }
})();
const have = db.prepare("SELECT COUNT(*) c FROM track WHERE genres IS NOT NULL").get().c;
db.close();
console.log(`song-genres: ${items.length} in file | ${DRY ? "would update" : `updated ${changed}`} | not in corpus ${missing} | malformed ${skipped} | tracks carrying genres: ${have}`);
