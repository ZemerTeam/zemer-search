// zemer-search — search engine and more for the Zemer app
// https://github.com/ZemerTeam/zemer-search
// Zemer app: https://github.com/ZemerTeam/zemer-app
// Copyright (C) 2026 alltechdev
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See the LICENSE file for details.

// Auto-generate the DATA-DRIVEN Zemer playlists from anonymous usage telemetry (zemer-stats).
//
//   Top 50   (auto-top-50)   — the audience's most-loved songs (a blend of ALL signals, below)
//   Trending (auto-trending) — hot right now (short-window live plays, skip-penalized)
//   Favorites(auto-favorites)— what people SAVE (favorite-primary, download-corroborated)
//
// It fetches the stats server's /stats aggregates, scores every songs by DISTINCT-DEVICE reach (so one
// device looping a song can't inflate it), and writes the results as ordinary `auto-*` playlists into
// data/zemer-playlists.json — then applies the file the normal way (harvester/zemer-playlists.mjs's
// applyZemerPlaylists). The app renders them identically to the hand-curated ones; nothing app-side or
// schema-side changes. Content filters (female/blocked/kidzone/video) are applied DOWNSTREAM by the
// /zemer-playlists reads, so raw ids are safe to store here.
//
// ── Ranking (uses live AND backfill, never summed naively) ────────────────────────────────────────────
//   Backfill = each install's ONE-TIME upload of its pre-existing listen history + currently-liked/
//   downloaded snapshot. It is the DEPTH today (live tracking is only days old) and it GROWS as more users
//   update to the tracking build (currently ~44% of devices have sent it). Live = events since tracking
//   shipped; thin now, grows forever, and is EXPOSURE-BIASED (it partly measures what we surfaced, e.g. a
//   freshly-featured album). So for "most loved", backfill is weighted higher; live earns weight as its
//   reach grows. Each signal is scored by a SHRUNK, saturating reach score  s(d) = d/(d+PRIOR)  — magnitude-
//   aware (17 devices ≠ 12) yet damped at small n, and needs no absolute-magnitude constant that would rot
//   as the corpus grows. Signals that measure the SAME act with TOTAL overlap (live vs backfill favorites)
//   are combined by MAX, not sum (the stats repo warns their overlap is total + un-dedupable).
//
// ── "Just works" guarantees ───────────────────────────────────────────────────────────────────────────
//   • A failed/empty /stats fetch ABORTS without touching the file or DB — last-good playlists stay live.
//   • Owns ONLY the `auto-*` id namespace; hand-curated playlists pass through untouched.
//   • Atomic write (tmp→rename) + no-op when the generated ids are unchanged (no needless index reload).
//   • Self-calibrating weights (evidence-based) + relative thresholds — no re-tuning as data grows.
//
//   STATS_URL=… STATS_KEY=… node harvester/auto-playlists.mjs        # generate + apply
//   DRY=1 …                                                          # print what it would write, no write
import fs from "node:fs";
import { openCorpus, loadZemerPlaylists, applyZemerPlaylists, ZEMER_PLAYLISTS_PATH, ZEMER_PLAYLISTS_AUTO_PATH, ACAPELLA_AUTO_PATH } from "../corpus/store.mjs";

const num = (v, d) => (Number.isFinite(+v) && +v > 0 ? +v : d); // NaN/blank/≤0 env → default (never slice(0,NaN))
const DRY = process.env.DRY === "1";
const STATS_URL = (process.env.STATS_URL || "").replace(/\/+$/, "");
const STATS_KEY = process.env.STATS_KEY || "";
const TOP_N = num(process.env.TOP_N, 50);
const TRENDING_N = num(process.env.TRENDING_N, 25);
const TRENDING_DAYS = num(process.env.TRENDING_DAYS, 7);
const FAV_N = num(process.env.FAV_N, 30);
const ALLTIME_DAYS = 3650; // "all the days we have" — the window just spans everything since launch
const PRIOR = 3; // shrinkage: a 3-device song scores 0.5, small-n songs are damped, needs no max-reach
const TREND_MIN_DEVICES = 3, TREND_MAX_SKIP = 0.5; // trending precision floor
const TREND_SKIP_PENALTY = 0.5; // skip is a HALF-weight dampener on reach (not a full multiplier)

