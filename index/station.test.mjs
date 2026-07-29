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
import { extendSchedule, scheduleAt } from "./station.mjs";

const mkPool = (n, artists = 8) => Array.from({ length: n }, (_, i) => ({ videoId: "v" + i, artistId: "A" + (i % artists), durationSec: 120 + (i % 5) * 30 }));
const T0 = 1_700_000_000_000;
const HOUR = 3600000;

test("schedule is contiguous, covers the horizon, and every entry is a pool track", () => {
  const pool = mkPool(60);
  const { entries } = extendSchedule({ pool, entries: [], state: { seed: 42 }, untilMs: T0 + 6 * HOUR, startAtMs: T0 });
  assert.ok(entries.length > 0);
  const last = entries[entries.length - 1];
  assert.ok(last[1] + last[2] * 1000 >= T0 + 6 * HOUR, "covers the horizon");
  const ids = new Set(pool.map((p) => p.videoId));
  for (let i = 0; i < entries.length; i++) {
    assert.ok(ids.has(entries[i][0]), "pool track");
    if (i) assert.equal(entries[i][1], entries[i - 1][1] + entries[i - 1][2] * 1000, "contiguous — no gaps, no overlaps");
  }
});

test("deterministic: same state + pool → identical schedule", () => {
  const pool = mkPool(60);
  const a = extendSchedule({ pool, entries: [], state: { seed: 7 }, untilMs: T0 + 3 * HOUR, startAtMs: T0 });
  const b = extendSchedule({ pool, entries: [], state: { seed: 7 }, untilMs: T0 + 3 * HOUR, startAtMs: T0 });
  assert.deepEqual(a.entries, b.entries);
});

test("APPEND-ONLY: extending never rewrites published entries", () => {
  const pool = mkPool(60);
  const first = extendSchedule({ pool, entries: [], state: { seed: 7 }, untilMs: T0 + 3 * HOUR, startAtMs: T0 });
  const snapshot = JSON.stringify(first.entries);
  const extended = extendSchedule({ pool, graph: {}, entries: first.entries, state: first.state, untilMs: T0 + 8 * HOUR, startAtMs: T0 });
  assert.equal(JSON.stringify(extended.entries.slice(0, JSON.parse(snapshot).length)), snapshot, "published prefix untouched");
  const last = extended.entries[extended.entries.length - 1];
  assert.ok(last[1] + last[2] * 1000 >= T0 + 8 * HOUR);
});

test("artist spacing: no artist within 3 consecutive slots", () => {
  const pool = mkPool(80, 10);
  const { entries } = extendSchedule({ pool, entries: [], state: { seed: 3 }, untilMs: T0 + 8 * HOUR, startAtMs: T0 });
  const artistOf = new Map(pool.map((p) => [p.videoId, p.artistId]));
  for (let i = 0; i < entries.length; i++)
    for (let j = Math.max(0, i - 3); j < i; j++)
      assert.notEqual(artistOf.get(entries[i][0]), artistOf.get(entries[j][0]), `artist repeat at ${j}→${i}`);
});

test("no-repeat memory: a track can't return until ~half the pool has played", () => {
  const pool = mkPool(40);
  const { entries } = extendSchedule({ pool, entries: [], state: { seed: 9 }, untilMs: T0 + 12 * HOUR, startAtMs: T0 });
  const minGap = Math.min(Math.floor(pool.length / 2), 4000);
  const lastSeen = new Map();
  entries.forEach(([v], i) => {
    if (lastSeen.has(v)) assert.ok(i - lastSeen.get(v) > minGap, `track ${v} repeated after ${i - lastSeen.get(v)} slots`);
    lastSeen.set(v, i);
  });
});

test("tiny pool never deadlocks (memory windows relax instead of hanging)", () => {
  const pool = mkPool(6, 6);
  const { entries } = extendSchedule({ pool, entries: [], state: { seed: 1 }, untilMs: T0 + 4 * HOUR, startAtMs: T0 });
  const last = entries[entries.length - 1];
  assert.ok(last[1] + last[2] * 1000 >= T0 + 4 * HOUR, "still covers the horizon");
});

test("cooc bonus steers toward neighbors of the previous track", () => {
  // two disjoint 'clusters' wired by a lib graph; with a strong graph the schedule should chain within
  // clusters more often than the 50/50 base rate
  const pool = mkPool(200, 100);
  const clusterOf = (v) => Number(v.slice(1)) % 2;
  const lib = {};
  for (const p of pool) lib[p.videoId] = pool.filter((q) => q.videoId !== p.videoId && clusterOf(q.videoId) === clusterOf(p.videoId)).slice(0, 40).map((q) => [q.videoId, 0.8]);
  const { entries } = extendSchedule({ pool, graph: { lib }, entries: [], state: { seed: 5 }, untilMs: T0 + 10 * HOUR, startAtMs: T0 });
  let same = 0;
  for (let i = 1; i < entries.length; i++) if (clusterOf(entries[i][0]) === clusterOf(entries[i - 1][0])) same++;
  assert.ok(same / (entries.length - 1) > 0.6, `cluster-coherent transitions ${(100 * same / (entries.length - 1)).toFixed(0)}% (want >60%)`);
});

test("scheduleAt finds the entry at a wall-clock instant (and -1 outside)", () => {
  const pool = mkPool(30);
  const { entries } = extendSchedule({ pool, entries: [], state: { seed: 2 }, untilMs: T0 + 2 * HOUR, startAtMs: T0 });
  const [v3, s3, d3] = entries[3];
  const i = scheduleAt(entries, s3 + Math.floor(d3 * 500));
  assert.equal(entries[i][0], v3);
  assert.equal(scheduleAt(entries, T0 - 1000), -1);
  const last = entries[entries.length - 1];
  assert.equal(scheduleAt(entries, last[1] + last[2] * 1000 + 1), -1);
});
