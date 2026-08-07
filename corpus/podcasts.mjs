// zemer-search — search engine and more for the Zemer app
// https://github.com/ZemerTeam/zemer-search
// Zemer app: https://github.com/ZemerTeam/zemer-app
// Copyright (C) 2026 alltechdev
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See the LICENSE file for details.

// Podcast store — new tables living in the SAME corpus.db as music (server-side only; one process, one DB).
// Kept self-contained (its own ensurePodcastSchema) so it can fold into corpus/store.mjs openCorpus later
// without disturbing the music schema now. Discovery-only: a SHOW (MPSP…) has EPISODES (each a YouTube
// videoId the app plays via InnerTube) and a host CHANNEL (UC…). Whitelist purity is by construction — only
// whitelisted shows are ever harvested/stored.

export function ensurePodcastSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS podcast_show (
      id               TEXT PRIMARY KEY,   -- MPSP…
      name             TEXT NOT NULL,
      author           TEXT,
      channelId        TEXT,               -- host UC… (resolved at harvest; whitelist rarely carries it)
      thumbnail        TEXT,
      description      TEXT,
      categories       TEXT,               -- JSON array of category strings (YouTube's — unpopulated/useless)
      episodeCountText TEXT,               -- display-only ("312 episodes")
      genres           TEXT,               -- comma-separated Zemer style slugs (harvester/podcast-genres.mjs)
      firstSeenAt      INTEGER,            -- first insert time (NEVER updated on re-harvest) → the "new shows" signal
      harvestedAt      INTEGER
    );
    CREATE TABLE IF NOT EXISTS podcast_episode (
      videoId       TEXT PRIMARY KEY,      -- the YouTube id the app plays (InnerTube), immutable
      showId        TEXT NOT NULL,
      title         TEXT NOT NULL,
      thumbnail     TEXT,
      durationSec   INTEGER,               -- often NULL from browse → filled by the /player top-up pass
      publishedText TEXT,                  -- raw ("Mar 10" / "3 days ago") — display-only, order via pos
      publishedAt   TEXT,                  -- real ISO date from /player microformat (top-up pass) → global recency sort
      pos           INTEGER,               -- position on the show page (newest-first)
      harvestedAt   INTEGER
    );
    CREATE TABLE IF NOT EXISTS podcast_channel (
      id          TEXT PRIMARY KEY,        -- UC…
      name        TEXT,
      thumbnail   TEXT,                    -- round avatar
      banner      TEXT,                    -- optional wide header art
      description TEXT,
      harvestedAt INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_pod_ep_show ON podcast_episode(showId, pos);
    CREATE INDEX IF NOT EXISTS idx_pod_show_channel ON podcast_show(channelId);
  `);
  // migration: add publishedAt to a podcast_episode created before this column existed (idempotent)
  const cols = db.prepare(`PRAGMA table_info(podcast_episode)`).all().map((c) => c.name);
  if (!cols.includes("publishedAt")) db.exec(`ALTER TABLE podcast_episode ADD COLUMN publishedAt TEXT`);
  // migration: add genres / firstSeenAt to a podcast_show table that predates them (idempotent)
  const scols = db.prepare(`PRAGMA table_info(podcast_show)`).all().map((c) => c.name);
  if (!scols.includes("genres")) db.exec(`ALTER TABLE podcast_show ADD COLUMN genres TEXT`);
  if (!scols.includes("firstSeenAt")) {
    db.exec(`ALTER TABLE podcast_show ADD COLUMN firstSeenAt INTEGER`);
    db.exec(`UPDATE podcast_show SET firstSeenAt=harvestedAt WHERE firstSeenAt IS NULL`); // seed existing rows (approximate)
  }
}

// Apply Zemer style genres to shows — REPLACE-WHOLESALE (a show absent from the map loses its genres), the
// same contract as track.genres: the durable JSON (data/podcast-genres.json) is the single source of truth
// and the harvest never touches the column, so re-applying can't be undone by a re-harvest. `map` = {showId:
// [slugs]}. Runs in one transaction.
export function applyPodcastGenres(db, map) {
  const upd = db.prepare(`UPDATE podcast_show SET genres=? WHERE id=?`);
  const tx = db.transaction(() => {
    db.prepare(`UPDATE podcast_show SET genres=NULL`).run(); // wholesale: clear, then set the listed ones
    let n = 0;
    for (const [id, slugs] of Object.entries(map)) { const g = (slugs || []).join(","); if (g) { upd.run(g, id); n++; } }
    return n;
  });
  return tx();
}

// Set both the real ISO date and (if still missing) the duration for one episode — the /player top-up pass.
export function setEpisodePlayerMeta(db, videoId, { durationSec, publishedAt }) {
  db.prepare(`UPDATE podcast_episode SET
      durationSec = COALESCE(durationSec, @durationSec),
      publishedAt = COALESCE(@publishedAt, publishedAt)
    WHERE videoId = @videoId`).run({ videoId, durationSec: durationSec ?? null, publishedAt: publishedAt ?? null });
}

// ---- READ layer (served by the /podcasts* endpoints; content filters applied in the API, mirroring music) ----
const showRow = (s) => ({
  id: s.id, name: s.name, author: s.author || undefined, channelId: s.channelId || undefined,
  thumbnail: s.thumbnail || undefined, episodeCountText: s.episodeCountText || undefined,
  genres: s.genres ? s.genres.split(",") : undefined,
});
const epRow = (e) => ({
  videoId: e.videoId, title: e.title, podcastId: e.showId, podcastName: e.podcastName || undefined,
  channelId: e.channelId || undefined, thumbnail: e.thumbnail || undefined,
  durationSeconds: e.durationSec ?? 0,
  // publishedAt is ISO-only (from /player). The raw browse label ("Mar 10"/"3 days ago") is NOT ISO, so it
  // is exposed separately as publishedText rather than leaking under the ISO-typed publishedAt field.
  publishedAt: e.publishedAt || undefined,
  publishedText: e.publishedText || undefined,
});

// A show's harvested art can be a YouTube shape that is ADVERTISED but never SERVED — `pl_c/…/
// studio_square_thumbnail` and `podcasts_artwork/…/auto_created_podcast_show_avatar` both 404 even bare
// (not an expired sqp signature; the path itself is dead). ~89% of shows carry one. So resolve show art to a
// DURABLE url at read time: keep a good stored value, else the host-channel yt3 avatar (via channelId, which
// every show has and which returns 200), else a first-episode /vi thumbnail (always durable). Read-time so it
// SELF-HEALS — a re-harvest re-storing the dead url can't regress it. Wire contract is unchanged: same
// `thumbnail` field, only the value is made to resolve.
const DEAD_ART = /\/pl_c\/|\/podcasts_artwork\//;
export const isDeadShowArt = (u) => !u || DEAD_ART.test(u);

// Factory: loads the channel-avatar map once, returns resolver(show)->url. Cheap (≈160 channel rows); the
// endpoints that use it are LRU-cached in the API anyway.
export function makeShowArtResolver(db) {
  const chAvatar = new Map(
    db.prepare(`SELECT id,thumbnail FROM podcast_channel`).all().map((c) => [c.id, c.thumbnail])
  );
  const firstEp = db.prepare(`SELECT thumbnail FROM podcast_episode WHERE showId=? ORDER BY pos LIMIT 1`);
  return (show) => {
    if (!isDeadShowArt(show.thumbnail)) return show.thumbnail || undefined; // good stored art (the ~11% yt3)
    const av = show.channelId ? chAvatar.get(show.channelId) : null;        // host-channel avatar (the ~89%)
    if (!isDeadShowArt(av)) return av;
    const ep = firstEp.get(show.id)?.thumbnail;                             // last-resort episode thumbnail
    if (!isDeadShowArt(ep)) return ep;
    return show.thumbnail || undefined;                                     // nothing better (0 shows in practice)
  };
}

// /podcasts — browse all whitelisted shows (alphabetical).
export const allPodcastShows = (db) => {
  const art = makeShowArtResolver(db);
  return db.prepare(`SELECT id,name,author,channelId,thumbnail,episodeCountText,genres FROM podcast_show ORDER BY name`)
    .all().map((s) => ({ ...showRow(s), thumbnail: art(s) }));
};

// /podcast-channels — the CHANNEL grid (the whitelist is channel-level like the artist whitelist: approve a
// publisher, its whole catalog is kosher). `approved` = Set of whitelisted host `UC` ids. Returns one tile
// per approved channel present in the corpus, with a durable avatar + show/episode counts. Drill-in is the
// existing `/podcast-channel?id=UC…`.
export function allPodcastChannels(db, approved) {
  const art = makeShowArtResolver(db);
  const counts = db.prepare(`
    SELECT s.channelId AS id, COUNT(DISTINCT s.id) AS showCount, COUNT(e.videoId) AS episodeCount
    FROM podcast_show s LEFT JOIN podcast_episode e ON e.showId = s.id
    WHERE s.channelId IS NOT NULL GROUP BY s.channelId`).all();
  const meta = new Map(db.prepare(`SELECT id,name,thumbnail FROM podcast_channel`).all().map((c) => [c.id, c]));
  const firstShow = db.prepare(`SELECT id,channelId,thumbnail FROM podcast_show WHERE channelId=? ORDER BY name LIMIT 1`);
  return counts
    .filter((r) => approved.has(r.id))
    .map((r) => {
      const ch = meta.get(r.id);
      let thumbnail = ch?.thumbnail;
      if (isDeadShowArt(thumbnail)) { const s = firstShow.get(r.id); thumbnail = s ? art(s) : undefined; } // durable avatar
      return { id: r.id, name: ch?.name || undefined, thumbnail: thumbnail || undefined, showCount: r.showCount, episodeCount: r.episodeCount };
    })
    .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
}

// /podcast?id= — one show + a page of its episodes (newest-first by pos), with nextOffset.
export function podcastDetail(db, id, offset = 0, limit = 30) {
  const s = db.prepare(`SELECT * FROM podcast_show WHERE id=?`).get(id);
  if (!s) return null;
  const eps = db.prepare(`SELECT videoId,showId,title,thumbnail,durationSec,publishedText,publishedAt
      FROM podcast_episode WHERE showId=? ORDER BY pos LIMIT ? OFFSET ?`).all(id, limit + 1, offset);
  const more = eps.length > limit;
  const art = makeShowArtResolver(db);
  return {
    podcast: { ...showRow(s), thumbnail: art(s), description: s.description || undefined,
      categories: s.categories ? JSON.parse(s.categories) : [] },
    episodes: eps.slice(0, limit).map(epRow),
    nextOffset: more ? offset + limit : null,
  };
}

// /podcast-channel?id= — host channel + its whitelisted shows shelf + a latest-episodes shelf.
export function podcastChannelDetail(db, id) {
  const shows = db.prepare(`SELECT id,name,author,channelId,thumbnail,episodeCountText,genres FROM podcast_show WHERE channelId=? ORDER BY name`).all(id);
  if (!shows.length) return null; // no whitelisted show under this channel → nothing to serve
  const ch = db.prepare(`SELECT * FROM podcast_channel WHERE id=?`).get(id);
  const eps = db.prepare(`SELECT e.videoId,e.showId,e.title,e.thumbnail,e.durationSec,e.publishedText,e.publishedAt, s.name podcastName
      FROM podcast_episode e JOIN podcast_show s ON s.id=e.showId
      WHERE s.channelId=? AND e.publishedAt IS NOT NULL ORDER BY e.publishedAt DESC LIMIT 30`).all(id);
  const art = makeShowArtResolver(db);
  // Channel header art: the podcast_channel avatar is a durable yt3 url; guard it anyway (dead/unharvested →
  // fall back to the first show's resolved art) so the channel page header never falls to a placeholder.
  const chArt = !isDeadShowArt(ch?.thumbnail) ? ch.thumbnail : art(shows[0]);
  return {
    channel: { id, name: (ch?.name) || shows[0].author || undefined,
      thumbnail: chArt, banner: ch?.banner || undefined, description: ch?.description || undefined },
    shows: shows.map((s) => ({ ...showRow(s), thumbnail: art(s) })),
    episodes: eps.map((e) => epRow({ ...e, channelId: id })),
  };
}

// /podcasts/new-episodes — latest episodes across ALL whitelisted shows (real ISO date, newest-first).
export const newPodcastEpisodes = (db, limit = 50) =>
  db.prepare(`SELECT e.videoId,e.showId,e.title,e.thumbnail,e.durationSec,e.publishedText,e.publishedAt,
      s.name podcastName, s.channelId
      FROM podcast_episode e JOIN podcast_show s ON s.id=e.showId
      WHERE e.publishedAt IS NOT NULL ORDER BY e.publishedAt DESC LIMIT ?`).all(limit).map(epRow);

// Index doc-loaders — feed the SAME matcher music uses (index/search.mjs), so podcast search gets skeleton
// cross-script (Hebrew↔romanized), Damerau fuzzy, and IDF ranking instead of a substring match. buildCategories
// shapes these into {title, artistName, …} docs. Loaded whole (small) and rebuilt on each index reload.
export const allPodcastShowDocs = (db) => {
  const art = makeShowArtResolver(db);
  return db.prepare(`SELECT id,name,author,channelId,thumbnail,episodeCountText,genres FROM podcast_show`)
    .all().map((s) => ({ ...s, thumbnail: art(s) })); // durable art for the /search-folded podcast group too
};
export const allPodcastEpisodeDocs = (db) =>
  db.prepare(`SELECT e.videoId,e.showId,e.title,e.thumbnail,e.durationSec,e.publishedText,e.publishedAt,
      s.name podcastName, s.channelId
      FROM podcast_episode e JOIN podcast_show s ON s.id=e.showId`).all();

// Upsert one show + its full episode list in a single transaction. Episodes are reconciled: each is
// upserted (durationSec COALESCEd so a prior /player top-up survives re-harvest), and any episode no longer
// on the show page is deleted. Never splits a show's writes.
export function upsertPodcast(db, show, episodes) {
  const now = Date.now();
  const insShow = db.prepare(`
    INSERT INTO podcast_show (id, name, author, channelId, thumbnail, description, categories, episodeCountText, firstSeenAt, harvestedAt)
    VALUES (@id, @name, @author, @channelId, @thumbnail, @description, @categories, @episodeCountText, @harvestedAt, @harvestedAt)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, author=excluded.author,
      channelId=COALESCE(excluded.channelId, podcast_show.channelId),
      thumbnail=COALESCE(excluded.thumbnail, podcast_show.thumbnail),
      description=COALESCE(excluded.description, podcast_show.description),
      categories=excluded.categories,
      episodeCountText=COALESCE(excluded.episodeCountText, podcast_show.episodeCountText),
      harvestedAt=excluded.harvestedAt
  `);
  const insEp = db.prepare(`
    INSERT INTO podcast_episode (videoId, showId, title, thumbnail, durationSec, publishedText, pos, harvestedAt)
    VALUES (@videoId, @showId, @title, @thumbnail, @durationSec, @publishedText, @pos, @harvestedAt)
    ON CONFLICT(videoId) DO UPDATE SET
      showId=excluded.showId, title=excluded.title,
      thumbnail=COALESCE(excluded.thumbnail, podcast_episode.thumbnail),
      durationSec=COALESCE(excluded.durationSec, podcast_episode.durationSec),
      publishedText=COALESCE(excluded.publishedText, podcast_episode.publishedText),
      pos=excluded.pos, harvestedAt=excluded.harvestedAt
  `);
  const tx = db.transaction(() => {
    insShow.run({
      id: show.id, name: show.name || show.id, author: show.author ?? null,
      channelId: show.channelId ?? null, thumbnail: show.thumbnail ?? null,
      description: show.description ?? null,
      categories: JSON.stringify(show.categories || []),
      episodeCountText: show.episodeCountText ?? null, harvestedAt: now,
    });
    let pos = 0;
    for (const e of episodes) {
      if (!e?.videoId) continue;
      insEp.run({
        videoId: e.videoId, showId: show.id, title: e.title || "", thumbnail: e.thumbnail ?? null,
        durationSec: e.durationSec ?? null, publishedText: e.publishedText ?? null, pos: pos++, harvestedAt: now,
      });
    }
    // Prune episodes that dropped off the show page via a temp keep-set (empty episode list → keep-set empty
    // → all rows for the show wiped). A temp table instead of a `videoId NOT IN (?,?,…)` list keeps this
    // correct regardless of timestamps AND avoids exceeding SQLite's bound-variable limit on a very long show
    // (PAGE_GUARD allows up to 50k episodes).
    db.exec("CREATE TEMP TABLE IF NOT EXISTS _pod_keep(id TEXT PRIMARY KEY)");
    db.prepare("DELETE FROM _pod_keep").run();
    const insKeep = db.prepare("INSERT OR IGNORE INTO _pod_keep(id) VALUES(?)");
    for (const e of episodes) if (e?.videoId) insKeep.run(e.videoId);
    db.prepare("DELETE FROM podcast_episode WHERE showId=? AND videoId NOT IN (SELECT id FROM _pod_keep)").run(show.id);
  });
  tx();
}

export function upsertPodcastChannel(db, ch) {
  db.prepare(`
    INSERT INTO podcast_channel (id, name, thumbnail, banner, description, harvestedAt)
    VALUES (@id, @name, @thumbnail, @banner, @description, @harvestedAt)
    ON CONFLICT(id) DO UPDATE SET
      name=COALESCE(excluded.name, podcast_channel.name),
      thumbnail=COALESCE(excluded.thumbnail, podcast_channel.thumbnail),
      banner=COALESCE(excluded.banner, podcast_channel.banner),
      description=COALESCE(excluded.description, podcast_channel.description),
      harvestedAt=excluded.harvestedAt
  `).run({ id: ch.id, name: ch.name ?? null, thumbnail: ch.thumbnail ?? null,
    banner: ch.banner ?? null, description: ch.description ?? null, harvestedAt: Date.now() });
}

export const existingShowIds = (db) =>
  db.prepare(`SELECT id FROM podcast_show`).all().map((r) => r.id);

// ---- Data-driven surfaces (data/podcast-surfaces.json from harvester/podcast-surfaces.mjs) ----
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const _HERE = path.dirname(fileURLToPath(import.meta.url));
export const PODCAST_SURFACES_PATH = process.env.PODCAST_SURFACES || path.resolve(_HERE, "../data/podcast-surfaces.json");
export function loadPodcastSurfaces(file = PODCAST_SURFACES_PATH) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } // absent → callers fall back to alpha
}

