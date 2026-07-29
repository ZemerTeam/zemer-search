// zemer-search — search engine and more for the Zemer app
// https://github.com/ZemerTeam/zemer-search
// Zemer app: https://github.com/ZemerTeam/zemer-app
// Copyright (C) 2026 alltechdev
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See the LICENSE file for details.

// Zemer Stations generator — extends each station's SYNCHRONIZED wall-clock schedule (see
// index/station.mjs) out to HORIZON_H hours ahead and prunes played-out history. Offline (corpus +
// radio-graph artifacts, zero network), APPEND-ONLY (published entries are never rewritten — a live
// listener can never be jumped mid-song), atomic write. Runs with auto-playlists on the twice-daily
// zemer-autoplaylists timer (12h cadence vs a 48h horizon = 4× safety margin); also safe to run by hand.
//
// PROGRAMMING POLICY (a synchronized station is ONE shared stream — it cannot be personalized, so the
// pool is pre-filtered to be kosher for every listener): tagged artists only, no female-involved tracks,
// no globally-blocked ids, AUDIO only (no videos), real durations. A track blocked AFTER being scheduled
// stands for ≤12h (until the next run regenerates future entries); the app additionally applies its own
// blocked list at play time (see the handoff doc).
//
//   node harvester/stations.mjs           # DRY=1 previews (no write)
import fs from "node:fs";
import path from "node:path";
import { openCorpus, allTracks, allArtists, loadRadioGraph, loadBlockedIds, STATIONS_PATH } from "../corpus/store.mjs";
import { buildFemaleMatcher, collectFemaleVideoIds } from "../index/credits.mjs";
import { extendSchedule } from "../index/station.mjs";

const DRY = process.env.DRY === "1";
const HORIZON_H = Number(process.env.STATION_HORIZON_H || 48);
const KEEP_PAST_H = 6; // history kept for late joins/debug; pruned beyond

// The station catalog — id/title are the app-facing contract; `match` slices the artist roster.
// Israeli = NOT isAmerican: the axis is crowd-verified (SK-Music taggers) and fully populated, so the
// complement is a real Israeli roster, not "untagged".
const STATIONS = [
  { id: "chasidish", title: "Chassidish Radio", match: (a) => a.isChasid },
  { id: "dj", title: "DJ / Remix Radio", match: (a) => a.isDJ },
  { id: "israeli", title: "Israeli Radio", match: (a) => !a.isAmerican },
];

const db = openCorpus();
const tracks = allTracks(db);
const artists = allArtists(db);
const graph = loadRadioGraph();
const blocked = loadBlockedIds();
const female = collectFemaleVideoIds(tracks, buildFemaleMatcher(artists)); // same featuring rule as /search
const now = Date.now();

let doc = { stations: {} };
try { doc = JSON.parse(fs.readFileSync(STATIONS_PATH, "utf8")); } catch { /* first run */ }
doc.stations = doc.stations || {};

for (const st of STATIONS) {
  const tagged = new Set(artists.filter(st.match).map((a) => a.id));
  const pool = tracks.filter((t) => tagged.has(t.artistId) && !t.isVideo && !female.has(t.videoId)
    && !blocked.global.has(t.videoId) && (t.durationSec || 0) >= 30)
    .map((t) => ({ videoId: t.videoId, artistId: t.artistId, durationSec: t.durationSec }));
  const prev = doc.stations[st.id] || {};
  const state = prev.state || { seed: (Math.imul(st.id.length * 2654435761, now & 0x7fffffff) ^ 0x9e3779b9) >>> 0, recentTracks: [], recentArtists: [] };
  // prune history, keep everything still relevant; APPEND from the last published entry
  const entries = (prev.entries || []).filter(([, s, d]) => s + d * 1000 > now - KEEP_PAST_H * 3600000);
  const before = entries.length;
  const out = extendSchedule({ pool, graph, entries, state, untilMs: now + HORIZON_H * 3600000, startAtMs: now });
  const horizon = out.entries.length ? (out.entries[out.entries.length - 1][1] + out.entries[out.entries.length - 1][2] * 1000 - now) / 3600000 : 0;
  // programming mix check: share of scheduled slots with real listener reach vs the pool's own share —
  // the station should lean well ABOVE the pool baseline ("songs people actually listen to"), never 100%
  const reach = graph.pop || {};
  const known = out.entries.filter(([v]) => reach[v] > 0).length;
  const poolKnown = pool.filter((p) => reach[p.videoId] > 0).length;
  console.log(`station ${st.id}: pool ${pool.length} tracks (${(100 * poolKnown / (pool.length || 1)).toFixed(0)}% listened), entries ${before} → ${out.entries.length}, horizon ${horizon.toFixed(1)}h, scheduled-from-listened ${(100 * known / (out.entries.length || 1)).toFixed(0)}%`);
  doc.stations[st.id] = { title: st.title, entries: out.entries, state: out.state };
}
doc.builtAt = now;

if (DRY) { console.log("DRY=1 — not writing", STATIONS_PATH); process.exit(0); }
const tmp = STATIONS_PATH + ".tmp";
fs.mkdirSync(path.dirname(STATIONS_PATH), { recursive: true });
fs.writeFileSync(tmp, JSON.stringify(doc));
fs.renameSync(tmp, STATIONS_PATH); // atomic — the API never reads a half-written schedule
console.log(`wrote ${STATIONS_PATH} (${(fs.statSync(STATIONS_PATH).size / 1024).toFixed(0)} KB)`);
