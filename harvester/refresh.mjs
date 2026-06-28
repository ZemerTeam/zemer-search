// Incremental maintenance: re-harvest the artists already in corpus.db, re-fetching their landing +
// shelf pages with a TTL (default 12h) so NEW releases are picked up, while immutable album pages keep
// their forever-cache. New tracks are upserted (INSERT OR IGNORE → only new videoIds added); nothing is
// removed. IP-safe (paced, cached, aborts on the first anti-bot block). Run on a schedule (e.g. daily).
//
//   MAX_AGE_H=12 node harvester/refresh.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { postBrowse } from "../harness/browse.mjs";
import { netStats } from "../harness/net.mjs";
import { harvestArtist, makeBrowse, BlockError } from "./core.mjs";
import { openCorpus, upsertArtistCatalog, harvestedArtistIds, stats } from "../corpus/store.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, "../data");

const whitelist = JSON.parse(fs.readFileSync(path.join(DATA, "whitelist.json"), "utf8"));
const byId = new Map(whitelist.map((a) => [a.id, a]));
const browse = makeBrowse(postBrowse);
const db = openCorpus();
const landingMaxAgeMs = Number(process.env.MAX_AGE_H || 12) * 3600 * 1000;
const artistIds = harvestedArtistIds(db);
const before = stats(db).tracks;
let aborted = false;

for (const aid of artistIds) {
  if (aborted) break;
  const artist = byId.get(aid) || { id: aid, name: db.prepare("SELECT name FROM artist WHERE id=?").get(aid)?.name || aid };
  try {
    const got = await harvestArtist(artist, browse, { landingMaxAgeMs });
    upsertArtistCatalog(db, artist, got); // existing rows update in place; new "+N" is the stats delta below
  } catch (e) {
    if (e instanceof BlockError) { console.warn("⚠ anti-bot block — stopping refresh to protect the IP"); aborted = true; }
    else console.warn(`  error on ${aid}: ${e.message}`);
  }
}

const s = stats(db);
db.close();
const ns = netStats();
console.log(`\nrefresh: +${s.tracks - before} new tracks across ${artistIds.length} artists → ${s.tracks} total`);
console.log(`${aborted ? "ABORTED on block; " : ""}net: ${ns.liveCount} live, ${ns.cacheHits} cached, ${ns.blockedCount} blocks`);
