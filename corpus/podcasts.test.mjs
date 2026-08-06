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
import Database from "better-sqlite3";
import {
  ensurePodcastSchema, upsertPodcast, upsertPodcastChannel, setEpisodePlayerMeta,
  prunePodcasts, allPodcastShows, allPodcastChannels, podcastDetail, podcastChannelDetail,
  newPodcastEpisodes, allPodcastShowDocs, allPodcastEpisodeDocs, podcastStats, existingShowIds,
  isDeadShowArt, makeShowArtResolver,
} from "./podcasts.mjs";

const fresh = () => { const db = new Database(":memory:"); ensurePodcastSchema(db); return db; };
const ep = (videoId, title, extra = {}) => ({ videoId, title, ...extra });
const cols = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);

// ---- schema -------------------------------------------------------------
test("ensurePodcastSchema is idempotent (safe to re-run)", () => {
  const db = fresh();
  assert.doesNotThrow(() => ensurePodcastSchema(db));
  ensurePodcastSchema(db);
  for (const t of ["podcast_show", "podcast_episode", "podcast_channel"]) {
    const n = db.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name=?`).get(t).n;
    assert.equal(n, 1);
  }
});

test("ensurePodcastSchema migrates a pre-publishedAt podcast_episode table", () => {
  const db = new Database(":memory:");
  // an episode table shaped BEFORE the publishedAt column existed
  db.exec(`CREATE TABLE podcast_episode (
    videoId TEXT PRIMARY KEY, showId TEXT NOT NULL, title TEXT NOT NULL,
    thumbnail TEXT, durationSec INTEGER, publishedText TEXT, pos INTEGER, harvestedAt INTEGER
  )`);
  assert.ok(!cols(db, "podcast_episode").includes("publishedAt"));
  ensurePodcastSchema(db);
  assert.ok(cols(db, "podcast_episode").includes("publishedAt"));
});

// ---- upsert + prune-on-reharvest ---------------------------------------
test("upsertPodcast inserts a show + episodes with pos ordering (newest-first as given)", () => {
  const db = fresh();
  upsertPodcast(db, { id: "MPSP1", name: "Show One", author: "Auth", channelId: "UCa", categories: ["Podcast"] },
    [ep("v1", "Newest"), ep("v2", "Middle"), ep("v3", "Oldest")]);

  assert.deepEqual(existingShowIds(db), ["MPSP1"]);
  const rows = db.prepare(`SELECT videoId,pos FROM podcast_episode WHERE showId='MPSP1' ORDER BY pos`).all();
  assert.deepEqual(rows, [{ videoId: "v1", pos: 0 }, { videoId: "v2", pos: 1 }, { videoId: "v3", pos: 2 }]);
});

test("re-upserting with fewer episodes PRUNES the dropped ones", () => {
  const db = fresh();
  upsertPodcast(db, { id: "MPSP1", name: "Show One" }, [ep("v1", "A"), ep("v2", "B"), ep("v3", "C")]);
  upsertPodcast(db, { id: "MPSP1", name: "Show One" }, [ep("v1", "A"), ep("v3", "C")]); // v2 dropped
  const ids = db.prepare(`SELECT videoId FROM podcast_episode WHERE showId='MPSP1' ORDER BY pos`).all().map((r) => r.videoId);
  assert.deepEqual(ids, ["v1", "v3"]);
});

test("re-upserting an empty episode list wipes all episodes for that show", () => {
  const db = fresh();
  upsertPodcast(db, { id: "MPSP1", name: "Show One" }, [ep("v1", "A"), ep("v2", "B")]);
  upsertPodcast(db, { id: "MPSP1", name: "Show One" }, []);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM podcast_episode WHERE showId='MPSP1'`).get().n, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM podcast_show WHERE id='MPSP1'`).get().n, 1); // show survives
});

test("durationSec/publishedAt COALESCE: a /player top-up survives a re-harvest with null values", () => {
  const db = fresh();
  upsertPodcast(db, { id: "MPSP1", name: "Show" }, [ep("v1", "Ep", { durationSec: null })]);
  setEpisodePlayerMeta(db, "v1", { durationSec: 1800, publishedAt: "2026-03-10T00:00:00Z" });
  // re-harvest brings the same episode back with NO duration (browse rarely has it)
  upsertPodcast(db, { id: "MPSP1", name: "Show" }, [ep("v1", "Ep", { durationSec: null })]);
  const r = db.prepare(`SELECT durationSec,publishedAt FROM podcast_episode WHERE videoId='v1'`).get();
  assert.equal(r.durationSec, 1800);
  assert.equal(r.publishedAt, "2026-03-10T00:00:00Z");
});

test("setEpisodePlayerMeta never downgrades an existing duration", () => {
  const db = fresh();
  upsertPodcast(db, { id: "MPSP1", name: "Show" }, [ep("v1", "Ep", { durationSec: 1200 })]);
  setEpisodePlayerMeta(db, "v1", { durationSec: 999, publishedAt: null });
  assert.equal(db.prepare(`SELECT durationSec FROM podcast_episode WHERE videoId='v1'`).get().durationSec, 1200);
});

// ---- prune (de-whitelisting) -------------------------------------------
test("prunePodcasts drops de-whitelisted shows + their episodes + orphan channels", () => {
  const db = fresh();
  upsertPodcastChannel(db, { id: "UCa", name: "Chan A" });
  upsertPodcastChannel(db, { id: "UCb", name: "Chan B" });
  upsertPodcast(db, { id: "MPSPkeep", name: "Keep", channelId: "UCa" }, [ep("k1", "K1")]);
  upsertPodcast(db, { id: "MPSPgone", name: "Gone", channelId: "UCb" }, [ep("g1", "G1"), ep("g2", "G2")]);

  const res = prunePodcasts(db, new Set(["MPSPkeep"]));
  assert.equal(res.shows, 1);
  assert.equal(res.channels, 1); // UCb orphaned (no surviving show points at it)

  assert.deepEqual(existingShowIds(db), ["MPSPkeep"]);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM podcast_episode WHERE showId='MPSPgone'`).get().n, 0);
  const chans = db.prepare(`SELECT id FROM podcast_channel ORDER BY id`).all().map((r) => r.id);
  assert.deepEqual(chans, ["UCa"]);
});

