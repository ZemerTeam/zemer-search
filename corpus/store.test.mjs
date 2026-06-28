import { test } from "node:test";
import assert from "node:assert/strict";
import { openCorpus, upsertArtistCatalog, artistDetail, albumDetail, whitelistedChannelIds, pruneArtists, prunePlan, pruneBlocklisted, stats, upsertCommunityPlaylist, removeCommunityPlaylist, allCommunityPlaylists, communityPlaylistMeta, communityPlaylistIds } from "./store.mjs";

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

test("pruneBlocklisted removes only the listed videoIds (+ album_track membership) and artists", () => {
  const db = openCorpus(":memory:"); seed(db); // UCmusic: vid00000001 (in MPRE_album), vid00000002
  let r = pruneBlocklisted(db, { videoIds: new Set(["vid00000001"]), artistIds: new Set() });
  assert.equal(r.tracks, 1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM track WHERE videoId='vid00000001'").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM album_track WHERE videoId='vid00000001'").get().c, 0, "album_track membership cleared");
  assert.ok(db.prepare("SELECT 1 FROM track WHERE videoId='vid00000002'").get(), "other track intact");
  // blocklisting an artist removes the artist + all its rows
  r = pruneBlocklisted(db, { videoIds: new Set(), artistIds: new Set(["UCmusic"]) });
  assert.equal(r.artists, 1);
  assert.equal(artistDetail(db, "UCmusic"), null);
});

// ---- community playlists (pilot) ---------------------------------------------------------------

test("community playlist round-trips: counts, source tag, membership, and meta lookup", () => {
  const db = openCorpus(":memory:");
  upsertCommunityPlaylist(db, { id: "PLcomm", title: "Shabbos Vibes", author: "DJ Moshe", thumbnail: "t.jpg", total: 20 }, [
    { videoId: "vid00000001", pos: 0 }, { videoId: "vid00000002", pos: 1 }, { videoId: "vid00000003", pos: 2 },
  ]);
  const all = allCommunityPlaylists(db);
  assert.equal(all.length, 1);
  assert.equal(all[0].id, "PLcomm");
  assert.equal(all[0].artistName, "DJ Moshe", "author surfaces as artistName for the index");
  assert.equal(all[0].source, "community");
  assert.equal(all[0].whitelisted, 3);
  assert.equal(all[0].total, 20);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM community_playlist_track WHERE playlistId='PLcomm'").get().c, 3);
  assert.equal(stats(db).communityPlaylists, 1);
  const meta = communityPlaylistMeta(db, "PLcomm");
  assert.equal(meta.title, "Shabbos Vibes");
  assert.equal(meta.author, "DJ Moshe");
  assert.ok(communityPlaylistIds(db).has("PLcomm"));
});

test("upsertCommunityPlaylist re-snapshots membership on a re-check (drops tracks no longer whitelisted)", () => {
  const db = openCorpus(":memory:");
  upsertCommunityPlaylist(db, { id: "PLx", title: "X", total: 10 }, [{ videoId: "a0000000001" }, { videoId: "b0000000002" }, { videoId: "c0000000003" }]);
  assert.equal(communityPlaylistMeta(db, "PLx").whitelisted, 3);
  // a later re-check finds only 1 still whitelisted → membership + count shrink, no stale rows linger
  upsertCommunityPlaylist(db, { id: "PLx", title: "X", total: 10 }, [{ videoId: "a0000000001" }]);
  assert.equal(communityPlaylistMeta(db, "PLx").whitelisted, 1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM community_playlist_track WHERE playlistId='PLx'").get().c, 1);
});

test("community playlist cover is derived from a WHITELISTED track, not the curator's cover image", () => {
  const db = openCorpus(":memory:");
  upsertCommunityPlaylist(db, { id: "PLcov", title: "C", thumbnail: "https://evil.example/cover.jpg", total: 5 },
    [{ videoId: "wl00000001x", pos: 0 }, { videoId: "wl00000002x", pos: 1 }]);
  const expect = "https://i.ytimg.com/vi/wl00000001x/mqdefault.jpg";
  assert.equal(allCommunityPlaylists(db)[0].thumbnail, expect, "index thumbnail from first whitelisted track");
  assert.equal(communityPlaylistMeta(db, "PLcov").thumbnail, expect, "meta thumbnail from first whitelisted track");
});

test("pruneBlocklisted removes an explicitly blocklisted community playlist + its membership", () => {
  const db = openCorpus(":memory:");
  upsertCommunityPlaylist(db, { id: "PLbad", title: "Bad", total: 5 }, [{ videoId: "x0000000001" }, { videoId: "x0000000002" }]);
  upsertCommunityPlaylist(db, { id: "PLok", title: "Ok", total: 5 }, [{ videoId: "y0000000001" }, { videoId: "y0000000002" }]);
  const r = pruneBlocklisted(db, { videoIds: new Set(), artistIds: new Set(), playlistIds: new Set(["PLbad"]) });
  assert.equal(r.playlists, 1);
  assert.equal(communityPlaylistMeta(db, "PLbad"), null, "blocklisted playlist gone");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM community_playlist_track WHERE playlistId='PLbad'").get().c, 0);
  assert.ok(communityPlaylistMeta(db, "PLok"), "other playlist intact");
});

test("removeCommunityPlaylist drops the playlist AND its membership ('remove what's not')", () => {
  const db = openCorpus(":memory:");
  upsertCommunityPlaylist(db, { id: "PLdel", title: "Gone", total: 6 }, [{ videoId: "v0000000001" }, { videoId: "v0000000002" }]);
  assert.equal(stats(db).communityPlaylists, 1);
  removeCommunityPlaylist(db, "PLdel");
  assert.equal(stats(db).communityPlaylists, 0);
  assert.equal(communityPlaylistMeta(db, "PLdel"), null);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM community_playlist_track WHERE playlistId='PLdel'").get().c, 0);
  assert.ok(!communityPlaylistIds(db).has("PLdel"));
});

test("pruneBlocklisted removes blocklisted videoIds from community membership and re-syncs the count", () => {
  const db = openCorpus(":memory:");
  upsertCommunityPlaylist(db, { id: "PLp", title: "P", total: 8 }, [{ videoId: "keep0000001" }, { videoId: "drop0000002" }, { videoId: "keep0000003" }]);
  assert.equal(communityPlaylistMeta(db, "PLp").whitelisted, 3);
  pruneBlocklisted(db, { videoIds: new Set(["drop0000002"]), artistIds: new Set() });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM community_playlist_track WHERE playlistId='PLp'").get().c, 2, "blocklisted membership row gone");
  assert.equal(communityPlaylistMeta(db, "PLp").whitelisted, 2, "stored count re-synced to membership");
});
