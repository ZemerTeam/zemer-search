// One-time backfill for cross-listed video/song flags. A `videoId` that's listed as a VIDEO on ANY artist
// page IS a video — but the corpus may have stored it as a song, because the same id is cross-listed
// (a music video on one artist's page, an audio song on another's) and a videoId lives once, first-harvest
// wins. This re-parses every artist from the CACHE (offline, zero YouTube calls), collects every videoId
// that appears as a video anywhere, and flips `isVideo=1` for any stored track still flagged as a song.
//
// Going forward the harvest already does this (core.mjs `add` prefers video within an artist; the upsert's
// ON CONFLICT does `isVideo=MAX(...)` across artists) — so this is just to fix what's already stored.
// SAFE: only flips song→video for ids POSITIVELY found as a video in the cache; never the reverse, never
// touches anything else. DRY=1 reports without writing.
import { openCorpus } from "../corpus/store.mjs";
import { postBrowse, parseArtistPage, parseArtistItems, parseArtistItemsContinuation, parsePlaylistPage } from "../harness/browse.mjs";

const DRY = process.env.DRY === "1";
const db = openCorpus();
const browse = async (a) => { const r = await postBrowse({ ...a, cacheOnly: true }); return r.miss ? {} : (r.json || {}); };

const artists = db.prepare("SELECT id FROM artist WHERE name IS NOT NULL").all();
const videoIds = new Set(); // ids that appear as a VIDEO on some page
const note = (s) => { if (s?.videoId && s.isVideo) videoIds.add(s.videoId); };
let scanned = 0;

for (const a of artists) {
  try {
    const page = parseArtistPage(await browse({ browseId: a.id }));
    for (const s of page.sections) {
      if (s.kind === "songs") s.songs.forEach(note);
      if (s.kind === "carousel") s.items.filter((i) => i.kind === "song").forEach(note);
    }
    for (const s of page.sections) {
      if (!s.moreEndpoint || !/song|video/i.test(s.title)) continue;
      const isV = /video/i.test(s.title);
      let p = parseArtistItems(await browse({ browseId: s.moreEndpoint.browseId, params: s.moreEndpoint.params }), isV);
      const sink = (x) => { (x.songs || []).forEach(note); (x.items || []).filter((i) => i.kind === "song").forEach(note); };
      sink(p); let c = p.continuation, g = 0;
      while (c && g++ < 200) { const cp = parseArtistItemsContinuation(await browse({ continuation: c }), isV); sink(cp); c = cp.continuation; }
    }
  } catch { /* cache gap → skip (never flip on missing data) */ }
  if (++scanned % 250 === 0) console.log(`  …scanned ${scanned}/${artists.length}, video-listed ids ${videoIds.size}`);
}

const toFlip = db.prepare("SELECT COUNT(*) c FROM track WHERE isVideo=0 AND videoId IN (SELECT value FROM json_each(?))")
  .get(JSON.stringify([...videoIds])).c;
console.log(`\nscanned ${scanned} artists; ${videoIds.size} ids are videos somewhere; ${toFlip} stored songs need flipping to video`);
if (DRY) { console.log("DRY RUN — no changes written."); process.exit(0); }

const upd = db.prepare("UPDATE track SET isVideo=1 WHERE videoId=? AND isVideo=0");
const tx = db.transaction((ids) => { let n = 0; for (const v of ids) n += upd.run(v).changes; return n; });
const flipped = tx([...videoIds]);
console.log(`flipped ${flipped} tracks song→video.`);
