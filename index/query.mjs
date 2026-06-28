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
