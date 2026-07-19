// zemer-search — search engine and more for the Zemer app
// https://github.com/ZemerTeam/zemer-search
// Zemer app: https://github.com/ZemerTeam/zemer-app
// Copyright (C) 2026 alltechdev
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See the LICENSE file for details.

import test from "node:test";
import assert from "node:assert/strict";
import { dupKey, dedupRanked } from "./dedup.mjs";

test("re-upload collapses: same artist, same title modulo case/punctuation", () => {
  assert.equal(dupKey("Kol Dodi Dofeik", "UCa"), dupKey("kol dodi dofeik!", "UCa"));
  assert.equal(dupKey("Bayit Shel Shalom - בית של שלום", "UCa"), dupKey("Bayit Shel Shalom — בית של שלום", "UCa"));
});

test("acapella/vocal variant NEVER collapses into the original (Three-Weeks-critical)", () => {
  assert.notEqual(dupKey("Home Again", "UCa"), dupKey("Home Again (Acapella)", "UCa"));
  assert.notEqual(dupKey("ידיעת האמת", "UCa"), dupKey("ידיעת האמת - ווקאלי", "UCa"));
  assert.notEqual(dupKey("Ad Ana", "UCa"), dupKey("Ad Ana (Vocal Version)", "UCa"));
});

test("live/instrumental/remix/cover variants stay distinct from the studio original", () => {
  for (const v of ["Song (Live)", "Song (Instrumental)", "Song Remix", "Song (Cover)", "Song קאבר"])
    assert.notEqual(dupKey("Song", "UCa"), dupKey(v, "UCa"));
});

test("same title by DIFFERENT artists never collapses (gotcha #9)", () => {
  assert.notEqual(dupKey("Tov Lehodot", "UCa"), dupKey("Tov Lehodot", "UCb"));
});

test("titles differing by a real word are different content", () => {
  assert.notEqual(dupKey("Tzama (Acapella)", "UCa"), dupKey("Tzama (Acapella Version)", "UCa")); // conservative: no merge
});

test("dedupRanked keeps the highest-ranked entry and preserves order", () => {
  const meta = { a: ["Song", "UC1"], b: ["song!!", "UC1"], c: ["Song (Acapella)", "UC1"], d: ["Other", "UC2"] };
  const keyOf = (x) => dupKey(...meta[x.v]);
  const out = dedupRanked([{ v: "a" }, { v: "b" }, { v: "c" }, { v: "d" }], keyOf).map((x) => x.v);
  assert.deepEqual(out, ["a", "c", "d"]); // b (re-upload of a) dropped; acapella variant + other artist kept
});
