// zemer-search — search engine and more for the Zemer app
// https://github.com/ZemerTeam/zemer-search
// Zemer app: https://github.com/ZemerTeam/zemer-app
// Copyright (C) 2026 alltechdev
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See the LICENSE file for details.

// Harvest the whitelisted PODCASTS — the podcast analogue of harvest/onboard.mjs. For each show in
// data/podcasts-whitelist.json: browse its MPSP page, paginate every episode, upsert the show + episodes;
// then resolve each distinct host CHANNEL's avatar (one browse per channel) and upsert it. Whitelist-pure
// by construction. IP-safe (paced, cached, aborts on the first anti-bot block → exits 75). Durations are
// usually absent from the browse page — a later /player top-up fills them (mirrors the music duration pass).
//
//   node harvester/podcasts.mjs            # full pass over all whitelisted shows (initial; forever-cache)
//   N=3 node harvester/podcasts.mjs        # limit to the first 3 shows (testing)
//   NEW=1 node harvester/podcasts.mjs      # only shows not already in the corpus (onboard semantics)
//   MAX_AGE_H=12 node harvester/podcasts.mjs # REFRESH: re-fetch each show's page (older than 12h) to catch new episodes
//   PRUNE=1 node harvester/podcasts.mjs    # also drop de-whitelisted shows (+ their episodes/orphan channels)
//   DRY=1 node harvester/podcasts.mjs      # parse + report, ZERO DB writes
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { postBrowse, parseArtistPage } from "../harness/browse.mjs";
import { parsePodcastPage, parsePodcastContinuation } from "../harness/podcast-browse.mjs";
import { makeBrowse, BlockError } from "./core.mjs";
import { netStats } from "../harness/net.mjs";
import { openCorpus } from "../corpus/store.mjs";
import { ensurePodcastSchema, upsertPodcast, upsertPodcastChannel, existingShowIds, prunePodcasts, podcastStats } from "../corpus/podcasts.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, "../data");
const DRY = process.env.DRY === "1";
const NEW = process.env.NEW === "1";
const PRUNE = process.env.PRUNE === "1";
const LIMIT = process.env.N ? Number(process.env.N) : Infinity;
// REFRESH: re-fetch the show page when older than MAX_AGE_H (so new episodes land). Unset = forever-cache
// (initial harvest / onboard). Episode continuation pages carry fresh tokens off a re-fetched page 1.
const landingMaxAgeMs = process.env.MAX_AGE_H ? Number(process.env.MAX_AGE_H) * 3600e3 : undefined;
const PAGE_GUARD = 500; // 500 × 100 eps = 50k max per show

const browse = makeBrowse(postBrowse);
const wl = JSON.parse(fs.readFileSync(path.join(DATA, "podcasts-whitelist.json"), "utf8")).podcasts;
const db = openCorpus();
ensurePodcastSchema(db);
const have = new Set(existingShowIds(db));
let todo = wl.filter((p) => /^MPSP/.test(p.id || ""));
if (NEW) todo = todo.filter((p) => !have.has(p.id));
todo = todo.slice(0, LIMIT);
console.log(`podcasts: ${todo.length} shows to harvest (whitelist ${wl.length}, ${have.size} already in corpus)${DRY ? " [DRY]" : ""}`);

// Harvest one show: page 1 + all episode continuations → { show, episodes }.
async function harvestShow(id) {
  const first = parsePodcastPage(await browse({ browseId: id, maxAgeMs: landingMaxAgeMs }), id);
  const seen = new Set(), episodes = [];
  const push = (e) => { if (e?.videoId && !seen.has(e.videoId)) { seen.add(e.videoId); episodes.push(e); } };
  first.episodes.forEach(push);
  let cont = first.continuation, guard = 0;
  while (cont && guard++ < PAGE_GUARD) {
    const cp = parsePodcastContinuation(await browse({ continuation: cont }));
    cp.episodes.forEach(push);
    cont = cp.continuation;
  }
  return { show: first.show, episodes };
}

