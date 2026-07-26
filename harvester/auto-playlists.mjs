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
import { openCorpus, loadZemerPlaylists, applyZemerPlaylists, applyHomeRank, setMeta, ZEMER_PLAYLISTS_PATH, ZEMER_PLAYLISTS_AUTO_PATH, ACAPELLA_AUTO_PATH, AUTO_HISTORY_PATH } from "../corpus/store.mjs";
import { dupKey, dedupRanked } from "./dedup.mjs";
import { pickBaseline, windowCleanOfSeason, exposureMult, exposureGate, EXPOSURE_DEFAULTS, baselineReach, cappedLookup } from "./trending.mjs";
import { hebDate, inThreeWeeks, seasonActive } from "../corpus/season.mjs";
import { LEGACY_FORMULA } from "../server/chart-badges.mjs";

const num = (v, d) => (Number.isFinite(+v) && +v > 0 ? +v : d); // NaN/blank/≤0 env → default (never slice(0,NaN))
// Same, but 0 is a MEANINGFUL value (e.g. "require no coverage at all" during a staged rollout). Only
// blank/NaN/negative fall back — `Number(x) || d` would silently swallow a deliberate 0 AND let a
// negative through, which for a threshold means the check can never fire.
const num0 = (v, d) => (Number.isFinite(+v) && +v >= 0 && String(v).trim() !== "" ? +v : d);
const DRY = process.env.DRY === "1";
const STATS_URL = (process.env.STATS_URL || "").replace(/\/+$/, "");
const STATS_KEY = process.env.STATS_KEY || "";
const TOP_N = num(process.env.TOP_N, 50);
const TRENDING_N = num(process.env.TRENDING_N, 25);
const TRENDING_DAYS = num(process.env.TRENDING_DAYS, 7);
// Exposure is measured over a DELIBERATELY LONGER window than the ranking window. Exposure and rank feed
// each other — a song ranks high, so we show it at the top of a chart, so it accrues exposure from that
// placement, so it is docked harder, so it ranks lower, so it is shown less… That loop is negative
// (self-stabilising, and exactly the correction the dampener exists to make), but if exposure tracked the
// same 7-day window as the ranking it could OSCILLATE with a period near the weekly badge anchor: a song
// near the docking threshold would show ▲6 one week and ▼6 the next with no change in real demand. A
// slow-moving exposure estimate damps that: rank can move week to week while exposure barely does.
const EXPOSURE_DAYS = num(process.env.EXPOSURE_DAYS, 28);
const FAV_N = num(process.env.FAV_N, 30);
const DOWNLOADED_N = num(process.env.DOWNLOADED_N, 30);
// People download whole ALBUMS at once, so a downloaded album gives every one of its tracks equal download
// reach — raw per-track ranking is one album exploded into rows. Keep at most this many tracks PER ALBUM
// (1 = one representative per album). Standalone singles (no album) aren't bursts and are never capped.
const DOWNLOADED_MAX_PER_ALBUM = num(process.env.DOWNLOADED_MAX_PER_ALBUM, 1);
const ALLTIME_DAYS = 3650; // "all the days we have" — the window just spans everything since launch
const PRIOR = 3; // shrinkage: a 3-device song scores 0.5, small-n songs are damped, needs no max-reach
const TREND_MIN_DEVICES = 3, TREND_MAX_SKIP = 0.5; // trending precision floor
const TREND_SKIP_PENALTY = 0.5; // skip is a HALF-weight dampener on reach (not a full multiplier)
// rank-history sidecar (written by recordHistory below; read here as the velocity-Trending baseline).
// Path comes from corpus/store.mjs so the API (the badge reader) and this writer can never diverge.
const HISTORY_PATH = AUTO_HISTORY_PATH;
const HISTORY_DAYS = num(process.env.HISTORY_DAYS, 60);

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
// only. We ADD acapella-popularity lists on top of the normal ones (nothing is removed). The window logic
// lives in corpus/season.mjs (shared with loadZemerPlaylists, which uses the SAME gate to seasonally
// retire curated entries marked `"season": "three-weeks"` — e.g. the browsable Acapella playlist).
// ACAPELLA_SEASON=on|off forces the state (testing / rabbinic override); NINE_DAYS=1 narrows to 1–9 Av.
const mourning = seasonActive("three-weeks");
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

