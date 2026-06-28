import { test } from "node:test";
import assert from "node:assert/strict";
import { openCorpus, upsertArtistCatalog, artistDetail, albumDetail, whitelistedChannelIds, pruneArtists, prunePlan, stats } from "./store.mjs";

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

test("pruneArtists removes de-whitelisted artists and ALL their rows; keeps the rest", () => {
  const db = openCorpus(":memory:"); seed(db);
  upsertArtistCatalog(db, { id: "UCother", name: "Gone Artist" }, {
    tracks: [{ videoId: "vid00000003", title: "Orphan", isVideo: false }],
    albums: [{ id: "MPRE_gone", playlistId: "PLg", title: "Gone Album", type: "album", year: 2019 }],
    playlists: [{ id: "PLgone", title: "Gone PL" }],
    albumTracks: [{ albumId: "MPRE_gone", videoId: "vid00000003", pos: 0 }],
  });
  assert.equal(stats(db).artists, 2);

  const { artists } = pruneArtists(db, new Set(["UCmusic"]));
  assert.equal(artists, 1);

  // kept artist fully intact
  assert.ok(artistDetail(db, "UCmusic"));
  assert.equal(stats(db).artists, 1);

  // removed artist + every dependent row gone (FK-safe cascade)
  assert.equal(artistDetail(db, "UCother"), null);
  assert.equal(albumDetail(db, "MPRE_gone"), null);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM track WHERE artistId='UCother'").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM album_track WHERE albumId='MPRE_gone'").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM playlist WHERE artistId='UCother'").get().c, 0);
});

test("pruneArtists is a no-op when every artist is kept", () => {
  const db = openCorpus(":memory:"); seed(db);
  const { artists } = pruneArtists(db, new Set(["UCmusic", "UCsomeoneelse"]));
  assert.equal(artists, 0);
  assert.ok(artistDetail(db, "UCmusic"));
});

test("prunePlan: safe when most artists survive; UNSAFE on a too-small/disjoint whitelist (corpus-wipe guard)", () => {
  const corpus = ["UCa", "UCb", "UCc", "UCd"];
  let p = prunePlan(corpus, new Set(corpus));              // all kept
  assert.equal(p.safe, true); assert.equal(p.toRemove, 0); assert.equal(p.survivors, 4);
  p = prunePlan(corpus, new Set(["UCa", "UCb", "UCc"]));   // 3/4 survive (75% ≥ 50%)
  assert.equal(p.safe, true); assert.equal(p.toRemove, 1); assert.deepEqual(p.dropIds, ["UCd"]);
  p = prunePlan(corpus, new Set(["UCa"]));                 // 1/4 survive (25% < 50%)
  assert.equal(p.safe, false); assert.equal(p.toRemove, 3);
  p = prunePlan(corpus, new Set(["UCx", "UCy", "UCz", "UCw"])); // plausibly-sized but disjoint → 0 survive
  assert.equal(p.safe, false); assert.equal(p.survivors, 0);
});

test("prunePlan: NaN/out-of-range PRUNE_MIN_RATIO falls back to 0.5 (can't silently defeat the guard)", () => {
  const corpus = ["UCa", "UCb", "UCc", "UCd"];
  for (const bad of [NaN, "50%", -1, 2, undefined, "abc"]) {
    const p = prunePlan(corpus, new Set([]), bad);        // disjoint → must stay UNSAFE
    assert.equal(p.minRatio, 0.5, `ratio ${String(bad)} → 0.5`);
    assert.equal(p.safe, false, `disjoint must be unsafe with ratio ${String(bad)}`);
  }
});

test("prunePlan: empty corpus is safe (nothing to wipe)", () => {
  const p = prunePlan([], new Set([]));
  assert.equal(p.safe, true); assert.equal(p.before, 0); assert.equal(p.toRemove, 0);
});
