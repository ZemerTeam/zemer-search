// zemer-search — search engine and more for the Zemer app
// https://github.com/ZemerTeam/zemer-search
// Zemer app: https://github.com/ZemerTeam/zemer-app
// Copyright (C) 2026 alltechdev
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See the LICENSE file for details.

// Chart-movement badges for the auto playlists (docs/future-plans.md #7): per-song ↑/↓/NEW on
// /zemer-playlists detail, computed against a FIXED WEEKLY ANCHOR — the Spotify "chart published"
// feel: the reference chart stays stable all week (badges don't churn twice a day), and rolls
// forward each Sunday.
//
// The anchor is read from the rank-history sidecar (auto-playlists-history.json — every successful
// apply records the served list orderings; `applied: false` runs never anchor, so badges can never
// reference a chart no user actually saw). Anchor choice: the FIRST applied run of the most recent
// COMPLETED week (UTC weeks, Sunday 00:00) — i.e. last week's published chart; if history is younger
// than that, progressively older weeks, finally the earliest applied run at all ("movement since the
// series began"). No usable history → null → no badge fields (additive, absent, never zeroed).
//
// Deltas are computed on RAW chart ranks (the full stored ordering), NOT on a viewer's post-filter
// row positions — a filtered-out member must not shift everyone below it into fake movement.

const WEEK = 7 * 86400000;
const weekStart = (ms) => { // most recent Sunday 00:00 UTC at/before ms
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - d.getUTCDay() * 86400000;
};

// → the anchor run ({t, lists, …}) or null. `runs` = the sidecar's runs array (untrusted shape).
export function pickAnchor(runs, nowMs = Date.now()) {
  const valid = (Array.isArray(runs) ? runs : [])
    .filter((r) => r && r.applied && r.lists && typeof r.lists === "object" && typeof r.t === "string")
    .map((r) => ({ r, ms: Date.parse(r.t) }))
    .filter((x) => Number.isFinite(x.ms) && x.ms <= nowMs)
    .sort((a, b) => a.ms - b.ms);
  if (!valid.length) return null;
  const cur = weekStart(nowMs);
  // last completed week first, then older weeks (bounded by the sidecar's own retention)
  for (let w = cur - WEEK; w >= valid[0].ms - WEEK; w -= WEEK) {
    const hit = valid.find((x) => x.ms >= w && x.ms < w + WEEK);
    if (hit) return hit.r;
  }
  return valid[0].r; // series younger than one completed week → movement since it began
}

// Annotate `tracks` (the detail rows, possibly content-filtered) with prevRank/delta/new for ONE
// playlist. `curOrder`/`prevOrder` = the RAW videoId orderings (current stored chart / anchor chart).
// delta > 0 = climbed. Mutates + returns tracks; missing data → tracks untouched (fields stay absent).
export function applyBadges(tracks, curOrder, prevOrder) {
  if (!Array.isArray(tracks) || !Array.isArray(curOrder) || !Array.isArray(prevOrder) || !prevOrder.length) return tracks;
  const cur = new Map(curOrder.map((v, i) => [v, i + 1]));
  const prev = new Map(prevOrder.map((v, i) => [v, i + 1]));
  for (const t of tracks) {
    const c = cur.get(t.videoId);
    if (!c) continue; // not on the raw chart (shouldn't happen) — leave unbadged
    const p = prev.get(t.videoId);
    if (p) { t.prevRank = p; t.delta = p - c; }
    else t.new = true; // wasn't on last week's chart at all
  }
  return tracks;
}
