// zemer-search — search engine and more for the Zemer app
// https://github.com/ZemerTeam/zemer-search
// Zemer app: https://github.com/ZemerTeam/zemer-app
// Copyright (C) 2026 alltechdev
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See the LICENSE file for details.

// Pure helpers for the Trending ranking (see docs/future-plans.md #1/#3 and auto-playlists.mjs):
//
//   • VELOCITY — "trending" as reach GROWTH week-over-week, read from the rank-history sidecar
//     (auto-playlists-history.json: every run appends its raw trending-window topPlays reach).
//     `pickBaseline` selects the sidecar run nearest to T−7d; `windowCleanOfSeason` is the
//     SELF-ACTIVATING GUARD: velocity engages only when BOTH compared windows (the current one and
//     the baseline's) lie fully outside The Three Weeks — the acapella season skews play patterns in
//     both directions, so a cross-season growth comparison is meaningless. The guard recurs by the
//     Hebrew calendar (no hardcoded dates): velocity suspends every year for the season plus the
//     following two windows, and re-engages on its own.
//
//   • EXPOSURE dampener — live plays partly measure what the app SURFACED, not pure demand. When the
//     stats server carries impression data (`topImpressions` — what was SHOWN, per-device reach), a
//     heavily-exposed song's score is docked up to EXPO_W so it must out-play its exposure to trend.
//     DORMANT until app builds ship impression events: no data → multiplier 1 → behavior unchanged.
//
// Pure data-in/data-out (no I/O, no clock reads) so every branch is unit-pinned.

// Pick the sidecar run whose timestamp is nearest `targetMs`, among runs that actually carry a reach
// snapshot for the SAME trending window (mixed-window snapshots aren't comparable). `tolMs` bounds the
// acceptable miss (twice-daily runs land within ~12h of any target; Shabbat/Yom Tov gaps stretch it —
// beyond the tolerance a "week-over-week" comparison silently becomes something else, so return null).
export function pickBaseline(runs, targetMs, windowDays, tolMs = 48 * 3600000) {
  let best = null, bestGap = Infinity;
  for (const r of Array.isArray(runs) ? runs : []) {
    if (!r || !Array.isArray(r.topPlays7d) || r.trendWindowDays !== windowDays) continue;
    const t = Date.parse(r.t);
    if (!Number.isFinite(t)) continue;
    const gap = Math.abs(t - targetMs);
    if (gap < bestGap) { best = r; bestGap = gap; }
  }
  return best && bestGap <= tolMs ? best : null;
}

// True when NO day of the `windowDays`-day window ending at `endMs` falls inside the season
// (`inSeason` = e.g. corpus/season.mjs inThreeWeeks, taking a Date). Checked per-day inclusive of
// both ends, so a window that merely touches the season is not "clean".
export function windowCleanOfSeason(endMs, windowDays, inSeason) {
  for (let i = 0; i <= windowDays; i++)
    if (inSeason(new Date(endMs - i * 86400000))) return false;
  return true;
}

// A baseline snapshot is the stats server's TOP-N list (LIMIT 200), so a song's ABSENCE from it is
// ambiguous once the cap is hit: it may have had zero reach, or simply ranked below the cutoff. Treating
// absence as 0 would inflate a below-cutoff song's growth into a fake surge, so absent songs get the
// SMALLEST reach actually observed in the snapshot as a conservative ceiling. An uncapped snapshot
// (fewer rows than the cap) is complete — absence there genuinely means zero.
export const STATS_TOP_LIMIT = 200;
// entries = [[id, reach], …] from a top-N /stats list. Absent id → the smallest reach in the list when
// the list is cap-sized (it may simply rank below the cutoff), else 0 (the list is complete).
export function cappedLookup(entries, cap = STATS_TOP_LIMIT) {
  const rows = (Array.isArray(entries) ? entries : []).filter((e) => Array.isArray(e));
  const map = new Map(rows.map(([id, n]) => [id, n || 0]));
  const floor = rows.length >= cap ? Math.min(...rows.map(([, n]) => n || 0)) : 0;
  return (id) => (map.has(id) ? map.get(id) : floor);
}
// the velocity baseline: sidecar topPlays7d rows ({v, d, …}) → same cap semantics
export function baselineReach(snapshotRows, cap = STATS_TOP_LIMIT) {
  return cappedLookup((Array.isArray(snapshotRows) ? snapshotRows : []).map((r) => [r?.v, r?.d || 0]), cap);
}

