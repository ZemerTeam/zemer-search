// zemer-search — search engine and more for the Zemer app
// https://github.com/ZemerTeam/zemer-search
// Zemer app: https://github.com/ZemerTeam/zemer-app
// Copyright (C) 2026 alltechdev
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See the LICENSE file for details.

// Diagnose the typo-test misses: is the index actually wrong, or did it return a DIFFERENT upload of the
// SAME song (a corpus duplicate), which the exact-videoId metric unfairly counts as a miss?
import { buildIndex, search } from "../index/search.mjs";
import { plainTokens } from "../index/normalize.mjs";
import { openCorpus, allTracks } from "../corpus/store.mjs";

const tracks = allTracks(openCorpus());
const index = buildIndex(tracks);
const norm = (s) => plainTokens(s).join(" ");

function transposeTypo(s) {
  const c = [...s]; if (c.length < 4) return s;
  const i = Math.floor(c.length / 2); [c[i - 1], c[i]] = [c[i], c[i - 1]]; return c.join("");
}

let exact = 0, sameTitle = 0, genuineMiss = 0, n = 0;
const misses = [];
for (const t of tracks) {
  const q = transposeTypo(t.title); if (q === t.title) continue; n++;
  const top = search(index, q, 5).map((r) => r.track);
  if (top.some((x) => x.videoId === t.videoId)) { exact++; continue; }
  if (top.some((x) => norm(x.title) === norm(t.title))) { sameTitle++; continue; } // same song, different upload
  genuineMiss++;
  if (misses.length < 12) misses.push({ true: t.title, top1: top[0]?.title ?? "(none)" });
}
console.log(`typo queries: ${n}`);
console.log(`  exact videoId in top-5:            ${exact}  (${(100 * exact / n).toFixed(1)}%)`);
console.log(`  same SONG, different upload:        ${sameTitle}  (${(100 * sameTitle / n).toFixed(1)}%)  ← also correct`);
console.log(`  → effective recall (right song):    ${exact + sameTitle}/${n}  (${(100 * (exact + sameTitle) / n).toFixed(1)}%)`);
console.log(`  genuine misses:                     ${genuineMiss}  (${(100 * genuineMiss / n).toFixed(1)}%)`);
if (misses.length) {
  console.log("\n  sample genuine misses (true title → top-1 returned):");
  for (const m of misses) console.log(`   • ${m.true.slice(0, 44).padEnd(44)} → ${m.top1.slice(0, 44)}`);
}
