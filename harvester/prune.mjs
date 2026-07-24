// zemer-search — search engine and more for the Zemer app
// https://github.com/ZemerTeam/zemer-search
// Zemer app: https://github.com/ZemerTeam/zemer-app
// Copyright (C) 2026 alltechdev
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See the LICENSE file for details.

// Remove artists no longer on the whitelist (de-whitelisted) from corpus.db so they stop being
// searchable — a content-safety step. Reads the freshly-fetched data/whitelist.json (run
// harness/whitelist.mjs first). No network; one local DB transaction.
//
// SAFETY GUARD (corpus/store.mjs prunePlan, unit-tested): refuses to prune unless at least
// PRUNE_MIN_RATIO of the CURRENT corpus artists would SURVIVE (still be whitelisted) — comparing
// survivors = corpus ∩ whitelist, NOT the raw whitelist size — so a plausibly-sized but wrong/disjoint
// whitelist can't pass and wipe everything. A non-numeric/out-of-range ratio falls back to 0.5.
//
//   node harvester/prune.mjs          # prune
//   DRY=1 node harvester/prune.mjs    # PREVIEW only: full would-remove report (blocklist + de-whitelisted
//                                     #   artists with names/track counts), zero writes; exit 1 if the
//                                     #   safety guard would refuse (so callers see the verdict either way)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setStatus } from "./status.mjs";
import { openCorpus, pruneArtists, existingArtistIds, prunePlan, pruneBlocklisted, stats } from "../corpus/store.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, "../data");

const DRY = process.env.DRY === "1";
const whitelist = JSON.parse(fs.readFileSync(path.join(DATA, "whitelist.json"), "utf8"));
const keep = new Set(whitelist.filter((a) => /^UC/.test(a.id || "")).map((a) => a.id));
const db = openCorpus();

// Blocklist prune first — always safe + independent of the whitelist guard (removes only explicitly
// listed junk videoIds/artists; upserts already skip them so they can't come back).
const bl = pruneBlocklisted(db, undefined, { dry: DRY });
if (bl.tracks || bl.artists || bl.playlists) console.log(`prune: blocklist ${DRY ? "WOULD remove" : "removed"} ${bl.tracks} track(s), ${bl.artists} artist(s), ${bl.playlists} community playlist(s)`);

const plan = prunePlan(existingArtistIds(db), keep, process.env.PRUNE_MIN_RATIO);

if (!plan.safe) {
  console.error(`prune: ${DRY ? "[DRY] would REFUSE" : "REFUSING"} — only ${plan.survivors}/${plan.before} current artists are still whitelisted ` +
    `(would remove ${plan.toRemove}; guard needs ≥ ${Math.round(plan.minRatio * 100)}% to survive). ` +
    `Looks like a bad/empty/mismatched whitelist fetch — re-run harness/whitelist.mjs.`);
  db.close();
  process.exit(1);
}

if (DRY) { // PREVIEW: the full would-remove report, then exit — zero writes happened above or below
  const doomed = [...existingArtistIds(db)].filter((id) => !keep.has(id));
  console.log(`prune: [DRY] guard OK (${plan.survivors}/${plan.before} survive) — WOULD remove ${doomed.length} de-whitelisted artist(s):`);
  for (const id of doomed.slice(0, 50)) {
    const a = db.prepare("SELECT name FROM artist WHERE id=?").get(id);
    const n = db.prepare("SELECT COUNT(*) c FROM track WHERE artistId=?").get(id).c;
    console.log(`  - ${id}  ${(a?.name || "?").slice(0, 40)}  (${n} track(s))`);
  }
  if (doomed.length > 50) console.log(`  … (+${doomed.length - 50} more)`);
  db.close();
  process.exit(0);
}

setStatus({ phase: "prune", done: 0, total: plan.toRemove, newTracks: 0, blocks: 0, startedAt: Date.now() });
const { artists, ids } = pruneArtists(db, keep);
setStatus({ phase: "done", done: artists, total: plan.toRemove });
const after = stats(db);
db.close();
console.log(`prune: removed ${artists} de-whitelisted artist(s) → ${after.artists} artists, ${after.tracks} tracks`);
if (artists) console.log(`  removed: ${ids.slice(0, 20).join(", ")}${ids.length > 20 ? ` … (+${ids.length - 20} more)` : ""}`);
