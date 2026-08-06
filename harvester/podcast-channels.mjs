// zemer-search — search engine and more for the Zemer app
// https://github.com/ZemerTeam/zemer-search
// Zemer app: https://github.com/ZemerTeam/zemer-app
// Copyright (C) 2026 alltechdev
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See the LICENSE file for details.

// CHANNEL-CATALOG discovery harvest — the "approve a publisher, its whole catalog is kosher" half of
// channel-level podcast whitelisting (the artist-whitelist model, applied to podcasts). For each approved
// host channel (UC), read its YT Music landing "Podcasts" shelf (valid MPSP show ids), find the shows NOT
// yet in the corpus, and harvest them (page + every episode). They then serve immediately: the API gates
// podcasts on CHANNEL membership, so any show on an approved channel is kosher with no per-show whitelist
// entry. Whitelist purity is by construction (only approved channels are scanned).
//
// COVERAGE NOTE: the "Podcasts" shelf is a capped preview (~10). Its "more" link routes to an empty Music
// view for podcast host channels (their shows live on the regular YouTube channel; the Music show ids MPSP
// don't map cleanly to the regular playlist ids), so a channel with >~10 shows keeps only its top shelf. In
// this corpus that affects a single channel; everything else is fully covered.
//
// IP-safe (paced, cached, aborts on the first anti-bot block → exits 75). Re-running is free (cache replay).
//   node harvester/podcast-channels.mjs             # discover + harvest new shows across all approved channels
//   MAX_AGE_H=12 node harvester/podcast-channels.mjs # re-fetch each channel landing older than 12h (catch new shows)
//   N=5 node harvester/podcast-channels.mjs          # limit to the first 5 approved channels (testing)
//   DRY=1 node harvester/podcast-channels.mjs         # report discovered/new counts, ZERO DB writes
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { postBrowse, parseArtistPage } from "../harness/browse.mjs";
import { parsePodcastPage, parsePodcastContinuation, parseChannelPodcastShelf } from "../harness/podcast-browse.mjs";
import { makeBrowse, BlockError } from "./core.mjs";
import { netStats } from "../harness/net.mjs";
import { openCorpus } from "../corpus/store.mjs";
import { ensurePodcastSchema, upsertPodcast, upsertPodcastChannel, existingShowIds, podcastStats } from "../corpus/podcasts.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, "../data");
const DRY = process.env.DRY === "1";
const LIMIT = process.env.N ? Number(process.env.N) : Infinity;
const landingMaxAgeMs = process.env.MAX_AGE_H ? Number(process.env.MAX_AGE_H) * 3600e3 : undefined; // unset = forever-cache
const PAGE_GUARD = 500; // 500 × 100 eps = 50k max per show

const browse = makeBrowse(postBrowse);
const wl = JSON.parse(fs.readFileSync(path.join(DATA, "podcasts-whitelist.json"), "utf8"));
// Approved publisher channels — the whitelist's derived `channels`, else grouped from the show docs.
const approved = wl.channels?.length
  ? wl.channels.map((c) => c.channelId)
  : [...new Set((wl.podcasts || []).map((p) => p.channelId).filter(Boolean))];
const channels = approved.slice(0, LIMIT);

const db = openCorpus();
ensurePodcastSchema(db);
const have = new Set(existingShowIds(db));
console.log(`channel-catalog discovery: ${channels.length} approved channels, ${have.size} shows already in corpus${DRY ? " [DRY]" : ""}`);

async function harvestShow(id) {
  const first = parsePodcastPage(await browse({ browseId: id, maxAgeMs: landingMaxAgeMs }), id);
  const seen = new Set(), episodes = [];
  const push = (e) => { if (e?.videoId && !seen.has(e.videoId)) { seen.add(e.videoId); episodes.push(e); } };
  first.episodes.forEach(push);
  let cont = first.continuation, guard = 0;
  while (cont && guard++ < PAGE_GUARD) { const cp = parsePodcastContinuation(await browse({ continuation: cont })); cp.episodes.forEach(push); cont = cp.continuation; }
  return { show: first.show, episodes };
}

let aborted = false, scanned = 0, discovered = 0, harvested = 0, epTotal = 0;
const newByChannel = new Map(); // channelId -> [{id,name}]
// 1) DISCOVER: scan each approved channel's Podcasts shelf for shows not yet in the corpus.
for (const cid of channels) {
  if (aborted) break;
  try {
    const shelf = parseChannelPodcastShelf(await browse({ browseId: cid, maxAgeMs: landingMaxAgeMs }));
    scanned++;
    const fresh = shelf.filter((s) => /^MPSP/.test(s.id) && !have.has(s.id));
    if (fresh.length) { newByChannel.set(cid, fresh); discovered += fresh.length; }
  } catch (e) {
    if (e instanceof BlockError) { console.warn("⚠ anti-bot block on channel scan — stopping (resume from cache)"); aborted = true; }
    else console.warn(`  channel scan error ${cid}: ${e.message}`);
  }
}
console.log(`scanned ${scanned}/${channels.length} channels → ${discovered} NEW shows on ${newByChannel.size} channels`);
if (DRY) {
  for (const [cid, shows] of [...newByChannel].sort((a, b) => b[1].length - a[1].length).slice(0, 12))
    console.log(`  ${cid}  +${shows.length}: ${shows.slice(0, 3).map((s) => s.name).join(", ")}${shows.length > 3 ? " …" : ""}`);
  console.log("\nDRY — no writes. Drop DRY=1 to harvest these into the corpus (they serve immediately via channel-gating).");
  db.close(); process.exit(0);
}

// 2) HARVEST: pull each new show (page + all episodes) and upsert. Resolve the host-channel avatar once.
for (const [cid, shows] of newByChannel) {
  if (aborted) break;
  let avatar = null;
  try { avatar = parseArtistPage(await browse({ browseId: cid })).thumbnail || null; } catch { /* keep null */ }
  for (const s of shows) {
    if (aborted) break;
    try {
      const { show, episodes } = await harvestShow(s.id);
      if (!show.name) show.name = s.name;
      if (!show.channelId) show.channelId = cid; // trust the discovery channel when the page omits it
      if (!show.thumbnail && s.thumbnail) show.thumbnail = s.thumbnail;
      upsertPodcast(db, show, episodes);
      harvested++; epTotal += episodes.length;
      console.log(`+ ${(show.name || s.id).padEnd(38).slice(0, 38)}  ${String(episodes.length).padStart(4)} eps  ch:${cid}`);
    } catch (e) {
      if (e instanceof BlockError) { console.warn("⚠ anti-bot block — stopping to protect the IP"); aborted = true; }
      else console.warn(`  error on ${s.name || s.id}: ${e.message}`);
    }
  }
  if (avatar && !aborted) { try { upsertPodcastChannel(db, { id: cid, thumbnail: avatar }); } catch { /* non-fatal */ } }
}

const st = podcastStats(db);
db.close();
const ns = netStats();
console.log(`\ndiscovery: harvested ${harvested} new shows, ${epTotal} episodes${aborted ? " (ABORTED on block)" : ""}`);
console.log(`corpus now: ${st.shows} shows, ${st.episodes} episodes, ${st.channels} channels`);
console.log(`net: ${ns.liveCount} live, ${ns.cacheHits} cached, ${ns.blockedCount} blocks`);
if (aborted) process.exitCode = 75;
