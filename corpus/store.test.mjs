import { test } from "node:test";
import assert from "node:assert/strict";
import { openCorpus, upsertArtistCatalog, artistDetail, albumDetail, whitelistedChannelIds } from "./store.mjs";

const seed = (db) => upsertArtistCatalog(db, { id: "UCmusic", name: "Test Artist" }, {
  regularChannelId: "UCregular",
  tracks: [
    { videoId: "vid00000001", title: "Song One", isVideo: false },
    { videoId: "vid00000002", title: "A Clip", isVideo: true },
  ],
  albums: [
    { id: "MPRE_album", playlistId: "PLa", title: "Big Album", type: "album", year: 2020 },
    { id: "MPRE_single", playlistId: "PLs", title: "A Single", type: "single", year: 2021 },
  ],
  albumTracks: [{ albumId: "MPRE_album", videoId: "vid00000001", pos: 0 }],
});

test("artistDetail groups songs / videos / albums / singles", () => {
  const db = openCorpus(":memory:"); seed(db);
  const d = artistDetail(db, "UCmusic");
  assert.equal(d.songs.length, 1);
  assert.equal(d.videos.length, 1);
  assert.equal(d.albums.length, 1);
  assert.equal(d.singles.length, 1);
  assert.equal(d.albums[0].title, "Big Album");
});

test("albumDetail returns the album's tracks in order", () => {
  const db = openCorpus(":memory:"); seed(db);
  const a = albumDetail(db, "MPRE_album");
  assert.equal(a.album.title, "Big Album");
  assert.equal(a.tracks.length, 1);
  assert.equal(a.tracks[0].videoId, "vid00000001");
});

test("whitelistedChannelIds includes both the music and the regular-upload channel", () => {
  const db = openCorpus(":memory:"); seed(db);
  const wl = whitelistedChannelIds(db);
  assert.ok(wl.has("UCmusic"), "music channel");
  assert.ok(wl.has("UCregular"), "regular channel");
});
