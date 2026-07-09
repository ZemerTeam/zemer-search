// zemer-search — search engine and more for the Zemer app
// https://github.com/ZemerTeam/zemer-search
// Zemer app: https://github.com/ZemerTeam/zemer-app
// Copyright (C) 2026 alltechdev
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See the LICENSE file for details.

// CLI to query the in-memory index over the harvested corpus (the on-device fallback algorithm).
//   node index/query.mjs "dudi polak kevakarat"
import { performance } from "node:perf_hooks";
import { buildIndex, search } from "./search.mjs";
import { loadDefaultSynonyms } from "./synonyms.mjs";
import { openCorpus, allTracks } from "../corpus/store.mjs";

const q = process.argv.slice(2).join(" ").trim();
if (!q) { console.error('usage: node index/query.mjs "<query>"'); process.exit(1); }

const tracks = allTracks(openCorpus());
const t0 = performance.now();
const index = buildIndex(tracks, loadDefaultSynonyms());
const tBuild = performance.now();
const res = search(index, q, 10);
const tSearch = performance.now();

console.log(`"${q}" → ${res.length} hits  (corpus ${tracks.length} tracks; index built ${(tBuild - t0).toFixed(0)}ms; search ${(tSearch - tBuild).toFixed(1)}ms)\n`);
for (const r of res) {
  console.log(`  [${String(r.score).padStart(3)}] ${r.track.artistName} — ${r.track.title}`.slice(0, 100) + `  ${r.track.videoId}`);
}
