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
import { seasonActive } from "../corpus/season.mjs";
import { pickBaseline, windowCleanOfSeason, exposureMult, exposureGate, baselineReach, cappedLookup } from "./trending.mjs";

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

test("exposureMult: docks by SHARE of the instrumented audience, bounded by EXPO_W", () => {
  assert.equal(exposureMult(0, 0), 1, "nothing instrumented = no dampening");
  assert.equal(exposureMult(50, 0), 1, "no denominator = no dampening, never a divide-by-zero");
  assert.equal(exposureMult(0, 100), 1, "shown to nobody = untouched");
  assert.ok(Math.abs(exposureMult(50, 100) - 0.825) < 1e-9, "half the audience = half the max dock");
  assert.ok(Math.abs(exposureMult(100, 100) - 0.65) < 1e-9, "shown to everyone = the full 35% dock");
  assert.ok(Math.abs(exposureMult(500, 100) - 0.65) < 1e-9, "share clamps at 1 (dedup gaps can't over-dock)");
  assert.equal(exposureMult(-5, 100), 1, "garbage negative = no dampening");
});

test("exposureMult is ADOPTION-INVARIANT — the same share docks the same at any fleet size", () => {
  // the rollout-skew failure the absolute-prior version had: docking depth must not move with adoption
  assert.equal(exposureMult(10, 20), exposureMult(500, 1000), "same share, same multiplier");
});

const SURFACES = [{ surface: "home:quick-picks", devices: 90 }, { surface: "home:new-releases", devices: 70 },
                  { surface: "search", devices: 60 }, { surface: "artist:UC123", devices: 40 }];
const REQ = ["home:", "search", "artist:"];
const ok = { enabled: true, impressionDevices: 100, playDevices: 120, requiredSurfaces: REQ, surfaces: SURFACES };

test("exposureGate: never auto-engages — explicit enable AND coverage, with a reason", () => {
  assert.equal(exposureGate({ ...ok, enabled: false }).on, false, "off unless explicitly enabled");
  assert.match(exposureGate({ ...ok, enabled: false }).reason, /EXPOSURE_DAMPENER=on/);
  assert.equal(exposureGate(ok).on, true, "83% coverage + all declared surfaces reporting");
  // partial rollout: plenty of devices, but most of the playing population isn't instrumented yet
  const thin = exposureGate({ ...ok, impressionDevices: 30, playDevices: 200 });
  assert.equal(thin.on, false, "15% coverage must not dampen");
  assert.match(thin.reason, /coverage 15%/);
  // tiny sample, even at 100% coverage
  const tiny = exposureGate({ ...ok, impressionDevices: 5, playDevices: 5,
                              surfaces: SURFACES.map((r) => ({ ...r, devices: 5 })) });
  assert.equal(tiny.on, false, "5 devices is not a population");
  assert.equal(exposureGate({ ...ok, impressionDevices: 0, playDevices: 0, surfaces: [] }).on, false, "no data, no divide-by-zero");
});

test("exposureGate: DEVICE coverage alone can't open it — every DECLARED surface must be reporting", () => {
  // the C.1 hole: home ships first, device coverage sails past 60% because every device visits home,
  // while artist pages are still emitting nothing — songs exposed there would be docked ~0%.
  const homeOnly = exposureGate({ ...ok, surfaces: [{ surface: "home:quick-picks", devices: 100 }] });
  assert.equal(homeOnly.on, false, "high device coverage must NOT open the gate on partial instrumentation");
  assert.deepEqual(homeOnly.missingSurfaces, ["search", "artist:"]);
  assert.match(homeOnly.reason, /not reporting yet/);
  // a declared surface present but with trivial volume is still 'not reporting'
  const trickle = exposureGate({ ...ok, surfaces: [...SURFACES.slice(0, 3), { surface: "artist:UC1", devices: 2 }] });
  assert.equal(trickle.on, false, "2 devices on a surface is not instrumentation");
  assert.deepEqual(trickle.missingSurfaces, ["artist:"]);
});

test("exposureGate: no declared list = closed (a missing config can't silently reopen the hole)", () => {
  const undeclared = exposureGate({ ...ok, requiredSurfaces: [] });
  assert.equal(undeclared.on, false);
  assert.match(undeclared.reason, /EXPOSURE_REQUIRED_SURFACES/);
});

test("exposureGate: a trailing ':' requirement is a PREFIX (per-section home rows all count)", () => {
  const perRow = exposureGate({ ...ok, requiredSurfaces: ["home:", "search", "artist:"],
    surfaces: [{ surface: "home:forgotten-favorites", devices: 55 }, { surface: "search", devices: 60 },
               { surface: "artist:UCabc", devices: 30 }] });
  assert.equal(perRow.on, true, "home:<section> satisfies the 'home:' requirement");
  const exact = exposureGate({ ...ok, requiredSurfaces: ["search"], surfaces: [{ surface: "searching", devices: 99 }] });
  assert.equal(exact.on, false, "a non-':' requirement must match exactly, not by prefix");
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

test("cappedLookup: same cap semantics for ANY top-N list (topImpressions gets the floor too)", () => {
  const capped = Array.from({ length: 200 }, (_, i) => [`id${i}`, 200 - i]); // min = 1
  const l = cappedLookup(capped);
  assert.equal(l("id0"), 200);
  assert.equal(l("unlisted"), 1, "below-cutoff exposure is floored, not treated as unexposed");
  // the cliff this prevents: an unlisted song must not score better than the last listed one
  assert.ok(exposureMult(l("unlisted"), 500) <= exposureMult(l("id199"), 500) + 1e-12);
  const short = cappedLookup([["a", 5]]);
  assert.equal(short("b"), 0, "an uncapped list is complete — absence really is zero");
  assert.equal(cappedLookup(null)("x"), 0);
});

test("velocity guard honors a FORCED season (ACAPELLA_SEASON), not just the calendar", () => {
  // the generator passes (d) => seasonActive("three-weeks", d); prove the forced states propagate
  const prev = process.env.ACAPELLA_SEASON;
  try {
    process.env.ACAPELLA_SEASON = "on";
    const gate = (d) => seasonActive("three-weeks", d);
    assert.equal(windowCleanOfSeason(Date.UTC(2026, 0, 15), 7, gate), false, "forced ON = never clean → velocity suspended");
    process.env.ACAPELLA_SEASON = "off";
    assert.equal(windowCleanOfSeason(Date.UTC(2026, 6, 20), 7, gate), true, "forced OFF = always clean, even mid-Three-Weeks");
  } finally { if (prev === undefined) delete process.env.ACAPELLA_SEASON; else process.env.ACAPELLA_SEASON = prev; }
});

test("exposureGate: a failed exposure fetch says so, instead of blaming the env var", () => {
  const g = exposureGate({ ...ok, unavailable: "exposure window (28d) unavailable this run" });
  assert.equal(g.on, false);
  assert.match(g.reason, /unavailable this run/);
  assert.doesNotMatch(g.reason, /EXPOSURE_DAMPENER/, "must not send the operator debugging the deployment");
});

test("exposureGate: duplicate surface rows MAX-merge, never last-one-wins", () => {
  const dup = exposureGate({ ...ok, requiredSurfaces: ["artist:"],
    surfaces: [{ surface: "artist:UC1", devices: 40 }, { surface: "artist:UC1", devices: 8 }] });
  assert.equal(dup.on, true, "40 devices is the truth; the trailing 8-device row must not hide it");
});
