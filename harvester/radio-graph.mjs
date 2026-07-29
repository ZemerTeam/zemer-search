// zemer-search — search engine and more for the Zemer app
// https://github.com/ZemerTeam/zemer-search
// Zemer app: https://github.com/ZemerTeam/zemer-app
// Copyright (C) 2026 alltechdev
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See the LICENSE file for details.

// Fetch the aggregated co-occurrence graph from zemer-stats (GET /radio-graph, STATS_KEY-gated) and write
// the corpus-INTERSECTED artifact `data/radio-graph.json` (gitignored) that powers /radio. zemer-stats owns
// the telemetry and returns only aggregated {pop, lib, sess} neighbor lists (no device data — see
// store.radioGraph there); THIS step drops every id (seed key or neighbor) not in the current corpus, so a
// de-whitelisted or never-harvested track can never surface in radio (same whitelist-purity rule as /playlist).
//
// Fail-safe: a down/empty/short graph leaves the existing artifact untouched (radio keeps its last-good graph;
// with no artifact at all the engine falls back to same-artist + popularity). No-op when unchanged.
//
//   STATS_URL=… STATS_KEY=… node harvester/radio-graph.mjs        # DRY=1 previews (no write)
import fs from "node:fs";
import { openCorpus, allTracks, RADIO_GRAPH_PATH } from "../corpus/store.mjs";

const STATS_URL = (process.env.STATS_URL || "").replace(/\/+$/, "");
const STATS_KEY = process.env.STATS_KEY || "";
const DRY = process.env.DRY === "1";
const die = (m) => { console.error(m); process.exit(1); };
if (!STATS_URL || !STATS_KEY) die("STATS_URL and STATS_KEY must be set (see .env) — refusing to run.");

async function fetchGraph() {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 60000); // the graph compute can take a few seconds server-side
  try {
    const res = await fetch(`${STATS_URL}/radio-graph?key=${encodeURIComponent(STATS_KEY)}`, { signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

let g;
try { g = await fetchGraph(); }
catch (e) { console.error(`radio-graph: fetch FAILED (${e.message}) — leaving existing artifact untouched`); process.exit(0); }
if (!g || typeof g !== "object" || !g.pop || !g.lib) { console.error("radio-graph: empty/short response — leaving existing artifact untouched"); process.exit(0); }

// Corpus intersection — the whitelist authority lives here, not in zemer-stats.
const db = openCorpus();
const inCorpus = new Set(allTracks(db).map((t) => t.videoId));
const keepList = (arr) => (arr || []).filter(([id]) => inCorpus.has(id));
const pop = {}; for (const id of Object.keys(g.pop)) if (inCorpus.has(id)) pop[id] = g.pop[id];
const lib = {}, sess = {};
for (const id of Object.keys(g.lib)) { if (!inCorpus.has(id)) continue; const n = keepList(g.lib[id]); if (n.length) lib[id] = n; }
for (const id of Object.keys(g.sess)) { if (!inCorpus.has(id)) continue; const n = keepList(g.sess[id]); if (n.length) sess[id] = n; }
// artist-level graph (the coverage tier) — intersect against the corpus ARTIST roster the same way
const inArtists = new Set(db.prepare("SELECT id FROM artist").all().map((r) => r.id));
const art = {};
for (const id of Object.keys(g.art || {})) { if (!inArtists.has(id)) continue; const n = (g.art[id] || []).filter(([a]) => inArtists.has(a)); if (n.length) art[id] = n; }

const out = { builtAt: g.builtAt || Date.now(), source: "zemer-stats", devices: g.devices ?? null, pop, lib, sess, art };
const libN = Object.keys(lib).length, sessN = Object.keys(sess).length, popN = Object.keys(pop).length;
console.log(`radio-graph: corpus-intersected — pop ${popN} (was ${Object.keys(g.pop).length}), lib seeds ${libN} (was ${Object.keys(g.lib).length}), sess seeds ${sessN}, artist seeds ${Object.keys(art).length}`);
if (!popN || !libN) { console.error("radio-graph: nothing survived corpus intersection — leaving existing artifact untouched"); process.exit(0); }

const nextJson = JSON.stringify(out);
let prev = ""; try { prev = fs.readFileSync(RADIO_GRAPH_PATH, "utf8"); } catch { /* none */ }
// compare ignoring builtAt (and trailing whitespace — the file is written with a trailing "\n") so an
// unchanged graph is a genuine no-op (no needless mtime bump → no needless API index reload)
const strip = (s) => s.replace(/"builtAt":\d+,?/, "").trim();
if (strip(prev) === strip(nextJson)) { console.log("radio-graph: unchanged — no write"); process.exit(0); }
if (DRY) { console.log("radio-graph: DRY=1 — would write", (nextJson.length / 1024 / 1024).toFixed(2), "MB"); process.exit(0); }

const tmp = RADIO_GRAPH_PATH + ".tmp";
fs.writeFileSync(tmp, nextJson + "\n");
fs.renameSync(tmp, RADIO_GRAPH_PATH); // atomic swap — the API reload never reads a half-written file
console.log(`radio-graph: wrote ${RADIO_GRAPH_PATH} (${(nextJson.length / 1024 / 1024).toFixed(2)} MB)`);
