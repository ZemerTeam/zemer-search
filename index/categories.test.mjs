import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCategories, searchCategories } from "./categories.mjs";

const artist = { id: "UC1", name: "דודי פולק", thumbnail: null, isFemale: false, isChasid: false, isKidZone: false };
const fem = { id: "UC2", name: "Some Female", thumbnail: null, isFemale: true, isChasid: false, isKidZone: false };
const flags = (a) => ({ isFemale: a.isFemale, isChasid: a.isChasid, isKidZone: a.isKidZone });
const corpus = {
  tracks: [
    { videoId: "aaaaaaaaaaa", title: "כבקרת", artistName: "דודי פולק", isVideo: false, explicit: false, ...flags(artist) },
    { videoId: "bbbbbbbbbbb", title: "live clip", artistName: "דודי פולק", isVideo: true, explicit: false, ...flags(artist) },
    { videoId: "ccccccccccc", title: "her song", artistName: "Some Female", isVideo: false, explicit: false, ...flags(fem) },
  ],
  artists: [artist, fem],
  albums: [
    { id: "MPRE1", playlistId: "PL_a", title: "Album One", artistName: "דודי פולק", type: "album", year: 2020, thumbnail: null, ...flags(artist) },
    { id: "MPRE2", playlistId: "PL_s", title: "Single One", artistName: "דודי פולק", type: "single", year: 2021, thumbnail: null, ...flags(artist) },
  ],
  playlists: [{ id: "PL1", title: "Best Of", artistName: "דודי פולק", thumbnail: null, ...flags(artist) }],
};

test("search groups results into artist/song/album/single/video/playlist categories", () => {
  const cats = buildCategories(corpus);
  const r = searchCategories(cats, "dudi polak", {});
  assert.ok(r.artists.some((a) => a.id === "UC1"), "artist");
  assert.ok(r.songs.some((s) => s.videoId === "aaaaaaaaaaa"), "song");
  assert.ok(r.videos.some((v) => v.videoId === "bbbbbbbbbbb"), "video");
  assert.ok(r.albums.some((a) => a.id === "MPRE1"), "album");
  assert.ok(r.singles.some((a) => a.id === "MPRE2"), "single");
  assert.ok(r.playlists.some((p) => p.id === "PL1"), "playlist");
});

test("cross-script query reaches every category", () => {
  const r = searchCategories(buildCategories(corpus), "kevakarat", {});
  assert.ok(r.songs.some((s) => s.videoId === "aaaaaaaaaaa"));
});

test("artists/albums/singles/playlists honor k (no longer hard-capped at 6)", () => {
  const f = { isFemale: false, isChasid: false, isKidZone: false };
  const mk = (n, g) => Array.from({ length: n }, (_, i) => g(i));
  const artists = mk(8, (i) => ({ id: `UCart${i}`, name: `Simcha Singer ${i}`, thumbnail: null, ...f }));
  const albums = [
    ...mk(8, (i) => ({ id: `MPRalb${i}`, playlistId: `PLa${i}`, title: `Simcha Album ${i}`, artistName: "X", type: "album", year: 2020, thumbnail: null, ...f })),
    ...mk(8, (i) => ({ id: `MPRsin${i}`, playlistId: `PLs${i}`, title: `Simcha Single ${i}`, artistName: "X", type: "single", year: 2021, thumbnail: null, ...f })),
  ];
  const playlists = mk(8, (i) => ({ id: `PLpl${i}`, title: `Simcha Playlist ${i}`, artistName: "X", thumbnail: null, ...f }));
  const r = searchCategories(buildCategories({ tracks: [], artists, albums, playlists }), "simcha", { k: 8 });
  assert.ok(r.artists.length >= 7, `artists=${r.artists.length} (was capped at 6)`);
  assert.ok(r.albums.length >= 7, `albums=${r.albums.length}`);
  assert.ok(r.singles.length >= 7, `singles=${r.singles.length}`);
  assert.ok(r.playlists.length >= 7, `playlists=${r.playlists.length}`);
  // summary (k=8) still bounds each category to ≤ k
  assert.ok(r.artists.length <= 8 && r.albums.length <= 8, "still bounded by k");
});

