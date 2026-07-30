// zemer-search — search engine and more for the Zemer app
// https://github.com/ZemerTeam/zemer-search
// Zemer app: https://github.com/ZemerTeam/zemer-app
// Copyright (C) 2026 alltechdev
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See the LICENSE file for details.

// Detect SONGS that are really VIDEOS via /player's videoDetails.musicVideoType — the authoritative
// signal (MUSIC_VIDEO_TYPE_ATV = audio art track; OMV/UGC/OFFICIAL_SOURCE_MUSIC/anything else = an actual
// video: music videos, uploads, live sessions, full-show recordings). The shelf backfill
// (backfill-video-flags.mjs) only catches ids LISTED as a video somewhere in the cached browse pages; a
// video harvested solely off a Songs/landing shelf (real case: a wedding-recap clip that then aired on a
// Zemer Station) is invisible to it.
//
// OUTPUT IS AN EXCLUSION LIST, NOT A CORPUS FLIP: writes data/player-video-ids.json (gitignored), consumed
// ONLY by the Zemer Stations pool filter + /station serve-time guard — a deliberate product call
// (2026-07-30): stations must never broadcast these, but search categories / blockVideos stay untouched
// (flipping ~1.2k tracks songs→videos is a visible app-wide shift; revisit separately if ever wanted).
// UNION-MERGED with the existing file, so partial runs on different machines/caches accumulate.
// Scope: STANDALONE tracks only — album members sit on an album tracklist and are songs by construction.
// DRY=1 reports; cache-first, LIVE=1 fetches uncached /players (IP-safe via net.mjs — from a datacenter
// run it through the residential PROXY_URL, same as the dating pass).
import fs from "node:fs";
import { openCorpus, PLAYER_VIDEO_IDS_PATH, loadPlayerVideoIds } from "../corpus/store.mjs";
import { postPlayer } from "../harness/player.mjs";

const DRY = process.env.DRY === "1";
const LIVE = process.env.LIVE === "1";
const AUDIO_TYPES = new Set(["MUSIC_VIDEO_TYPE_ATV"]); // everything else = video
const db = openCorpus();
const known = loadPlayerVideoIds();
const todo = db.prepare(
  `SELECT t.videoId FROM track t WHERE t.isVideo=0
   AND NOT EXISTS (SELECT 1 FROM album_track a WHERE a.videoId=t.videoId)`).all()
  .filter(({ videoId }) => !known.has(videoId)); // already classified video — no /player spend
db.close();
console.log(`video-type: ${todo.length} standalone songs to classify (${known.size} already listed; ${LIVE ? "cache + live" : "cache-only"})`);

const found = [];
let audio = 0, notype = 0, uncached = 0;
for (const { videoId } of todo) {
  let type = null, seen = false;
  for (const client of ["WEB_REMIX", "WEB"]) {
    const r = await postPlayer({ videoId, client, cacheOnly: !LIVE });
    if (r.blocked) { console.warn("⚠ anti-bot block — stopping"); process.exitCode = 75; break; }
    if (r.miss || !r.json) continue;
    seen = true;
    const t = r.json?.videoDetails?.musicVideoType;
    if (t) { type = t; break; } // WEB_REMIX carries the type; plain WEB is the LOGIN_REQUIRED fallback
  }
  if (process.exitCode === 75) break;
  if (type && !AUDIO_TYPES.has(type)) found.push(videoId);
  else if (type) audio++;
  else if (seen) notype++; // /player answered but carried no musicVideoType (unavailable/region) — leave as-is
  else uncached++;
}
const merged = [...new Set([...known, ...found])].sort();
if (!DRY && found.length) {
  const tmp = PLAYER_VIDEO_IDS_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ builtAt: Date.now(), videoIds: merged }, null, 1));
  fs.renameSync(tmp, PLAYER_VIDEO_IDS_PATH); // atomic — readers never see a half-written list
}
console.log(`video-type: +${found.length} new video ids${DRY ? " (DRY — no writes)" : found.length ? ` → ${PLAYER_VIDEO_IDS_PATH} (${merged.length} total)` : " — file unchanged"}, confirmed-audio ${audio}, no-type ${notype}, not-in-cache ${uncached}`);
