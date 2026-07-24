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
import { pickBaseline, windowCleanOfSeason, exposureMult, baselineReach } from "./trending.mjs";

const D = 86400000;
const T0 = Date.UTC(2026, 7, 10); // an arbitrary fixed "now" (no season dependence in these tests)
const run = (t, extra = {}) => ({ t: new Date(t).toISOString(), trendWindowDays: 7, topPlays7d: [], ...extra });

test("pickBaseline: nearest run to T−7d wins; misses beyond tolerance return null", () => {
  const target = T0 - 7 * D;
  const runs = [run(target - 30 * 3600000), run(target - 5 * 3600000), run(target + 11 * 3600000), run(T0)];
  assert.equal(pickBaseline(runs, target, 7), runs[1], "5h-away beats 11h- and 30h-away");
  assert.equal(pickBaseline([run(target - 60 * 3600000)], target, 7), null, "60h miss > 48h tolerance");
  assert.equal(pickBaseline([], target, 7), null);
  assert.equal(pickBaseline(null, target, 7), null, "corrupt history (non-array) is a clean null");
});

test("pickBaseline: runs without a comparable snapshot are skipped", () => {
  const target = T0 - 7 * D;
  const exact = run(target);
  const runs = [
    run(target, { trendWindowDays: 14 }),        // different window — not comparable
    run(target, { topPlays7d: undefined }),      // no reach snapshot recorded
    { t: "not-a-date", trendWindowDays: 7, topPlays7d: [] },
    null,                                        // malformed entry
    exact,
  ];
  assert.equal(pickBaseline(runs, target, 7), exact, "only the same-window, snapshot-carrying run qualifies");
});

test("pickBaseline: applied:false runs still qualify (reach is recorded on every run)", () => {
  const target = T0 - 7 * D;
  const r = run(target, { applied: false });
  assert.equal(pickBaseline([r], target, 7), r);
});

test("windowCleanOfSeason: clean only when NO day of the window is in season", () => {
  const seasonStart = T0 - 3 * D, seasonEnd = T0 - 1 * D; // a 3-day mock season
  const inSeason = (d) => d.getTime() >= seasonStart && d.getTime() <= seasonEnd;
  assert.equal(windowCleanOfSeason(T0, 7, inSeason), false, "window overlapping the season is dirty");
  assert.equal(windowCleanOfSeason(seasonEnd + 8 * D, 7, inSeason), true, "fully past the season is clean");
  assert.equal(windowCleanOfSeason(seasonEnd + 6 * D, 7, inSeason), false, "still reaches back into it");
  assert.equal(windowCleanOfSeason(seasonStart - 1 * D, 7, inSeason), true, "fully before the season is clean");
});

test("exposureMult: 1 with no data, saturating dock with reach, never below 1−EXPO_W", () => {
  assert.equal(exposureMult(0), 1, "no exposure data = no dampening (dormant)");
  assert.equal(exposureMult(-5), 1, "garbage negative = no dampening");
  const few = exposureMult(3), many = exposureMult(1000);
  assert.ok(few > 0.9, `3 exposed devices barely docks (got ${few})`);
  assert.ok(many < few, "more exposure docks more");
  assert.ok(many > 1 - 0.35 - 1e-9 && many >= 0.65, "dock saturates at EXPO_W");
});

test("baselineReach: absent song floors at the snapshot minimum when the top-N cap was hit", () => {
  const capped = Array.from({ length: 200 }, (_, i) => ({ v: `id${i}`, d: 200 - i })); // min d = 1
  const r = baselineReach(capped);
  assert.equal(r("id0"), 200, "present songs read their recorded reach");
  assert.equal(r("id199"), 1);
  assert.equal(r("never-listed"), 1, "below-cutoff song assumed at the cutoff, not 0 (no fake surge)");
});

test("baselineReach: an UNCAPPED snapshot is complete — absence really means zero", () => {
  const r = baselineReach([{ v: "a", d: 9 }, { v: "b", d: 4 }]);
  assert.equal(r("a"), 9);
  assert.equal(r("zzz"), 0);
  assert.equal(baselineReach(undefined)("anything"), 0, "no snapshot at all → zero, never NaN");
});
