// Offline benchmark (ZERO network) — proves the Hebrew-aware fuzzy index beats the app's current
// search over the SAME whitelisted corpus. Baseline = the app's real behavior: DatabaseDao.searchSongs
// does `title LIKE '%query%'` on the raw title (case-insensitive), then whitelist-filters. We replicate
// that exactly and compare recall@5.
//
//   node bench/bench.mjs
import { buildIndex, search } from "../index/search.mjs";
import { openCorpus, allTracks } from "../corpus/store.mjs";

const tracks = allTracks(openCorpus());
const index = buildIndex(tracks);
const K = 5;

// The app's CURRENT search, faithfully: raw case-insensitive substring on title (+ the corpus is
// already the whitelisted set, matching filterWhitelisted).
function likeSearch(query) {
  const q = query.toLowerCase();
  return tracks.filter((t) => t.title.toLowerCase().includes(q)).slice(0, K);
}
const idHit = (results, videoId) => results.slice(0, K).some((r) => (r.track ? r.track.videoId : r.videoId) === videoId);
const wantHit = (results, want) => results.slice(0, K).some((r) => want(r.track ? r.track : r));

// Deterministic realistic typo: transpose the two characters straddling the middle of the title.
function transposeTypo(s) {
  const chars = [...s];
  if (chars.length < 4) return s;
  const i = Math.floor(chars.length / 2);
  [chars[i - 1], chars[i]] = [chars[i], chars[i - 1]];
  return chars.join("");
}

// ---- Test 1: typo robustness on an evenly-sampled slice (fast at any corpus size) ------------------
const SAMPLE = Math.min(800, tracks.length);
const step = Math.max(1, Math.floor(tracks.length / SAMPLE));
let idxHits = 0, likeHits = 0, n = 0;
for (let i = 0; i < tracks.length; i += step) {
  const t = tracks[i];
  const q = transposeTypo(t.title);
  if (q === t.title) continue;
  n++;
  if (idHit(search(index, q, K), t.videoId)) idxHits++;
  if (idHit(likeSearch(q), t.videoId)) likeHits++;
}
console.log("=== Test 1: typo robustness (1 transposition), recall@5 — evenly-sampled ===");
console.log(`  corpus: ${tracks.length} tracks   sampled queries: ${n}`);
console.log(`  app LIKE search:   ${likeHits}/${n}  (${(100 * likeHits / n).toFixed(0)}%)`);
console.log(`  fuzzy index:       ${idxHits}/${n}  (${(100 * idxHits / n).toFixed(0)}%)`);

// ---- Test 2: cross-script romanized queries (curated from the real harvested artists) --------------
// A user types Latin; the content is Hebrew. These are real queries a user would type for artists/titles
// present in the harvested corpus. `want` confirms the right artist/title came back.
const has = (s) => (t) => (t.artistName + " " + t.title).includes(s);
const cross = [
  { q: "dudi polak",       want: has("דודי פולק") },
  { q: "kevakarat",        want: has("כבקרת") },
  { q: "natanel zelevski", want: has("נתנאל זלבסקי") },
  { q: "binyamin",         want: has("בנימין") },
  { q: "morasha kollel",   want: has("Morasha Kollel") },
  { q: "chana",            want: has("Chana") },
];
console.log("\n=== Test 2: cross-script romanized queries (Latin query → Hebrew content), top-5 ===");
let cIdx = 0, cLike = 0;
for (const c of cross) {
  const i = wantHit(search(index, c.q, K), c.want);
  const l = wantHit(likeSearch(c.q), c.want);
  if (i) cIdx++; if (l) cLike++;
  const top = search(index, c.q, 1)[0];
  console.log(`  "${c.q}"  index:${i ? "HIT " : "miss"}  like:${l ? "HIT " : "miss"}   top→ ${top ? `${top.track.artistName} — ${top.track.title}`.slice(0, 60) : "(none)"}`);
}
console.log(`  cross-script recall:  app LIKE ${cLike}/${cross.length}   fuzzy index ${cIdx}/${cross.length}`);

// ---- Size of the on-device subset (the "least MB" check) --------------------------------------------
const compact = tracks.map((t) => [t.videoId, t.title, t.artistId, t.isVideo ? 1 : 0]);
const raw = Buffer.byteLength(JSON.stringify(compact));
import("node:zlib").then(({ gzipSync }) => {
  const gz = gzipSync(JSON.stringify(compact)).length;
  console.log(`\n=== On-device subset size (this ${tracks.length}-track corpus, compact [id,title,artistId,isVideo]) ===`);
  console.log(`  raw ${(raw / 1024).toFixed(1)} KB   gzipped ${(gz / 1024).toFixed(1)} KB   = ${(gz / tracks.length).toFixed(1)} bytes/track gz`);
  console.log(`  → extrapolated to a 100k-track subset: ~${(gz / tracks.length * 100000 / 1024 / 1024).toFixed(1)} MB gzipped`);
});