// Signal weights for the loved-score blend. Backfill plays lead (deep + unbiased by our surfacing);
// favorites weigh most per-listener (deliberate intent); live plays are modest + skip-penalized
// (exposure-biased, still thin); downloads are weak corroboration (noisy: auto-download-on-like/retries).
const W = { backPlay: 1.0, livePlay: 0.6, favorite: 1.2, download: 0.3 };

// Misconfiguration (missing key) fails LOUD (exit 1). A benign, self-healing condition (a down/empty /stats,
// or no stats id intersecting the corpus mid-rebuild) leaves the last-good playlists untouched and exits 0 —
// the twice-daily timer just retries next tick, so it must not spam a systemd unit failure.
const die = (msg) => { console.error(`auto-playlists: ${msg}`); process.exit(1); };
const benign = (msg) => { console.warn(`auto-playlists: ${msg}`); process.exit(0); };
if (!STATS_URL || !STATS_KEY) die("STATS_URL and STATS_KEY must be set (see .env) — refusing to run.");

// ── Acapella season (The Three Weeks) ─────────────────────────────────────────────────────────────────
// During the mourning period from 17 Tammuz through 9 Av (Tisha b'Av) observant Jews listen to acapella
// only. We ADD acapella-popularity lists on top of the normal ones (nothing is removed). The window is
// computed from the HEBREW calendar (Intl, offline), so it recurs correctly every year on its own — the
// Gregorian dates drift yearly but 17 Tammuz–9 Av don't. Day granularity (civil midnight in Brooklyn; the
// Hebrew day rolls at sunset, so the boundary can be off by an evening — fine for a day-based gate).
// ACAPELLA_SEASON=on|off forces the state (testing / rabbinic override); NINE_DAYS=1 narrows to 1–9 Av.
function hebDate(d) {
  const p = new Intl.DateTimeFormat("en-u-ca-hebrew", { month: "long", day: "numeric", timeZone: "America/New_York" }).formatToParts(d);
  return { month: p.find((x) => x.type === "month")?.value || "", day: +(p.find((x) => x.type === "day")?.value) };
}
function inThreeWeeks(d = new Date()) {
  const { month, day } = hebDate(d);
  const isTammuz = /^tam+uz$/i.test(month), isAv = month === "Av"; // ICU spells it "Tamuz"; match defensively
  if (process.env.NINE_DAYS === "1") return isAv && day <= 9;
  return (isTammuz && day >= 17) || (isAv && day <= 9);
}
const seasonEnv = (process.env.ACAPELLA_SEASON || "auto").toLowerCase();
const mourning = seasonEnv === "on" ? true : seasonEnv === "off" ? false : inThreeWeeks();
// How many days (incl. today) we're into the current Three Weeks — the /stats window for the acapella lists,
// so they rank by plays FROM the Three Weeks only (no all-time backfill). Grows 1→~22 across the period.
function threeWeeksDays() {
  let n = 0, d = new Date();
  for (let i = 0; i < 30 && inThreeWeeks(d); i++) { n++; d = new Date(d.getTime() - 86400000); }
  return Math.max(n, 1);
}

// The acapella set = the curated `acapella` playlist's `videoIds` PLUS auto-discovered clearly-labeled
// acapella releases (loadZemerPlaylists folds `data/acapella-auto.json` into the acapella entry). We do NOT
// expand the playlist's `albumIds` — album-expansion pulls in unvetted, possibly-non-acapella album tracks.
function acapellaSet() {
  const ac = loadZemerPlaylists().playlists.find((p) => p.id === "acapella");
  return ac ? new Set(ac.videoIds || []) : null;
}

