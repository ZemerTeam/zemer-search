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
import { openCorpus, albumsNeedingDate, setAlbumUploadDate, datedAlbumCount, stats } from "../corpus/store.mjs";

const MIN_YEAR = Number(process.env.MIN_YEAR || 0);
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : 100000;

const db = openCorpus();
const todo = albumsNeedingDate(db, { minYear: MIN_YEAR, limit: LIMIT });
console.log(`releases: dating ${todo.length} undated albums${MIN_YEAR ? ` (year >= ${MIN_YEAR})` : ""}; already dated ${datedAlbumCount(db)} of ${stats(db).albums + stats(db).singles}`);

let aborted = false, done = 0, dated = 0, nodate = 0;
if (todo.length) setStatus({ phase: "releases", mode: "date", done: 0, total: todo.length, newTracks: 0, blocks: 0, startedAt: Date.now() });
for (const al of todo) {
  if (aborted) break;
  try {
    const r = await postPlayer({ videoId: al.sampleVideoId });
    if (r.blocked) { console.warn("⚠ anti-bot block — stopping to protect the IP (resume from cache next run)"); aborted = true; setStatus({ blocks: 1 }); break; }
    const date = r.json ? playerUploadDate(r.json) : null;
    if (date) { setAlbumUploadDate(db, al.id, date); dated++; }
    else nodate++;
  } catch (e) { console.warn(`  error dating ${al.title}: ${e.message}`); nodate++; }
  if (todo.length) setStatus({ done: ++done, newTracks: dated });
}
if (todo.length) setStatus({ phase: aborted ? "blocked" : "done", done });

const finalDated = datedAlbumCount(db);
const s = stats(db);
db.close();
const ns = netStats();
console.log(`\nreleases: dated ${dated}, no-date ${nodate}; corpus now has ${finalDated} dated releases`);
console.log(`${aborted ? "ABORTED on block; " : ""}net: ${ns.liveCount} live, ${ns.cacheHits} cached, ${ns.blockedCount} blocks`);
if (aborted) process.exitCode = 75; // EX_TEMPFAIL — a block is a (resumable) failure
