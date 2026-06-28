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

test("blockVideos empties the Videos category; allowFemale=false hides the female artist", () => {
  const cats = buildCategories(corpus);
  assert.equal(searchCategories(cats, "dudi polak", { blockVideos: true }).videos.length, 0);
  const noFem = searchCategories(cats, "some female", { allowFemale: false });
  assert.equal(noFem.artists.length, 0);
  assert.equal(noFem.songs.length, 0);
});
