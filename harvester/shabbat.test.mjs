import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { parseShabbatWindows, isQuiet, roughlyShabbat, shabbatQuiet } from "../harness/shabbat.mjs";

const SAMPLE = { items: [
  { category: "candles", date: "2026-07-03T20:12:00-04:00", title: "Candle lighting: 8:12pm" },
  { category: "havdalah", date: "2026-07-04T21:20:00-04:00", title: "Havdalah: 9:20pm" },
] };
const CANDLE = Date.parse("2026-07-03T20:12:00-04:00");
const HAV = Date.parse("2026-07-04T21:20:00-04:00");
const START = CANDLE - 20 * 60 * 1000;

test("parseShabbatWindows: window = candle−20min → havdalah", () => {
  const w = parseShabbatWindows(SAMPLE);
  assert.equal(w.length, 1);
  assert.equal(w[0].start, START);
  assert.equal(w[0].end, HAV);
});

test("parseShabbatWindows: multi-candle run (Yom Tov) spans ONE window", () => {
  const j = { items: [
    { category: "candles", date: "2026-07-03T20:12:00-04:00" },
    { category: "candles", date: "2026-07-04T21:20:00-04:00" },
    { category: "havdalah", date: "2026-07-05T21:19:00-04:00" },
  ] };
  const w = parseShabbatWindows(j);
  assert.equal(w.length, 1);
  assert.equal(w[0].start, Date.parse("2026-07-03T20:12:00-04:00") - 20 * 60 * 1000);
  assert.equal(w[0].end, Date.parse("2026-07-05T21:19:00-04:00"));
});

test("isQuiet: half-open [start, end) — resume exactly at havdalah", () => {
  const w = parseShabbatWindows(SAMPLE);
  assert.equal(isQuiet(w, START), true);
  assert.equal(isQuiet(w, START - 1), false);
  assert.equal(isQuiet(w, HAV - 1), true);
  assert.equal(isQuiet(w, HAV), false);
});

test("roughlyShabbat: Fri≥15:00 ET and Sat<22:00 ET (static fail-safe)", () => {
  const at = (iso) => Date.parse(iso);
  assert.equal(roughlyShabbat(at("2026-07-03T20:00:00Z")), true);  // Fri 16:00 EDT
  assert.equal(roughlyShabbat(at("2026-07-03T14:00:00Z")), false); // Fri 10:00 EDT
  assert.equal(roughlyShabbat(at("2026-07-05T01:00:00Z")), true);  // Sat 21:00 EDT
  assert.equal(roughlyShabbat(at("2026-07-05T03:00:00Z")), false); // Sat 23:00 EDT
  assert.equal(roughlyShabbat(at("2026-07-01T18:00:00Z")), false); // Wed
});

test("shabbatQuiet: serves from cache with NO network; quiet inside, resume at havdalah", async () => {
  const cp = path.join(os.tmpdir(), `zs-shab-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(cp, JSON.stringify({ fetchedAt: START, windows: parseShabbatWindows(SAMPLE) }));
  const noNet = async () => { throw new Error("must not fetch on Shabbos"); };
  const inside = await shabbatQuiet(CANDLE, { cachePath: cp, fetchImpl: noNet });
  assert.equal(inside.quiet, true);
  assert.equal(inside.until, HAV);
  assert.equal((await shabbatQuiet(HAV, { cachePath: cp, fetchImpl: noNet })).quiet, false);
  fs.rmSync(cp, { force: true });
});