// ── Exposure dampener ─────────────────────────────────────────────────────────────────────────────────
// Dock a song by the SHARE of the instrumented audience that was shown it: 1 (shown to nobody) down to
// 1−EXPO_W (shown to every device that reports impressions).
//
// The share is deliberately RELATIVE to the impression-reporting population, not an absolute device count
// against a fixed prior. With an absolute prior the docking depth drifts upward for weeks purely as app
// adoption climbs — impressions come only from updated clients while plays come from ALL of them — so
// Trending would visibly churn with no change in underlying demand (the app-side rollout-skew objection,
// 2026-07-24). A share is adoption-invariant: "half the instrumented devices saw this" means the same
// thing at 20% adoption and at 100%.
//
// Feed `exposedDevices` from a cappedLookup over topImpressions, NOT a raw map: it is a LIMIT-200 list,
// and treating a below-cutoff song as zero exposure would leave it undocked while the song one rank above
// takes the full dock — a score cliff that systematically favors the unlisted.
export const EXPO_W = 0.35;
export function exposureMult(exposedDevices, impressionDevices, w = EXPO_W) {
  if (!(impressionDevices > 0)) return 1;                       // nothing instrumented → no dampening
  const share = Math.min(1, Math.max(0, (exposedDevices || 0) / impressionDevices));
  return 1 - w * share;
}

// Whether exposure may influence ranking AT ALL. Two independent conditions, both from the app-side
// review: an EXPLICIT enable (a permanent kill switch — never auto-engage on partial instrumentation,
// which would penalise whichever surfaces happen to be wired first), and a minimum coverage of the
// playing population (so a half-rolled-out client can't skew the chart). Returns a reason, for the log.
export const EXPOSURE_DEFAULTS = { minCoverage: 0.6, minDevices: 20, minSurfaceDevices: 10 };

// Does a declared requirement match an observed surface slug? A requirement ending in ":" is a PREFIX
// (so "home:" covers home:quick-picks, home:new-releases, … — the app names home rows per section);
// anything else must match exactly.
const surfaceMatches = (req, seen) => (req.endsWith(":") ? seen.startsWith(req) : seen === req);

export function exposureGate({ enabled, unavailable = null, impressionDevices = 0, playDevices = 0,
                               requiredSurfaces = [], surfaces = [],
                               minCoverage = EXPOSURE_DEFAULTS.minCoverage,
                               minDevices = EXPOSURE_DEFAULTS.minDevices,
                               minSurfaceDevices = EXPOSURE_DEFAULTS.minSurfaceDevices } = {}) {
  const coverage = playDevices > 0 ? impressionDevices / playDevices : 0;
  const pct = (x) => `${Math.round(x * 100)}%`;
  const no = (reason) => ({ on: false, coverage, missingSurfaces: [], reason });

  if (!enabled) return no("disabled (set EXPOSURE_DAMPENER=on to enable)");
  // Enabled but the data isn't there this run — say THAT, not "the flag isn't set", or the operator goes
  // looking for a deployment problem that doesn't exist.
  if (unavailable) return no(unavailable);

  // DEVICE coverage answers rollout skew. It does NOT answer partial-SURFACE coverage: every updated
  // device visits home, so device coverage sails past the bar while artist/mood/chart screens are still
  // emitting nothing — and songs exposed mainly there would be docked ~0% while home-surfaced songs take
  // the full dock. So the app DECLARES which surfaces its shipped version instruments, and every one of
  // them must actually be present in the stream before exposure may touch ranking.
  if (!requiredSurfaces.length)
    return no("no declared surface list (set EXPOSURE_REQUIRED_SURFACES to the surfaces the app instruments)");
  // MAX-merge duplicate slugs rather than last-one-wins: if /stats ever returns a surface twice (a shard
  // merge, a per-version split), keeping the last row could report 8 devices for a surface that actually
  // has 48 and hold the gate shut forever while the dashboard says otherwise.
  const seen = new Map();
  for (const r of surfaces) if (r && r.surface)
    seen.set(r.surface, Math.max(seen.get(r.surface) || 0, r.devices || 0));
  const missing = requiredSurfaces.filter((req) =>
    ![...seen].some(([slug, devices]) => surfaceMatches(req, slug) && devices >= minSurfaceDevices));
  if (missing.length)
    return { on: false, coverage, missingSurfaces: missing,
             reason: `surface(s) not reporting yet (need ≥${minSurfaceDevices} devices each): ${missing.join(", ")}` };

  if (impressionDevices < minDevices)
    return no(`only ${impressionDevices} impression-reporting device(s), need ${minDevices}`);
  if (coverage < minCoverage)
    return no(`coverage ${pct(coverage)} of playing devices, need ${pct(minCoverage)}`);
  return { on: true, coverage, missingSurfaces: [],
           reason: `coverage ${pct(coverage)}, ${impressionDevices} instrumented device(s), all ${requiredSurfaces.length} declared surface(s) reporting` };
}
