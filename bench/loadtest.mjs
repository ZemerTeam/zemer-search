// zemer-search — search engine and more for the Zemer app
// https://github.com/ZemerTeam/zemer-search
// Zemer app: https://github.com/ZemerTeam/zemer-app
// Copyright (C) 2026 alltechdev
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See the LICENSE file for details.

// Concurrent load test against a running API — simulates realistic as-you-type traffic (every growing
// prefix of popular queries, so the LRU cache gets exercised like real users typing).
//   node bench/loadtest.mjs [totalRequests] [concurrency]     (API=http://host:port to override)
const TOTAL = Number(process.argv[2] || 20000);
const CONC = Number(process.argv[3] || 200);
const BASE = process.env.API || "http://localhost:7700";

const terms = ["kevakarat", "avraham fried", "mordechai ben david", "yaakov", "dudi polak", "shir",
  "hallel", "simcha", "chaim", "baruch levine", "yoni", "lev tahor", "ein keloheinu", "hamalach"];
const queries = [];
for (const t of terms) for (let n = 2; n <= t.length; n++) queries.push(t.slice(0, n)); // each keystroke

let next = 0, ok = 0, err = 0, sum = 0, max = 0;
const t0 = performance.now();
async function worker() {
  while (true) {
    const i = next++;
    if (i >= TOTAL) return;
    const q = process.env.UNIQUE === "1" ? queries[i % queries.length] + " " + i : queries[i % queries.length]; // UNIQUE=1 → all cache misses (worst case)
    const s = performance.now();
    try { const r = await fetch(`${BASE}/search?q=${encodeURIComponent(q)}`); await r.text(); r.ok ? ok++ : err++; }
    catch { err++; }
    const ms = performance.now() - s; sum += ms; if (ms > max) max = ms;
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
const secs = (performance.now() - t0) / 1000;
console.log(`${BASE}  ${TOTAL} reqs @ concurrency ${CONC} → ${(TOTAL / secs).toFixed(0)} req/s | avg ${(sum / TOTAL).toFixed(2)}ms | max ${max.toFixed(0)}ms | ok ${ok} err ${err} | ${secs.toFixed(1)}s`);
