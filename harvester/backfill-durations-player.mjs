// Fill remaining track durations from already-cached /player responses (videoDetails.lengthSeconds).
// The browse-page backfill (backfill-track-meta.mjs) covers ~97% — what it misses are mostly tracks on no
// album page (videos/standalone), and the dating pass (releases.mjs) already fetched THEIR /player. So this
// is a pure cache read by default: DRY=1 reports, LIVE=1 additionally fetches the few /players not yet
// cached (IP-safe via net.mjs; only useful for album-audio stragglers). Never overwrites a known duration.
import { openCorpus } from "../corpus/store.mjs";
import { postPlayer } from "../harness/player.mjs";

const DRY = process.env.DRY === "1";
const LIVE = process.env.LIVE === "1";
const db = openCorpus();
const todo = db.prepare("SELECT videoId FROM track WHERE durationSec IS NULL").all();
const upd = db.prepare("UPDATE track SET durationSec=? WHERE videoId=? AND durationSec IS NULL");
console.log(`durations: ${todo.length} tracks lack durationSec (${LIVE ? "cache + live" : "cache-only"})`);

let filled = 0, nolen = 0, uncached = 0;
for (const { videoId } of todo) {
  let len = null, seen = false;
  for (const client of ["WEB_REMIX", "WEB"]) {
    const r = await postPlayer({ videoId, client, cacheOnly: !LIVE });
    if (r.blocked) { console.warn("⚠ anti-bot block — stopping"); process.exitCode = 75; break; }
    if (r.miss || !r.json) continue;
    seen = true;
    const ls = Number(r.json?.videoDetails?.lengthSeconds);
    if (ls > 0) { len = ls; break; }
  }
  if (process.exitCode === 75) break;
  if (len != null) { if (!DRY) upd.run(len, videoId); filled++; }
  else if (seen) nolen++;
  else uncached++;
}
const left = db.prepare("SELECT COUNT(*) c FROM track WHERE durationSec IS NULL").get().c;
db.close();
console.log(`durations: filled ${filled}${DRY ? " (DRY — no writes)" : ""}, no-length ${nolen}, not-in-cache ${uncached}; still missing ${DRY ? todo.length : left}`);
