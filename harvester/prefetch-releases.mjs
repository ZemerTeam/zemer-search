// zemer-search — search engine and more for the Zemer app
// https://github.com/ZemerTeam/zemer-search
// Zemer app: https://github.com/ZemerTeam/zemer-app
// Copyright (C) 2026 alltechdev
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See the LICENSE file for details.

// Feed-driven PRE-HARVEST — make new releases browsable/playable near-real-time, not on the daily-harvest
// delay. Reads the same releases feed the app + /new use (RELEASES_FEED, real /player dates, whitelist-
// filtered, ~5-min fresh), finds releases whose ALBUM (browseId) or single (sampleVideoId) isn't fully in
// the corpus yet, and harvests just those artists — deep + forced-fresh landing so the NEW ALBUM'S PAGE
// (its tracklist + metadata) is fetched, not merely the landing card. So /new (feed-sourced, already instant
// to *list*) is now also instant to *browse*: `/album` returns the tracklist and every track plays.
//
// ALBUM-AWARE (the whole point — per-channel RSS is blind to music-channel `OLAK` album drops): a release
// with trackCount>1 pulls the full album via the artist's album pages. Cheap: only the MISSING releases
// trigger a harvest (usually 0–few), deduped by artist, and re-harvest replays the gzip cache except the one
// new album page. IP-safe (net.mjs: paced, cached, anti-bot circuit breaker → exits 75 on a block). Run under
// the maintenance flock (the service wraps it in `flock -n`), so it never overlaps a full refresh on the
// single-writer DB.
//
//   RELEASES_FEED=… node harvester/prefetch-releases.mjs        # DRY=1 previews (no harvest/write)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { postBrowse } from "../harness/browse.mjs";
import { netStats } from "../harness/net.mjs";
import { harvestArtist, makeBrowse, BlockError } from "./core.mjs";
import { openCorpus, upsertArtistCatalog, whitelistedChannelIds } from "../corpus/store.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, "../data");
const FEED = (process.env.RELEASES_FEED || "https://api.flipphoneguy.duckdns.org/zemer/recent-releases.json");
const DRY = process.env.DRY === "1";

// 1) fetch the feed (fail-safe: unreachable → nothing to do, exit clean — the daily sweep is the floor)
let feed;
try {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 10000);
  const res = await fetch(FEED, { signal: ac.signal }); clearTimeout(t);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  feed = await res.json();
} catch (e) { console.error(`prefetch-releases: feed unreachable (${e.message}) — nothing to do`); process.exit(0); }
if (!feed || !Array.isArray(feed.releases) || !feed.releases.length) { console.log("prefetch-releases: empty feed — nothing to do"); process.exit(0); }

const db = openCorpus();
const whitelist = JSON.parse(fs.readFileSync(path.join(DATA, "whitelist.json"), "utf8"));
const byId = new Map(whitelist.map((a) => [a.id, a]));
const browse = makeBrowse(postBrowse);

// 2) which releases are already fully in the corpus? album present WITH tracks, or the single's track present.
const hasAlbumTracks = db.prepare("SELECT COUNT(*) c FROM album_track WHERE albumId=?");
const hasAlbum = db.prepare("SELECT 1 FROM album WHERE id=?");
const hasTrack = db.prepare("SELECT 1 FROM track WHERE videoId=?");
const present = (r) => {
  if (r.browseId && hasAlbum.get(r.browseId) && hasAlbumTracks.get(r.browseId).c > 0) return true; // album + tracklist harvested
  if (r.sampleVideoId && hasTrack.get(r.sampleVideoId)) return true;                                  // single/track already in
  return false;
};
const missing = feed.releases.filter((r) => r.artistId && !present(r));
const artistIds = [...new Set(missing.map((r) => r.artistId))]; // one harvest per artist even if it dropped several
console.log(`prefetch-releases: feed ${feed.releases.length} releases, ${missing.length} missing → ${artistIds.length} artist(s) to harvest`);
if (!artistIds.length) { db.close(); process.exit(0); }
if (DRY) {
  for (const r of missing) console.log(`  would harvest: "${r.title}" — ${r.artistName} (${r.trackCount > 1 ? "album " + r.trackCount + "trk" : "single"}, ${r.uploadDate})`);
  db.close(); process.exit(0);
}

// Whitelist-purity guard for harvestArtist's ownsRow: the corpus' whitelisted channels + every feed artist id
// (the feed is whitelist-filtered upstream, so a feed artist not yet in our local whitelist.json is trusted).
const wlChannels = new Set([...whitelistedChannelIds(db), ...whitelist.map((a) => a.id).filter(Boolean), ...artistIds]);
let harvested = 0, aborted = false;
const before = db.prepare("SELECT COUNT(*) c FROM track").get().c;
for (const aid of artistIds) {
  if (aborted) break;
  const nameFromFeed = missing.find((r) => r.artistId === aid)?.artistName;
  const artist = byId.get(aid) || { id: aid, name: db.prepare("SELECT name FROM artist WHERE id=?").get(aid)?.name || nameFromFeed || aid };
  try {
    // deep + landingMaxAgeMs:0 → force a fresh landing (discover the new album), then fetch its album page.
    const got = await harvestArtist(artist, browse, { landingMaxAgeMs: 0, shallow: false, whitelist: wlChannels });
    upsertArtistCatalog(db, artist, got);
    harvested++;
  } catch (e) {
    if (e instanceof BlockError) { console.warn("⚠ anti-bot block — stopping to protect the IP"); aborted = true; }
    else console.warn(`  error on ${aid} (${artist.name}): ${e.message}`);
  }
}
const added = db.prepare("SELECT COUNT(*) c FROM track").get().c - before;
db.close();
const ns = netStats();
console.log(`prefetch-releases: harvested ${harvested}/${artistIds.length} artist(s), +${added} tracks; net ${ns.liveCount} live, ${ns.cacheHits} cached, ${ns.blockedCount} blocks`);
if (aborted) process.exitCode = 75; // anti-bot block → surface as failure; cache makes the next tick resume
