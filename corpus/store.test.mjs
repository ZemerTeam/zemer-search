import { test } from "node:test";
import assert from "node:assert/strict";
import { openCorpus, upsertArtistCatalog, artistDetail, albumDetail, tracksByIds, whitelistedChannelIds, pruneArtists, prunePlan, pruneBlocklisted, stats, upsertCommunityPlaylist, removeCommunityPlaylist, allCommunityPlaylists, communityPlaylistList, communityKeptCounts, communityPlaylistMeta, communityPlaylistIds, albumsNeedingDate, setAlbumUploadDate, datedAlbumCount, recentAlbums, recentTracks, setFemaleSet } from "./store.mjs";

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

// ---- release dating (New Releases accuracy) ----------------------------------------------------

test("albumsNeedingDate returns undated albums with a sample track; setAlbumUploadDate dates them", () => {
  const db = openCorpus(":memory:"); seed(db); // MPRE_album has vid00000001 in album_track; MPRE_single has none
  let need = albumsNeedingDate(db);
  const ids = need.map((r) => r.id);
  assert.ok(ids.includes("MPRE_album"), "album with a sample track is datable");
  assert.ok(!ids.includes("MPRE_single"), "album with no album_track row is skipped (nothing to /player)");
  assert.equal(need.find((r) => r.id === "MPRE_album").sampleVideoId, "vid00000001");
  assert.equal(datedAlbumCount(db), 0);
  setAlbumUploadDate(db, "MPRE_album", "2026-05-17T07:33:33-07:00");
  assert.equal(datedAlbumCount(db), 1);
  assert.equal(albumsNeedingDate(db).some((r) => r.id === "MPRE_album"), false, "dated album no longer needs dating");
});

test("albumsNeedingDate minYear restricts to recent releases", () => {
  const db = openCorpus(":memory:"); seed(db); // MPRE_album year 2020, MPRE_single year 2021
  const recent = albumsNeedingDate(db, { minYear: 2021 }).map((r) => r.id);
  assert.ok(!recent.includes("MPRE_album"), "2020 album excluded when minYear=2021");
});