// ---- read shapes --------------------------------------------------------
test("allPodcastShows lists shows alphabetically with the show shape", () => {
  const db = fresh();
  upsertPodcast(db, { id: "MPSPb", name: "Bravo", author: "AuthB", channelId: "UCb", episodeCountText: "5 episodes" }, []);
  upsertPodcast(db, { id: "MPSPa", name: "Alpha", author: "AuthA", channelId: "UCa" }, []);
  const shows = allPodcastShows(db);
  assert.deepEqual(shows.map((s) => s.name), ["Alpha", "Bravo"]);
  assert.equal(shows[0].id, "MPSPa");
  assert.equal(shows[0].author, "AuthA");
  assert.equal(shows[0].channelId, "UCa");
  assert.equal(shows[0].episodeCountText, undefined); // absent → omitted (undefined)
  assert.equal(shows[1].episodeCountText, "5 episodes");
});

test("podcastDetail pages episodes by pos with a correct nextOffset", () => {
  const db = fresh();
  const eps = Array.from({ length: 5 }, (_, i) => ep(`v${i}`, `Ep ${i}`, { publishedText: `Day ${i}` }));
  upsertPodcast(db, { id: "MPSP1", name: "Show", description: "Desc", categories: ["Podcast", "Torah"] }, eps);

  const p1 = podcastDetail(db, "MPSP1", 0, 2);
  assert.deepEqual(p1.podcast.categories, ["Podcast", "Torah"]);
  assert.equal(p1.podcast.description, "Desc");
  assert.deepEqual(p1.episodes.map((e) => e.videoId), ["v0", "v1"]);
  assert.equal(p1.nextOffset, 2);

  const p2 = podcastDetail(db, "MPSP1", 4, 2); // last page: 1 remaining, no more
  assert.deepEqual(p2.episodes.map((e) => e.videoId), ["v4"]);
  assert.equal(p2.nextOffset, null);

  assert.equal(podcastDetail(db, "MPSPmissing", 0, 2), null);
});

test("podcastDetail epRow: publishedAt is ISO-only, raw label exposed separately as publishedText", () => {
  const db = fresh();
  upsertPodcast(db, { id: "MPSP1", name: "Show" }, [
    ep("withIso", "A", { publishedText: "Mar 10" }),
    ep("textOnly", "B", { publishedText: "Aug 1" }),
  ]);
  setEpisodePlayerMeta(db, "withIso", { durationSec: 600, publishedAt: "2026-03-10T00:00:00Z" });
  const { episodes } = podcastDetail(db, "MPSP1", 0, 30);
  assert.equal(episodes[0].videoId, "withIso");
  assert.equal(episodes[0].durationSeconds, 600);
  assert.equal(episodes[0].publishedAt, "2026-03-10T00:00:00Z"); // real ISO date
  assert.equal(episodes[0].publishedText, "Mar 10");             // raw label kept alongside
  // second episode: no /player date → publishedAt is undefined (NOT the raw "Aug 1"), raw text still available
  assert.equal(episodes[1].videoId, "textOnly");
  assert.equal(episodes[1].durationSeconds, 0);
  assert.equal(episodes[1].publishedAt, undefined);             // ISO field never carries a non-ISO string
  assert.equal(episodes[1].publishedText, "Aug 1");
});