// /podcasts?sort=top — telemetry-ranked shows FIRST (real data always leads), the un-ranked TAIL ordered by
// episode count desc as the cold-start signal (a substantial back catalog beats strict A-Z while telemetry is
// young). As plays accrue, more shows are telemetry-ranked and the episode-count fallback shrinks on its own.
export function topPodcastShows(db, surfaces) {
  const all = allPodcastShows(db);
  const epc = new Map(db.prepare(`SELECT showId, COUNT(*) n FROM podcast_episode GROUP BY showId`).all().map((r) => [r.showId, r.n]));
  const byEpisodes = (a, b) => (epc.get(b.id) || 0) - (epc.get(a.id) || 0);
  if (!surfaces?.topShows?.length) return [...all].sort(byEpisodes); // no telemetry yet → episode-count order
  const rank = new Map(surfaces.topShows.map((s, i) => [s.id, i]));
  const byId = new Map(all.map((s) => [s.id, s]));
  const ranked = surfaces.topShows.map((s) => byId.get(s.id)).filter(Boolean);
  const rest = all.filter((s) => !rank.has(s.id)).sort(byEpisodes);
  return [...ranked, ...rest];
}

// New shows for the Podcasts-tab "New" row — by FIRST-seen time (never bumped by re-harvest), so it is a real
// new-arrivals signal, not "everything re-harvested last night". Channel-gate applied by the caller.
export function newPodcastShows(db, limit = 25) {
  const art = makeShowArtResolver(db);
  return db.prepare(`SELECT id,name,author,channelId,thumbnail,episodeCountText,genres FROM podcast_show
      WHERE firstSeenAt IS NOT NULL ORDER BY firstSeenAt DESC LIMIT ?`).all(limit).map((s) => ({ ...showRow(s), thumbnail: art(s) }));
}

