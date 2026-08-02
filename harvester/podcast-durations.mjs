// zemer-search — search engine and more for the Zemer app
// https://github.com/ZemerTeam/zemer-app
// Copyright (C) 2026 alltechdev
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See the LICENSE file for details.

// Podcast episode DURATION top-up. Podcast browse pages carry only a publish date, not a length, so every
// episode lands with durationSec=NULL. This pass fills it from /player videoDetails.lengthSeconds — the
// same IP-safe /player path releases.mjs uses to date music (WEB_REMIX first, WEB fallback for gated
// uploads). Durations are REQUIRED by the app (resume/"N left"/Continue-Listening derive from them).
// /player is datacenter-blocked → run off-datacenter (npb6 residential) or via PROXY_URL. Idempotent:
// only fills NULLs, so re-runs cost nothing after the cache warms.
//
//   node harvester/podcast-durations.mjs           # fill all missing
//   N=50 node harvester/podcast-durations.mjs       # cap to 50 episodes (testing)
//   DRY=1 node harvester/podcast-durations.mjs       # report only, no writes
import { postPlayer, playerUploadDate } from "../harness/player.mjs";
import { netStats } from "../harness/net.mjs";
import { openCorpus } from "../corpus/store.mjs";
import { ensurePodcastSchema, setEpisodePlayerMeta } from "../corpus/podcasts.mjs";

const DRY = process.env.DRY === "1";
const LIMIT = process.env.N ? Number(process.env.N) : Infinity;

const db = openCorpus();
ensurePodcastSchema(db);
// need either a duration or a real ISO date → one /player fills both
let todo = db.prepare(`SELECT videoId FROM podcast_episode WHERE durationSec IS NULL OR publishedAt IS NULL ORDER BY pos`).all().map((r) => r.videoId);
if (todo.length > LIMIT) todo = todo.slice(0, LIMIT);
const total = db.prepare(`SELECT COUNT(*) n FROM podcast_episode`).get().n;
console.log(`podcast-durations: ${todo.length} episodes need duration/date (of ${total} total)${DRY ? " [DRY]" : ""}`);

// One /player: WEB_REMIX (YT Music) first, WEB fallback for LOGIN_REQUIRED/gated uploads. Returns both the
// length (videoDetails.lengthSeconds) and the real ISO date (microformat uploadDate) from the same response.
async function playerMeta(videoId) {
  let durationSec = null, publishedAt = null, blocked = false;
  for (const client of ["WEB_REMIX", "WEB"]) {
    const r = await postPlayer({ videoId, client });
    if (r.blocked) { blocked = true; break; } // KEEP any partial already gathered from the first client
    const n = Number(r.json?.videoDetails?.lengthSeconds);
    if (durationSec == null && Number.isFinite(n) && n > 0) durationSec = n;
    if (publishedAt == null) { const d = playerUploadDate(r.json); if (d) publishedAt = String(d).slice(0, 10); }
    if (durationSec != null && publishedAt != null) break; // got both, skip the fallback client
  }
  return { durationSec, publishedAt, blocked };
}

let filledDur = 0, filledDate = 0, missing = 0, done = 0, aborted = false;
for (const videoId of todo) {
  try {
    const m = await playerMeta(videoId);
    if (m.durationSec != null || m.publishedAt != null) {
      if (!DRY) setEpisodePlayerMeta(db, videoId, m); // persist the partial BEFORE any block-abort below
      if (m.durationSec != null) filledDur++;
      if (m.publishedAt != null) filledDate++;
    } else if (!m.blocked) missing++;
    if (m.blocked) { console.warn("⚠ anti-bot block — stopping (resume from cache next run)"); aborted = true; break; }
  } catch (e) {
    missing++;
  }
  if (++done % 200 === 0) console.log(`  … ${done}/${todo.length}  (${filledDur} dur, ${filledDate} date, ${missing} none)`);
}

const haveDur = db.prepare(`SELECT COUNT(*) n FROM podcast_episode WHERE durationSec IS NOT NULL`).get().n;
const haveDate = db.prepare(`SELECT COUNT(*) n FROM podcast_episode WHERE publishedAt IS NOT NULL`).get().n;
db.close();
const ns = netStats();
console.log(`\npodcast-durations: +${filledDur} durations, +${filledDate} dates, ${missing} had neither${aborted ? " (ABORTED on block)" : ""}`);
console.log(`coverage now: duration ${haveDur}/${total} (${(100 * haveDur / total).toFixed(1)}%), date ${haveDate}/${total} (${(100 * haveDate / total).toFixed(1)}%)`);
console.log(`net: ${ns.liveCount} live, ${ns.cacheHits} cached, ${ns.blockedCount} blocks`);
if (aborted) process.exitCode = 75;
