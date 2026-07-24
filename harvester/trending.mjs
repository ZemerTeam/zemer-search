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

// Exposure dampener: 1 (no data / unexposed) down to 1−EXPO_W (saturating with exposed-device reach).
// EXPO_PRIOR is deliberately larger than the ranking PRIOR: a song shown to a handful of devices is
// barely docked; only broad surfacing (home rows shown fleet-wide) approaches the full dock.
export const EXPO_W = 0.35, EXPO_PRIOR = 10;
export function exposureMult(exposedDevices, w = EXPO_W, prior = EXPO_PRIOR) {
  const d = exposedDevices > 0 ? exposedDevices : 0;
  return 1 - w * (d / (d + prior));
}
