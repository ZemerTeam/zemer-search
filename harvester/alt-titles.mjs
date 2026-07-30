// zemer-search — search engine and more for the Zemer app
// https://github.com/ZemerTeam/zemer-search
// Zemer app: https://github.com/ZemerTeam/zemer-app
// Copyright (C) 2026 alltechdev
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See the LICENSE file for details.

// Apply data/alt-titles.json → track.altTitle: a song's title in the OTHER script (Hebrew ⇄ romanized),
// indexed by the matcher as a second searchable title so a Hebrew query finds a romanized-titled song and
// vice-versa (the artist-level equivalent is artist.altName, which rides the whitelist instead).
//
// The JSON is the durable source of truth — the harvest can never produce this field (a browse page shows
// exactly one title), so the track upsert deliberately leaves altTitle untouched and this step re-applies
// it. Idempotent: re-running writes nothing when unchanged. DRY=1 previews.
//
//   node harvester/alt-titles.mjs        # apply
//   DRY=1 node harvester/alt-titles.mjs  # preview only
import fs from "node:fs";
import { openCorpus, ALT_TITLES_PATH } from "../corpus/store.mjs";

const DRY = process.env.DRY === "1";
let doc;
try { doc = JSON.parse(fs.readFileSync(ALT_TITLES_PATH, "utf8")); }
catch { console.log(`alt-titles: no ${ALT_TITLES_PATH} — nothing to apply`); process.exit(0); }
const items = Array.isArray(doc) ? doc : (doc.items || []);
if (!items.length) { console.log("alt-titles: file has no items — nothing to apply"); process.exit(0); }

const db = openCorpus();
const known = new Set(db.prepare("SELECT videoId FROM track").all().map((r) => r.videoId));
const upd = db.prepare("UPDATE track SET altTitle=? WHERE videoId=? AND (altTitle IS NULL OR altTitle<>?)");
let changed = 0, missing = 0, skipped = 0;
const apply = db.transaction(() => {
  for (const it of items) {
    const v = it?.videoId, t = it?.altTitle;
    if (!v || !t || typeof t !== "string" || !t.trim()) { skipped++; continue; }
    if (!known.has(v)) { missing++; continue; } // not in the corpus (yet) — nothing to attach it to
    if (!DRY) changed += upd.run(t, v, t).changes;
  }
});
apply();
const have = db.prepare("SELECT COUNT(*) c FROM track WHERE altTitle IS NOT NULL").get().c;
db.close();
console.log(`alt-titles: ${items.length} in file | ${DRY ? "would update" : "updated"} ${DRY ? "-" : changed} | not in corpus ${missing} | malformed ${skipped} | total tracks carrying one: ${have}`);