// /podcasts/trending — the surface's trending episode ids, hydrated to full episode rows (newest-trend first).
export function trendingPodcastEpisodes(db, surfaces, limit = 50) {
  const ids = (surfaces?.trendingEpisodes || []).slice(0, limit).map((e) => e.videoId);
  if (!ids.length) return [];
  const rows = db.prepare(`SELECT e.videoId,e.showId,e.title,e.thumbnail,e.durationSec,e.publishedText,e.publishedAt,
      s.name podcastName, s.channelId FROM podcast_episode e JOIN podcast_show s ON s.id=e.showId
      WHERE e.videoId IN (${ids.map(() => "?").join(",")})`).all(...ids);
  const order = new Map(ids.map((id, i) => [id, i])); // preserve the surface's trend order
  return rows.map(epRow).sort((a, b) => order.get(a.videoId) - order.get(b.videoId));
}

// Drop shows (and their episodes) no longer in the whitelist; then drop channels with no surviving show.
// keepIds = the current whitelisted MPSP set. Returns {shows, channels} removed.
export function prunePodcasts(db, keepIds) {
  const gone = db.prepare(`SELECT id FROM podcast_show`).all().map((r) => r.id).filter((id) => !keepIds.has(id));
  const tx = db.transaction(() => {
    for (const id of gone) {
      db.prepare(`DELETE FROM podcast_episode WHERE showId=?`).run(id);
      db.prepare(`DELETE FROM podcast_show WHERE id=?`).run(id);
    }
    // orphan channels (no show points at them anymore)
    db.prepare(`DELETE FROM podcast_channel WHERE id NOT IN (SELECT DISTINCT channelId FROM podcast_show WHERE channelId IS NOT NULL)`).run();
  });
  const chBefore = db.prepare(`SELECT COUNT(*) n FROM podcast_channel`).get().n;
  tx();
  const chAfter = db.prepare(`SELECT COUNT(*) n FROM podcast_channel`).get().n;
  return { shows: gone.length, channels: chBefore - chAfter };
}

export function podcastStats(db) {
  const shows = db.prepare(`SELECT COUNT(*) n FROM podcast_show`).get().n;
  const episodes = db.prepare(`SELECT COUNT(*) n FROM podcast_episode`).get().n;
  const channels = db.prepare(`SELECT COUNT(*) n FROM podcast_channel`).get().n;
  const withDur = db.prepare(`SELECT COUNT(*) n FROM podcast_episode WHERE durationSec IS NOT NULL`).get().n;
  const withCh = db.prepare(`SELECT COUNT(*) n FROM podcast_show WHERE channelId IS NOT NULL`).get().n;
  return { shows, episodes, channels, withDur, withCh };
}
