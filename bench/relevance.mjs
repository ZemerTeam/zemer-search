// Relevance benchmark — measures RANKING quality, not just recall. For a deterministic sample of tracks
// it generates realistic queries (exact title, title prefix, artist+title, typo) and measures how often
// the source track lands at rank 1 / within top 3, plus Mean Reciprocal Rank. Also runs curated
// cross-script / partial queries that assert the TOP result is correct. Higher = better matching.
//
//   node bench/relevance.mjs
import { buildIndex, search } from "../index/search.mjs";
import { plainTokens } from "../index/normalize.mjs";
import { openCorpus, allTracks } from "../corpus/store.mjs";

const tracks = allTracks(openCorpus());
const index = buildIndex(tracks);

const rankOf = (q, videoId, k = 10) => {
  const r = search(index, q, k);
  const i = r.findIndex((x) => x.track.videoId === videoId);
  return i === -1 ? Infinity : i + 1;
};
const transpose = (s) => { const c = [...s]; if (c.length < 4) return s; const i = c.length >> 1; [c[i - 1], c[i]] = [c[i], c[i - 1]]; return c.join(""); };

// ---- round-trip ranking over a sample ----
const SAMPLE = Math.min(600, tracks.length);
const step = Math.max(1, Math.floor(tracks.length / SAMPLE));
const kinds = {
  "exact title":   (t) => t.title,
  "title prefix":  (t) => plainTokens(t.title).slice(0, 2).join(" "),
  "artist+title":  (t) => `${t.artistName} ${plainTokens(t.title)[0] || ""}`,
  "title typo":    (t) => transpose(t.title),
};
const agg = {};
for (const name of Object.keys(kinds)) agg[name] = { n: 0, p1: 0, p3: 0, mrr: 0 };

for (let i = 0; i < tracks.length; i += step) {
  const t = tracks[i];
  if (plainTokens(t.title).length === 0) continue;
  for (const [name, mk] of Object.entries(kinds)) {
    const q = (mk(t) || "").trim();
    if (!q) continue;
    const r = rankOf(q, t.videoId);
    const a = agg[name]; a.n++;
    if (r === 1) a.p1++;
    if (r <= 3) a.p3++;
    a.mrr += r === Infinity ? 0 : 1 / r;
  }
}

console.log(`=== Ranking over ${agg["exact title"].n} sampled tracks (corpus ${tracks.length}) ===`);
console.log("query kind        P@1     P@3     MRR");
for (const [name, a] of Object.entries(agg))
  console.log(`  ${name.padEnd(15)} ${(100 * a.p1 / a.n).toFixed(1).padStart(5)}%  ${(100 * a.p3 / a.n).toFixed(1).padStart(5)}%  ${(a.mrr / a.n).toFixed(3)}`);

// ---- curated "what a human types" — the TOP result must be the right artist/title ----
const has = (s) => (t) => (t.artistName + " " + t.title).includes(s);
const curated = [
  { q: "dudi polak",       want: has("דודי פולק") },
  { q: "kevakarat",        want: has("כבקרת") },
  { q: "avraham fried",    want: has("Avraham Fried") },
  { q: "yaakov shwekey",   want: (t) => /shwekey|שwekey|שווקי/i.test(t.artistName) },
  { q: "mordechai ben david", want: (t) => /ben david|בן דוד/i.test(t.artistName) },
];
let top1 = 0, considered = 0;
console.log(`\n=== Curated top-result correctness ===`);
for (const c of curated) {
  const r = search(index, c.q, 5);
  if (!r.length) { console.log(`  "${c.q}" → (no results)`); continue; }
  considered++;
  const ok = c.want(r[0].track);
  if (ok) top1++;
  console.log(`  "${c.q}" → ${ok ? "OK  " : "MISS"}  top: ${r[0].track.artistName} — ${r[0].track.title}`.slice(0, 86));
}
console.log(`  curated P@1: ${top1}/${considered}`);
