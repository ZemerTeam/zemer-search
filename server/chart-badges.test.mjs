// zemer-search — search engine and more for the Zemer app
// https://github.com/ZemerTeam/zemer-search
// Zemer app: https://github.com/ZemerTeam/zemer-app
// Copyright (C) 2026 alltechdev
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See the LICENSE file for details.

import { test } from "node:test";
import assert from "node:assert/strict";
import { pickAnchor, applyBadges, applyRanks, chartedBefore, LEGACY_FORMULA } from "./chart-badges.mjs";

const D = 86400000;
// Wed 2026-08-12 12:00 UTC → current week starts Sun Aug 9; last completed week starts Sun Aug 2.
const NOW = Date.UTC(2026, 7, 12, 12);
const SUN = Date.UTC(2026, 7, 9);
const run = (ms, extra = {}) => ({ t: new Date(ms).toISOString(), applied: true, lists: { "auto-top-50": [] }, ...extra });

test("pickAnchor: first applied run of the last COMPLETED week; stable against later runs", () => {
  const lastWeekFirst = run(SUN - 7 * D + 8 * 3600000); // Sun Aug 2, 08:00 — the published chart
  const runs = [run(SUN - 7 * D + 20 * 3600000), lastWeekFirst, run(SUN + 8 * 3600000), run(NOW - 3600000)];
  assert.equal(pickAnchor(runs, NOW), lastWeekFirst, "earliest run of last week wins, not this week's");
});

test("pickAnchor: young history falls back to older weeks, then the series start (if old enough)", () => {
  const first = run(SUN + 8 * 3600000); // series began THIS week (no completed week yet), >2d before NOW
  assert.equal(pickAnchor([first, run(NOW - 3600000)], NOW), first, "movement since the series began");
  const old = run(SUN - 21 * D); // only a 3-week-old run exists
  assert.equal(pickAnchor([old, run(NOW - 3600000)], NOW), old);
  // a baseline only hours old is not a baseline — better no badges than "movement since this morning"
  const fresh = run(NOW - 5 * 3600000);
  assert.equal(pickAnchor([fresh, run(NOW - 3600000)], NOW), null);
});

test("pickAnchor: unapplied/list-less/malformed runs never anchor; empty history is null", () => {
  const good = run(SUN - 7 * D + 8 * 3600000);
  const runs = [
    run(SUN - 7 * D, { applied: false }),            // reach-only run (apply failed) — never served
    run(SUN - 7 * D + 3600000, { lists: undefined }),
    { t: "garbage", applied: true, lists: {} },
    null,
    good,
  ];
  assert.equal(pickAnchor(runs, NOW), good);
  assert.equal(pickAnchor([], NOW), null);
  assert.equal(pickAnchor(undefined, NOW), null);
});

test("applyBadges: delta from RAW ranks, NEW for chart entries, absent without an anchor", () => {
  const tracks = [{ videoId: "a" }, { videoId: "c" }, { videoId: "d" }];
  // raw current chart: a,b,c,d — b is filtered out of the VIEW but must still occupy rank 2
  applyBadges(tracks, ["a", "b", "c", "d"], ["c", "a", "b"]);
  assert.deepEqual(tracks[0], { videoId: "a", prevRank: 2, delta: 1 }, "2→1 = climbed 1");
  assert.deepEqual(tracks[1], { videoId: "c", prevRank: 1, delta: -2 }, "1→3 = fell 2 (raw rank, not view row)");
  assert.deepEqual(tracks[2], { videoId: "d", new: true }, "not on the anchor chart = NEW");
  const bare = [{ videoId: "a" }];
  applyBadges(bare, ["a"], []);
  assert.deepEqual(bare[0], { videoId: "a" }, "no anchor data → no badge fields at all");
});

test("pickAnchor: a FORMULA change resets the baseline — never compare across ranking changes", () => {
  // Last week's chart came from the old formula. Anchoring on it would render the ranking change itself
  // as a screenful of dramatic (and entirely fake) movement.
  const lastWeek = run(SUN - 7 * D + 8 * 3600000, { formula: "reach" });

  // 1. Immediately after the flip there is no usable same-formula baseline at all → NO badges.
  const justFlipped = run(NOW - 4 * 3600000, { formula: "velocity" });
  assert.equal(pickAnchor([lastWeek, justFlipped], NOW), null, "the flip itself is never rendered as movement");

  // 2. A few days in, movement resumes against the FIRST POST-FLIP run — same formula, honest comparison,
  //    and still never the pre-flip chart.
  const firstPostFlip = run(SUN + 8 * 3600000, { formula: "velocity" });
  assert.equal(pickAnchor([lastWeek, firstPostFlip, run(NOW - 3600000, { formula: "velocity" })], NOW),
    firstPostFlip, "anchors post-flip, never across the change");

  // 3. Once a completed week of the new formula exists, the normal weekly anchor takes over.
  const newLastWeek = run(SUN - 7 * D + 9 * 3600000, { formula: "velocity" });
  assert.equal(pickAnchor([lastWeek, newLastWeek, firstPostFlip], NOW), newLastWeek);
});

