// Date RELEASES precisely — what makes New Releases accurate. Browse pages carry only a year; the real
// release date lives in the /player microformat. For each album lacking a date but with a sample track
// (we already store album_track), fetch ONE /player on that sample and store its uploadDate on the album.
//
// One /player PER RELEASE (not per track). Incremental: already-dated albums are skipped, so re-runs are
// cheap and a re-run after new harvests only dates the new releases. IP-safe (paced, cached, aborts on the
// first anti-bot block → exit 75, resume from cache next run). A song inherits its album's date in
// recentTracks(), so dating albums also fixes the New Releases Songs ordering.
//
//   node harvester/releases.mjs                  # date every undated album that has a sample track
//   MIN_YEAR=2025 node harvester/releases.mjs    # only recent releases (what New Releases needs first)
//   LIMIT=500 node harvester/releases.mjs        # cap this run
import { postPlayer, playerUploadDate } from "../harness/player.mjs";
import { netStats } from "../harness/net.mjs";
import { setStatus } from "./status.mjs";
import { openCorpus, albumsNeedingDate, setAlbumUploadDate, datedAlbumCount, tracksNeedingDate, setTrackUploadDate, datedTrackCount, stats } from "../corpus/store.mjs";

const MIN_YEAR = Number(process.env.MIN_YEAR || 0);
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : 100000;
// Which phases to run (both by default): albums (incl. singles/EPs) and STANDALONE tracks (no album to
// inherit from). TRACKS=0 = albums only (the New-Releases-recent path); ALBUMS=0 = standalone tracks only.
const DO_ALBUMS = process.env.ALBUMS !== "0";
const DO_TRACKS = process.env.TRACKS !== "0" && MIN_YEAR === 0; // standalone tracks carry only a real date (no year to gate)

const db = openCorpus();
const albums = DO_ALBUMS ? albumsNeedingDate(db, { minYear: MIN_YEAR, limit: LIMIT }) : [];
const tracks = DO_TRACKS ? tracksNeedingDate(db, { limit: LIMIT }) : [];
const total = albums.length + tracks.length;
console.log(`releases: dating ${albums.length} undated albums${MIN_YEAR ? ` (year >= ${MIN_YEAR})` : ""} + ${tracks.length} standalone tracks; already dated ${datedAlbumCount(db)}/${stats(db).albums + stats(db).singles} albums, ${datedTrackCount(db)} tracks`);

let aborted = false, done = 0, dated = 0, nodate = 0;
if (total) setStatus({ phase: "releases", mode: "date", done: 0, total, newTracks: 0, blocks: 0, startedAt: Date.now() });
// One /player per item (album → its sample track; standalone track → itself); IP-safe via net.mjs (paced,
// cached, aborts on the first anti-bot block → resume from cache next run). Albums first (they cover the most
// tracks per call), then the standalone tail.
const dateOne = async (videoId, apply) => {
  if (aborted) return;
  try {
    const r = await postPlayer({ videoId });
    if (r.blocked) { console.warn("⚠ anti-bot block — stopping to protect the IP (resume from cache next run)"); aborted = true; setStatus({ blocks: 1 }); return; }
    const date = r.json ? playerUploadDate(r.json) : null;
    if (date) { apply(date); dated++; } else nodate++;
  } catch (e) { console.warn(`  error dating ${videoId}: ${e.message}`); nodate++; }
  if (total) setStatus({ done: ++done, newTracks: dated });
};
for (const al of albums) { if (aborted) break; await dateOne(al.sampleVideoId, (d) => setAlbumUploadDate(db, al.id, d)); }
for (const t of tracks) { if (aborted) break; await dateOne(t.videoId, (d) => setTrackUploadDate(db, t.videoId, d)); }
if (total) setStatus({ phase: aborted ? "blocked" : "done", done });

const finalAlb = datedAlbumCount(db), finalTrk = datedTrackCount(db);
const s = stats(db);
db.close();
const ns = netStats();
console.log(`\nreleases: dated ${dated}, no-date ${nodate}; corpus now has ${finalAlb} dated albums + ${finalTrk} dated standalone tracks`);
console.log(`${aborted ? "ABORTED on block; " : ""}net: ${ns.liveCount} live, ${ns.cacheHits} cached, ${ns.blockedCount} blocks`);
if (aborted) process.exitCode = 75; // EX_TEMPFAIL — a block is a (resumable) failure
