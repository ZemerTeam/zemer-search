// Shabbat/Yom-Tov quiet gate for the maintenance jobs — keeps refresh/overrides/playlists from running from
// 20 min BEFORE candle lighting until havdalah, using ACCURATE weekly times for Brooklyn, NY from the Hebcal
// Shabbat API (zmanim-derived: candle lighting = 18 min before sunset, havdalah = nightfall). Times shift week
// to week, so a static systemd OnCalendar can't be right — the timers run all week and each maintenance
// service gates on this via `ExecCondition=/usr/bin/env node harness/shabbat.mjs` (exit 0 = run, 1 = skip).
//
// Robustness: times are cached to data/shabbat.json and only re-fetched when stale — the frequent timers keep
// the cache warm, so NO network call is made on Shabbos itself. If Hebcal is unreachable with no cache, it
// FAILS SAFE to a conservative static NY window (Fri 15:00 → Sat 22:00 ET) rather than risk running on Shabbos.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CACHE = process.env.SHABBAT_CACHE || path.join(ROOT, "data", "shabbat.json");
const GEONAMEID = process.env.SHABBAT_GEONAMEID || "5110302"; // Brooklyn, New York
const HEBCAL_URL = `https://www.hebcal.com/shabbat?cfg=json&geonameid=${GEONAMEID}&M=on&lg=s`;
const PRE_BUFFER_MS = 20 * 60 * 1000; // stop this long BEFORE candle lighting
const REFETCH_AGE_MS = 6 * 24 * 3600 * 1000; // refresh the cache at least weekly

// --- pure helpers (unit-tested) ---

// Hebcal items → quiet windows [{start, end, label}] in epoch-ms. Each `candles` opens a window that closes at
// the next `havdalah` (so a multi-day Yom Tov spans one continuous window). start = candle lighting − buffer.
export function parseShabbatWindows(json, preBufferMs = PRE_BUFFER_MS) {
  const items = (json && Array.isArray(json.items)) ? json.items : [];
  const windows = [];
  let open = null;
  for (const it of items) {
    const t = Date.parse(it.date); // ISO with offset → correct UTC ms
    if (!Number.isFinite(t)) continue;
    if (it.category === "candles") { if (open === null) open = t; }
    else if (it.category === "havdalah" && open !== null) {
      windows.push({ start: open - preBufferMs, end: t, label: it.title || "Shabbat" });
      open = null;
    }
  }
  return windows;
}

export function isQuiet(windows, now) {
  return (windows || []).some((w) => now >= w.start && now < w.end);
}

// Conservative timezone fallback when Hebcal is unavailable and there's no cache: Fri 15:00 → Sat 22:00 ET.
export function roughlyShabbat(now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", hour: "2-digit", hour12: false,
  }).formatToParts(new Date(now)).map((p) => [p.type, p.value]));
  const dow = parts.weekday, hour = Number(parts.hour) % 24;
  return (dow === "Fri" && hour >= 15) || (dow === "Sat" && hour < 22);
}

// --- IO ---

function readCache(cachePath) {
  try { const c = JSON.parse(fs.readFileSync(cachePath, "utf8")); return (c && Array.isArray(c.windows)) ? c : null; }
  catch { return null; }
}

async function getWindows(now, { cachePath, fetchImpl }) {
  const cache = readCache(cachePath);
  const lastEnd = cache && cache.windows.length ? Math.max(...cache.windows.map((w) => w.end)) : 0;
  const fresh = cache && now <= lastEnd && (now - (cache.fetchedAt || 0)) < REFETCH_AGE_MS;
  if (fresh) return cache.windows; // warm all week by the frequent timers → no fetch on Shabbos
  try {
    const windows = parseShabbatWindows(await fetchImpl());
    if (!windows.length) throw new Error("no candle/havdalah items in Hebcal response");
    try { fs.mkdirSync(path.dirname(cachePath), { recursive: true }); fs.writeFileSync(cachePath, JSON.stringify({ fetchedAt: now, geonameid: GEONAMEID, windows })); } catch {}
    return windows;
  } catch (e) {
    console.warn(`  shabbat: Hebcal fetch failed (${e.message}) — using ${cache ? "stale cache" : "static fallback"}`);
    return cache ? cache.windows : null;
  }
}

// Returns { quiet, label?, until?, fallback? }. `until` = havdalah (resume time). Never throws.
export async function shabbatQuiet(now = Date.now(), opts = {}) {
  const cachePath = opts.cachePath || CACHE;
  const fetchImpl = opts.fetchImpl || (async () => (await fetch(HEBCAL_URL, { signal: AbortSignal.timeout(10000) })).json());
  const windows = await getWindows(now, { cachePath, fetchImpl });
  if (windows) {
    const w = windows.find((x) => now >= x.start && now < x.end);
    return w ? { quiet: true, label: w.label, until: w.end } : { quiet: false };
  }
  return roughlyShabbat(now) ? { quiet: true, label: "Shabbat (static fallback — Hebcal unavailable)", fallback: true } : { quiet: false, fallback: true };
}

// CLI gate: `node harness/shabbat.mjs` → exit 0 = OK to run, exit 1 = quiet (systemd ExecCondition skips the unit).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = await shabbatQuiet();
  if (r.quiet) console.error(`shabbat: quiet${r.label ? ` (${r.label})` : ""}${r.until ? `, resume ~${new Date(r.until).toISOString()}` : ""} — skipping maintenance`);
  process.exit(r.quiet ? 1 : 0);
}