test("videos category respects k (not capped at 6) so the Videos pill isn't truncated", () => {
  const vids = Array.from({ length: 8 }, (_, i) => ({ videoId: `vvvvvvvvv0${i}`, title: `Simcha Clip ${i}`, artistName: "דודי פולק", isVideo: true, explicit: false, ...flags(artist) }));
  const cats = buildCategories({ ...corpus, tracks: [...corpus.tracks, ...vids] });
  assert.ok(searchCategories(cats, "simcha clip", { k: 8 }).videos.length >= 7, "more than the old hard cap of 6 videos");
  assert.equal(searchCategories(cats, "simcha clip", { k: 8, blockVideos: true }).videos.length, 0, "blockVideos still empties the category");
});

test("blockVideos empties the Videos category; allowFemale=false hides the female artist", () => {
  const cats = buildCategories(corpus);
  assert.equal(searchCategories(cats, "dudi polak", { blockVideos: true }).videos.length, 0);
  const noFem = searchCategories(cats, "some female", { allowFemale: false });
  assert.equal(noFem.artists.length, 0);
  assert.equal(noFem.songs.length, 0);
});

// ---- community playlists in search results respect the content filter --------------------------
// clsMask bit = (isFemale*4 + isVideo*2 + isKidZone): female-audio=1<<4, male-audio=1<<0, male-video=1<<2.
const CP = (id, title, clsMask, fb = 0) => ({ id, title, artistName: "", author: "DJ", thumbnail: null, source: "community", whitelisted: 5, total: 5, fb, clsMask });

test("community search: an ALL-female playlist is hidden when female is blocked; a mixed one survives", () => {
  const community = [CP("PLallfem", "Shabbos Female", 1 << 4), CP("PLmixed", "Shabbos Mixed", (1 << 4) | (1 << 0))];
  const cats = buildCategories({ ...corpus, community });
  const open = searchCategories(cats, "shabbos", { k: 20 }).community.map((p) => p.id);
  assert.ok(open.includes("PLallfem") && open.includes("PLmixed"), "both shown by default");
  const filtered = searchCategories(cats, "shabbos", { k: 20, allowFemale: false }).community.map((p) => p.id);
  assert.ok(!filtered.includes("PLallfem"), "all-female community playlist hidden in search when female blocked");
  assert.ok(filtered.includes("PLmixed"), "mixed community playlist still shown");
});

test("community search: an all-video playlist is hidden when videos are blocked", () => {
  const community = [CP("PLvid", "Shabbos Clips", 1 << 2), CP("PLaud", "Shabbos Audio", 1 << 0)];
  const cats = buildCategories({ ...corpus, community });
  const ids = searchCategories(cats, "shabbos", { k: 20, blockVideos: true }).community.map((p) => p.id);
  assert.ok(!ids.includes("PLvid"), "all-video community playlist hidden when videos blocked");
  assert.ok(ids.includes("PLaud"), "audio playlist still shown");
});

test("community search: conjunction is EXACT — female+video blocked hides a list with no member passing BOTH", () => {
  // members: female-audio (1<<4) + male-video (1<<2) — neither is both non-female AND non-video
  const community = [CP("PLconj", "Shabbos Conj", (1 << 4) | (1 << 2))];
  const cats = buildCategories({ ...corpus, community });
  assert.ok(searchCategories(cats, "shabbos", { k: 20 }).community.some((p) => p.id === "PLconj"), "shown by default");
  assert.equal(searchCategories(cats, "shabbos", { k: 20, allowFemale: false, blockVideos: true }).community.some((p) => p.id === "PLconj"), false,
    "hidden when BOTH blocked (no member is non-female AND non-video)");
  assert.ok(searchCategories(cats, "shabbos", { k: 20, allowFemale: false }).community.some((p) => p.id === "PLconj"),
    "female-only block keeps it (the male video member survives)");
});

test("community search: a not-yet-in-corpus (fallback) member keeps a playlist regardless of filter", () => {
  const community = [CP("PLfb", "Shabbos Fallback", 1 << 4, 1)]; // looks all-female but has a fallback member
  const cats = buildCategories({ ...corpus, community });
  assert.ok(searchCategories(cats, "shabbos", { k: 20, allowFemale: false }).community.some((p) => p.id === "PLfb"),
    "fallback member (unknown flags) keeps it (fail-open, matches /playlist)");
});

test("community search: no filter = unchanged (every matching community playlist shown)", () => {
  const community = [CP("PLa", "Shabbos A", 1 << 4), CP("PLb", "Shabbos B", 1 << 2)];
  const cats = buildCategories({ ...corpus, community });
  assert.equal(searchCategories(cats, "shabbos", { k: 20 }).community.length, 2, "default shows all");
});
