// Category + as-you-type relevance — measures whether searching an ARTIST / ALBUM / SINGLE name (full,
// typed-prefix, or typo) puts the right entity at rank 1 of its category, via the real searchCategories
// path the API uses. Also measures partial ("as you type") TRACK queries. Higher = better.
//
//   node bench/category-relevance.mjs
import { buildCategories, searchCategories } from "../index/categories.mjs";
import { openCorpus, allTracks, allArtists, allAlbums, allPlaylists } from "../corpus/store.mjs";
import { plainTokens } from "../index/normalize.mjs";

const db = openCorpus();
const tracks = allTracks(db), artists = allArtists(db), albums = allAlbums(db);
const cats = buildCategories({ tracks, artists, albums, playlists: allPlaylists(db) });

const rankIn = (list, id) => { const i = list.findIndex((x) => (x.id ?? x.videoId) === id); return i === -1 ? Infinity : i + 1; };
const prefixOf = (s) => { const n = Math.max(3, Math.ceil(s.length * 0.6)); return s.slice(0, n); }; // ~60%, mid-word
const transpose = (s) => { const c = [...s]; if (c.length < 4) return s; const i = c.length >> 1; [c[i - 1], c[i]] = [c[i], c[i - 1]]; return c.join(""); };
const sample = (arr, n) => { const step = Math.max(1, Math.floor(arr.length / n)); return arr.filter((_, i) => i % step === 0); };

function evalEntities(label, items, catKey, idKey) {
  const agg = { full1: 0, full3: 0, prefix1: 0, typo1: 0, n: 0 };
  for (const e of sample(items, 300)) {
    const name = e[idKey];
    if (!name || !plainTokens(name).length) continue;
    agg.n++;
    const cat = (q) => searchCategories(cats, q, { k: 10 })[catKey] || [];
    const rFull = rankIn(cat(name), e.id);
    if (rFull === 1) agg.full1++;
    if (rFull <= 3) agg.full3++;
    if (rankIn(cat(prefixOf(name)), e.id) === 1) agg.prefix1++;
    if (rankIn(cat(transpose(name)), e.id) === 1) agg.typo1++;
  }
  const p = (x) => `${(100 * x / agg.n).toFixed(1)}%`;
  console.log(`  ${label.padEnd(18)} n=${String(agg.n).padStart(4)}   full P@1 ${p(agg.full1)}  P@3 ${p(agg.full3)}   prefix P@1 ${p(agg.prefix1)}   typo P@1 ${p(agg.typo1)}`);
}

console.log(`=== Category accuracy (corpus: ${artists.length} artists, ${albums.length} albums) ===`);
evalEntities("artists", artists, "artists", "name");
evalEntities("albums (non-single)", albums.filter((a) => a.type !== "single"), "albums", "title");
evalEntities("singles", albums.filter((a) => a.type === "single"), "singles", "title");

// ---- as-you-type: a TITLE prefix truncated mid-word must surface the song ----
let n = 0, p1 = 0, p3 = 0;
for (const t of sample(tracks, 500)) {
  if (!plainTokens(t.title).length) continue;
  const partial = prefixOf(t.title);
  if (partial === t.title) continue;
  n++;
  const songs = searchCategories(cats, partial, { k: 10 }).songs || [];
  const r = rankIn(songs, t.videoId);
  if (r === 1) p1++;
  if (r <= 3) p3++;
}
console.log(`\n=== As-you-type: partial title prefix → song (n=${n}) ===`);
console.log(`  P@1 ${(100 * p1 / n).toFixed(1)}%   P@3 ${(100 * p3 / n).toFixed(1)}%`);
