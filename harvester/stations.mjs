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
// radio-graph artifacts, zero network), atomic write. The currently-playing + imminent entries (a 10-min
// guard window) are IMMUTABLE — a live listener can never be jumped mid-song — while the un-aired future
// is rewritten every run under fresh pool filters. Runs with auto-playlists on the twice-daily
// zemer-autoplaylists timer (12h cadence vs a 48h horizon = 4× safety margin); also safe to run by hand.
//
// PROGRAMMING POLICY (a synchronized station is ONE shared stream — it cannot be personalized, so the
// pool is pre-filtered to be kosher for every listener): tagged artists only, no female-involved tracks
// (auto-detected + the curated blocked-ids `female` overrides), no globally-blocked ids, AUDIO only (no
// videos), real durations. A track blocked AFTER being scheduled is purged from the un-aired future on
// the next run (≤12h); the API additionally drops blocked/de-whitelisted ids at SERVE time, and the app
// applies its own blocked list at play time (see the handoff doc) — three layers, no permanent exposure.
//
//   node harvester/stations.mjs           # DRY=1 previews (no write)
import fs from "node:fs";
import path from "node:path";
import { openCorpus, allTracks, allArtists, loadRadioGraph, loadBlockedIds, loadPlayerVideoIds, STATIONS_PATH, ZEMER_PLAYLISTS_PATH, ACAPELLA_AUTO_PATH } from "../corpus/store.mjs";
import { buildFemaleMatcher, collectFemaleVideoIds } from "../index/credits.mjs";
import { extendSchedule } from "../index/station.mjs";

const DRY = process.env.DRY === "1";
const HORIZON_H = Number(process.env.STATION_HORIZON_H || 48);
const KEEP_PAST_H = 6; // history kept for late joins/debug; pruned beyond

// The station catalog — id/title are the app-facing contract; `match` slices the artist roster.
// Israeli = NOT isAmerican: the axis is crowd-verified (SK-Music taggers) and fully populated, so the
// complement is a real Israeli roster, not "untagged" — `requires` guards exactly that: on a corpus whose
// isAmerican column is still unpopulated (fresh deploy, pre-migration sync) the negation would match the
// ENTIRE roster, so the station is skipped (fail-soft) rather than broadcasting the whole catalog.
const STATIONS = [
  { id: "chasidish", title: "Chassidish Radio", match: (a) => a.isChasid },
  { id: "dj", title: "DJ / Remix Radio", match: (a) => a.isDJ },
  { id: "israeli", title: "Israeli Radio", match: (a) => !a.isAmerican, requires: "isAmerican" },
];

const db = openCorpus();
const tracks = allTracks(db);
const artists = allArtists(db);
const graph = loadRadioGraph();
const blocked = loadBlockedIds();
const female = collectFemaleVideoIds(tracks, buildFemaleMatcher(artists)); // same featuring rule as /search
// NO STATION PLAYS ACAPELLA (product rule, 2026-07-29) — same master set that keeps acapella out of
// Trending / Top Downloaded: the curated `acapella` playlist's videoIds (read UN-GATED, so the exclusion
// holds year-round incl. off-season) + the auto-detected clearly-labeled list, plus the strict title
// marker as a belt for anything not yet curated (CLEAR-label only — never excludes ambiguous titles).
const acapella = new Set();
try { for (const v of ((JSON.parse(fs.readFileSync(ZEMER_PLAYLISTS_PATH, "utf8")).playlists || []).find((p) => p?.id === "acapella")?.videoIds || [])) acapella.add(v); } catch { /* none */ }
try { for (const v of (JSON.parse(fs.readFileSync(ACAPELLA_AUTO_PATH, "utf8")).videoIds || [])) acapella.add(v); } catch { /* none */ }
const CLEAR_ACAP = /a[\s-]?c+app?ell?a|\bvocal\s+version\b|\(\s*vocal\s*\)|ווקאל|וואקאל|אקפלה/i;
const playerVideo = loadPlayerVideoIds(); // /player-classified real videos stored isVideo=0 — audio-only pools drop them
const now = Date.now();

