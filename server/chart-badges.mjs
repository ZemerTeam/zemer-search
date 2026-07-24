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

// Every recorded run carries the RANKING FORMULA that produced it. Movement may only be measured
// between runs of the SAME formula: when the formula changes (velocity Trending engaging, the exposure
// dampener being flipped on), the order shifts for reasons that have nothing to do with demand, and
// rendering that as ▲/▼ tells users "these songs surged" when the truth is "we changed how we rank".
// A formula change therefore RESETS the baseline — badges simply disappear until a full week of
// same-formula history exists again. Runs recorded before this field existed were all produced by the
// original reach-primary, no-exposure formula, hence the legacy default.
// Signatures are PER PLAYLIST. A global signature would tie every chart to Trending's mode: a single
// missed run (Shabbat gate, a /stats blip) drops Trending to its reach fallback, and Top 50 / Favorites /
// Acapella — whose ranking that mode never touches — would lose their badges too, for days. It must also
// cover the ordering KNOBS, not just the mode, or retuning a weight reshuffles a chart while the signature
// stays put and the change renders as a page of fake ▲/▼.
export const LEGACY_FORMULA = "reach";
export const formulaOf = (r, playlistId = null) => {
  if (playlistId && r && r.formulas && typeof r.formulas === "object" && typeof r.formulas[playlistId] === "string")
    return r.formulas[playlistId];
  return r && typeof r.formula === "string" ? r.formula : LEGACY_FORMULA; // pre-per-playlist entries
};

const WEEK = 7 * 86400000;
const MIN_FALLBACK_ANCHOR_MS = 2 * 86400000; // youngest usable "since the series began" baseline
// most recent Sunday 00:00 UTC at/before ms — the chart week. Exported so the API can key its anchor
// cache on it: the anchor rolls over every Sunday WITHOUT any file change, so mtime alone is not enough.
export const chartWeek = (ms) => {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - d.getUTCDay() * 86400000;
};
const weekStart = chartWeek;

// → the anchor run ({t, lists, …}) or null. `runs` = the sidecar's runs array (untrusted shape).
// Only runs produced by the CURRENT formula are eligible (see above) — the current formula being that of
// the most recent applied run.
export function pickAnchor(runs, nowMs = Date.now(), playlistId = null) {
  const all = (Array.isArray(runs) ? runs : [])
    .filter((r) => r && r.applied && r.lists && typeof r.lists === "object" && typeof r.t === "string")
    .map((r) => ({ r, ms: Date.parse(r.t) }))
    .filter((x) => Number.isFinite(x.ms) && x.ms <= nowMs)
    .sort((a, b) => a.ms - b.ms);
  if (!all.length) return null;
  const current = formulaOf(all[all.length - 1].r, playlistId);
  const valid = all.filter((x) => formulaOf(x.r, playlistId) === current);
  if (!valid.length) return null;
  const cur = weekStart(nowMs);
  // last completed week first, then older weeks (bounded by the sidecar's own retention)
  for (let w = cur - WEEK; w >= valid[0].ms - WEEK; w -= WEEK) {
    const hit = valid.find((x) => x.ms >= w && x.ms < w + WEEK);
    if (hit) return hit.r;
  }
  // Series younger than a completed week (a fresh deployment, or the first days after a formula change):
  // fall back to the earliest same-formula run — but only once it is old enough to be a meaningful
  // baseline. Anchoring on a run from a few hours ago would label ~nothing as "movement since <today>",
  // and immediately after a formula change it would quietly re-introduce the cross-formula comparison
  // this reset exists to prevent.
  const oldest = valid[0];
  return nowMs - oldest.ms >= MIN_FALLBACK_ANCHOR_MS ? oldest.r : null;
}

// Every videoId that has EVER charted on this playlist strictly before the anchor, under the SAME formula
// as the anchor itself — the input that separates a first-time entry from a song returning to the chart.
// `formula` is passed in (the anchor's own) rather than re-derived: deriving it here from a differently
// filtered/ordered view of the same array could silently disagree with pickAnchor's choice, which would
// empty this set and quietly turn every re-entry back into a "new entry".
export function chartedBefore(runs, playlistId, anchorMs, formula) {
  const seen = new Set();
  for (const r of Array.isArray(runs) ? runs : []) {
    if (!r || !r.applied || !r.lists || typeof r.lists !== "object" || typeof r.t !== "string") continue;
    const t = Date.parse(r.t);
    if (!Number.isFinite(t) || t >= anchorMs || formulaOf(r, playlistId) !== formula) continue;
    const list = r.lists[playlistId];
    if (!Array.isArray(list)) continue; // a hand-edited/truncated sidecar must degrade, never throw a 500
    for (const v of list) seen.add(v);
  }
  return seen;
}

// Stamp each row with its 1-based position on the RAW chart. Separate from the movement badges because
// it is knowable whenever the chart has a stored ordering, anchor or not — and because the row's index in
// a response is NOT the chart position: content filters remove rows server-side, so a filtered viewer's
// 3rd row can be the chart's 7th. Displaying the index next to a delta measured on the raw chart produces
// "up 5, now number 12", which is self-contradictory. A filtered list therefore shows GAPS (1, 2, 4, 7) —
// a chart position is not a line number, and the gaps are the filter being visible rather than hidden.
export function applyRanks(tracks, curOrder) {
  if (!Array.isArray(tracks) || !Array.isArray(curOrder)) return tracks;
  const cur = new Map(curOrder.map((v, i) => [v, i + 1]));
  for (const t of tracks) { const r = cur.get(t.videoId); if (r) t.rank = r; }
  return tracks;
}

// Annotate `tracks` (the detail rows, possibly content-filtered) with prevRank/delta/new/reentry for ONE
// playlist. `curOrder`/`prevOrder` = the RAW videoId orderings (current stored chart / anchor chart).
// delta > 0 = climbed. `everCharted` (optional, from chartedBefore) splits an absent-from-anchor song into
// a true first appearance (`new`) and a return (`reentry`) — visually distinct, and not inferable from a
// delta. Mutates + returns tracks; missing data → tracks untouched (fields stay absent).
export function applyBadges(tracks, curOrder, prevOrder, everCharted = null) {
  if (!Array.isArray(tracks) || !Array.isArray(curOrder) || !Array.isArray(prevOrder) || !prevOrder.length) return tracks;
  const cur = new Map(curOrder.map((v, i) => [v, i + 1]));
  const prev = new Map(prevOrder.map((v, i) => [v, i + 1]));
  for (const t of tracks) {
    const c = cur.get(t.videoId);
    if (!c) continue; // not on the raw chart (shouldn't happen) — leave unbadged
    const p = prev.get(t.videoId);
    if (p) { t.prevRank = p; t.delta = p - c; }
    else if (everCharted && everCharted.has(t.videoId)) t.reentry = true; // charted before, fell off, back
    else t.new = true;                                                    // never charted under this formula
  }
  return tracks;
}
