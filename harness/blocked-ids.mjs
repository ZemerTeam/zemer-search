// Pull the conditional id-override list (the world-readable Firestore `blockedContentIds` collection the app
// honors — see zemer-app docs/whitelist/README.md "Conditional id overrides") into
// zemer-search/data/blocked-ids.json as {global:[...ids], female:[...ids]}. Mirrors the app's BlockedIdsCache:
// each doc is one id matched against a result's videoId / playlistId / channelId — reason `female` hides it
// only when female is blocked, `global` (or absent/unknown) hides it for everyone; `disabled:true` is skipped.
// Reads the project id + API key from the app's gitignored google-services.json READ-ONLY (app is immutable).
//   node harness/blocked-ids.mjs
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

const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/blockedContentIds`;
const val = (v) => (v?.stringValue ?? v?.booleanValue ?? v?.integerValue ?? null);

let pageToken = null, pages = 0;
const global = [], female = [];
do {
  const u = new URL(base);
  u.searchParams.set("pageSize", "300");
  u.searchParams.set("key", apiKey);
  if (pageToken) u.searchParams.set("pageToken", pageToken);
  const res = await fetch(u);
  const j = await res.json();
  if (j.error) { console.error("Firestore error:", j.error.status, j.error.message); process.exit(1); }
  for (const d of (j.documents || [])) {
    const f = d.fields || {};
    if (f.disabled?.booleanValue) continue;                     // soft-deleted / template → not applied
    const id = val(f.id) || d.name.split("/").pop();
    if (!id) continue;
    const reason = String(val(f.reason) || val(f.category) || "global").toLowerCase();
    (reason === "female" ? female : global).push(id);           // unknown/absent reason → global (over-block, never leak)
  }
  pageToken = j.nextPageToken;
  pages++;
} while (pageToken && pages < 80);

const outDir = path.join(WORKSPACE, "data");
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, "blocked-ids.json");
const next = JSON.stringify({ global, female });
// Write ONLY when the list actually changed, so a frequent fetch of an unchanged list is a true no-op:
// the file's mtime doesn't move, so the API's reload change-gate doesn't fire a (costly) index rebuild.
// A real edit rewrites it → the API re-applies within one reload tick (~RELOAD_MS).
let prev = null; try { prev = fs.readFileSync(out, "utf8"); } catch { /* none yet */ }
if (prev === next) {
  console.log(`blocked-ids unchanged (${global.length} global, ${female.length} female) — not rewritten (no needless reload)`);
} else {
  fs.writeFileSync(out, next);
  console.log(`wrote ${global.length} global + ${female.length} female id-overrides -> data/blocked-ids.json`);
}