test("newPodcastEpisodes returns only dated episodes, newest publishedAt first", () => {
  const db = fresh();
  upsertPodcast(db, { id: "MPSP1", name: "Show One" }, [ep("old", "Old"), ep("new", "New"), ep("undated", "Undated")]);
  setEpisodePlayerMeta(db, "old", { durationSec: null, publishedAt: "2026-01-01T00:00:00Z" });
  setEpisodePlayerMeta(db, "new", { durationSec: null, publishedAt: "2026-06-01T00:00:00Z" });
  // "undated" has no publishedAt → excluded
  const rows = newPodcastEpisodes(db);
  assert.deepEqual(rows.map((r) => r.videoId), ["new", "old"]);
  assert.equal(rows[0].podcastName, "Show One");
});

test("podcastChannelDetail returns channel + shows + dated latest episodes", () => {
  const db = fresh();
  upsertPodcastChannel(db, { id: "UCa", name: "Channel A", thumbnail: "http://av.jpg" });
  upsertPodcast(db, { id: "MPSPa", name: "Show A", channelId: "UCa" }, [ep("v1", "E1")]);
  upsertPodcast(db, { id: "MPSPb", name: "Show B", channelId: "UCa" }, [ep("v2", "E2")]);
  setEpisodePlayerMeta(db, "v1", { durationSec: null, publishedAt: "2026-02-01T00:00:00Z" });
  setEpisodePlayerMeta(db, "v2", { durationSec: null, publishedAt: "2026-05-01T00:00:00Z" });

  const d = podcastChannelDetail(db, "UCa");
  assert.equal(d.channel.name, "Channel A");
  assert.equal(d.channel.thumbnail, "http://av.jpg");
  assert.deepEqual(d.shows.map((s) => s.name), ["Show A", "Show B"]);
  assert.deepEqual(d.episodes.map((e) => e.videoId), ["v2", "v1"]); // publishedAt desc
  assert.equal(d.episodes[0].channelId, "UCa");

  assert.equal(podcastChannelDetail(db, "UCnone"), null);
});

test("allPodcastShowDocs / allPodcastEpisodeDocs return joined raw docs for the matcher", () => {
  const db = fresh();
  upsertPodcast(db, { id: "MPSP1", name: "Show One", author: "Auth", channelId: "UCa" },
    [ep("v1", "Episode One"), ep("v2", "Episode Two")]);

  const showDocs = allPodcastShowDocs(db);
  assert.equal(showDocs.length, 1);
  assert.equal(showDocs[0].name, "Show One");

  const epDocs = allPodcastEpisodeDocs(db).sort((a, b) => a.videoId.localeCompare(b.videoId));
  assert.equal(epDocs.length, 2);
  assert.equal(epDocs[0].title, "Episode One");
  assert.equal(epDocs[0].podcastName, "Show One"); // joined from the show
  assert.equal(epDocs[0].channelId, "UCa");
});

// ---- durable show art (the pl_c / podcasts_artwork 404 fix) --------------
const DEAD_PLC = "https://i.ytimg.com/pl_c/PLxxx/studio_square_thumbnail.jpg?sqp=a&rs=b";
const DEAD_ART2 = "https://i.ytimg.com/podcasts_artwork/xxx/auto_created_podcast_show_avatar.jpg?sqp=a";
const AVATAR = "https://yt3.googleusercontent.com/abc=w544-c-h544-l90-rj";

test("isDeadShowArt flags the two dead YouTube shapes (and null), not durable urls", () => {
  assert.equal(isDeadShowArt(DEAD_PLC), true);
  assert.equal(isDeadShowArt(DEAD_ART2), true);
  assert.equal(isDeadShowArt(null), true);
  assert.equal(isDeadShowArt(AVATAR), false);
  assert.equal(isDeadShowArt("https://i.ytimg.com/vi/v1/hqdefault.jpg"), false);
});