test("recentAlbums/recentTracks order by REAL release date when present, index-time fallback below", () => {
  const db = openCorpus(":memory:"); seed(db);
  // add a second, newer-INDEXED album whose real date is OLDER than MPRE_album's real date
  upsertArtistCatalog(db, { id: "UCmusic", name: "Test Artist" }, {
    tracks: [{ videoId: "vid00000009", title: "Newer Indexed", isVideo: false }],
    albums: [{ id: "MPRE_old", playlistId: "PLo", title: "Old Release", type: "album", year: 2010 }],
    albumTracks: [{ albumId: "MPRE_old", videoId: "vid00000009", pos: 0 }],
  }, Date.now() + 1000); // indexed later
  setAlbumUploadDate(db, "MPRE_album", "2026-05-17T00:00:00Z"); // real: new
  setAlbumUploadDate(db, "MPRE_old", "2010-01-01T00:00:00Z");   // real: old
  const albums = recentAlbums(db, 10).filter((a) => a.type !== "single");
  assert.equal(albums[0].id, "MPRE_album", "newest REAL release date leads, despite older index time");
  assert.equal(albums[0].releaseDate, "2026-05-17T00:00:00Z");
  // the track on the newest-dated album leads recentTracks
  assert.equal(recentTracks(db, 10)[0].videoId, "vid00000001", "track inherits its album's real date for ordering");
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
  assert.equal(all[0].artistName, "", "curator is NOT indexed as artistName (community ranks by title only)");
  assert.equal(all[0].author, "DJ Moshe", "curator kept in author for display");
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

test("featuring filter (_female set): a male-primary feat-female track is dropped from SQL female filters", () => {
  const db = openCorpus(":memory:");
  upsertArtistCatalog(db, { id: "UCm", name: "Male Artist" }, { tracks: [ // male primary (isFemale defaults 0)
    { videoId: "maleaudio01", title: "Solo" },
    { videoId: "featfem0001", title: "Duet (feat. Some Female)" },
  ] });
  upsertCommunityPlaylist(db, { id: "PLfeat", title: "Mix", total: 2 }, [{ videoId: "maleaudio01", pos: 0 }, { videoId: "featfem0001", pos: 1 }]);
  // _female empty → primary-only: both male-primary tracks survive allowFemale=0
  assert.equal(communityKeptCounts(db, ["PLfeat"], { allowFemale: false }).get("PLfeat"), 2);
  assert.equal(artistDetail(db, "UCm", { allowFemale: false }).songs.length, 2);
  // publish the feat track as female-involved → it drops from the count AND the artist's songs
  setFemaleSet(db, ["featfem0001"]);
  assert.equal(communityKeptCounts(db, ["PLfeat"], { allowFemale: false }).get("PLfeat"), 1, "feat-female member excluded from kept count");
  const d = artistDetail(db, "UCm", { allowFemale: false });
  assert.ok(d.songs.some((s) => s.videoId === "maleaudio01") && !d.songs.some((s) => s.videoId === "featfem0001"), "feat-female dropped, male solo kept");
  // tracksByIds reports the feat track as female (so /playlist drops it); empty filter is unaffected
  assert.equal(tracksByIds(db, ["featfem0001"]).get("featfem0001").isFemale, true);
  setFemaleSet(db, []); // revert → primary-only again
  assert.equal(communityKeptCounts(db, ["PLfeat"], { allowFemale: false }).get("PLfeat"), 2, "empty _female reverts to primary-only");
});

test("community: an un-harvested member with a resolved female artistId is treated as female (no fail-open)", () => {
  const db = openCorpus(":memory:");
  upsertArtistCatalog(db, { id: "UCfem", name: "She Sings", isFemale: true }, { tracks: [] });        // female, no harvested tracks
  upsertArtistCatalog(db, { id: "UCmale", name: "He Sings" }, { tracks: [{ videoId: "malesong001", title: "Male Song" }] });
  upsertCommunityPlaylist(db, { id: "PLmix", title: "Mixed", total: 2 }, [
    { videoId: "malesong001", pos: 0 },                       // harvested male (artistId null → track join)
    { videoId: "femunharv01", pos: 1, artistId: "UCfem" },    // NOT in corpus; resolved to the female artist
  ]);
  // female-blocked: only the male survives → kept count 1 (NOT 2 via the old fail-open)
  assert.equal(communityKeptCounts(db, ["PLmix"], { allowFemale: false }).get("PLmix"), 1, "resolved female fallback member excluded");
  // an all-female playlist whose only member is an un-harvested female: fb=0 (resolved), clsMask = female-audio only
  upsertCommunityPlaylist(db, { id: "PLfem", title: "All Fem", total: 1 }, [{ videoId: "femunharv02", pos: 0, artistId: "UCfem" }]);
  const row = allCommunityPlaylists(db).find((p) => p.id === "PLfem");
  assert.equal(row.fb, 0, "a resolved member is no longer a fail-open fallback");
  assert.equal(row.clsMask, 1 << 4, "female-audio class only → searchCategories will hide it when female blocked");
  // a member with NO corpus track AND NO resolved artist is still a true fallback (fail-open kept)
  upsertCommunityPlaylist(db, { id: "PLunk", title: "Unknown", total: 1 }, [{ videoId: "trulyunknwn", pos: 0 }]);
  assert.equal(allCommunityPlaylists(db).find((p) => p.id === "PLunk").fb, 1, "truly-unknown member still fails open");
});

test("upsertArtistCatalog prefers video: a cross-listed videoId becomes/stays isVideo=1 (never downgraded)", () => {
  const db = openCorpus(":memory:");
  const iv = (v) => db.prepare("SELECT isVideo FROM track WHERE videoId=?").get(v).isVideo;
  // stored first as a SONG (artist A's page lists it as audio)
  upsertArtistCatalog(db, { id: "UCa", name: "A" }, { tracks: [{ videoId: "xvid0000001", title: "Journey", isVideo: false }] });
  assert.equal(iv("xvid0000001"), 0);
  // the SAME id is a VIDEO on artist B's page → ON CONFLICT MAX flips it to video (stays under A, the PK owner)
  upsertArtistCatalog(db, { id: "UCb", name: "B" }, { tracks: [{ videoId: "xvid0000001", title: "Journey", isVideo: true }] });
  assert.equal(iv("xvid0000001"), 1, "song → video when cross-listed as a video");
  // a later song re-list must NOT downgrade it back
  upsertArtistCatalog(db, { id: "UCc", name: "C" }, { tracks: [{ videoId: "xvid0000001", title: "Journey", isVideo: false }] });
  assert.equal(iv("xvid0000001"), 1, "a video is never downgraded to a song");
});

// ---- per-user content filters (female / videos / KidZone), applied server-side on drill-in --------

const seedFlags = (db) => {
  // male artist: a song + a video; both also placed in an album (to exercise blockVideos on albumDetail)
  upsertArtistCatalog(db, { id: "UCmale", name: "Male Artist" }, {
    tracks: [
      { videoId: "male0song01", title: "Nice Niggun", isVideo: false },
      { videoId: "male0vid001", title: "Live Clip", isVideo: true },
    ],
    albums: [{ id: "MPRE_mix", playlistId: "PLm", title: "Mixed Album", type: "album", year: 2024 }],
    albumTracks: [{ albumId: "MPRE_mix", videoId: "male0song01", pos: 0 }, { albumId: "MPRE_mix", videoId: "male0vid001", pos: 1 }],
  });
  // female artist: a song + an album
  upsertArtistCatalog(db, { id: "UCfem", name: "Female Singer", isFemale: true }, {
    tracks: [{ videoId: "fem00song01", title: "Her Song", isVideo: false }],
    albums: [{ id: "MPRE_fem", playlistId: "PLf", title: "Her Album", type: "album", year: 2024 }],
    albumTracks: [{ albumId: "MPRE_fem", videoId: "fem00song01", pos: 0 }],
  });
  // KidZone artist
  upsertArtistCatalog(db, { id: "UCkid", name: "Kids Choir", isKidZone: true }, {
    tracks: [{ videoId: "kid00song01", title: "Aleph Bais", isVideo: false }],
  });
};

test("artistDetail: blockVideos empties the videos category, leaves songs", () => {
  const db = openCorpus(":memory:"); seedFlags(db);
  const open = artistDetail(db, "UCmale");
  assert.equal(open.songs.length, 1);
  assert.equal(open.videos.length, 1, "videos present by default");
  const filtered = artistDetail(db, "UCmale", { blockVideos: true });
  assert.equal(filtered.songs.length, 1, "songs untouched");
  assert.equal(filtered.videos.length, 0, "videos dropped when blockVideos");
});

test("artistDetail: a blocked-female user can't open a female artist (treated as not-found)", () => {
  const db = openCorpus(":memory:"); seedFlags(db);
  assert.ok(artistDetail(db, "UCfem"), "female artist visible by default (allowFemale unset)");
  assert.equal(artistDetail(db, "UCfem", { allowFemale: false }), null, "allowFemale:false hides the female artist");
  assert.ok(artistDetail(db, "UCmale", { allowFemale: false }), "male artist still visible when female blocked");
});

test("artistDetail: kidZoneOnly hides non-KidZone artists, keeps KidZone ones", () => {
  const db = openCorpus(":memory:"); seedFlags(db);
  assert.ok(artistDetail(db, "UCkid", { kidZoneOnly: true }), "kidzone artist visible in kidZone-only mode");
  assert.equal(artistDetail(db, "UCmale", { kidZoneOnly: true }), null, "non-kidzone artist hidden in kidZone-only mode");
});

test("albumDetail: blockVideos filters video tracks; a female-artist album is gated for a blocked-female user", () => {
  const db = openCorpus(":memory:"); seedFlags(db);
  assert.equal(albumDetail(db, "MPRE_mix").tracks.length, 2, "song + video present by default");
  const noVid = albumDetail(db, "MPRE_mix", { blockVideos: true });
  assert.equal(noVid.tracks.length, 1, "video track dropped");
  assert.equal(noVid.tracks[0].videoId, "male0song01");
  assert.ok(albumDetail(db, "MPRE_fem"), "female album visible by default");
  assert.equal(albumDetail(db, "MPRE_fem", { allowFemale: false }), null, "female artist's album hidden when female blocked");
});

test("tracksByIds carries content flags so /playlist can filter songs WITHIN a mixed playlist", () => {
  const db = openCorpus(":memory:"); seedFlags(db);
  const m = tracksByIds(db, ["male0song01", "male0vid001", "fem00song01", "kid00song01"]);
  assert.equal(m.get("male0vid001").isVideo, true);
  assert.equal(m.get("male0song01").isVideo, false);
  assert.equal(m.get("fem00song01").isFemale, true);
  assert.equal(m.get("kid00song01").isKidZone, true);
  assert.equal(m.get("male0song01").isFemale, false);
  // A mixed (male+female) playlist, for a blocked-female user, keeps the male song and drops the female one
  // (this is exactly what the /playlist endpoint does with these flags — per-song, not whole-playlist).
  const inPlaylist = ["male0song01", "fem00song01"];
  const keptForBlockedFemale = inPlaylist.filter((id) => !m.get(id).isFemale);
  assert.deepEqual(keptForBlockedFemale, ["male0song01"]);
});

test("detail filters default to OPEN — absent opts = no filtering (gotcha #7)", () => {
  const db = openCorpus(":memory:"); seedFlags(db);
  assert.ok(artistDetail(db, "UCfem"), "female visible when no flag passed");
  assert.equal(artistDetail(db, "UCmale").videos.length, 1, "videos present when no flag passed");
  assert.equal(albumDetail(db, "MPRE_mix").tracks.length, 2);
});

test("communityPlaylistList: an ALL-female playlist is HIDDEN when female is blocked; a mixed one survives", () => {
  const db = openCorpus(":memory:"); seedFlags(db);
  upsertCommunityPlaylist(db, { id: "PLallfem", title: "All Female", total: 2 }, [{ videoId: "fem00song01", pos: 0 }]);
  upsertCommunityPlaylist(db, { id: "PLmixed", title: "Mixed", total: 3 }, [{ videoId: "fem00song01", pos: 0 }, { videoId: "male0song01", pos: 1 }]);
  const open = communityPlaylistList(db, 100).map((p) => p.id);
  assert.ok(open.includes("PLallfem") && open.includes("PLmixed"), "both visible by default");
  const filtered = communityPlaylistList(db, 100, { allowFemale: false });
  const ids = filtered.map((p) => p.id);
  assert.ok(!ids.includes("PLallfem"), "ALL-female playlist hidden when female is blocked");
  assert.ok(ids.includes("PLmixed"), "mixed playlist still shows");
  const mixed = filtered.find((p) => p.id === "PLmixed");
  assert.equal(mixed.whitelisted, 1, "displayed count = kept (male) tracks only");
  assert.equal(mixed.thumbnail, "https://i.ytimg.com/vi/male0song01/mqdefault.jpg", "cover taken from the kept (male) track, not the female one");
});

test("communityPlaylistList: an all-video playlist is HIDDEN when videos are blocked", () => {
  const db = openCorpus(":memory:"); seedFlags(db);
  upsertCommunityPlaylist(db, { id: "PLvid", title: "Clips", total: 1 }, [{ videoId: "male0vid001", pos: 0 }]);
  upsertCommunityPlaylist(db, { id: "PLaud", title: "Audio", total: 1 }, [{ videoId: "male0song01", pos: 0 }]);
  assert.ok(communityPlaylistList(db, 100).map((p) => p.id).includes("PLvid"), "video playlist visible by default");
  const ids = communityPlaylistList(db, 100, { blockVideos: true }).map((p) => p.id);
  assert.ok(!ids.includes("PLvid"), "all-video playlist hidden when videos blocked");
  assert.ok(ids.includes("PLaud"), "audio playlist still shows");
});

test("communityKeptCounts: a mixed playlist's count is reduced to the post-filter total (no female songs)", () => {
  const db = openCorpus(":memory:"); seedFlags(db);
  upsertCommunityPlaylist(db, { id: "PLmix", title: "Mixed", total: 9 }, [
    { videoId: "fem00song01", pos: 0 }, { videoId: "male0song01", pos: 1 }, { videoId: "male0vid001", pos: 2 },
  ]);
  assert.equal(communityKeptCounts(db, ["PLmix"], {}), null, "no filter active → null (caller keeps stored count)");
  assert.equal(communityKeptCounts(db, ["PLmix"], { allowFemale: false }).get("PLmix"), 2, "female blocked → counts only the 2 non-female tracks");
  assert.equal(communityKeptCounts(db, ["PLmix"], { blockVideos: true }).get("PLmix"), 2, "videos blocked → counts only the 2 non-video tracks");
  assert.equal(communityKeptCounts(db, ["PLmix"], { allowFemale: false, blockVideos: true }).get("PLmix"), 1, "both blocked → only the male audio track");
});
