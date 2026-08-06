// zemer-search — search engine and more for the Zemer app
// https://github.com/ZemerTeam/zemer-search
// Zemer app: https://github.com/ZemerTeam/zemer-app
// Copyright (C) 2026 alltechdev
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See the LICENSE file for details.

// Apply data/podcast-genres.json → podcast_show.genres (comma-separated Zemer style slugs). The podcast
// analog of harvester/song-genres.mjs. Genre is a property of the SHOW, not the publisher channel (a channel
// hosts multiple genres — same reason music genre is a release property, not an artist one). The harvest can
// never produce this field, so the durable JSON is the single source of truth and this re-applies it;
// REPLACE-WHOLESALE (a show dropped from the JSON loses its genres). Idempotent; DRY=1 previews.
//
//   node harvester/podcast-genres.mjs        # apply
//   DRY=1 node harvester/podcast-genres.mjs  # preview only
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openCorpus } from "../corpus/store.mjs";
import { ensurePodcastSchema, applyPodcastGenres } from "../corpus/podcasts.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.env.PODCAST_GENRES || path.resolve(HERE, "../data/podcast-genres.json");
const DRY = process.env.DRY === "1";

// The podcast genre vocabulary — a slug outside this set is dropped and reported as malformed (never written).
export const PODCAST_GENRE_SLUGS = new Set([
  "gemara", "parsha", "chassidus", "mussar", "halacha", "machshava", "tefilla", "stories", "history",
  "kiruv", "family", "parnassah", "health", "news", "people", "music", "chizuk", "shiur", "moadim", "women",
]);

let doc;
try { doc = JSON.parse(fs.readFileSync(FILE, "utf8")); }
catch { console.log(`podcast-genres: no ${FILE} — nothing to apply`); process.exit(0); }
const shows = doc.shows || [];
if (!shows.length) { console.log("podcast-genres: file has no shows — nothing to apply"); process.exit(0); }

const map = {}; const malformed = new Set(); let withGenres = 0;
for (const s of shows) {
  if (!s?.id) continue;
  const good = (s.genres || []).filter((g) => { if (PODCAST_GENRE_SLUGS.has(g)) return true; malformed.add(g); return false; });
  map[s.id] = good;
  if (good.length) withGenres++;
}

const counts = {};
for (const g of Object.values(map)) for (const s of g) counts[s] = (counts[s] || 0) + 1;
console.log(`podcast-genres: ${shows.length} shows, ${withGenres} with ≥1 genre${DRY ? " [DRY]" : ""}`);
console.log("distribution:", Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([g, n]) => `${g}:${n}`).join("  "));
if (malformed.size) console.log("⚠ MALFORMED slugs dropped (not in the vocabulary):", [...malformed].join(", "));
if (DRY) { console.log("\nDRY — no writes. Drop DRY=1 to apply (replace-wholesale)."); process.exit(0); }

const db = openCorpus();
ensurePodcastSchema(db);
const n = applyPodcastGenres(db, map);
const total = db.prepare(`SELECT COUNT(*) c FROM podcast_show WHERE genres IS NOT NULL`).get().c;
db.close();
console.log(`applied genres to ${n} shows (corpus now: ${total} shows carry genres).`);