test("resolver: dead show art -> host-channel avatar; good art kept as-is", () => {
  const db = fresh();
  upsertPodcastChannel(db, { id: "UCa", name: "A", thumbnail: AVATAR });
  upsertPodcast(db, { id: "MPSP1", name: "Dead", channelId: "UCa", thumbnail: DEAD_PLC }, [ep("v1", "E1", { thumbnail: "https://i.ytimg.com/vi/v1/hqdefault.jpg" })]);
  upsertPodcast(db, { id: "MPSP2", name: "Good", channelId: "UCa", thumbnail: AVATAR }, [ep("v2", "E2")]);
  const art = makeShowArtResolver(db);
  assert.equal(art({ id: "MPSP1", channelId: "UCa", thumbnail: DEAD_PLC }), AVATAR, "dead -> channel avatar");
  assert.equal(art({ id: "MPSP2", channelId: "UCa", thumbnail: AVATAR }), AVATAR, "good stored art untouched");
  // and it flows through the served DTOs
  const byId = Object.fromEntries(allPodcastShows(db).map((s) => [s.id, s.thumbnail]));
  assert.equal(byId["MPSP1"], AVATAR);
  assert.equal(byId["MPSP2"], AVATAR);
  assert.equal(podcastDetail(db, "MPSP1").podcast.thumbnail, AVATAR);
  assert.equal(allPodcastShowDocs(db).find((s) => s.id === "MPSP1").thumbnail, AVATAR);
});

test("resolver: no channel avatar -> falls back to a first-episode /vi thumbnail", () => {
  const db = fresh();
  upsertPodcast(db, { id: "MPSP3", name: "NoAvatar", channelId: "UCx", thumbnail: DEAD_ART2 },
    [ep("v9", "E9", { thumbnail: "https://i.ytimg.com/vi/v9/hqdefault.jpg" })]);
  const art = makeShowArtResolver(db);
  assert.equal(art({ id: "MPSP3", channelId: "UCx", thumbnail: DEAD_ART2 }), "https://i.ytimg.com/vi/v9/hqdefault.jpg");
});

// ---- channel grid (channel-level whitelist) ------------------------------
test("allPodcastChannels: one tile per APPROVED channel, with show/episode counts + durable avatar", () => {
  const db = fresh();
  upsertPodcastChannel(db, { id: "UCa", name: "Publisher A", thumbnail: AVATAR });
  upsertPodcast(db, { id: "MPSP1", name: "S1", channelId: "UCa", thumbnail: DEAD_PLC }, [ep("v1", "E1"), ep("v2", "E2")]);
  upsertPodcast(db, { id: "MPSP2", name: "S2", channelId: "UCa", thumbnail: AVATAR }, [ep("v3", "E3")]);
  upsertPodcast(db, { id: "MPSP3", name: "S3", channelId: "UCb", thumbnail: DEAD_PLC }, [ep("v4", "E4")]); // channel NOT approved

  const chans = allPodcastChannels(db, new Set(["UCa"]));
  assert.equal(chans.length, 1, "only the approved channel UCa surfaces, not UCb");
  const a = chans[0];
  assert.equal(a.id, "UCa");
  assert.equal(a.name, "Publisher A");
  assert.equal(a.showCount, 2);
  assert.equal(a.episodeCount, 3);
  assert.equal(a.thumbnail, AVATAR, "durable channel avatar");

  // an approved channel whose avatar row is missing falls back to a show's resolved (durable) art
  const db2 = fresh();
  upsertPodcast(db2, { id: "MPSPx", name: "X", channelId: "UCc", thumbnail: DEAD_PLC },
    [ep("v9", "E9", { thumbnail: "https://i.ytimg.com/vi/v9/hqdefault.jpg" })]);
  const c = allPodcastChannels(db2, new Set(["UCc"]))[0];
  assert.equal(c.thumbnail, "https://i.ytimg.com/vi/v9/hqdefault.jpg");
});

test("podcastStats counts shows/episodes/channels/withDur/withCh", () => {
  const db = fresh();
  upsertPodcastChannel(db, { id: "UCa", name: "A" });
  upsertPodcast(db, { id: "MPSP1", name: "S1", channelId: "UCa" }, [ep("v1", "E1", { durationSec: 100 }), ep("v2", "E2")]);
  upsertPodcast(db, { id: "MPSP2", name: "S2" }, [ep("v3", "E3")]); // no channelId
  const s = podcastStats(db);
  assert.deepEqual(s, { shows: 2, episodes: 3, channels: 1, withDur: 1, withCh: 1 });
});
