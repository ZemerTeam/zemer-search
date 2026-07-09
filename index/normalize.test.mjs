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
import { plainTokens, skeletonTokens, damerau } from "./normalize.mjs";

test("plainTokens lowercases Latin, folds punctuation, keeps Hebrew", () => {
  assert.deepEqual(plainTokens("Dudi Polak (feat. X)"), ["dudi", "polak", "feat", "x"]);
  assert.deepEqual(plainTokens("כבקרת"), ["כבקרת"]);
  assert.deepEqual(plainTokens(""), []);
});

test("skeleton aligns a romanized Latin query with the Hebrew title — the core fuzzy win", () => {
  const eq = (a, b) => assert.deepEqual(skeletonTokens(a), skeletonTokens(b), `${a} ≠ ${b}`);
  eq("כבקרת", "kevakarat");      // → kbkrt (b/v fold + vowel-less Hebrew)
  eq("דודי פולק", "dudi polak"); // → dd plk (matres lectionis dropped)
  eq("בנימין", "binyamin");      // → bnmn
  eq("נתנאל", "natanel");        // → ntnl
});

test("skeleton strips niqqud (NFD) so pointed/unpointed Hebrew matches", () => {
  assert.deepEqual(skeletonTokens("שָׁלוֹם"), skeletonTokens("שלום"));
});

test("damerau: adjacent transposition costs 1; respects the cap", () => {
  assert.equal(damerau("abc", "abc", 2), 0);
  assert.equal(damerau("abc", "abd", 2), 1);   // substitution
  assert.equal(damerau("abcd", "abdc", 2), 1); // transposition
  assert.equal(damerau("wawa", "waaw", 2), 1); // the short-title case the benchmark stressed
  assert.ok(damerau("abc", "xyz", 2) > 2);     // capped, no underflow
  assert.equal(damerau("", "ab", 2), 2);
});