// The MASTER curated acapella playlist's videoIds — read UN-GATED, straight from data/zemer-playlists.json,
// NOT via loadZemerPlaylists (which seasonally RETIRES the acapella entry off-season, exactly when we still
// need it: right after the Three Weeks the seasonal acapella surge is still inside Trending's 7-day window).
// Used to keep acapella OUT of the regular Trending list year-round (acapella has its own seasonal list).
// videoIds only — these are the hand-vetted acapella tracks; we do NOT expand albumIds (they can carry
// non-acapella album members, same caution as acapellaSet). Empty set on any read error → no-op (safe).
function masterAcapellaIds() {
  try {
    const ac = (JSON.parse(fs.readFileSync(ZEMER_PLAYLISTS_PATH, "utf8")).playlists || []).find((p) => p?.id === "acapella");
    return new Set(ac?.videoIds || []);
  } catch { return new Set(); }
}

// Recurring auto-add: recent releases whose TITLE clearly says acapella / vocal-version get appended to the
// gitignored acapella-auto list (folded into the curated acapella playlist by loadZemerPlaylists). ONLY clear
// labels — a STRICT marker, so nothing ambiguous is ever added; a rolling window keeps it to NEW releases.
// (Deliberately STRICTER than dedup.mjs's acapella VARIANT class: this ADMITS songs into the acapella set,
// where a false positive pollutes; that one only DISTINGUISHES variants, where over-matching is harmless.)
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

// Near-dup guard (see dedup.mjs): the same song re-uploaded under another videoId must not take two chart
// slots. Applied to every ranked list BEFORE its slice, so a dropped duplicate frees the slot for the next
// song. Keyed by artist + traits + variant markers + normalized title; the traits distinguish what the
// title can't — isVideo (a cross-listed music VIDEO is a different recording than the audio song) and
// curated-acapella membership (an UNLABELED acapella version has an identical title). An id not in the
// corpus keys to itself (kept).
const dupMeta = db.prepare("SELECT title, artistId, isVideo FROM track WHERE videoId=?");
const acapForKey = acapellaSet() || new Set();
const dupKeyCache = new Map();
const keyOf = (x) => {
  const v = x.v;
  if (!dupKeyCache.has(v)) {
    const r = dupMeta.get(v);
    const traits = r ? `${r.isVideo ? "v" : ""}${acapForKey.has(v) ? "a" : ""}` : "";
    dupKeyCache.set(v, r ? dupKey(r.title, r.artistId, traits) : v);
  }
  return dupKeyCache.get(v);
};

// recurring auto-add of clearly-labeled acapella new releases (before ranking, so they're eligible now)
const acapellaAdded = scanAcapellaReleases(db);
if (acapellaAdded.length) console.log(`acapella: +${acapellaAdded.length} clearly-labeled release(s) added to the acapella set`);

