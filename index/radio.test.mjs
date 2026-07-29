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
import { buildRadioIndex, radio } from "./radio.mjs";

// Synthetic corpus: artists A/B/C (male), F (female). Enough tracks to backfill an endless queue.
const T = (videoId, artistId, artistName, extra = {}) => ({ videoId, title: videoId, artistId, artistName, isVideo: false, explicit: false, durationSec: 200, playCount: 0, releaseDate: "2024-01-01", isFemale: false, isChasid: false, isKidZone: false, ...extra });
const tracks = [
  T("a1", "A", "Artist A"), T("a2", "A", "Artist A"), T("a3", "A", "Artist A"), T("a4", "A", "Artist A"),
  T("b1", "B", "Artist B"), T("b2", "B", "Artist B"), T("b3", "B", "Artist B"),
  T("c1", "C", "Artist C"), T("c2", "C", "Artist C"),
  T("f1", "F", "Artist F", { isFemale: true }),
  T("v1", "A", "Artist A", { isVideo: true }),
  T("k1", "C", "Artist C", { isKidZone: true }),
];
const artists = [
  { id: "A", name: "Artist A", isFemale: false, isChasid: false, isKidZone: false },
  { id: "B", name: "Artist B", isFemale: false, isChasid: false, isKidZone: false },
  { id: "C", name: "Artist C", isFemale: false, isChasid: false, isKidZone: true },
  { id: "F", name: "Artist F", isFemale: true, isChasid: false, isKidZone: false },
];
const albumTracks = [{ albumId: "ALB", videoId: "a1", pos: 0 }, { albumId: "ALB", videoId: "a2", pos: 1 }];
// a1: session neighbor b1 (strong), library neighbors b2/c1; f1 is a library neighbor too (for purity test)
const graph = {
  pop: { a1: 20, a2: 10, a3: 8, a4: 5, b1: 15, b2: 12, b3: 6, c1: 9, c2: 4, f1: 7, v1: 3, k1: 2 },
  sess: { a1: [["b1", 0.9]] },
  lib: { a1: [["b2", 0.5], ["c1", 0.45], ["f1", 0.4], ["v1", 0.35], ["a2", 0.3]] },
};
const mk = (blocked = { global: new Set(), female: new Set() }) => buildRadioIndex({ tracks, artists, albumTracks, graph, blocked });

test("song seed plays THAT song first, then co-occurrence expansion", () => {
  const idx = mk();
  const { ids } = radio(idx, { kind: "song", seed: "a1", limit: 12 });
  assert.equal(ids[0], "a1", "the seed song goes first");
  assert.equal(ids.filter((v) => v === "a1").length, 1, "and appears only once");
  assert.ok(ids.includes("b1"), "then its co-occurrence neighbors follow");
  assert.ok(ids.indexOf("b2") < ids.indexOf("c2"), "cooc neighbor beats a non-neighbor");
});

test("artist seed leads with one of the artist's OWN songs", () => {
  const idx = mk();
  const { ids } = radio(idx, { kind: "artist", seed: "A", limit: 12 });
  assert.equal(idx.byId.get(ids[0]).artistId, "A", "first track is by the seed artist");
});

test("cold song (no cooc) falls back to the seed's artist, never empty", () => {
  const idx = mk();
  const { ids } = radio(idx, { kind: "song", seed: "a3", limit: 6 }); // a3 has no graph entry
  assert.ok(ids.length > 0);
  assert.ok(ids.some((v) => ["a1", "a2", "a4"].includes(v)), "surfaces same-artist catalog");
});

test("unknown seed is graceful (popularity station), not an error/empty", () => {
  const idx = mk();
  const { ids } = radio(idx, { kind: "song", seed: "zzzzz", limit: 5 });
  assert.ok(ids.length > 0);
});

test("album seed: the album plays through first, in order", () => {
  const idx = mk();
  const { ids } = radio(idx, { kind: "album", seed: "ALB", limit: 8 });
  assert.deepEqual(ids.slice(0, 2), ["a1", "a2"], "opening run = album tracks in pos order");
  assert.ok(ids.length > 2, "then continues");
});

test("female-blocked never yields a female-involved track", () => {
  const idx = mk();
  const { ids } = radio(idx, { kind: "song", seed: "a1", allowFemale: false, limit: 12 });
  assert.ok(!ids.includes("f1"), "f1 dropped though it is a library neighbor");
});

test("blockVideos drops video tracks; kidZoneOnly keeps only KidZone", () => {
  const idx = mk();
  assert.ok(!radio(idx, { kind: "song", seed: "a1", blockVideos: true, limit: 12 }).ids.includes("v1"));
  const kz = radio(idx, { kind: "shuffle", kidZoneOnly: true, limit: 12 }).ids;
  assert.ok(kz.length > 0 && kz.every((v) => v === "k1"), "only the KidZone track survives");
});

test("blocked-ids (global) are dropped", () => {
  const idx = mk({ global: new Set(["b1"]), female: new Set() });
  assert.ok(!radio(idx, { kind: "song", seed: "a1", limit: 12 }).ids.includes("b1"));
});

test("no more than 2 of the same artist in a row (diversity cap)", () => {
  const idx = mk();
  const { ids } = radio(idx, { kind: "artist", seed: "A", limit: 12 });
  let run = 1;
  for (let i = 1; i < ids.length; i++) {
    const ai = idx.byId.get(ids[i]).artistId, ap = idx.byId.get(ids[i - 1]).artistId;
    run = ai === ap ? run + 1 : 1;
    assert.ok(run <= 2, `artist ${ai} runs ${run} at index ${i}`);
  }
});

test("paging is deterministic, dup-free across pages, and endless", () => {
  const idx = mk();
  const seen = new Set();
  let opts = { kind: "shuffle", rngSeed: 42, offset: 0, limit: 5 };
  let pages = 0, off = 0;
  while (pages < 6) {
    const r = radio(idx, { ...opts, offset: off });
    for (const v of r.ids) { assert.ok(!seen.has(v), `dup ${v}`); seen.add(v); }
    if (r.nextOffset == null) break;
    off = r.nextOffset; pages++;
  }
  assert.ok(seen.size >= tracks.length - 2, "walks essentially the whole catalog");
  // determinism
  const a = radio(idx, { kind: "song", seed: "a1", rngSeed: 7, offset: 0, limit: 5 }).ids;
  const b = radio(idx, { kind: "song", seed: "a1", rngSeed: 7, offset: 0, limit: 5 }).ids;
  assert.deepEqual(a, b);
});

test("playlist seed expands from its member tracks' co-occurrence", () => {
  const idx = mk();
  const { ids } = radio(idx, { kind: "playlist", seed: "PLxyz", seedTracks: ["a1"], limit: 8 });
  assert.ok(ids.length > 0);
  assert.ok(ids.includes("b1"), "a1's session neighbor surfaces via playlist expansion");
});

test("playlist with no resolvable members falls back to popularity, never empty", () => {
  const idx = mk();
  const { ids } = radio(idx, { kind: "playlist", seed: "PLempty", seedTracks: [], limit: 5 });
  assert.ok(ids.length > 0);
});

test("shuffle needs no seed and varies with rngSeed", () => {
  const idx = mk();
  const a = radio(idx, { kind: "shuffle", rngSeed: 1, limit: 8 }).ids;
  const b = radio(idx, { kind: "shuffle", rngSeed: 2, limit: 8 }).ids;
  assert.ok(a.length > 0);
  assert.notDeepEqual(a, b, "different session seed → different order");
});
