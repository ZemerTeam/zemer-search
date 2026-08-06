// zemer-search — search engine and more for the Zemer app
// https://github.com/ZemerTeam/zemer-search
// Zemer app: https://github.com/ZemerTeam/zemer-app
// Copyright (C) 2026 alltechdev
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See the LICENSE file for details.

// Pull the PODCAST whitelist (the Firestore `podcastsWhitelist` collection the app syncs) into
// zemer-search/data/podcasts-whitelist.json, plus the `podcastDatabaseNumber/latest` version gate.
// Sibling of harness/whitelist.mjs (artistsWhitelist) — same read-only google-services.json path, same
// Firestore REST access. The app's doc fields (WhitelistFetcher.fetchPodcastWhitelist): id|podcastId,
// name|podcastName, thumbnailUrl, channelId.
//   node harness/podcasts-whitelist.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, "..");
const APP = process.env.ZEMER_APP || path.resolve(WORKSPACE, "../zemer-app");

function findGoogleServices() {
  for (const p of ["app/google-services.json", "google-services.json"]) {
    const abs = path.join(APP, p);
    if (fs.existsSync(abs)) return abs;
  }
  throw new Error("google-services.json not found in zemer-app (gitignored; needed for project id + API key)");
}

const gs = JSON.parse(fs.readFileSync(findGoogleServices(), "utf8"));
const projectId = gs.project_info?.project_id;
const apiKey = gs.client?.[0]?.api_key?.[0]?.current_key;
if (!projectId || !apiKey) throw new Error("could not read project_id / api_key from google-services.json");

const docsBase = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
const val = (v) => (v?.stringValue ?? v?.booleanValue ?? v?.integerValue ?? v?.timestampValue ?? null);

// --- collection: podcastsWhitelist ---
let pageToken = null, all = [], pages = 0;
do {
  const u = new URL(`${docsBase}/podcastsWhitelist`);
  u.searchParams.set("pageSize", "300");
  u.searchParams.set("key", apiKey);
  if (pageToken) u.searchParams.set("pageToken", pageToken);
  const res = await fetch(u);
  const j = await res.json();
  if (j.error) { console.error("Firestore error:", j.error.status, j.error.message); process.exit(1); }
  for (const d of (j.documents || [])) {
    const f = d.fields || {};
    const id = val(f.id) || val(f.podcastId) || d.name.split("/").pop();
    const name = val(f.name) || val(f.podcastName);
    if (!id || !name) continue; // app skips docs missing either (return@forEach)
    all.push({
      id,                                 // MPSP… — the stable SHOW id the app routes on
      name,
      channelId: val(f.channelId) || null, // host UC… (may be absent)
      thumbnailUrl: val(f.thumbnailUrl) || null, // whitelist-provided cover (often absent → harvest fills)
      // per-SHOW content flags (curator-set). Drive per-item female/KidZone filtering; a channel is wholly
      // female/kids only when ALL its shows are (see channel derivation below).
      isFemale: f.isFemale?.booleanValue === true,
      isKidZone: f.isKidZone?.booleanValue === true,
      isVerified: f.isVerified?.booleanValue === true,
    });
  }
  pageToken = j.nextPageToken;
  pages++;
} while (pageToken && pages < 80);

// --- version gate: podcastDatabaseNumber/latest (updatedAt timestamp, else `update`) ---
let version = null;
try {
  const u = new URL(`${docsBase}/podcastDatabaseNumber/latest`);
  u.searchParams.set("key", apiKey);
  const j = await (await fetch(u)).json();
  const f = j.fields || {};
  const updatedAt = f.updatedAt?.timestampValue ? Date.parse(f.updatedAt.timestampValue) : null;
  const update = val(f.update);
  version = updatedAt ?? (update != null ? Number(update) : null);
} catch { /* version stays null — non-fatal */ }

// --- derive the CHANNEL allow-set (the podcast whitelist is moving from show-level to channel-level, the
// same model as the artist whitelist — approve a publisher channel, its whole catalog is kosher). Grouped
// from the show docs until the Firestore collection itself is re-keyed. A channel is wholly-female/kids only
// when EVERY one of its shows is; per-item exceptions on a mixed channel are handled by blockedContentIds
// (exactly like a whitelisted music artist's one blocked track). Shows with no host UC (YouTube exposes
// none) can't be channel-gated, so they are grandfathered as a small show-level allow-set. ---
const byCh = new Map();
const grandfathered = [];
for (const p of all) {
  if (!p.channelId) { grandfathered.push({ id: p.id, name: p.name, isFemale: p.isFemale, isKidZone: p.isKidZone }); continue; }
  if (!byCh.has(p.channelId)) byCh.set(p.channelId, []);
  byCh.get(p.channelId).push(p);
}
const channels = [...byCh.entries()].map(([channelId, shows]) => ({
  channelId,
  showCount: shows.length,
  isFemale: shows.every((s) => s.isFemale),   // wholly-female publisher → channel flag; else per-show blocked-ids
  isKidZone: shows.every((s) => s.isKidZone),
  isVerified: shows.some((s) => s.isVerified),
}));

const outDir = path.join(WORKSPACE, "data");
fs.mkdirSync(outDir, { recursive: true });
const out = { version, fetchedAt: Date.now(), podcasts: all, channels, grandfathered };
fs.writeFileSync(path.join(outDir, "podcasts-whitelist.json"), JSON.stringify(out));
const withCh = all.filter((p) => p.channelId).length;
console.log(`wrote ${all.length} podcast shows -> data/podcasts-whitelist.json (${withCh} with channelId → ${channels.length} channels, ${grandfathered.length} grandfathered channel-less; version ${version})`);
