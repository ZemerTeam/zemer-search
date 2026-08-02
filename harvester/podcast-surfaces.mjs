// zemer-search — search engine and more for the Zemer app
// https://github.com/ZemerTeam/zemer-app
// Copyright (C) 2026 alltechdev
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See the LICENSE file for details.

// DATA-DRIVEN podcast surfaces — the podcast analogue of auto-playlists.mjs. Fetches the zemer-stats
// /stats podcast section (episode reach + 20%-completion + subscribe reach — telemetry stays aggregated,
// no device data leaves), rolls EPISODES up to their SHOW using the corpus episode→show map, and writes
// the gitignored `data/podcast-surfaces.json` consumed by /podcasts?sort=top and /podcasts/trending.
//
// v1 ranking is REACH+COMPLETION-primary (velocity Trending is a later refinement, exactly how music
// Trending started). Fail-safe: a down/empty /stats leaves the existing file untouched; DRY=1 previews.
//
//   STATS_URL=… STATS_KEY=… node harvester/podcast-surfaces.mjs         # generate + write
//   STATS_URL=… STATS_KEY=… DRY=1 node harvester/podcast-surfaces.mjs   # preview, no write
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openCorpus } from "../corpus/store.mjs";
import { ensurePodcastSchema } from "../corpus/podcasts.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = process.env.PODCAST_SURFACES || path.resolve(HERE, "../data/podcast-surfaces.json");
const STATS_URL = (process.env.STATS_URL || "").replace(/\/+$/, "");
const STATS_KEY = process.env.STATS_KEY || "";
const DAYS = Number(process.env.DAYS || 30);
const DRY = process.env.DRY === "1";
const SUB_WEIGHT = Number(process.env.SUB_WEIGHT || 3); // a subscribe ≈ 3 qualified listens (the podcast "favorite")

const die = (m) => { console.error(m); process.exit(1); };
const benign = (m) => { console.log(m); process.exit(0); }; // self-healing: leave last-good file in place
if (!STATS_URL || !STATS_KEY) die("STATS_URL and STATS_KEY must be set (see .env) — refusing to run.");

async function fetchStats() {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  try {
    const res = await fetch(`${STATS_URL}/stats?key=${encodeURIComponent(STATS_KEY)}&days=${DAYS}`, { signal: ac.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; } finally { clearTimeout(timer); }
}

let stats;
try { stats = await fetchStats(); } catch (e) { benign(`/stats fetch failed (${e.message}) — leaving surfaces untouched.`); }
if (!stats || !stats.podcast) benign("/stats has no podcast section — leaving surfaces untouched.");
const topEpisodes = stats.podcast.topEpisodes || [];
const topSubscribes = stats.podcast.topSubscribes || [];
if (!topEpisodes.length && !topSubscribes.length) benign("no podcast telemetry yet — leaving surfaces untouched.");

const db = openCorpus();
ensurePodcastSchema(db);
// episode videoId → showId, and channelId → [showIds] (a subscribe may target a channel or a show)
const epShow = new Map(db.prepare("SELECT videoId, showId FROM podcast_episode").all().map((r) => [r.videoId, r.showId]));
const showChannel = new Map(db.prepare("SELECT id, channelId FROM podcast_show").all().map((r) => [r.id, r.channelId]));
const channelShows = new Map();
for (const [showId, ch] of showChannel) if (ch) { if (!channelShows.has(ch)) channelShows.set(ch, []); channelShows.get(ch).push(showId); }
const knownShow = new Set(showChannel.keys());

// Roll episode engagement up to shows. Device reach can't be summed exactly across episodes (overlap
// unknown from aggregates), so `reach` is an upper bound; `qualified` (≥20%-completion listens) is the
// primary signal, corroborated by subscribe reach.
const show = new Map();
const bump = (id) => { if (!show.has(id)) show.set(id, { id, qualified: 0, reach: 0, subReach: 0, episodesEngaged: 0 }); return show.get(id); };
let mappedEp = 0;
for (const e of topEpisodes) {
  const sid = epShow.get(e.videoId);
  if (!sid) continue; // episode not in our corpus (whitelist-pure: ignore)
  mappedEp++;
  const s = bump(sid);
  s.qualified += e.qualified || 0;
  s.reach += e.devices || 0;
  s.episodesEngaged += 1;
}
for (const sub of topSubscribes) {
  const id = sub.id;
  if (knownShow.has(id)) bump(id).subReach += sub.devices || 0;               // subscribed at show level
  else if (channelShows.has(id)) for (const sid of channelShows.get(id)) bump(sid).subReach += sub.devices || 0; // channel → all its shows
}

// Top Podcasts: qualified listens + weighted subscribe reach.
const topShows = [...show.values()]
  .map((s) => ({ ...s, score: s.qualified + SUB_WEIGHT * s.subReach }))
  .filter((s) => s.score > 0)
  .sort((a, b) => b.score - a.score || b.reach - a.reach)
  .slice(0, 100);

// Trending Episodes (v1): recent high-completion engagement = reach × avg-completion. Whitelist-pure.
const trendingEpisodes = topEpisodes
  .filter((e) => epShow.has(e.videoId))
  .map((e) => ({ videoId: e.videoId, showId: epShow.get(e.videoId), reach: e.devices || 0, avgCompletion: e.avgCompletion ?? null,
    trend: (e.devices || 0) * (e.avgCompletion ?? 0) }))
  .sort((a, b) => b.trend - a.trend || b.reach - a.reach)
  .slice(0, 50);

db.close();
const doc = { generatedAt: Date.now(), days: DAYS, subWeight: SUB_WEIGHT,
  topShows: topShows.map((s) => ({ id: s.id, score: Math.round(s.score * 100) / 100, qualified: s.qualified, reach: s.reach, subReach: s.subReach, episodesEngaged: s.episodesEngaged })),
  trendingEpisodes };

console.log(`podcast-surfaces: ${topEpisodes.length} episodes in stats, ${mappedEp} mapped to corpus shows → ${topShows.length} ranked shows, ${trendingEpisodes.length} trending episodes${DRY ? " [DRY]" : ""}`);
if (topShows[0]) console.log(`  #1 show: ${topShows[0].id} (score ${doc.topShows[0].score}, ${topShows[0].qualified} qualified, ${topShows[0].subReach} subs)`);
if (DRY) process.exit(0);
// atomic write (last-good preserved on crash)
const tmp = OUT_PATH + ".tmp";
fs.writeFileSync(tmp, JSON.stringify(doc));
fs.renameSync(tmp, OUT_PATH);
console.log(`wrote ${OUT_PATH}`);