// Recurring auto-add: recent releases whose TITLE clearly says acapella / vocal-version get appended to the
// gitignored acapella-auto list (folded into the curated acapella playlist by loadZemerPlaylists). ONLY clear
// labels — a STRICT marker, so nothing ambiguous is ever added; a rolling window keeps it to NEW releases.
const CLEAR_ACAP = /a[\s-]?c+app?ell?a|\bvocal\s+version\b|\(\s*vocal\s*\)|ווקאל|וואקאל|אקפלה/i;
function scanAcapellaReleases(db) {
  const since = new Date(Date.now() - num(process.env.ACAPELLA_SCAN_DAYS, 60) * 86400000).toISOString().slice(0, 10);
  let curated; try { curated = (JSON.parse(fs.readFileSync(ZEMER_PLAYLISTS_PATH, "utf8")).playlists || []).find((p) => p?.id === "acapella"); } catch { curated = null; }
  let existing = []; try { existing = JSON.parse(fs.readFileSync(ACAPELLA_AUTO_PATH, "utf8")).videoIds || []; } catch { /* first run */ }
  const have = new Set([...(curated?.videoIds || []), ...existing]);
  const rows = db.prepare(`
    SELECT t.videoId, t.title, COALESCE(t.uploadDate, MAX(al.uploadDate)) AS rd
    FROM track t LEFT JOIN album_track at ON at.videoId=t.videoId LEFT JOIN album al ON al.id=at.albumId
    GROUP BY t.videoId HAVING rd IS NOT NULL AND substr(rd,1,10) >= @since`).all({ since });
  const fresh = rows.filter((r) => CLEAR_ACAP.test(r.title || "") && !have.has(r.videoId)).map((r) => r.videoId);
  if (fresh.length && !DRY) {
    const tmp = `${ACAPELLA_AUTO_PATH}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ videoIds: [...existing, ...fresh] }, null, 2) + "\n");
    fs.renameSync(tmp, ACAPELLA_AUTO_PATH);
  }
  return fresh;
}

async function fetchStats(days) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 30000);
  try {
    const res = await fetch(`${STATS_URL}/stats?key=${encodeURIComponent(STATS_KEY)}&days=${days}`, { signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

const s = (d) => (d > 0 ? d / (d + PRIOR) : 0); // shrunk saturating reach score
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// ── fetch (fail-safe: any error → abort, never touch the file/DB) ─────────────────────────────────────
// During the acapella season, also pull a window covering ONLY the Three Weeks so far, so the acapella
// lists rank by plays from the Three Weeks (no all-time backfill).
const SEASON_DAYS = mourning ? threeWeeksDays() : 0;
let all, trend, season = null;
try {
  const reqs = [fetchStats(ALLTIME_DAYS), fetchStats(TRENDING_DAYS)];
  if (mourning) reqs.push(fetchStats(SEASON_DAYS));
  const r = await Promise.all(reqs);
  [all, trend] = r; if (mourning) season = r[2];
} catch (e) { benign(`/stats fetch failed (${e.message}) — leaving existing playlists untouched.`); }
const rows = (o, k) => (Array.isArray(o?.[k]) ? o[k] : []);
if (!rows(all, "topBackfilled").length && !rows(all, "topPlays").length)
  benign("/stats returned no play data — leaving existing playlists untouched.");

// ── corpus membership (only servable ids go in; guarantees the lists actually fill to N) ──────────────
const db = openCorpus();
const inCorpus = new Set(db.prepare("SELECT videoId FROM track").all().map((r) => r.videoId));

// recurring auto-add of clearly-labeled acapella new releases (before ranking, so they're eligible now)
const acapellaAdded = scanAcapellaReleases(db);
if (acapellaAdded.length) console.log(`acapella: +${acapellaAdded.length} clearly-labeled release(s) added to the acapella set`);

// ── per-signal device-reach maps ──────────────────────────────────────────────────────────────────────
const bpDev = new Map(), lpDev = new Map(), lpSkip = new Map(), favDev = new Map(), dlDev = new Map();
for (const r of rows(all, "topBackfilled")) bpDev.set(r.videoId, r.devices || 0);
for (const r of rows(all, "topPlays")) { lpDev.set(r.videoId, r.devices || 0); lpSkip.set(r.videoId, r.skipRate || 0); }
// favorites/downloads: use the BACKFILL snapshot, which carries real distinct-DEVICE reach (`r.id` = videoId).
// Live topActions is intentionally NOT folded in: the stats server emits only a raw event COUNT (`n`, not
// devices) for it, and mixing a count into a device-reach score would over-rank a song one device saved many
// times — the exact inflation the device-reach ranking exists to prevent. (Live favorites are negligible today
// and would need per-device counts from the stats server to fold in correctly.)
for (const r of rows(all, "topActionsBackfilled")) {
  const m = r.kind === "favorite" ? favDev : r.kind === "download" ? dlDev : null;
  if (m) m.set(r.id, Math.max(m.get(r.id) || 0, r.devices || 0));
}

// ── Top 50 = most PLAYED. PLAYS DOMINATE; favorites (then downloads) ONLY BREAK TIES ──────────────────
// Primary sort = play reach (all-time backfill + recent live, device-reach, live plays skip-penalized).
// Secondary sort = favorites/downloads — so a song can only be reordered by favorites against another song
// with the SAME play score. A 6-play song can NEVER leapfrog a 17-play song on favorites (the old blended
// score let it, which is why Top 50 didn't match the play data). Favorites also have their own dedicated list.
const candidates = new Set([...bpDev.keys(), ...lpDev.keys(), ...favDev.keys(), ...dlDev.keys()].filter((v) => inCorpus.has(v)));
// Fail-safe: a valid /stats whose ids don't intersect the corpus (e.g. corpus.db mid-rebuild, or a stats
// schema change that renamed the id field) would otherwise yield empty lists and WIPE the live auto rows.
// Leave last-good untouched instead.
if (!candidates.size) benign("no /stats ids intersect the corpus — leaving existing playlists untouched.");
const loved = [...candidates].map((v) => ({
  v,
  play: W.backPlay * s(bpDev.get(v) || 0)
      + W.livePlay * s(lpDev.get(v) || 0) * (1 - clamp(lpSkip.get(v) || 0, 0, 0.8)),
  tie: W.favorite * s(favDev.get(v) || 0) + W.download * s(dlDev.get(v) || 0), // tiebreak only
})).sort((a, b) => b.play - a.play || b.tie - a.tie);

const top50 = loved.slice(0, TOP_N).map((x) => x.v);

// ── trending = short-window live plays, REACH-PRIMARY, skip a light quality dampener, precision-floored ─
// A user reading "Trending" expects reach ("lots of people are playing this"), so distinct-device reach is
// the primary sort — NOT the shrunk/saturated reach used for the loved-score (which would let a strong
// finish-rate on a small audience beat a much larger one). Skip is a HALF-weight penalty (docks up to 50%)
// plus the <0.5 floor, so a genuinely skipped track is demoted/removed but a popular one with some skips
// still leads. (Velocity — reach growth week-over-week — is the truer trending signal, but needs ≥2 weeks
// of live history; revisit once the data supports it.)
const trendingIds = rows(trend, "topPlays")
  .filter((r) => inCorpus.has(r.videoId) && (r.devices || 0) >= TREND_MIN_DEVICES && (r.skipRate || 0) < TREND_MAX_SKIP)
  .map((r) => ({ v: r.videoId, score: (r.devices || 0) * (1 - TREND_SKIP_PENALTY * clamp(r.skipRate || 0, 0, 1)) }))
  .sort((a, b) => b.score - a.score).slice(0, TRENDING_N).map((x) => x.v);

// ── favorites = favorite-primary, download-corroborated ───────────────────────────────────────────────
const favRanked = [...new Set([...favDev.keys(), ...dlDev.keys()])].filter((v) => inCorpus.has(v))
  .map((v) => ({ v, score: W.favorite * s(favDev.get(v) || 0) + W.download * s(dlDev.get(v) || 0) }))
  .filter((x) => (favDev.get(x.v) || 0) > 0) // must have at least one real favorite; downloads alone are too noisy to seed
  .sort((a, b) => b.score - a.score);
const favIds = favRanked.slice(0, FAV_N).map((x) => x.v);

// ── acapella season: ADD an acapella list on top. Two hard rules: (1) ONLY songs hand-listed in the curated
// acapella playlist, and (2) ranked by plays FROM THE THREE WEEKS ONLY (the `season` window — NO all-time
// backfill, NO favorites/downloads) — so it reflects what people are actually playing this season. Reach-
// primary with a light skip dampener (same as Trending). Nothing is removed; it disappears after Tisha b'Av.
const acap = mourning ? acapellaSet() : null;
const acBlocks = [];
if (acap && acap.size && season) {
  const acTop = rows(season, "topPlays")
    .filter((r) => acap.has(r.videoId) && inCorpus.has(r.videoId) && (r.devices || 0) >= 1)
    .map((r) => ({ v: r.videoId, score: (r.devices || 0) * (1 - TREND_SKIP_PENALTY * clamp(r.skipRate || 0, 0, 1)) }))
    .sort((a, b) => b.score - a.score).slice(0, TOP_N).map((x) => x.v);
  if (acTop.length) acBlocks.push({ id: "auto-acapella-top-50", title: "Acapella Top 50", videoIds: acTop });
}

// ── the auto blocks (acapella-season lists FIRST when active, empty videoId lists dropped) ─────────────
const autoBlocks = [
  ...acBlocks, // acapella season: on top so the app surfaces them first; [] outside the Three Weeks
  { id: "auto-top-50", title: "Top 50", videoIds: top50 },
  { id: "auto-trending", title: "Trending", videoIds: trendingIds },
  { id: "auto-favorites", title: "Favorites", videoIds: favIds },
].filter((b) => b.videoIds.length);

// "Year of <Y>" — a DYNAMIC year rule (no telemetry: the store computes everything released this year at
// read time, newest first, growing with each harvest). Emitted here so it's part of the auto-managed set on
// the same schedule and AUTO-ROLLS to the current UTC year — nobody edits it annually. YEAR pins it; YEAR_PLAYLIST=0 disables.
const YEAR = num(process.env.YEAR, new Date().getUTCFullYear());
if (process.env.YEAR_PLAYLIST !== "0") autoBlocks.push({ id: `auto-year-${YEAR}`, title: `Year of ${YEAR}`, year: YEAR });

// The auto file holds ONLY the auto-* blocks; the hand-curated file is never touched here. The loader
// (loadZemerPlaylists) merges the two, so the apply below writes the full union — curated stays pristine
// and committed, the auto file is gitignored + regenerated by this timer (deploy = `git pull` never clashes).
const autoDoc = { playlists: autoBlocks };

// change-gate: no-op when the generated auto file is byte-identical (avoids a needless index reload) — but
// still (re)apply if the DB has lost the auto rows (e.g. corpus.db was rebuilt from scratch since last run).
const nextJson = JSON.stringify(autoDoc, null, 2) + "\n";
const prevJson = (() => { try { return fs.readFileSync(ZEMER_PLAYLISTS_AUTO_PATH, "utf8"); } catch { return ""; } })();
const dbHasAuto = db.prepare("SELECT 1 FROM zemer_playlist WHERE id LIKE 'auto-%' LIMIT 1").get();
const changed = nextJson !== prevJson || (autoBlocks.length && !dbHasAuto) || acapellaAdded.length > 0;

for (const b of autoBlocks) console.log(`  ${b.id} — "${b.title}"  ${b.year ? `dynamic (year ${b.year})` : `${b.videoIds.length} track(s)`}`);
console.log(`auto-playlists: ${autoBlocks.length} auto list(s)${mourning ? `  [acapella season — ${hebDate(new Date()).month} ${hebDate(new Date()).day}]` : ""}${DRY ? "  [DRY]" : ""}${changed ? "" : "  [unchanged — no write]"}`);

if (DRY || !changed) process.exit(0);

// Apply FIRST, commit the auto file only on success — if applyZemerPlaylists throws (e.g. a bad hand-curated
// entry), the DB rolls back AND the auto file is left unchanged, so the next run retries (no silent file/DB
// drift). `curated` comes from loadZemerPlaylists (which already folds in acapella-auto, written above) with
// its auto-* blocks stripped, then combined with THIS run's freshly-built autoBlocks.
const curated = loadZemerPlaylists().playlists.filter((p) => !String(p.id || "").startsWith("auto-"));
const r = applyZemerPlaylists(db, { playlists: [...autoBlocks, ...curated] }, { dry: false });

const tmp = `${ZEMER_PLAYLISTS_AUTO_PATH}.tmp-${process.pid}`;
fs.writeFileSync(tmp, nextJson);
fs.renameSync(tmp, ZEMER_PLAYLISTS_AUTO_PATH);

console.log(`applied: ${r.playlists} playlist(s), ${r.items} item(s) → corpus.db (API reloads on its next tick)`);
if (r.missing.length) console.warn(`⚠ ${r.missing.length} id(s) not in the corpus yet (they'll serve once harvested).`);
