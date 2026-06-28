// Pinned tests for the community-playlist pilot's pure logic (the admission gate + seed builder). The
// gate is a QUALITY gate, not a purity gate — purity is enforced at serve time (see corpus/store.test.mjs
// "community playlist" round-trip + the /playlist endpoint), so these only assert the admit/reject policy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { admitPlaylist, buildSeeds, screenText } from "./playlists.mjs";

test("admitPlaylist rejects a playlist with too few whitelisted tracks", () => {
  const v = admitPlaylist({ total: 50, whitelisted: 3 }, { minTracks: 4, minRatio: 0.5 });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "too-few-whitelisted");
});

test("admitPlaylist rejects a mostly-non-whitelisted playlist even with many whitelisted tracks", () => {
  // 10 whitelisted of 100 — clears the count floor but is only 10% whitelisted → a fragment, not a list.
  const v = admitPlaylist({ total: 100, whitelisted: 10 }, { minTracks: 4, minRatio: 0.5 });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "too-impure");
});

test("admitPlaylist admits a list that clears BOTH the count floor and the ratio floor", () => {
  const v = admitPlaylist({ total: 12, whitelisted: 8 }, { minTracks: 4, minRatio: 0.5 });
  assert.equal(v.ok, true);
  assert.equal(v.reason, "admitted");
});

test("admitPlaylist ratio is inclusive at the floor", () => {
  assert.equal(admitPlaylist({ total: 10, whitelisted: 5 }, { minTracks: 4, minRatio: 0.5 }).ok, true);
});

test("buildSeeds dedupes (case-insensitive), drops _comment-style keys, and caps to n", () => {
  const seeds = buildSeeds(
    { topics: ["_comment", "Jewish Music", "jewish music", "Kumzitz"], artistNames: ["Avraham Fried", "Kumzitz"] },
    { mode: "both", n: 3 });
  assert.deepEqual(seeds, ["Jewish Music", "Kumzitz", "Avraham Fried"]);
});

test("buildSeeds mode=artists uses only artist names; mode=topics only topics", () => {
  assert.deepEqual(buildSeeds({ topics: ["t1"], artistNames: ["a1"] }, { mode: "artists", n: 9 }), ["a1"]);
  assert.deepEqual(buildSeeds({ topics: ["t1"], artistNames: ["a1"] }, { mode: "topics", n: 9 }), ["t1"]);
});

test("screenText flags blocklisted terms in the title OR curator name (case-insensitive); null otherwise", () => {
  assert.equal(screenText("Best EXPLICIT mix", "Someone", ["explicit"]), "explicit", "matches in title");
  assert.equal(screenText("Clean mix", "DJ Explicit", ["explicit"]), "explicit", "matches in curator");
  assert.equal(screenText("Shabbos Songs", "Mordy", ["explicit"]), null, "no match → null");
  assert.equal(screenText("anything", "anyone", []), null, "empty term list → null (screen disabled)");
});

test("buildSeeds firstNames adds each artist's leading token (deduped, ≥3 chars), as its own seed", () => {
  const seeds = buildSeeds(
    { topics: [], artistNames: ["Avraham Fried", "Avraham Rosenblum", "Yo Yo", "Mordechai Ben David"] },
    { mode: "artists", n: 99, firstNames: true });
  // full names + first names, first name "Avraham" deduped, "Yo" dropped (<3 chars)
  assert.deepEqual(seeds, ["Avraham Fried", "Avraham", "Avraham Rosenblum", "Yo Yo", "Mordechai Ben David", "Mordechai"]);
});
