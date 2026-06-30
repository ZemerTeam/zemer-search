// Onboard NEW whitelisted artists — those in data/whitelist.json but not yet in corpus.db. Existing
// artists are skipped entirely (their new releases are handled by refresh.mjs). Full per-artist harvest
// (forever-cache). IP-safe (paced, cached, aborts on the first anti-bot block → exits 75). Cheap when
// nothing is new (a no-op that makes zero live requests).
//
//   node harvester/onboard.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { postBrowse } from "../harness/browse.mjs";
import { netStats } from "../harness/net.mjs";
import { harvestArtist, makeBrowse, BlockError } from "./core.mjs";
import { setStatus } from "./status.mjs";
import { openCorpus, upsertArtistCatalog, existingArtistIds, whitelistedChannelIds, stats } from "../corpus/store.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, "../data");

const whitelist = JSON.parse(fs.readFileSync(path.join(DATA, "whitelist.json"), "utf8"));
const browse = makeBrowse(postBrowse);
const db = openCorpus();
const have = new Set(existingArtistIds(db));
const wlChannels = new Set([...whitelistedChannelIds(db), ...whitelist.map((a) => a.id).filter(Boolean)]); // whitelist-purity guard
const todo = whitelist.filter((a) => /^UC/.test(a.id || "") && !have.has(a.id));
console.log(`onboard: ${todo.length} new whitelisted artists (whitelist ${whitelist.length}, ${have.size} already in corpus)`);

let aborted = false, done = 0;
if (todo.length) setStatus({ phase: "onboard", done: 0, total: todo.length, newTracks: 0, blocks: 0, startedAt: Date.now() });
for (const a of todo) {
  if (aborted) break;
  try {
    const got = await harvestArtist(a, browse, { whitelist: wlChannels }); // full catalog, forever-cache
    // Only persist a real catalog. A transient fetch error yields {} → 0 tracks; writing that row would
    // strand the artist (onboard then skips it as "existing" forever). Leave it un-onboarded → retried.
    if (got.tracks.length) {
      upsertArtistCatalog(db, a, got);
      console.log(`+ ${(a.name || a.id).padEnd(32).slice(0, 32)}  ${got.tracks.length}t ${got.albums.length}al ${got.playlists.length}pl`);
    } else {
      console.warn(`  0 tracks for ${a.name || a.id} — not persisting (will retry next onboard)`);
    }
  } catch (e) {
    if (e instanceof BlockError) { console.warn("⚠ anti-bot block — stopping onboard to protect the IP (resume next run from cache)"); aborted = true; setStatus({ blocks: 1 }); }
    else console.warn(`  error on ${a.name || a.id}: ${e.message}`);
  }
  if (todo.length) setStatus({ done: ++done });
}
if (todo.length) setStatus({ phase: aborted ? "blocked" : "done", done }); // terminal phase so the UI clears

const s = stats(db);
db.close();
const ns = netStats();
console.log(`\nonboard: corpus now ${s.artists} artists, ${s.tracks} tracks`);
console.log(`${aborted ? "ABORTED on block; " : ""}net: ${ns.liveCount} live, ${ns.cacheHits} cached, ${ns.blockedCount} blocks`);
if (aborted) process.exitCode = 75; // EX_TEMPFAIL → wrapper/systemd treats a block as failure
