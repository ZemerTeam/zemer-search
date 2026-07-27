// zemer-search — search engine and more for the Zemer app
// https://github.com/ZemerTeam/zemer-search
// Zemer app: https://github.com/ZemerTeam/zemer-app
// Copyright (C) 2026 alltechdev
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See the LICENSE file for details.

// Re-harvest ONE artist — the per-artist path `refresh.mjs` loops over, exposed as a CLI so the API can
// trigger a targeted, on-demand refresh when a user opens a stale artist/album (demand-driven freshness).
// The API spawns this under the maintenance flock (`flock -n -E 0 …`), so it never overlaps a full refresh on
// the single-writer DB, and it's IP-safe (net.mjs: paced, cached, aborts on an anti-bot block). Shabbat-gated
// in code (a spawn during the quiet window is a no-op), matching every other harvest path.
//
//   node harvester/refresh-one.mjs <artistId>          # shallow (landing) — the default for on-open freshness
//   DEEP=1 node harvester/refresh-one.mjs <artistId>   # full pagination
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { postBrowse } from "../harness/browse.mjs";
import { harvestArtist, makeBrowse, BlockError } from "./core.mjs";
import { shabbatQuiet } from "../harness/shabbat.mjs";
import { openCorpus, upsertArtistCatalog, whitelistedChannelIds } from "../corpus/store.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, "../data");
const aid = process.argv[2];
if (!aid) { console.error("usage: node harvester/refresh-one.mjs <artistId>"); process.exit(2); }

// Shabbat gate (same window every harvest path honors) — a demand spawn in the quiet window no-ops.
if ((await shabbatQuiet()).quiet) { console.log(`refresh-one ${aid}: Shabbat window — skipping`); process.exit(0); }

const db = openCorpus();
const row = db.prepare("SELECT id,name,isFemale,isChasid,isKidZone,regularChannelId FROM artist WHERE id=?").get(aid);
let artist = row;
if (!artist) { // not yet in corpus — fall back to the whitelist entry (a brand-new artist opened before onboard)
  try { const wl = JSON.parse(fs.readFileSync(path.join(DATA, "whitelist.json"), "utf8")); artist = wl.find((a) => a.id === aid); } catch { /* none */ }
}
if (!artist) { console.error(`refresh-one: ${aid} not in corpus or whitelist — skipping`); process.exit(0); }

const browse = makeBrowse(postBrowse);
const wlChannels = new Set([...whitelistedChannelIds(db), aid]);
const shallow = process.env.DEEP !== "1";
const before = db.prepare("SELECT COUNT(*) c FROM track WHERE artistId=?").get(aid).c;
try {
  // landingMaxAgeMs:0 → force a fresh landing so a just-dropped single/album is seen (then its pages fetched).
  const got = await harvestArtist(artist, browse, { landingMaxAgeMs: 0, shallow, whitelist: wlChannels });
  upsertArtistCatalog(db, artist, got); // also bumps artist.refreshedAt
  const added = db.prepare("SELECT COUNT(*) c FROM track WHERE artistId=?").get(aid).c - before;
  console.log(`refresh-one ${aid} (${artist.name}): ${shallow ? "shallow" : "deep"} +${added} tracks`);
} catch (e) {
  if (e instanceof BlockError) { console.warn(`refresh-one ${aid}: anti-bot block`); process.exitCode = 75; }
  else { console.warn(`refresh-one ${aid}: ${e.message}`); process.exitCode = 1; }
} finally { db.close(); }
