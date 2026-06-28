// Build the on-device fallback artifact (the "least MB" download): a compact, gzipped index scoped to a
// user's content config. Artist names are interned (id→name map) instead of repeated per row; thumbnails
// are derived from the videoId on-device (i.ytimg.com/vi/<id>/...), so they are NOT stored. The app ships
// this file the same way it ships player_configs.json and loads it into the pure-Kotlin in-memory index.
//
//   ALLOW_FEMALE=0 KIDZONE=1 node index/build-subset.mjs
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { openCorpus, allTracks } from "../corpus/store.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, "../data");
const tracks = allTracks(openCorpus());

// Scope by content config (mirrors WhitelistCache.isAllowed + KidZone). Default: allow all whitelisted.
const allowFemale = process.env.ALLOW_FEMALE !== "0";
const kidZoneOnly = process.env.KIDZONE === "1";
const scoped = tracks.filter((t) => (allowFemale || !t.isFemale) && (!kidZoneOnly || t.isKidZone));

// Intern artist id -> name; pack flags into one byte. Row = [videoId, title, artistId, flags].
const F_VIDEO = 1, F_EXPLICIT = 2, F_FEMALE = 4, F_KIDZONE = 8;
const artists = {};
const rows = scoped.map((t) => {
  artists[t.artistId] = t.artistName;
  const flags = (t.isVideo ? F_VIDEO : 0) | (t.explicit ? F_EXPLICIT : 0) | (t.isFemale ? F_FEMALE : 0) | (t.isKidZone ? F_KIDZONE : 0);
  return [t.videoId, t.title, t.artistId, flags];
});

const payload = { v: 1, builtForCorpus: tracks.length, artists, tracks: rows };
const json = JSON.stringify(payload);
const gz = zlib.gzipSync(json, { level: 9 });
const out = path.join(DATA, "subset.json.gz");
fs.writeFileSync(out, gz);

console.log(`subset: ${rows.length}/${tracks.length} tracks (allowFemale=${allowFemale} kidZoneOnly=${kidZoneOnly}), ${Object.keys(artists).length} artists`);
console.log(`  raw ${(json.length / 1024).toFixed(1)} KB  →  gzipped ${(gz.length / 1024).toFixed(1)} KB  (${(gz.length / Math.max(1, rows.length)).toFixed(1)} bytes/track)`);
console.log(`  extrapolated to 100k tracks: ~${(gz.length / Math.max(1, rows.length) * 100000 / 1024 / 1024).toFixed(1)} MB  ->  data/subset.json.gz`);