let aborted = false, done = 0, epTotal = 0, withDur = 0;
const channelIds = new Set(), chNameHint = new Map(); // channelId -> a show author (name fallback)
for (const p of todo) {
  if (aborted) break;
  try {
    const { show, episodes } = await harvestShow(p.id);
    // keep the whitelist name if the page title is blank; whitelist thumbnail as a fallback cover
    if (!show.name) show.name = p.name;
    if (!show.thumbnail && p.thumbnailUrl) show.thumbnail = p.thumbnailUrl;
    if (!DRY) upsertPodcast(db, show, episodes);
    if (show.channelId) { channelIds.add(show.channelId); if (show.author) chNameHint.set(show.channelId, show.author); }
    epTotal += episodes.length;
    withDur += episodes.filter((e) => e.durationSec != null).length;
    console.log(`+ ${(show.name || p.id).padEnd(38).slice(0, 38)}  ${String(episodes.length).padStart(4)} eps  ch:${show.channelId || "—"}`);
  } catch (e) {
    if (e instanceof BlockError) { console.warn("⚠ anti-bot block — stopping to protect the IP (resume next run from cache)"); aborted = true; }
    else console.warn(`  error on ${p.name || p.id}: ${e.message}`);
  }
  done++;
}

// Resolve host-channel avatars (one browse each). Name falls back to a show's author.
let chDone = 0;
if (!aborted) for (const cid of channelIds) {
  try {
    const page = parseArtistPage(await browse({ browseId: cid }));
    const ch = { id: cid, name: chNameHint.get(cid) || null, thumbnail: page.thumbnail || null };
    if (!DRY) upsertPodcastChannel(db, ch);
    chDone++;
  } catch (e) {
    if (e instanceof BlockError) { aborted = true; break; }
    console.warn(`  channel error ${cid}: ${e.message}`);
  }
}

// PRUNE de-whitelisted shows (only on a full pass — a limited/NEW run doesn't see the whole set).
// Whitelisting is CHANNEL-level: a show survives if its host channel is an approved publisher (so channel-
// catalog-discovered shows are KEPT, not just the individually-listed ones — else the daily discovery run's
// shows would be deleted here on the next pass), or if it is a grandfathered channel-less whitelisted show.
// A show on a DE-approved channel (its channel no longer backs any whitelist show) is correctly dropped.
let pruned = null;
if (PRUNE && !NEW && LIMIT === Infinity && !aborted) {
  const approvedChannels = new Set(wl.filter((p) => p.channelId).map((p) => p.channelId));
  const grandfathered = new Set(wl.filter((p) => !p.channelId && /^MPSP/.test(p.id || "")).map((p) => p.id));
  const survives = (s) => (s.channelId && approvedChannels.has(s.channelId)) || grandfathered.has(s.id);
  const keep = new Set(db.prepare("SELECT id,channelId FROM podcast_show").all().filter(survives).map((s) => s.id));
  pruned = DRY ? { shows: [...new Set(existingShowIds(db))].filter((id) => !keep.has(id)).length, channels: 0 } : prunePodcasts(db, keep);
} else if (PRUNE) {
  console.warn("  PRUNE skipped — only runs on a full pass (no NEW=, no N=)");
}

const s = DRY ? null : podcastStats(db);
if (pruned) console.log(`pruned ${pruned.shows} de-whitelisted shows, ${pruned.channels} orphan channels`);
db.close();
const ns = netStats();
console.log(`\npodcasts: harvested ${done} shows, ${epTotal} episodes (${withDur} with duration from browse), ${chDone} channels resolved`);
if (s) console.log(`corpus now: ${s.shows} shows, ${s.episodes} episodes, ${s.channels} channels, ${s.withCh} shows w/ channel, ${s.withDur} eps w/ duration`);
console.log(`${aborted ? "ABORTED on block; " : ""}net: ${ns.liveCount} live, ${ns.cacheHits} cached, ${ns.blockedCount} blocks`);
if (aborted) process.exitCode = 75;
