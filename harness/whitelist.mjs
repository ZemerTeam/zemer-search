// Pull the artist whitelist (the world-readable Firestore `artistsWhitelist` collection the app syncs)
// into zemer-search/data/whitelist.json. Ported from zemer-app/tests/search/fetch-whitelist.mjs; reads
// the project id + API key from the app's gitignored google-services.json READ-ONLY (app is immutable),
// writes the cache into THIS workspace.
//   node harness/whitelist.mjs
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

const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/artistsWhitelist`;
const val = (v) => (v?.stringValue ?? v?.booleanValue ?? v?.integerValue ?? null);

let pageToken = null, all = [], pages = 0;
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
    all.push({
      id: val(f.id) || val(f.artistId) || d.name.split("/").pop(),
      name: val(f.name) || val(f.artistName),
      isFemale: !!f.isFemale?.booleanValue,
      isChasid: !!f.isChasid?.booleanValue,
      isKidZone: !!f.isKidZone?.booleanValue,
    });
  }
  pageToken = j.nextPageToken;
  pages++;
} while (pageToken && pages < 80);

const outDir = path.join(WORKSPACE, "data");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "whitelist.json"), JSON.stringify(all));
const uc = all.filter((a) => /^UC/.test(a.id || "")).length;
console.log(`wrote ${all.length} whitelist entries -> data/whitelist.json (${uc} UC* channels, ${all.length - uc} other)`);
