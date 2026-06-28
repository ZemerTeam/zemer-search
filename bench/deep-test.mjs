// Deep correctness test — areas beyond recall/precision: content filtering, playlist ranking,
// begins>contains for EVERY category, synonyms, determinism. Reports issues. Run: node bench/deep-test.mjs
import { buildCategories, searchCategories } from "../index/categories.mjs";
import { plainTokens, skeletonKey } from "../index/normalize.mjs";
import { openCorpus, allTracks, allArtists, allAlbums, allPlaylists } from "../corpus/store.mjs";
import { loadDefaultSynonyms } from "../index/synonyms.mjs";

const db = openCorpus();
const tracks = allTracks(db), artists = allArtists(db), albums = allAlbums(db), playlists = allPlaylists(db);
const cats = buildCategories({ tracks, artists, albums, playlists }, loadDefaultSynonyms());
let issues = 0;

// 1. CONTENT FILTERING -----------------------------------------------------------------------------
{
  let bad = 0;
  for (const q of ["yoni", "avraham", "shir", "live", "simcha", "berko"]) if (searchCategories(cats, q, { blockVideos: true, k: 8 }).videos.length) bad++;
  console.log(`1a. blockVideos → videos empty: ${bad ? `✗ ${bad} queries still returned videos` : "✓"}`); issues += bad;

  const fem = artists.filter((a) => a.isFemale);
  let leaked = 0, present = 0;
  for (const a of fem.filter((_, i) => i % Math.max(1, Math.floor(fem.length / 30)) === 0)) {
    if (searchCategories(cats, a.name, { allowFemale: false, k: 12 }).artists.some((x) => x.id === a.id)) leaked++;
    if (searchCategories(cats, a.name, { k: 12 }).artists.some((x) => x.id === a.id)) present++;
  }
  const fn = fem.filter((_, i) => i % Math.max(1, Math.floor(fem.length / 30)) === 0).length;
  console.log(`1b. allowFemale=false hides female: ${leaked ? `✗ ${leaked} leaked` : "✓"}  |  default shows female: ${present}/${fn}`);
  issues += leaked + (present < fn ? 1 : 0);

  // kidZone: every result must be a kidzone artist's
  const kidArtistIds = new Set(artists.filter((a) => a.isKidZone).map((a) => a.id));
  const songArtist = new Map(tracks.map((t) => [t.videoId, t.artistId]));
  let kzBad = 0;
  for (const q of ["shir", "aleph", "torah", "yom", "simcha"]) {
    const r = searchCategories(cats, q, { kidZoneOnly: true, k: 8 }).songs;
    for (const s of r) if (!kidArtistIds.has(songArtist.get(s.videoId))) kzBad++;
  }
  console.log(`1c. kidZoneOnly → only KidZone artists: ${kzBad ? `✗ ${kzBad} non-kidzone` : "✓"}`); issues += kzBad;
}

// 2. PLAYLIST search -------------------------------------------------------------------------------
{
  const step = Math.max(1, Math.floor(playlists.length / 200));
  let n = 0, p1 = 0, found = 0;
  for (let i = 0; i < playlists.length; i += step) {
    const p = playlists[i]; if (!plainTokens(p.title).length) continue; n++;
    const r = searchCategories(cats, p.title, { k: 20 }).playlists;
    const rank = r.findIndex((x) => x.id === p.id);
    if (rank === 0) p1++; if (rank >= 0) found++;
  }
  console.log(`2. playlist search: P@1 ${(100 * p1 / n).toFixed(1)}%  recall@20 ${(100 * found / n).toFixed(1)}%  (n=${n})`);
  if (found / n < 0.95) issues++;
}

// 3. begins>contains for SONGS, ALBUMS, SINGLES ----------------------------------------------------
for (const cat of ["songs", "albums", "singles", "playlists"]) {
  let viol = 0, n = 0;
  for (const q of ["shir", "simcha", "nigun", "hallel", "chaim", "yom", "lev", "ani", "tov", "chasunah", "kol"]) {
    const r = searchCategories(cats, q, { k: 12 })[cat]; if (r.length < 2) continue; n++;
    // begins-match = the query starts the title OR artist — in plain OR skeleton (cross-script: a Hebrew
    // "ניגון" begins-matches romanized "nigun").
    const qsk = skeletonKey(q);
    const begins = (x) => {
      const tp = plainTokens(x.title || x.name)[0], ap = plainTokens(x.artist || "")[0];
      if ((tp && tp.startsWith(q)) || (ap && ap.startsWith(q))) return true;
      if (qsk.length < 3) return false;
      const ts = skeletonKey(x.title || x.name).split(" ")[0], as = skeletonKey(x.artist || "").split(" ")[0];
      return (ts && ts.startsWith(qsk)) || (as && as.startsWith(qsk));
    };
    let seenContains = false, bad = false, ex = "";
    for (const x of r) { if (!begins(x)) { seenContains = true; } else if (seenContains) { bad = true; ex = `${x.title || x.name} / ${x.artist || ""}`; break; } }
    if (bad) { viol++; if (viol <= 2) console.log(`     [${cat}] "${q}": begins-match "${ex.slice(0, 40)}" ranked below a contains-match`); }
  }
  console.log(`3. begins>contains [${cat.padEnd(9)}]: ${viol} violations / ${n}`); issues += viol;
}

// 4. SYNONYMS --------------------------------------------------------------------------------------
{
  const r = searchCategories(cats, "mbd", { k: 10 });
  const all = [...r.artists, ...r.songs, ...r.albums, ...r.singles];
  const ok = all.some((x) => /ben david|בן דוד/i.test(`${x.name || ""} ${x.artist || ""}`));
  console.log(`4. synonym mbd → Mordechai Ben David: ${ok ? "✓" : "✗ not found"}`); if (!ok) issues++;
}

// 5. DETERMINISM ----------------------------------------------------------------------------------
{
  let bad = 0;
  for (const q of ["avraham fried", "shir", "kevakarat", "yoni gamerman"]) {
    if (JSON.stringify(searchCategories(cats, q, { k: 8 })) !== JSON.stringify(searchCategories(cats, q, { k: 8 }))) bad++;
  }
  console.log(`5. determinism: ${bad ? `✗ ${bad} non-deterministic` : "✓"}`); issues += bad;
}

console.log(`\nTOTAL issues found: ${issues}`);
db.close();
