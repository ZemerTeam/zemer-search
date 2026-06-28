// Precision audit — runs a battery of diverse real queries and flags any returned result that has NO
// genuine textual connection to the query (i.e. a likely false positive): no result token prefixes,
// is-prefixed-by, typo-matches, or skeleton-matches a query token. Goal: zero suspicious results.
//   node bench/audit.mjs
import { buildCategories, searchCategories } from "../index/categories.mjs";
import { plainTokens, skeletonTokens, damerau } from "../index/normalize.mjs";
import { openCorpus, allTracks, allArtists, allAlbums, allPlaylists } from "../corpus/store.mjs";

const db = openCorpus();
const cats = buildCategories({ tracks: allTracks(db), artists: allArtists(db), albums: allAlbums(db), playlists: allPlaylists(db) });

const queries = [
  "avr", "shl", "ber", "yos", "men", "dav", "chai", "yid", "sim",          // short prefixes
  "avraham fried", "mordechai ben david", "lipa", "dudi polak", "shwekey",  // full names
  "kevakarat", "lecha dodi", "kol nidrei", "vehi sheamda", "adon olam",     // cross-script romanized
  "אברהם", "שבת", "כבקרת", "ירושלים",                                        // Hebrew
  "avrahm fried", "yoni gamermn", "mordehai", "kevakrat",                   // typos
  "qwertyuiop", "blarghnod", "xqzjkw",                                      // garbage (must be ~0)
];

function genuine(query, text) {
  const qp = plainTokens(query), qs = skeletonTokens(query).filter((t) => t.length >= 3);
  const tp = plainTokens(text), ts = skeletonTokens(text);
  for (const q of qp) for (const t of tp) {
    if (t.startsWith(q) || q.startsWith(t)) return true;
    if (q.length >= 3 && t.length >= 3 && Math.abs(q.length - t.length) <= 1 && damerau(q, t, 1) <= 1) return true;
  }
  for (const q of qs) for (const t of ts) if (t.startsWith(q) || q.startsWith(t)) return true;
  return false;
}

let totalSus = 0;
for (const query of queries) {
  const r = searchCategories(cats, query, { k: 8 });
  const all = [];
  for (const [cat, items] of Object.entries(r)) for (const it of items) all.push({ cat, text: `${it.name || it.title || ""} ${it.artist || ""}`.trim() });
  const sus = all.filter((x) => !genuine(query, x.text));
  totalSus += sus.length;
  const tag = sus.length ? `  ⚠ ${sus.length} SUSPICIOUS → ${sus.slice(0, 3).map((x) => `${x.cat}:${x.text.slice(0, 28)}`).join(" | ")}` : "";
  console.log(`"${query}"`.padEnd(24) + `${all.length} results${tag}`);
}
console.log(`\nTOTAL suspicious (false positives) across ${queries.length} queries: ${totalSus}`);
db.close();