let doc = { stations: {} };
try { doc = JSON.parse(fs.readFileSync(STATIONS_PATH, "utf8")); } catch { /* first run */ }
const prevStations = doc.stations || {};
doc.stations = {}; // rebuilt strictly from the catalog — a removed/renamed station can't linger stale

// The append-only guarantee protects LISTENERS, which only requires the currently-playing + imminent
// entries to be immutable. Everything starting beyond this guard window is REWRITTEN each run, so fresh
// pool filters (a newly-blocked id, a de-whitelisted artist, updated tags) purge scheduled-but-unaired
// tracks within one run (≤12h), instead of standing for the whole 48h horizon.
const GUARD_MS = 10 * 60000;

for (const st of STATIONS) {
  // Coverage THRESHOLD, not mere presence (review-caught: one tagged artist out of 1,600 would open the
  // gate while `!isAmerican` admits every untagged artist — Israeli Radio would broadcast the whole
  // roster on a partially-tagged corpus). And a skipped station CARRIES its previous schedule forward
  // (review-caught: rebuilding doc.stations from scratch dropped the guard-window entries the design
  // promises are immutable — live listeners would 404 mid-song).
  if (st.requires && artists.filter((a) => a[st.requires]).length < artists.length * 0.3) {
    console.warn(`station ${st.id}: SKIPPED — required tag '${st.requires}' below 30% coverage on this corpus; carrying previous schedule forward`);
    if (prevStations[st.id]) doc.stations[st.id] = prevStations[st.id];
    continue;
  }
  const tagged = new Set(artists.filter(st.match).map((a) => a.id));
  // kosher-for-all pool: tagged artists, audio-only, no female-involved (auto-detected AND the curated
  // blocked-ids `female` overrides — the ids curation exists precisely because detection can't see them),
  // no globally-blocked ids, real durations. Audio-only means the /player-classified list too: a video
  // stored isVideo=0 (harvested off a Songs shelf — real case: a wedding-recap clip aired) is caught by
  // data/player-video-ids.json (backfill-video-type-player.mjs; stations-only, no corpus flip).
  const pool = tracks.filter((t) => tagged.has(t.artistId) && !t.isVideo && !playerVideo.has(t.videoId) && !female.has(t.videoId)
    && !blocked.global.has(t.videoId) && !blocked.female.has(t.videoId) && (t.durationSec || 0) >= 30
    && !acapella.has(t.videoId) && !CLEAR_ACAP.test(t.title || ""))
    .map((t) => ({ videoId: t.videoId, artistId: t.artistId, durationSec: t.durationSec }));
  const prev = prevStations[st.id] || {};
  const idHash = [...st.id].reduce((h, ch) => (Math.imul(h ^ ch.charCodeAt(0), 16777619)) >>> 0, 2166136261); // per-ID stream (length-only collided)
  const state = prev.state || { seed: (Math.imul(idHash, now & 0x7fffffff) ^ 0x9e3779b9) >>> 0, recentTracks: [], recentArtists: [] };
  // keep recent history + the immutable now/imminent window; DROP (rewrite) the un-aired future
  const entries = (prev.entries || []).filter(([, s, d]) => s + d * 1000 > now - KEEP_PAST_H * 3600000 && s <= now + GUARD_MS);
  // the persisted memory windows described the truncated tail — rebuild them from the KEPT entries so
  // no-repeat/artist-spacing continue correctly across the rewrite
  const artistOf = new Map(pool.map((p) => [p.videoId, p.artistId]));
  state.recentArtists = entries.slice(-12).map(([v]) => artistOf.get(v)).filter(Boolean);
  state.recentTracks = entries.slice(-Math.min(Math.floor(pool.length / 2) || 1, 4000)).map(([v]) => v);
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