// ── per-signal device-reach maps ──────────────────────────────────────────────────────────────────────
const bpDev = new Map(), lpDev = new Map(), lpSkip = new Map(), favDev = new Map(), dlDev = new Map();
for (const r of rows(all, "topBackfilled")) bpDev.set(r.videoId, r.devices || 0);
for (const r of rows(all, "topPlays")) { lpDev.set(r.videoId, r.devices || 0); lpSkip.set(r.videoId, r.skipRate || 0); }
// favorites/downloads: the BACKFILL snapshot MAX-merged with LIVE actions, both on the same distinct-
// DEVICE-reach axis (`r.id`/`r.devices`; the stats server emits per-device counts on live topActions since
// 2026-07-16 — before that only a raw event count existed, which could not be mixed into a reach score).
// MAX, never sum: the overlap is TOTAL and un-dedupable from aggregates (every favorite since live tracking
// began also lands in a later install's backfill snapshot — the stats repo's standing warning). A row from
// an older stats server has no `devices` field → 0 → a no-op (backfill-only, the old behavior).
for (const src of ["topActionsBackfilled", "topActions"]) for (const r of rows(all, src)) {
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

const top50 = dedupRanked(loved, keyOf).slice(0, TOP_N).map((x) => x.v);

// ── trending = short-window live plays, skip a light quality dampener, precision-floored ──────────────
// Two ranking modes (both device-reach-based, never raw counts):
//   VELOCITY (the default once data allows — future-plans #1): primary sort = reach GROWTH week-over-week
//   (current window devices − the same song's devices in the sidecar snapshot nearest T−7d, floored at 0 —
//   a new-to-chart song's full reach IS its growth). "Trending" = accelerating, not merely big: a perennial
//   #1 with flat reach yields to a genuinely surging song. Engages ONLY when a comparable baseline exists
//   (same window, within tolerance) AND both compared windows are fully clear of The Three Weeks
//   (windowCleanOfSeason — the SELF-ACTIVATING seasonal guard, Hebrew-calendar-recurring: the acapella
//   season skews both sides of a cross-season growth comparison, so velocity suspends for the season plus
//   the following two windows every year, and re-engages on its own).
//   REACH (the standing fallback + the velocity tiebreak): distinct-device reach — "lots of people are
//   playing this" — NOT the shrunk/saturated reach of the loved-score (which would let a strong finish-rate
//   on a small audience beat a much larger one). Skip is a HALF-weight penalty (docks up to 50%) plus the
//   <0.5 floor, so a genuinely skipped track is demoted/removed but a popular one with some skips leads.
// EXPOSURE dampener (future-plans #3): both modes multiply in exposureMult — a song the app broadly
// SURFACED (per-device impression reach from /stats topImpressions) must out-play its exposure to trend.
// DORMANT (multiplier 1, byte-identical ranking) until app builds ship impression events.
// Exposure gating: NEVER auto-engage. Requires an explicit EXPOSURE_DAMPENER=on (a permanent kill
// switch) AND enough of the playing population to actually report impressions — partial instrumentation
// would dock the surfaces that happen to be wired first and leave the rest untouched, which is worse
// than not correcting at all. Thresholds are tunable; see trending.mjs exposureGate.
// Exposure comes from its OWN longer window (see EXPOSURE_DAYS) — fetched only when the dampener is
// enabled, since it is dormant otherwise. A failure here disables dampening for this run rather than
// aborting: exposure is a refinement, and losing it must never cost the playlists a regeneration.
let expWin = null;
if (process.env.EXPOSURE_DAMPENER === "on") {
  try { expWin = await fetchStats(EXPOSURE_DAYS); }
  catch (e) { console.warn(`auto-playlists: exposure window fetch failed (${e.message}) — dampener off this run.`); }
}
const expRows = rows(expWin, "topImpressions");
const imprDevices = expWin?.window?.impressionDevices || 0;
const gate = exposureGate({
  enabled: process.env.EXPOSURE_DAMPENER === "on",
  // a fetch failure is NOT "the flag isn't set" — saying so sends the operator debugging the deployment
  unavailable: process.env.EXPOSURE_DAMPENER === "on" && !expWin ? `exposure window (${EXPOSURE_DAYS}d) unavailable this run` : null,
  impressionDevices: imprDevices,
  playDevices: expWin?.window?.playDevices || 0, // same window as the numerator — a coherent share
  // The surfaces the SHIPPED app version instruments, declared by the app side (comma-separated; a
  // trailing ":" is a prefix, e.g. "home:" covers every per-section home row). Every one must actually
  // be reporting before exposure may touch ranking — see exposureGate.
  requiredSurfaces: (process.env.EXPOSURE_REQUIRED_SURFACES || "").split(",").map((x) => x.trim()).filter(Boolean),
  surfaces: rows(expWin, "impressionSurfaces"),
  minCoverage: num0(process.env.EXPOSURE_MIN_COVERAGE, EXPOSURE_DEFAULTS.minCoverage),
  minDevices: num0(process.env.EXPOSURE_MIN_DEVICES, EXPOSURE_DEFAULTS.minDevices),
  minSurfaceDevices: num0(process.env.EXPOSURE_MIN_SURFACE_DEVICES, EXPOSURE_DEFAULTS.minSurfaceDevices),
});
// cappedLookup, not a raw map: topImpressions is a LIMIT-200 list, so an absent id means "at most the
// smallest listed exposure", never "unexposed" — else the songs just below the cutoff would be the only
// undocked ones on the chart (the stats server's contract: absent = no data, NOT zero exposure).
const expReach = gate.on && expRows.length ? cappedLookup(expRows.map((r) => [r.videoId, r.devices || 0])) : null;
const mult = expReach ? (v) => exposureMult(expReach(v), imprDevices) : () => 1;

// the SAME gate every other seasonal path uses (seasonActive honors ACAPELLA_SEASON=on|off; the bare
// inThreeWeeks predicate would ignore a forced season and engage velocity on exactly the skewed data
// the guard exists to exclude).
const inSeason = (d) => seasonActive("three-weeks", d);
let velocityBase = null;
if (windowCleanOfSeason(Date.now(), TRENDING_DAYS, inSeason)) {
  let hist = null;
  try { hist = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8")); } catch { /* no/corrupt sidecar → reach mode */ }
  // one FULL window back, not a hardcoded 7 days: at the default TRENDING_DAYS=7 these are identical,
  // but a changed window would otherwise overlap itself (double-counting a surge into a Δ of ~0) or
  // leave an unobserved gap between the compared windows.
  const cand = pickBaseline(hist?.runs, Date.now() - TRENDING_DAYS * 86400000, TRENDING_DAYS);
  if (cand && windowCleanOfSeason(Date.parse(cand.t), cand.trendWindowDays, inSeason)) velocityBase = cand;
}
const prevReach = baselineReach(velocityBase?.topPlays7d);
const dampSkip = (r) => 1 - TREND_SKIP_PENALTY * clamp(r.skipRate || 0, 0, 1);
const reachScore = (r) => (r.devices || 0) * dampSkip(r) * mult(r.videoId);
// Acapella belongs to the seasonal Acapella lists, not the general Trending or Top Downloaded rows — keep
// the master curated acapella set OUT of both year-round (esp. post-season, when the Three-Weeks surge is
// still in-window). Shared by trendRanked and dlRanked below.
const acapExclude = masterAcapellaIds();
const trendRanked = rows(trend, "topPlays")
  .filter((r) => inCorpus.has(r.videoId) && !acapExclude.has(r.videoId) && (r.devices || 0) >= TREND_MIN_DEVICES && (r.skipRate || 0) < TREND_MAX_SKIP)
  .map((r) => ({
    v: r.videoId,
    score: velocityBase
      ? Math.max(0, (r.devices || 0) - prevReach(r.videoId)) * dampSkip(r) * mult(r.videoId)
      : reachScore(r),
    tie: reachScore(r), // velocity ties (incl. the flat steady-state where every Δ=0) fall back to reach order
  }))
  .sort((a, b) => b.score - a.score || b.tie - a.tie);
const trendingIds = dedupRanked(trendRanked, keyOf).slice(0, TRENDING_N).map((x) => x.v);
// Signature of the ranking formula behind THIS run — recorded with the ordering so the chart-movement
// badges never compare across a formula change (they reset instead). See server/chart-badges.mjs.
// One signature PER LIST, covering the knobs that determine that list's ORDER (not its length, and not
// the acapella window's day count, which grows by design). Trending's mode never touches the others.
const LOVED_SIG = `loved|b${W.backPlay},l${W.livePlay},f${W.favorite},d${W.download}|prior${PRIOR}`;
const RANK_FORMULAS = {
  "auto-top-50": LOVED_SIG,
  "auto-favorites": `fav|f${W.favorite},d${W.download}|prior${PRIOR}`,
  // `acapx` marks the acapella-excluded membership: it removes rows, which shifts survivors' ranks, so it's
  // a chart-basis change like a mode flip — including it in the signature makes the badges RESET (blank until
  // a fresh matching anchor forms) instead of rendering the one-time acapella-removal shuffle as fake surges.
  "auto-trending": `trend|${velocityBase ? "velocity" : "reach"}|${expReach ? `expo${EXPOSURE_DAYS}` : "noexpo"}`
    + `|win${TRENDING_DAYS}|skip${TREND_SKIP_PENALTY}/${TREND_MAX_SKIP}|min${TREND_MIN_DEVICES}${acapExclude.size ? "|acapx" : ""}`,
  "auto-acapella-top-50": `acap|skip${TREND_SKIP_PENALTY}|min1`,
  "auto-downloaded": `dl|prior${PRIOR}|album${DOWNLOADED_MAX_PER_ALBUM}${acapExclude.size ? "|acapx" : ""}`,
};
console.log(`trending: ${velocityBase ? `VELOCITY mode (baseline ${velocityBase.t})` : `reach mode (no clean baseline one ${TRENDING_DAYS}d window back)`}${expReach ? `, exposure dampener ON (${EXPOSURE_DAYS}d exposure window) — ${gate.reason}` : `, exposure dampener off — ${gate.reason}`}`);

// ── favorites = favorite-primary, download-corroborated ───────────────────────────────────────────────
const favRanked = [...new Set([...favDev.keys(), ...dlDev.keys()])].filter((v) => inCorpus.has(v))
  .map((v) => ({ v, score: W.favorite * s(favDev.get(v) || 0) + W.download * s(dlDev.get(v) || 0) }))
  .filter((x) => (favDev.get(x.v) || 0) > 0) // must have at least one real favorite; downloads alone are too noisy to seed
  .sort((a, b) => b.score - a.score);
const favIds = dedupRanked(favRanked, keyOf).slice(0, FAV_N).map((x) => x.v);

// ── Top Downloaded = download-primary, ONE per album ──────────────────────────────────────────────────
// Downloading is this audience's dominant SAVE action (far outweighs favoriting), and it surfaces content
// neither Top 50 (play-primary) nor Favorites (favorite-primary) does. But downloads come in ALBUM bursts —
// a downloaded album gives every track equal download reach — so raw per-track ranking is one album
// exploded into rows. `capPerAlbum` keeps only each album's TOP track (download-primary; ties broken by
// PLAY reach — an album's tracks are download-tied, so the tiebreak surfaces the album's actual hit, not an
// arbitrary track). Standalone singles have no album → never capped. Needs ≥1 real download. Acapella is
// excluded (shared `acapExclude`, same as Trending) — it has its own seasonal lists.
const albumOfTrack = new Map();
for (const r of db.prepare("SELECT albumId, videoId FROM album_track").all()) if (!albumOfTrack.has(r.videoId)) albumOfTrack.set(r.videoId, r.albumId);
const capPerAlbum = (ranked, maxPer) => {
  const count = new Map(), out = [];
  for (const x of ranked) {
    const al = albumOfTrack.get(x.v);
    if (al) { const c = count.get(al) || 0; if (c >= maxPer) continue; count.set(al, c + 1); }
    out.push(x);
  }
  return out;
};
const dlPlayReach = (v) => Math.max(bpDev.get(v) || 0, lpDev.get(v) || 0); // for the within-album tiebreak
const dlRanked = [...dlDev.keys()].filter((v) => inCorpus.has(v) && !acapExclude.has(v) && (dlDev.get(v) || 0) > 0)
  .map((v) => ({ v, score: s(dlDev.get(v) || 0), tie: s(dlPlayReach(v)) }))
  .sort((a, b) => b.score - a.score || b.tie - a.tie); // download desc; within a download-tie, most-played first
const dlIds = capPerAlbum(dedupRanked(dlRanked, keyOf), DOWNLOADED_MAX_PER_ALBUM).slice(0, DOWNLOADED_N).map((x) => x.v);

// ── acapella season: ADD an acapella list on top. Two hard rules: (1) ONLY songs hand-listed in the curated
// acapella playlist, and (2) ranked by plays FROM THE THREE WEEKS ONLY (the `season` window — NO all-time
// backfill, NO favorites/downloads) — so it reflects what people are actually playing this season. Reach-
// primary with a light skip dampener (same as Trending). Nothing is removed; it disappears after Tisha b'Av.
const acap = mourning ? acapellaSet() : null;
const acBlocks = [];
if (acap && acap.size && season) {
  const acRanked = rows(season, "topPlays")
    .filter((r) => acap.has(r.videoId) && inCorpus.has(r.videoId) && (r.devices || 0) >= 1)
    .map((r) => ({ v: r.videoId, score: (r.devices || 0) * (1 - TREND_SKIP_PENALTY * clamp(r.skipRate || 0, 0, 1)) }))
    .sort((a, b) => b.score - a.score);
  const acTop = dedupRanked(acRanked, keyOf).slice(0, TOP_N).map((x) => x.v);
  if (acTop.length) acBlocks.push({ id: "auto-acapella-top-50", title: "Acapella Top 50", videoIds: acTop });
}

// ── the auto blocks (acapella-season lists FIRST when active, empty videoId lists dropped) ─────────────
const autoBlocks = [
  ...acBlocks, // acapella season: on top so the app surfaces them first; [] outside the Three Weeks
  { id: "auto-top-50", title: "Top 50", videoIds: top50 },
  { id: "auto-trending", title: "Trending", videoIds: trendingIds },
  { id: "auto-favorites", title: "Favorites", videoIds: favIds },
  { id: "auto-downloaded", title: "Top Downloaded", videoIds: dlIds },
].filter((b) => b.videoIds.length);

// "Year of <Y>" — a DYNAMIC year rule (no telemetry: the store computes everything released this year at
// read time, newest first, growing with each harvest). Emitted here so it's part of the auto-managed set on
// the same schedule and AUTO-ROLLS to the current UTC year — nobody edits it annually. YEAR pins it; YEAR_PLAYLIST=0 disables.
const YEAR = num(process.env.YEAR, new Date().getUTCFullYear());
if (process.env.YEAR_PLAYLIST !== "0") autoBlocks.push({ id: `auto-year-${YEAR}`, title: `Year of ${YEAR}`, year: YEAR });

// ── rank-history recorder (best-effort — must NEVER fail the run) ─────────────────────────────────────
// Appends each list's ordering PLUS the raw trending-window play-reach rows to a gitignored sidecar —
// the accumulating groundwork for the deferred velocity-Trending and chart-movement work (see
// docs/future-plans.md #1/#7): "reach 7 days ago" will simply be read from here — no stats-server change
// needed. Called on no-op ticks (published order == current) AND after a successful apply — never before,
// so a failed apply can't record an ordering no user ever saw. Robustness: a CORRUPT existing file is
// preserved aside (never silently wiped), malformed entries are dropped instead of poisoning the filter,
// and a `wx` lockfile makes the read-modify-write safe against an overlapping manual run. Pruned to
// HISTORY_DAYS; each entry records its trending window so mixed-window data is detectable.
// (HISTORY_PATH/HISTORY_DAYS are defined up top — the velocity baseline reads the same sidecar.)
function recordHistory(appliedOk) {
  if (DRY) return;
  const lock = `${HISTORY_PATH}.lock`;
  try {
    try { fs.writeFileSync(lock, String(process.pid), { flag: "wx" }); }
    catch {
      let stale = true;
      try { stale = Date.now() - fs.statSync(lock).mtimeMs > 10 * 60000; } catch { /* vanished → treat as stale */ }
      if (!stale) { console.warn("auto-playlists: history locked by a concurrent run — skipping this append."); return; }
      // stale lock (crashed run): remove it, then re-race for it ATOMICALLY — if two takers race, exactly
      // one wins the wx create and the loser skips (a plain overwrite here would let both proceed).
      try { fs.unlinkSync(lock); } catch { /* already gone */ }
      try { fs.writeFileSync(lock, String(process.pid), { flag: "wx" }); }
      catch { console.warn("auto-playlists: lost the stale-lock race to a concurrent run — skipping this append."); return; }
    }
    try {
      let hist = null;
      if (fs.existsSync(HISTORY_PATH)) {
        try { hist = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8")); }
        catch { hist = undefined; /* unparseable */ }
        if (!hist || !Array.isArray(hist.runs)) { // corrupt OR wrong-shape ≠ missing: preserve the bytes, never silently wipe
          const aside = `${HISTORY_PATH}.corrupt-${Date.now()}`;
          fs.renameSync(HISTORY_PATH, aside);
          console.warn(`auto-playlists: history file was corrupt/wrong-shape — preserved at ${aside}, starting a fresh series.`);
          hist = null;
        }
      }
      if (!hist) hist = { runs: [] };
      const cutoff = Date.now() - HISTORY_DAYS * 86400000;
      hist.runs = hist.runs.filter((r) => r && typeof r.t === "string" && Date.parse(r.t) >= cutoff);
      // Stamp pre-existing entries with the formula that actually produced them: everything recorded
      // before this field existed used reach-primary ranking with no exposure dampening.
      // Stamp older entries with THIS run's signatures. Valid because the stamp happens at a moment when
      // the ranking configuration hasn't changed — the same reasoning as the original legacy stamp below —
      // and it avoids a badge blackout purely from introducing the field.
      for (const r of hist.runs) {
        if (r && typeof r.formula !== "string") r.formula = LEGACY_FORMULA;
        if (r && !r.formulas) r.formulas = RANK_FORMULAS;
      }
      hist.runs.push({
        t: new Date().toISOString(),
        applied: !!appliedOk, // false = the raw reach below is real, but the orderings were NOT served
        // The ranking formula behind this ordering. Movement badges may only compare like with like —
        // a formula change resets the baseline instead of rendering as a screenful of fake surges.
        formulas: RANK_FORMULAS,
        trendWindowDays: TRENDING_DAYS, // the window topPlays rows below were measured over
        // lists only when the apply succeeded (or no-op'd): badges must never anchor on an unserved chart.
        ...(appliedOk ? { lists: Object.fromEntries(autoBlocks.filter((b) => b.videoIds).map((b) => [b.id, b.videoIds])) } : {}),
        // raw trending-window topPlays, compact keys: v=videoId, d=distinct devices, n=qualified plays, s=skipRate
        // — recorded on EVERY run, applied or not: the reach time series is independent of apply success.
        topPlays7d: rows(trend, "topPlays").map((r) => ({ v: r.videoId, d: r.devices || 0, n: r.n || 0, s: r.skipRate || 0 })),
      });
      const ht = `${HISTORY_PATH}.tmp-${process.pid}`;
      fs.writeFileSync(ht, JSON.stringify(hist) + "\n");
      fs.renameSync(ht, HISTORY_PATH);
    } finally { try { fs.unlinkSync(lock); } catch { /* best-effort */ } }
  } catch (e) { console.warn(`auto-playlists: history append failed (${e.message}) — continuing.`); }
}

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

// ── HOME ROWS (top albums / videos by real listening — the /home-rows endpoint) ───────────────────────
// Runs on EVERY completed tick — before the DRY / no-op exits below — because album & video reach shift
// on days the Top 50 ordering doesn't, and it has its own table and its own /stats window. Fully ISOLATED
// in a try/catch that never rethrows: a bug here degrades home rows (the app falls back to its YouTube
// scrape) but can NEVER disturb the Top 50 / Trending / Favorites apply that follows, nor the run's exit.
// Ranked by distinct-device reach over a 30-day LIVE window (home stays current; no backfill — sidesteps
// the Top 50 backfill-freeze). Community omitted until the app tags community:<id> (today those plays are
// indistinguishable inside playlist:). Writes only when !DRY.
await (async () => {
  try {
    const HOME_WINDOW_DAYS = num(process.env.HOME_WINDOW_DAYS, 30);
    // Per-row pool caps — deliberately larger than what the app SHOWS so its rotateByArtist has fresh
    // headroom to turn the row over on refresh (the app caps the shown count client-side). Sized to give
    // ≥2× each row's shown count in DISTINCT artists: albums show 20 but average >1 album/artist, so 80
    // albums yields ~50 distinct; artists are 1:1 so 60 is ample for a 20-shown row. Videos are
    // content-limited (few whitelisted music videos clear the reach floor) — the cap never binds; we send
    // all that qualify.
    const HOME_ALBUMS_N = num(process.env.HOME_ALBUMS_N, 80);
    const HOME_VIDEOS_N = num(process.env.HOME_VIDEOS_N, 80);
    const HOME_ARTISTS_N = num(process.env.HOME_ARTISTS_N, 60);
    const home = await fetchStats(HOME_WINDOW_DAYS);
    // artist channel id is needed on every card (the app maps our artist NAMES to null ids, which no-ops
    // its famous/american/israeli gate + one-per-artist dedup).
    const artistOfAlbum = new Map(db.prepare("SELECT id, artistId FROM album").all().map((x) => [x.id, x.artistId]));
    const artistOfVideo = new Map(db.prepare("SELECT videoId, artistId FROM track WHERE isVideo=1").all().map((x) => [x.videoId, x.artistId]));
    // OLAK5uy_ (audio-playlist id from YouTubeAlbumRadio) → album browseId, so those plays aren't dropped.
    const olakToAlbum = new Map(db.prepare("SELECT playlistId, id FROM album WHERE playlistId IS NOT NULL").all().map((x) => [x.playlistId, x.id]));
    const artistIds = new Set(db.prepare("SELECT id FROM artist").all().map((x) => x.id));

    const albReach = new Map();
    for (const x of rows(home, "topSources")) {
      if (!x.source?.startsWith("album:")) continue;
      let id = x.source.slice(6);
      if (!artistOfAlbum.has(id)) id = olakToAlbum.get(id) || id; // bridge OLAK; unknown ids fall through
      if (!artistOfAlbum.has(id)) continue;                        // album not in corpus → skip
      albReach.set(id, Math.max(albReach.get(id) || 0, x.devices || 0)); // MAX-merge the two id spaces
    }
    const topAlbums = [...albReach.entries()].sort((a, b) => b[1] - a[1]).slice(0, HOME_ALBUMS_N)
      .map(([id, d]) => ({ kind: "album", refId: id, artistId: artistOfAlbum.get(id), score: s(d) }));

    const topVideos = rows(home, "topPlays")
      .filter((x) => artistOfVideo.has(x.videoId) && (x.devices || 0) >= 1)
      .map((x) => ({ v: x.videoId, score: s(x.devices || 0) * (1 - TREND_SKIP_PENALTY * clamp(x.skipRate || 0, 0, 1)) }))
      .sort((a, b) => b.score - a.score).slice(0, HOME_VIDEOS_N)
      .map((x) => ({ kind: "video", refId: x.v, artistId: artistOfVideo.get(x.v), score: x.score }));

    // top artists: /stats topArtists already ranks by distinct-device reach and (as of the topArtists
    // channel-id change) carries the artist id. refId IS the artist id. famous/american does not apply
    // (app decision) — content gate is female/kidzone/blocked, applied at read time by homeRows.
    const topArtists = rows(home, "topArtists")
      .filter((x) => x.id && artistIds.has(x.id) && (x.devices || 0) >= 1)
      .sort((a, b) => (b.devices || 0) - (a.devices || 0)) // self-contained ranking, don't trust /stats order
      .slice(0, HOME_ARTISTS_N)
      .map((x) => ({ kind: "artist", refId: x.id, artistId: x.id, score: s(x.devices || 0) }));

    // Only write rows we actually have data for — applyHomeRank replaces just the keys present, so an empty
    // window (or a stats server without the album rollup) leaves the OTHER row's last-good intact instead of
    // blanking it. Both empty → write nothing → the whole table's last-good survives (the fail-safe: home
    // never goes dark on a bad tick, it just serves the previous ranking until the next good one).
    const homeOut = {};
    if (topAlbums.length) homeOut["top-albums"] = topAlbums;
    if (topVideos.length) homeOut["top-videos"] = topVideos;
    if (topArtists.length) homeOut["top-artists"] = topArtists;
    if (!DRY && Object.keys(homeOut).length) applyHomeRank(db, homeOut);
    console.log(`home-rows: ${topAlbums.length} albums, ${topVideos.length} videos, ${topArtists.length} artists (${HOME_WINDOW_DAYS}d live reach)`
      + `${Object.keys(homeOut).length ? "" : " — no data, last-good left untouched"}${DRY ? "  [DRY]" : ""}`);
    // Make the "stats had rows but none survived filtering" case VISIBLE — otherwise a mismatch between the
    // /stats id space and the corpus (e.g. topArtists ids that aren't corpus artist PKs, an empty devices
    // field) would silently produce an empty row with no error. A warning here is the tripwire for that.
    for (const [key, statRows, built] of [["albums", rows(home, "topSources").filter((x) => x.source?.startsWith("album:")), topAlbums],
                                          ["videos", rows(home, "topPlays"), topVideos],
                                          ["artists", rows(home, "topArtists"), topArtists]]) {
      if (statRows.length && !built.length) console.warn(`home-rows: ${key} — /stats had ${statRows.length} rows but 0 survived corpus/filter matching (id-space mismatch?)`);
    }
  } catch (e) { console.warn(`home-rows: skipped (${e.message}) — playlists unaffected.`); }
})();

if (DRY) process.exit(0);
if (!changed) { recordHistory(true); setMeta(db, "auto_applied_at", Date.now()); process.exit(0); } // no-op: ranking confirmed current from healthy /stats — stamp freshness

// Apply FIRST, commit the auto file only on success — if applyZemerPlaylists throws (e.g. a bad hand-curated
// entry), the DB rolls back AND the auto file is left unchanged, so the next run retries (no silent file/DB
// drift). `curated` comes from loadZemerPlaylists (which already folds in acapella-auto, written above) with
// its auto-* blocks stripped, then combined with THIS run's freshly-built autoBlocks.
const curated = loadZemerPlaylists().playlists.filter((p) => !String(p.id || "").startsWith("auto-"));
let r;
try { r = applyZemerPlaylists(db, { playlists: [...autoBlocks, ...curated] }, { dry: false }); }
catch (e) {
  // The reach TIME SERIES is independent of apply success — record it (without the unserved orderings,
  // applied:false) so a multi-day apply-failure stretch doesn't punch a hole in the velocity baseline.
  recordHistory(false);
  throw e; // then still fail the run loudly (systemd Result=failed; next tick retries)
}

const tmp = `${ZEMER_PLAYLISTS_AUTO_PATH}.tmp-${process.pid}`;
fs.writeFileSync(tmp, nextJson);
fs.renameSync(tmp, ZEMER_PLAYLISTS_AUTO_PATH);
recordHistory(true); // orderings recorded only now — after the apply actually succeeded
setMeta(db, "auto_applied_at", Date.now()); // freshness for /health — only on a successful apply

console.log(`applied: ${r.playlists} playlist(s), ${r.items} item(s) → corpus.db (API reloads on its next tick)`);
if (r.missing.length) console.warn(`⚠ ${r.missing.length} id(s) not in the corpus yet (they'll serve once harvested).`);
