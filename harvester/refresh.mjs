// zemer-search — search engine and more for the Zemer app
// https://github.com/ZemerTeam/zemer-search
// Zemer app: https://github.com/ZemerTeam/zemer-app
// Copyright (C) 2026 alltechdev
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See the LICENSE file for details.

// Incremental maintenance: re-harvest the artists already in corpus.db — ALL artist rows, including any
// with 0 tracks, so a transiently-failed first harvest recovers instead of being stranded. Re-fetches
// landing + shelf pages with a TTL (MAX_AGE_H, default 20h) so NEW releases are picked up, while
// immutable album pages keep their forever-cache. New tracks are upserted; nothing is removed here
// (de-whitelisted artists are dropped by harvester/prune.mjs). IP-safe (paced, cached, aborts on the
// first anti-bot block → exits 75 and writes a "blocked" status so an aborted run is distinguishable
// from a clean one).
//
//   default = DEEP (full pagination) — the complete pass; preserves the historical refresh behavior, so
//             an existing bare `node harvester/refresh.mjs` cron keeps catching items anywhere in a catalog
//   SHALLOW=1 = landing-only (~1 req/artist) — the fast daily pass (may miss items below the carousel fold)
//
//   MAX_AGE_H=20 node harvester/refresh.mjs               # deep (full)
//   SHALLOW=1 MAX_AGE_H=20 node harvester/refresh.mjs     # fast shallow
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
const byId = new Map(whitelist.map((a) => [a.id, a]));
const browse = makeBrowse(postBrowse);
const db = openCorpus();
const landingMaxAgeMs = Number(process.env.MAX_AGE_H || 20) * 3600 * 1000;
const shallow = process.env.SHALLOW === "1"; // default = DEEP (full pagination); SHALLOW=1 = landing-only fast pass
const deep = !shallow;
const artistIds = existingArtistIds(db); // ALL artist rows (incl. 0-track) so transiently-failed harvests recover
const wlChannels = new Set([...whitelistedChannelIds(db), ...whitelist.map((a) => a.id).filter(Boolean)]); // whitelist-purity guard
const before = stats(db).tracks;
let aborted = false;
let done = 0;
setStatus({ phase: "refresh", mode: deep ? "deep" : "shallow", done: 0, total: artistIds.length, newTracks: 0, blocks: 0, startedAt: Date.now() });

for (const aid of artistIds) {
  if (aborted) break;
  const artist = byId.get(aid) || { id: aid, name: db.prepare("SELECT name FROM artist WHERE id=?").get(aid)?.name || aid };
  try {
    const got = await harvestArtist(artist, browse, { landingMaxAgeMs, shallow, whitelist: wlChannels });
    upsertArtistCatalog(db, artist, got); // existing rows update in place; new "+N" is the stats delta below
  } catch (e) {
    if (e instanceof BlockError) { console.warn("⚠ anti-bot block — stopping refresh to protect the IP"); aborted = true; setStatus({ blocks: 1 }); }
    else console.warn(`  error on ${aid}: ${e.message}`);
  }
  done++;
  // publish progress for the web UI (cheap; newTracks via COUNT only every 10 artists)
  if (done % 10 === 0 || done === artistIds.length) setStatus({ done, newTracks: stats(db).tracks - before });
  else setStatus({ done });
}

const s = stats(db);
setStatus({ phase: aborted ? "blocked" : "done", done, total: artistIds.length, newTracks: s.tracks - before, blocks: netStats().blockedCount });
db.close();
const ns = netStats();
console.log(`\nrefresh (${deep ? "deep" : "shallow"}): +${s.tracks - before} new tracks across ${artistIds.length} artists → ${s.tracks} total`);
console.log(`${aborted ? "ABORTED on block; " : ""}net: ${ns.liveCount} live, ${ns.cacheHits} cached, ${ns.blockedCount} blocks`);
if (aborted) process.exitCode = 75; // EX_TEMPFAIL → the wrapper/systemd treats a block as failure (alert; cache makes next run resume)
