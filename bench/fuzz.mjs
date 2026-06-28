// Comprehensive bug-hunt — maximum input variation, random diverse entities (NOT hand-picked).
// Probes: (1) crashes on weird input, (2) recall — searching a random entity's FULL name must find it,
// with extra focus on names containing special chars (' ׳ ״ & ( ) - . digits), (3) false positives,
// (4) category integrity. Reports concrete anomalies. Run: node bench/fuzz.mjs
import { buildCategories, searchCategories } from "../index/categories.mjs";
import { plainTokens, skeletonTokens, damerau } from "../index/normalize.mjs";
import { openCorpus, allTracks, allArtists, allAlbums, allPlaylists } from "../corpus/store.mjs";

const db = openCorpus();
const tracks = allTracks(db), artists = allArtists(db), albums = allAlbums(db), playlists = allPlaylists(db);
const cats = buildCategories({ tracks, artists, albums, playlists });

// ---- 1. crash fuzzing — none of these may throw ----
const weird = ["", " ", "   ", "'", '"', "()", "&", "-", "--", ".", "!@#$%^", "a".repeat(600),
  "🎵🎶🔥", "‏‎", "\t\n\r", "123", "0", "?", "*", "[]{}", "\\/", "feat.", "(live)",
  "ג'רופי", "חג׳בי", "8th day", "vol 2", "ben-zion", "o'connor", "r' shlomo", "מ\"", "א" , "  shir  ",
  "SHIR", "ShIr", "001", "%20", "null", "undefined", "<script>", "א ב ג ד ה"];
let crashes = 0;
for (const q of weird) {
  try { searchCategories(cats, q, { k: 5 }); }
  catch (e) { crashes++; console.log(`  ✗ CRASH on ${JSON.stringify(q)}: ${e.message}`); }
}
console.log(`1. crash fuzz: ${crashes} crashes over ${weird.length} weird inputs`);

// ---- 2. recall — random diverse entities; full name must be found ----
const idOf = { artists: (x) => x.id, albums: (x) => x.id, singles: (x) => x.id, songs: (x) => x.videoId };
function recall(label, items, catKey, nameKey, want, n = 250) {
  const step = Math.max(1, Math.floor(items.length / n));
  let total = 0, miss = 0, missSpecial = 0, totalSpecial = 0;
  const shown = [];
  for (let i = 0; i < items.length; i += step) {
    const e = items[i], name = e[nameKey];
    if (!name || !plainTokens(name).length) continue;
    const special = /['’׳״&()\-.\d]/.test(name);
    total++; if (special) totalSpecial++;
    const found = (searchCategories(cats, name, { k: 25 })[catKey] || []).some((x) => idOf[catKey](x) === want(e));
    if (!found) { miss++; if (special) missSpecial++; if (shown.length < 8) shown.push(name.slice(0, 40)); }
  }
  console.log(`2. ${label.padEnd(8)} full-name recall: ${(100 * (total - miss) / total).toFixed(1)}%  (${miss}/${total} miss; special-char ${totalSpecial - missSpecial}/${totalSpecial})`);
  if (shown.length) console.log(`     misses: ${shown.join("  |  ")}`);
}
recall("artists", artists, "artists", "name", (e) => e.id);
recall("albums", albums.filter((a) => a.type !== "single"), "albums", "title", (e) => e.id);
recall("singles", albums.filter((a) => a.type === "single"), "singles", "title", (e) => e.id);
// songs & videos checked against THEIR OWN category (a live video is in 'videos', not 'songs').
{
  const step = Math.max(1, Math.floor(tracks.length / 300));
  let total = 0, miss = 0; const shown = [];
  for (let i = 0; i < tracks.length; i += step) {
    const t = tracks[i]; if (!plainTokens(t.title).length) continue; total++;
    const found = (searchCategories(cats, t.title, { k: 25 })[t.isVideo ? "videos" : "songs"] || []).some((x) => x.videoId === t.videoId);
    if (!found) { miss++; if (shown.length < 8) shown.push((t.isVideo ? "[V]" : "[S]") + t.title.slice(0, 36)); }
  }
  console.log(`2. ${"songs+vid".padEnd(8)} full-title recall: ${(100 * (total - miss) / total).toFixed(1)}%  (${miss}/${total} miss)`);
  if (shown.length) console.log(`     misses: ${shown.join("  |  ")}`);
}

// ---- 3. false positives across random + special-char queries ----
const genuine = (q, text) => {
  const qp = plainTokens(q), qs = skeletonTokens(q).filter((t) => t.length >= 3), tp = plainTokens(text), ts = skeletonTokens(text);
  for (const a of qp) for (const t of tp) { if (t.startsWith(a) || a.startsWith(t)) return true; if (a.length >= 3 && t.length >= 3 && Math.abs(a.length - t.length) <= 1 && damerau(a, t, 1) <= 1) return true; }
  for (const a of qs) for (const t of ts) if (t.startsWith(a) || a.startsWith(t)) return true;
  return false;
};
const special = [...artists, ...albums].filter((e) => /['’׳״&()]/.test(e.name || e.title)).filter((_, i) => i % 7 === 0).slice(0, 120);
let fp = 0, fpN = 0;
for (const e of special) {
  const q = e.name || e.title;
  const r = searchCategories(cats, q, { k: 8 });
  for (const items of Object.values(r)) for (const it of items) { fpN++; const text = `${it.name || it.title || ""} ${it.artist || ""}`; if (!genuine(q, text)) { fp++; if (fp <= 6) console.log(`  ⚠ FP for ${JSON.stringify(q.slice(0,24))}: ${text.slice(0,34)}`); } }
}
console.log(`3. false positives on special-char queries: ${fp} / ${fpN}`);

// ---- 4. category integrity — each result has the right shape for its category ----
let bad = 0;
const probe = ["shir", "avraham", "yeshiva", "chasunah", "nigun", " ", "live", "kol"];
for (const q of probe) {
  const r = searchCategories(cats, q, { k: 6 });
  for (const s of [...(r.songs || []), ...(r.videos || [])]) if (!s.videoId) bad++;
  for (const a of [...(r.artists || [])]) if (!a.id || a.videoId) bad++;
  for (const a of [...(r.albums || []), ...(r.singles || [])]) if (!a.id || a.videoId) bad++;
}
console.log(`4. category integrity: ${bad} mis-shaped results`);
db.close();
