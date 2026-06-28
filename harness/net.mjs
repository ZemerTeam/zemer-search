// Polite, cached HTTP layer for all YouTube calls. Protects the source IP:
//   - Disk cache keyed by (method+url+body): a response is fetched AT MOST ONCE, ever. Re-runs,
//     resumes, and development iterations are served entirely from cache → zero repeat traffic.
//   - Single-flight queue with a minimum inter-request interval + jitter (no bursting, concurrency 1).
//   - Anti-bot ("Sorry…" HTML) detection → caller backs off; never cached, never retried in a tight loop.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.resolve(HERE, "../data/.httpcache");
const MIN_INTERVAL_MS = Number(process.env.MIN_INTERVAL_MS || 900); // ≥0.9s between live requests
const JITTER_MS = Number(process.env.JITTER_MS || 500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");

let lastLiveAt = 0;
let queue = Promise.resolve();
let liveCount = 0;
let cacheHits = 0;
let blockedCount = 0;

// Serialize live requests with a paced interval (cache hits bypass the queue entirely).
function scheduleLive(task) {
  const p = queue.then(async () => {
    const since = Date.now() - lastLiveAt;
    const wait = MIN_INTERVAL_MS - since;
    if (wait > 0) await sleep(wait);
    await sleep(Math.floor(Math.random() * JITTER_MS));
    lastLiveAt = Date.now();
    return task();
  });
  queue = p.then(() => {}, () => {});
  return p;
}

export async function cachedPost(url, headers, bodyObj, { maxAgeMs = Infinity } = {}) {
  const body = JSON.stringify(bodyObj);
  // Cache entries are gzipped (browse JSON compresses ~10x) to keep disk usage small.
  const file = path.join(CACHE_DIR, sha1(`POST ${url} ${body}`) + ".json.gz");
  if (fs.existsSync(file)) {
    // maxAgeMs lets maintenance re-fetch stale pages (e.g. an artist landing page, to catch new
    // releases) while immutable pages (albums) keep their forever-cache (default Infinity).
    const fresh = maxAgeMs === Infinity || (Date.now() - fs.statSync(file).mtimeMs) <= maxAgeMs;
    if (fresh) {
      cacheHits++;
      try { return { json: JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString("utf8")), cached: true }; }
      catch { /* corrupt cache entry → refetch */ }
    }
  }
  return scheduleLive(async () => {
    let res, txt;
    try {
      res = await fetch(url, { method: "POST", headers, body });
      txt = await res.text();
    } catch (e) {
      return { error: e.message, networkError: true };
    }
    if (txt.startsWith("<")) { blockedCount++; return { blocked: true, status: res.status }; }
    let json;
    try { json = JSON.parse(txt); } catch (e) { return { error: "non-JSON response", status: res.status }; }
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, zlib.gzipSync(JSON.stringify(json)));
    fs.renameSync(tmp, file); // atomic
    liveCount++;
    return { json, status: res.status, cached: false };
  });
}

export const netStats = () => ({ liveCount, cacheHits, blockedCount });
