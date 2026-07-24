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
import { pickAnchor, applyBadges } from "./chart-badges.mjs";

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

test("pickAnchor: young history falls back to older weeks, then the series start", () => {
  const first = run(SUN + 8 * 3600000); // series began THIS week (no completed week yet)
  assert.equal(pickAnchor([first, run(NOW - 3600000)], NOW), first, "movement since the series began");
  const old = run(SUN - 21 * D); // only a 3-week-old run exists
  assert.equal(pickAnchor([old, run(NOW - 3600000)], NOW), old);
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
