// zemer-search — search engine and more for the Zemer app
// https://github.com/ZemerTeam/zemer-search
// Zemer app: https://github.com/ZemerTeam/zemer-app
// Copyright (C) 2026 alltechdev
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See the LICENSE file for details.

// Apply data/track-energy.json → track.energy (0..1 acoustic INTENSITY: mellow ↔ driving).
//
// Energy measures how driving a recording is, NOT how fast it is — never present or use it as tempo.
// It is trusted because it passed validation against evidence independent of the field itself (see
// gotcha #23 for the tests, including a permutation null and an album-coherence check).
//
// Bindings come from PROVEN album pairs (gotcha #22) with a strict 1-second per-song duration match, so a
// value cannot drift onto a different cut of the same song. Idempotent, replace-wholesale; DRY=1 previews.
//
//   node harvester/track-energy.mjs        # apply
//   DRY=1 node harvester/track-energy.mjs  # preview only
import fs from "node:fs";
import { openCorpus, TRACK_ENERGY_PATH } from "../corpus/store.mjs";

const DRY = process.env.DRY === "1";
let doc;
try { doc = JSON.parse(fs.readFileSync(TRACK_ENERGY_PATH, "utf8")); }
catch { console.log(`track-energy: no ${TRACK_ENERGY_PATH} — nothing to apply`); process.exit(0); }
const items = Array.isArray(doc) ? doc : (doc.items || []);
if (!items.length) { console.log("track-energy: file has no items — nothing to apply"); process.exit(0); }

const db = openCorpus();
const known = new Set(db.prepare("SELECT videoId FROM track").all().map((r) => r.videoId));
const upd = db.prepare("UPDATE track SET energy=? WHERE videoId=? AND (energy IS NULL OR energy<>?)");
// Replace-wholesale: the JSON is the source of truth, so a song it no longer lists must lose its value —
// otherwise a tightened derivation leaves a stale number behind.
const keep = items.map((it) => it?.videoId).filter(Boolean);
const clr = db.prepare("UPDATE track SET energy=NULL WHERE energy IS NOT NULL AND videoId NOT IN (SELECT value FROM json_each(?))");
let changed = 0, missing = 0, skipped = 0, cleared = 0;
db.transaction(() => {
  if (!DRY) cleared = clr.run(JSON.stringify(keep)).changes;
  for (const it of items) {
    const v = it?.videoId, e = it?.energy;
    if (!v || typeof e !== "number" || !(e >= 0 && e <= 1)) { skipped++; continue; } // out-of-range = bug, never stored
    if (!known.has(v)) { missing++; continue; }
    if (!DRY) changed += upd.run(e, v, e).changes;
  }
})();
const have = db.prepare("SELECT COUNT(*) c FROM track WHERE energy IS NOT NULL").get().c;
db.close();
console.log(`track-energy: ${items.length} in file | ${DRY ? "would update" : `updated ${changed}, cleared ${cleared}`} | not in corpus ${missing} | malformed ${skipped} | tracks carrying energy: ${have}`);