test("pickAnchor: legacy runs (no formula field) count as the original reach formula", () => {
  const legacy = run(SUN - 7 * D + 8 * 3600000);                       // no formula key at all
  const now = run(SUN + 8 * 3600000, { formula: LEGACY_FORMULA });     // same formula, explicitly
  assert.equal(pickAnchor([legacy, now], NOW), legacy, "existing history keeps working across the upgrade");
});

test("chartedBefore + applyBadges: a returning song is a RE-ENTRY, not a new entry", () => {
  const anchorMs = SUN - 7 * D;
  const runs = [
    run(anchorMs - 14 * D, { lists: { "auto-top-50": ["old-hit", "x"] } }),   // charted long ago
    run(anchorMs, { lists: { "auto-top-50": ["x", "y"] } }),                  // the anchor week
  ];
  const ever = chartedBefore(runs, "auto-top-50", anchorMs, LEGACY_FORMULA);
  assert.ok(ever.has("old-hit"));
  assert.ok(!ever.has("y"), "the anchor run itself is not 'before' it");
  const tracks = [{ videoId: "old-hit" }, { videoId: "brand-new" }, { videoId: "x" }];
  applyBadges(tracks, ["old-hit", "brand-new", "x"], ["x", "y"], ever);
  assert.deepEqual(tracks[0], { videoId: "old-hit", reentry: true }, "returned to the chart");
  assert.deepEqual(tracks[1], { videoId: "brand-new", new: true }, "never charted before");
  assert.equal(tracks[2].delta, -2, "x fell 1 → 3");
  // without history the old behaviour holds: everything absent from the anchor reads as NEW
  const bare = [{ videoId: "old-hit" }];
  applyBadges(bare, ["old-hit"], ["x"]);
  assert.deepEqual(bare[0], { videoId: "old-hit", new: true });
});

test("formula signatures are PER PLAYLIST — Trending changing must not blank Top 50's badges", () => {
  // one skipped run drops Trending to its reach fallback; Top 50's ranking never involved that mode.
  const f = (trend) => ({ "auto-top-50": "loved|v1", "auto-trending": trend });
  const lastWeek = { ...run(SUN - 7 * D + 8 * 3600000), formulas: f("trend|velocity"),
                     lists: { "auto-top-50": ["a"], "auto-trending": ["a"] } };
  const now = { ...run(NOW - 3600000), formulas: f("trend|reach"),
                lists: { "auto-top-50": ["a"], "auto-trending": ["a"] } };
  assert.equal(pickAnchor([lastWeek, now], NOW, "auto-top-50"), lastWeek, "unaffected chart keeps its anchor");
  assert.equal(pickAnchor([lastWeek, now], NOW, "auto-trending"), null, "the changed chart resets, alone");
});

test("chartedBefore: uses the ANCHOR's formula, and survives a malformed sidecar", () => {
  const anchorMs = SUN - 7 * D;
  const mk = (ms, formula, list) => ({ t: new Date(ms).toISOString(), applied: true,
                                       formulas: { "auto-top-50": formula }, lists: { "auto-top-50": list } });
  const runs = [mk(anchorMs - 14 * D, "A", ["old"]), mk(anchorMs - 10 * D, "B", ["other"]), mk(anchorMs, "A", ["x"])];
  const ever = chartedBefore(runs, "auto-top-50", anchorMs, "A");
  assert.ok(ever.has("old"), "same-formula history counts");
  assert.ok(!ever.has("other"), "a different formula's history does not");
  // garbage shapes degrade to "no history", never a 500 out of the request handler
  const junk = [{ t: "x", applied: true, lists: { "auto-top-50": 42 } }, null,
                { applied: true, lists: null }, { t: new Date(anchorMs - D).toISOString(), applied: true, lists: { "auto-top-50": 7 } }];
  assert.equal(chartedBefore(junk, "auto-top-50", anchorMs, LEGACY_FORMULA).size, 0);
});

test("legacy entries (no per-playlist formulas) still resolve, so the upgrade blanks nothing", () => {
  const legacy = run(SUN - 7 * D + 8 * 3600000);                       // neither formula nor formulas
  const alsoLegacy = run(NOW - 3600000);
  assert.equal(pickAnchor([legacy, alsoLegacy], NOW, "auto-top-50"), legacy);
});

test("applyRanks: the CHART position, not the row index — a filtered list shows gaps", () => {
  // raw chart a,b,c,d,e; the viewer's filters removed b and d server-side
  const tracks = [{ videoId: "a" }, { videoId: "c" }, { videoId: "e" }];
  applyRanks(tracks, ["a", "b", "c", "d", "e"]);
  assert.deepEqual(tracks.map((t) => t.rank), [1, 3, 5], "positions are the chart's, so the list has gaps");
  // and the rank agrees with the delta, which is the whole point
  applyBadges(tracks, ["a", "b", "c", "d", "e"], ["c", "b", "a", "d", "e"]);
  const c = tracks.find((t) => t.videoId === "c");
  assert.equal(c.rank, 3); assert.equal(c.prevRank, 1); assert.equal(c.delta, -2, "1 → 3 is down 2, consistent with rank 3");
  // a row that isn't on the chart at all gets no rank rather than a wrong one
  const off = [{ videoId: "zzz" }];
  applyRanks(off, ["a"]);
  assert.equal(off[0].rank, undefined);
});
