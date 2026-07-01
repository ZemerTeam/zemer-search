// Polite, cached HTTP layer for all YouTube calls. Protects the source IP:
//   - Disk cache keyed by (method+url+body): a response is fetched AT MOST ONCE, ever. Re-runs, resumes,
//     and dev iterations are served entirely from cache → zero repeat traffic. Cache HITS are unlimited
//     and instant — they bypass the limiter completely.
//   - Bounded-concurrency, rate-paced limiter for LIVE requests: at most CONCURRENCY requests in flight
//     (default 1 = single-flight), AND each live start is reserved a slot ≥ MIN_INTERVAL_MS + jitter
//     after the previous, so the aggregate live rate is capped (~1/interval) NO MATTER the concurrency —
//     parallelism only overlaps request latency, it never bursts past the paced rate. Defaults stay the
//     historical single-flight + ≥0.9s; opt into speed with CONCURRENCY>1 + a smaller MIN_INTERVAL_MS
//     (still bounded + paced — IP-safe, just not serial).
//   - Anti-bot circuit breaker: the first "Sorry…" challenge latches a back-off (BLOCK_COOLDOWN_MS) that
//     short-circuits every pending + new live request to {blocked:true} — so the in-flight concurrency
//     can't keep hammering a flagged IP. Callers still abort on the first block; the latch auto-clears
//     after the cooldown so a long-lived process (the API) recovers on its own.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.resolve(HERE, "../data/.httpcache");
const MIN_INTERVAL_MS = Number(process.env.MIN_INTERVAL_MS || 900); // min gap between LIVE request starts
const JITTER_MS = Number(process.env.JITTER_MS || 500);
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 1)); // max live requests in flight
const BLOCK_COOLDOWN_MS = Number(process.env.BLOCK_COOLDOWN_MS || 300000); // back-off after an anti-bot page
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");

let liveCount = 0;
let cacheHits = 0;
let blockedCount = 0;
let blockedUntil = 0; // anti-bot latch: while now < blockedUntil, no live requests fire

// Bounded-concurrency, rate-paced scheduler for LIVE requests. Up to CONCURRENCY run at once; each start
// reserves a slot ≥ MIN_INTERVAL_MS + jitter after the previous, so the aggregate START rate is capped
// (~1/interval) regardless of concurrency. Concurrency only overlaps latency — it never bursts.
let inFlight = 0;
let nextSlot = 0;
const queue = [];
function pump() {
  while (inFlight < CONCURRENCY && queue.length) {
    const job = queue.shift();
    inFlight++;
    run(job);
  }
}
async function run({ task, resolve }) {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + MIN_INTERVAL_MS + Math.floor(Math.random() * JITTER_MS); // reserve a paced slot
  if (at > now) await sleep(at - now);
  try { resolve(await task()); }
  finally { inFlight--; pump(); }
}
function scheduleLive(task) {
  return new Promise((resolve) => { queue.push({ task, resolve }); pump(); });
}

export async function cachedPost(url, headers, bodyObj, { maxAgeMs = Infinity, cacheOnly = false } = {}) {
  const body = JSON.stringify(bodyObj);
  // Cache entries are gzipped (browse JSON compresses ~10x) to keep disk usage small.
  const file = path.join(CACHE_DIR, sha1(`POST ${url} ${body}`) + ".json.gz");
  if (fs.existsSync(file)) {
    // maxAgeMs lets maintenance re-fetch stale pages (e.g. an artist landing page, to catch new
    // releases) while immutable pages (albums) keep their forever-cache (default Infinity).
    const fresh = maxAgeMs === Infinity || (Date.now() - fs.statSync(file).mtimeMs) <= maxAgeMs;
    if (fresh) {
      try {
        const json = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString("utf8"));
        // A previously-cached SOFT bot-gate response (see below) is a masked block, not an answer — treat it
        // as a miss so a later run can retry live (the successful response then overwrites this entry).
        if (!(json?.playabilityStatus?.reason && /confirm you.?re not a bot/i.test(json.playabilityStatus.reason))) {
          cacheHits++;
          return { json, cached: true };
        }
      } catch { /* corrupt cache entry → refetch */ }
    }
  }
  // Cache-only readers (e.g. offline report generation alongside a live run) never issue a live request.
  if (cacheOnly) return { miss: true, status: 0 };
  // Circuit breaker: after an anti-bot page, don't issue more live requests until the cooldown expires.
  if (Date.now() < blockedUntil) return { blocked: true, status: 0 };
  return scheduleLive(async () => {
    let res, txt;
    try {
      res = await fetch(url, { method: "POST", headers, body });
      txt = await res.text();
    } catch (e) {
      return { error: e.message, networkError: true };
    }
    if (txt.startsWith("<")) { blockedCount++; blockedUntil = Date.now() + BLOCK_COOLDOWN_MS; return { blocked: true, status: res.status }; }
    let json;
    try { json = JSON.parse(txt); } catch (e) { return { error: "non-JSON response", status: res.status }; }
    // The SOFT anti-bot gate: a valid 200 JSON whose playabilityStatus says "Sign in to confirm you're not a
    // bot" (seen on /player mid-sweep). It's a block, not an answer — latch the same cooldown and, crucially,
    // do NOT cache it (a cached gate response would permanently mask the real answer on re-runs).
    if (json?.playabilityStatus?.reason && /confirm you.?re not a bot/i.test(json.playabilityStatus.reason)) {
      blockedCount++; blockedUntil = Date.now() + BLOCK_COOLDOWN_MS;
      return { blocked: true, status: res.status };
    }
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, zlib.gzipSync(JSON.stringify(json)));
    fs.renameSync(tmp, file); // atomic
    liveCount++;
    return { json, status: res.status, cached: false };
  });
}

export const netStats = () => ({ liveCount, cacheHits, blockedCount });
