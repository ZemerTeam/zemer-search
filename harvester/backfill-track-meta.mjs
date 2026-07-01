// One-time backfill for track detail metadata: durationSec (from album-page fixed columns) + playCount
// (from the artist landing "Songs" shelf). Both are ALREADY in the cached browse pages — the harvest just
// didn't extract them before. This re-parses every artist OFFLINE (cacheOnly — zero YouTube calls) via the
// same harvestArtist path (which now captures both) and writes ONLY the two new columns for existing rows.
// SAFE + additive: never touches videoId/title/isVideo/etc., never deletes; DRY=1 reports. The harvest fills
// these going forward, so this is just to populate what's already stored.
import { openCorpus, whitelistedChannelIds } from "../corpus/store.mjs";
import { harvestArtist } from "./core.mjs";
import { postBrowse } from "../harness/browse.mjs";

const DRY = process.env.DRY === "1";
const db = openCorpus();
const wl = whitelistedChannelIds(db);
const browse = async (a) => { const r = await postBrowse({ ...a, cacheOnly: true }); return r.miss ? {} : (r.json || {}); };
const artists = db.prepare("SELECT id, name, isFemale, isChasid, isKidZone, regularChannelId FROM artist WHERE name IS NOT NULL").all();
const upd = db.prepare(`UPDATE track SET durationSec=COALESCE(@durationSec, durationSec),
  playCount=NULLIF(MAX(COALESCE(playCount,0), COALESCE(@playCount,0)), 0)
  WHERE videoId=@videoId AND (@durationSec IS NOT NULL OR @playCount IS NOT NULL)`);

let scanned = 0, dur = 0, plays = 0, updated = 0;
for (const a of artists) {
  let tracks = [];
  try { ({ tracks } = await harvestArtist(a, browse, { whitelist: wl })); } catch { /* cache gap → skip */ }
  const rows = tracks.filter((t) => t.durationSec != null || t.playCount != null);
  for (const t of tracks) { if (t.durationSec != null) dur++; if (t.playCount != null) plays++; }
  if (!DRY && rows.length) {
    const tx = db.transaction((rs) => { for (const t of rs) updated += upd.run({ videoId: t.videoId, durationSec: t.durationSec ?? null, playCount: t.playCount ?? null }).changes; });
    tx(rows);
  }
  if (++scanned % 200 === 0) console.log(`  …scanned ${scanned}/${artists.length}, dur-rows ${dur}, play-rows ${plays}`);
}
console.log(`scanned ${scanned} artists; parsed rows with duration ${dur}, with playCount ${plays}; ${DRY ? "DRY — no writes" : "updated " + updated + " track rows"}`);
