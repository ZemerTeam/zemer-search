// Keep the search corpus in sync with the whitelist mirror (content.zemer.io) — cheaply and promptly.
// Every run: read the mirror's whitelist VERSION GATE (advances only on a real whitelist content change) and
// its blocked-id list, both from the mirror (ZERO Firestore reads).
//   * blocked-ids changed  → rewrite data/blocked-ids.json (serve-time filter; the API auto-reloads → newly
//     blocked content disappears, "remove the newly blocked").
//   * whitelist gate changed → pull /whitelist (mirror), rewrite data/whitelist.json, then ONBOARD new artists
//     (full per-artist harvest → searchable) + PRUNE de-whitelisted — under the maintenance flock so it never
//     collides with the daily/weekly maintain.sh (non-blocking: if that run holds the lock, we defer to it).
// Cheap when nothing changed (two tiny GETs, no harvest). Shabbat-gated by the service's ExecCondition.
//   node harvester/mirror-sync.mjs         (DRY=1 → report only, no writes/onboard)
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const DATA = path.join(REPO, "data");
const MIRROR = (process.env.MIRROR_URL || "https://content.zemer.io").replace(/\/+$/, "");
const LOCK = process.env.ZEMER_LOCK || "/tmp/zemer-maintain.lock";
const STATE = path.join(DATA, "mirror-sync.json");
const DRY = process.env.DRY === "1";

const getJSON = async (p) => {
  const res = await fetch(MIRROR + p, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${p} → HTTP ${res.status}`);
  return res.json();
};
const readMaybe = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };
const atomicWrite = (f, obj) => { const t = f + ".tmp"; fs.writeFileSync(t, JSON.stringify(obj)); fs.renameSync(t, f); };

let ver, gate, blocked;
try {
  ver = await getJSON("/whitelist/version");
  gate = ver?.gate;
  blocked = await getJSON("/blockedContentIds");
} catch (e) {
  console.error(`mirror-sync: mirror unreachable (${e.message}) — leaving everything as-is`);
  process.exit(1);
}
if (!Number.isFinite(gate)) { console.error("mirror-sync: no numeric gate from /whitelist/version — skipping"); process.exit(1); }

// 1) blocked-ids — serve-time filter, no DB lock. Rewrite only when it actually differs.
const blockedFile = path.join(DATA, "blocked-ids.json");
if (blocked && Array.isArray(blocked.global) && Array.isArray(blocked.female)) {
  if (JSON.stringify(blocked) !== readMaybe(blockedFile)) {
    if (DRY) console.log(`[DRY] blocked-ids WOULD update → ${blocked.global.length} global, ${blocked.female.length} female`);
    else { atomicWrite(blockedFile, blocked); console.log(`blocked-ids updated → ${blocked.global.length} global, ${blocked.female.length} female (API reloads serve-time)`); }
  }
} else console.warn("mirror-sync: /blockedContentIds not {global,female} — left blocked-ids as-is");

// 2) whitelist — gate-gated. No change → done (the common, cheap path).
const state = JSON.parse(readMaybe(STATE) || "{}");
if (gate === state.gate) { console.log(`mirror-sync: no whitelist change (gate ${gate})`); process.exit(0); }

let wl;
try { wl = await getJSON("/whitelist"); } catch (e) { console.error(`mirror-sync: /whitelist fetch failed (${e.message})`); process.exit(1); }
if (!Array.isArray(wl) || wl.length === 0) { console.error(`mirror-sync: /whitelist empty (${wl?.length}) — refusing to wipe`); process.exit(1); }
// Map to the exact shape harness/whitelist.mjs produces (onboard/prune read .id/.name; female matcher reads isFemale).
const mapped = wl.map((a) => ({ id: a.id, name: a.name, isFemale: !!a.isFemale, isChasid: !!a.isChasid, isKidZone: !!a.isKidZone }));

if (DRY) { console.log(`[DRY] whitelist changed (gate ${state.gate ?? "-"} → ${gate}); ${mapped.length} entries; WOULD write data/whitelist.json + onboard + prune`); process.exit(0); }

atomicWrite(path.join(DATA, "whitelist.json"), mapped);
console.log(`mirror-sync: whitelist changed (gate ${state.gate ?? "-"} → ${gate}) — ${mapped.length} entries; onboard + prune under flock`);

// Onboard (new artists) + prune (de-whitelisted) under the maintenance flock. Non-blocking: `flock -n` exits 1
// if maintain.sh holds it (the daily run will cover), and onboard's anti-bot block is exit 75 — in either case
// we DON'T commit the gate, so the next run retries. Commit only on a clean full sync.
const r = spawnSync("flock", ["-n", LOCK, "bash", "-c", "node harvester/onboard.mjs && node harvester/prune.mjs"], { stdio: "inherit", cwd: REPO });
if (r.status === 0) { atomicWrite(STATE, { gate, at: new Date().toISOString() }); console.log(`mirror-sync: done — gate ${gate} committed`); }
else { console.error(`mirror-sync: onboard/prune not completed (status ${r.status}: lock held, anti-bot block, or error) — gate NOT committed, will retry`); process.exit(r.status || 1); }
