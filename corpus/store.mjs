// SQLite corpus store — the durable source-of-truth for the harvested catalog (replaces the prototype
// tracks.json). Normalized: artist holds the per-artist content flags; track/album/playlist reference it.
// WAL mode for durable, concurrent reads. The harvester upserts ONE artist's whole catalog per
// transaction, so a long harvest checkpoints continuously (crash/kill safe) instead of only at the end.
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Env-configurable so it deploys to a server unchanged (CORPUS_DB=/var/lib/zemer-search/corpus.db).
export const DB_PATH = process.env.CORPUS_DB || path.resolve(HERE, "../data/corpus.db");

// Curated blocklist (data/blocklist.json, committed like synonyms.json): specific junk videoIds and/or
// artist ids to keep OUT of the corpus regardless of the whitelist — for track-level junk under an
// otherwise-wanted artist (the whitelist is artist-granularity and can't express that). Honored by
// upsertArtistCatalog (never stores a blocklisted id) and pruneBlocklisted (removes existing rows).
const BLOCKLIST_PATH = process.env.BLOCKLIST || path.resolve(HERE, "../data/blocklist.json");
let _blocklist = null;
export function blocklist() {
  if (_blocklist) return _blocklist;
  let v = [], a = [], p = [], t = [];
  try {
    const j = JSON.parse(fs.readFileSync(BLOCKLIST_PATH, "utf8"));
    v = j.videoIds || []; a = j.artistIds || [];
    p = j.playlistIds || [];                                   // community playlist ids to exclude
    t = (j.playlistTerms || []).map((s) => String(s).toLowerCase()).filter(Boolean); // title/curator screen
  } catch { /* no/invalid blocklist → empty */ }
  _blocklist = { videoIds: new Set(v), artistIds: new Set(a), playlistIds: new Set(p), playlistTerms: t };
  return _blocklist;
}

// Conditional id-override list (data/blocked-ids.json, fetched from the Firestore `blockedContentIds`
// collection by harness/blocked-ids.mjs — the same list the app honors). One flat table of ids matched
// against a result's videoId / playlistId / channelId / browseId: `global` ids are dropped for everyone,
// `female` ids only when female is blocked. Read fresh (no cache) so an index reload picks up a new fetch.
export const BLOCKED_IDS_PATH = process.env.BLOCKED_IDS || path.resolve(HERE, "../data/blocked-ids.json");
export function loadBlockedIds() {
  let global = [], female = [];
  try { const j = JSON.parse(fs.readFileSync(BLOCKED_IDS_PATH, "utf8")); global = j.global || []; female = j.female || []; } catch { /* none → empty (no-op) */ }
  return { global: new Set(global), female: new Set(female) };
}

export function openCorpus(file = DB_PATH) {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 8000"); // WAL has one writer; multiple maintenance processes queue, not error
  db.exec(`
    CREATE TABLE IF NOT EXISTS artist (
      id               TEXT PRIMARY KEY,
      name             TEXT,
      thumbnail        TEXT,
      regularChannelId TEXT,
      isFemale         INTEGER NOT NULL DEFAULT 0,
      isChasid         INTEGER NOT NULL DEFAULT 0,
      isKidZone        INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS track (
      videoId     TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      artistId    TEXT NOT NULL REFERENCES artist(id),
      isVideo     INTEGER NOT NULL DEFAULT 0,
      explicit    INTEGER NOT NULL DEFAULT 0,
      harvestedAt INTEGER
    );
    CREATE TABLE IF NOT EXISTS album (
      id         TEXT PRIMARY KEY,           -- album browseId (MPRE…)
      playlistId TEXT,
      title      TEXT NOT NULL,
      artistId   TEXT NOT NULL REFERENCES artist(id),
      type       TEXT NOT NULL DEFAULT 'album', -- album | single | ep
      year       INTEGER,
      thumbnail  TEXT,
      uploadDate TEXT                           -- REAL release date (ISO-8601), dated via /player; NULL until dated
    );
    CREATE TABLE IF NOT EXISTS playlist (
      id        TEXT PRIMARY KEY,            -- playlistId
      title     TEXT NOT NULL,
      artistId  TEXT NOT NULL REFERENCES artist(id),
      thumbnail TEXT
    );
    CREATE TABLE IF NOT EXISTS album_track (
      albumId TEXT NOT NULL,                 -- album.id (MPRE…)
      videoId TEXT NOT NULL,
      pos     INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (albumId, videoId)
    );
    CREATE INDEX IF NOT EXISTS idx_track_artist ON track(artistId);
    CREATE INDEX IF NOT EXISTS idx_albumtrack_album ON album_track(albumId);
    CREATE INDEX IF NOT EXISTS idx_albumtrack_video ON album_track(videoId);
    CREATE INDEX IF NOT EXISTS idx_album_artist ON album(artistId);
    CREATE INDEX IF NOT EXISTS idx_playlist_artist ON playlist(artistId);
    -- Community playlists (pilot): YTM playlists curated by community members, NOT owned by a whitelisted
    -- artist. Kept in their OWN tables so the artist-owned playlist table (and its NOT NULL artistId FK)
    -- is untouched and the pilot is trivially reversible. PURITY is guaranteed at SERVE time: the /playlist
    -- endpoint re-fetches the playlist live and keeps only whitelisted tracks, so we never serve a
    -- non-whitelisted track regardless of what else the playlist holds. These rows carry the discovery-time
    -- counts (total/whitelisted) and community_playlist_track stores the whitelisted subset we matched
    -- (powers search/index, the displayed counts, and the pilot yield report).
    CREATE TABLE IF NOT EXISTS community_playlist (
      id           TEXT PRIMARY KEY,         -- playlistId (no VL prefix)
      title        TEXT NOT NULL,
      author       TEXT,                     -- curator/owner display name (free text; not a whitelisted artist)
      thumbnail    TEXT,
      total        INTEGER NOT NULL DEFAULT 0,   -- tracks on YTM at discovery
      whitelisted  INTEGER NOT NULL DEFAULT 0,   -- of those, how many are whitelisted (the only ones served)
      discoveredAt INTEGER
    );
    CREATE TABLE IF NOT EXISTS community_playlist_track (
      playlistId TEXT NOT NULL,
      videoId    TEXT NOT NULL,
      pos        INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (playlistId, videoId)
    );
    CREATE INDEX IF NOT EXISTS idx_cpt_playlist ON community_playlist_track(playlistId);
    -- Zemer-CURATED playlists (the /zemer-playlists endpoint): hand-picked categories of songs/albums,
    -- authored in data/zemer-playlists.json and applied by harvester/zemer-playlists.mjs (offline). An
    -- 'album' item expands to its member tracks at READ time (via album_track), so a re-harvested album's
    -- new tracks appear automatically. Replaced wholesale on every apply — the JSON is the source of truth.
    CREATE TABLE IF NOT EXISTS zemer_playlist (
      id    TEXT PRIMARY KEY,                -- slug from the JSON (e.g. "shabbos")
      title TEXT NOT NULL,
      pos   INTEGER NOT NULL DEFAULT 0       -- display order = file order
    );
    CREATE TABLE IF NOT EXISTS zemer_playlist_item (
      playlistId TEXT NOT NULL,
      kind       TEXT NOT NULL,              -- 'track' | 'album'
      refId      TEXT NOT NULL,              -- videoId | album browseId (MPRE…)
      pos        INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (playlistId, kind, refId)
    );
    CREATE INDEX IF NOT EXISTS idx_zpi_playlist ON zemer_playlist_item(playlistId);
  `);
  // Migrate existing DBs (CREATE TABLE IF NOT EXISTS won't add a new column to an existing table).
  if (!db.prepare("PRAGMA table_info(artist)").all().some((c) => c.name === "regularChannelId"))
    db.exec("ALTER TABLE artist ADD COLUMN regularChannelId TEXT");
  // album.uploadDate: the release's REAL date (ISO-8601), dated via one /player on a sample track (see
  // harvester/releases.mjs). Browse pages only carry a year; this is what makes New Releases accurate.
  if (!db.prepare("PRAGMA table_info(album)").all().some((c) => c.name === "uploadDate"))
    db.exec("ALTER TABLE album ADD COLUMN uploadDate TEXT");
  // community_playlist_track.artistId: the member's resolved whitelisted artist (its uploader channel →
  // artist id), captured at discovery. Lets the content filter know a member's gender even when its TRACK
  // isn't harvested (e.g. a track on the artist's regular channel, issue #108) — without it those members
  // are "unknown" and an all-female playlist with one such member would wrongly fail open. NULL until
  // backfilled (harvester/backfill-community-artists.mjs), and NULL behaves exactly like the old behavior.
  if (!db.prepare("PRAGMA table_info(community_playlist_track)").all().some((c) => c.name === "artistId"))
    db.exec("ALTER TABLE community_playlist_track ADD COLUMN artistId TEXT");
  // Track detail metadata, extracted from the already-cached browse rows (no new fetches — see
  // harvester/backfill-track-meta.mjs): durationSec (from album-page fixed columns) + playCount (from the
  // landing "Songs" shelf, for a real "Top songs" ranking). Both nullable; absent = unknown (old behavior).
  if (!db.prepare("PRAGMA table_info(track)").all().some((c) => c.name === "durationSec"))
    db.exec("ALTER TABLE track ADD COLUMN durationSec INTEGER");
  if (!db.prepare("PRAGMA table_info(track)").all().some((c) => c.name === "playCount"))
    db.exec("ALTER TABLE track ADD COLUMN playCount INTEGER");
  // Per-track real release date (ISO-8601), from one /player on the track itself — for STANDALONE tracks
  // (not in any album, so they can't inherit an album's uploadDate). Dated off-datacenter (/player is blocked
  // from datacenters) by harvester/releases.mjs and shipped in; NULL until dated. Preserved across re-harvest.
  if (!db.prepare("PRAGMA table_info(track)").all().some((c) => c.name === "uploadDate"))
    db.exec("ALTER TABLE track ADD COLUMN uploadDate TEXT");
  // Per-connection scratch set of "female-involved" videoIds (primary OR a featured female — see
  // index/credits.mjs), populated by setFemaleSet() at index reload. The female content-filter SQL ORs
  // membership here onto the primary `isFemale`. Empty by default → identical to primary-only filtering.
  db.exec("CREATE TEMP TABLE IF NOT EXISTS _female(videoId TEXT PRIMARY KEY)");
  return db;
}

// Replace this connection's female-involved videoId set (see openCorpus `_female`). Called at index reload
// with the set computed by index/credits.mjs over the whole corpus, so the SQL female filters agree exactly
// with the in-memory ones. An empty set reverts to primary-`isFemale`-only filtering.
export function setFemaleSet(db, videoIds = []) {
  const ins = db.prepare("INSERT OR IGNORE INTO _female(videoId) VALUES(?)");
  db.transaction((ids) => { db.prepare("DELETE FROM _female").run(); for (const v of ids) ins.run(v); })([...videoIds]);
}

// Upsert one artist's whole catalog (tracks + albums + playlists) in a single transaction — the durable
// per-artist checkpoint. Returns processed counts (for logging; refresh measures "new" via stats deltas).
export function upsertArtistCatalog(db, artist, catalog, ts = Date.now()) {
  const bl = blocklist();
  if (bl.artistIds.has(artist.id)) return { tracks: 0, albums: 0, playlists: 0, blocked: true }; // never store a blocklisted artist
  let { tracks = [], albums = [], playlists = [], albumTracks = [], thumbnail = null, regularChannelId = null } = catalog;
  if (bl.videoIds.size) { // never store blocklisted junk tracks (so a re-harvest can't re-add them)
    tracks = tracks.filter((t) => !bl.videoIds.has(t.videoId));
    albumTracks = albumTracks.filter((at) => !bl.videoIds.has(at.videoId));
  }
  const upArtist = db.prepare(
    `INSERT INTO artist(id,name,thumbnail,regularChannelId,isFemale,isChasid,isKidZone) VALUES(@id,@name,@thumbnail,@regularChannelId,@isFemale,@isChasid,@isKidZone)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, thumbnail=COALESCE(excluded.thumbnail, artist.thumbnail),
       regularChannelId=COALESCE(excluded.regularChannelId, artist.regularChannelId),
       isFemale=excluded.isFemale, isChasid=excluded.isChasid, isKidZone=excluded.isKidZone`);
  const insTrack = db.prepare(
    `INSERT INTO track(videoId,title,artistId,isVideo,explicit,harvestedAt,durationSec,playCount) VALUES(@videoId,@title,@artistId,@isVideo,@explicit,@harvestedAt,@durationSec,@playCount)
     ON CONFLICT(videoId) DO UPDATE SET title=excluded.title, isVideo=MAX(track.isVideo, excluded.isVideo),
       durationSec=COALESCE(excluded.durationSec, track.durationSec),
       playCount=NULLIF(MAX(COALESCE(track.playCount,0), COALESCE(excluded.playCount,0)), 0)`);
  const insAlbum = db.prepare(
    `INSERT INTO album(id,playlistId,title,artistId,type,year,thumbnail) VALUES(@id,@playlistId,@title,@artistId,@type,@year,@thumbnail)
     ON CONFLICT(id) DO UPDATE SET playlistId=excluded.playlistId, title=excluded.title, type=excluded.type, year=excluded.year, thumbnail=excluded.thumbnail`);
  const insPlaylist = db.prepare(
    `INSERT INTO playlist(id,title,artistId,thumbnail) VALUES(@id,@title,@artistId,@thumbnail)
     ON CONFLICT(id) DO UPDATE SET title=excluded.title, thumbnail=excluded.thumbnail`);
  const insAlbumTrack = db.prepare(
    `INSERT INTO album_track(albumId,videoId,pos) VALUES(@albumId,@videoId,@pos)
     ON CONFLICT(albumId,videoId) DO UPDATE SET pos=excluded.pos`);
  const tx = db.transaction(() => {
    upArtist.run({ id: artist.id, name: artist.name ?? null, thumbnail, regularChannelId, isFemale: artist.isFemale ? 1 : 0, isChasid: artist.isChasid ? 1 : 0, isKidZone: artist.isKidZone ? 1 : 0 });
    for (const t of tracks) insTrack.run({ videoId: t.videoId, title: t.title, artistId: artist.id, isVideo: t.isVideo ? 1 : 0, explicit: t.explicit ? 1 : 0, harvestedAt: ts, durationSec: t.durationSec ?? null, playCount: t.playCount ?? null });
    for (const al of albums) insAlbum.run({ id: al.id, playlistId: al.playlistId ?? null, title: al.title, artistId: artist.id, type: al.type || "album", year: al.year ?? null, thumbnail: al.thumbnail ?? null });
    for (const pl of playlists) insPlaylist.run({ id: pl.id, title: pl.title, artistId: artist.id, thumbnail: pl.thumbnail ?? null });
    for (const at of albumTracks) insAlbumTrack.run({ albumId: at.albumId, videoId: at.videoId, pos: at.pos });
  });
  tx();
  return { tracks: tracks.length, albums: albums.length, playlists: playlists.length };
}

// All tracks in the denormalized shape the index/bench/subset already expect.
export function allTracks(db) {
  return db.prepare(`
    SELECT t.videoId, t.title, t.artistId, a.name AS artistName,
           t.isVideo, t.explicit, t.durationSec, t.playCount,
           COALESCE(t.uploadDate, MAX(al.uploadDate)) AS releaseDate,
           a.isFemale, a.isChasid, a.isKidZone
    FROM track t JOIN artist a ON a.id = t.artistId
    LEFT JOIN album_track at ON at.videoId = t.videoId
    LEFT JOIN album al ON al.id = at.albumId
    GROUP BY t.videoId
  `).all().map((r) => ({
    videoId: r.videoId, title: r.title, artistId: r.artistId, artistName: r.artistName,
    isVideo: !!r.isVideo, explicit: !!r.explicit, durationSec: r.durationSec ?? null, playCount: r.playCount ?? null,
    releaseDate: r.releaseDate || null,
    isFemale: !!r.isFemale, isChasid: !!r.isChasid, isKidZone: !!r.isKidZone,
  }));
}

export const allArtists = (db) => db.prepare(
  "SELECT id, name, thumbnail, isFemale, isChasid, isKidZone FROM artist WHERE name IS NOT NULL").all()
  .map((r) => ({ id: r.id, name: r.name, thumbnail: r.thumbnail, isFemale: !!r.isFemale, isChasid: !!r.isChasid, isKidZone: !!r.isKidZone }));

export const allAlbums = (db) => db.prepare(`
  SELECT al.id, al.playlistId, al.title, al.artistId, al.type, al.year, al.thumbnail, al.uploadDate,
         a.name AS artistName, a.isFemale, a.isChasid, a.isKidZone,
         COUNT(at.videoId) AS trackCount, SUM(t.durationSec) AS totalDurationSec
  FROM album al JOIN artist a ON a.id = al.artistId
  LEFT JOIN album_track at ON at.albumId = al.id LEFT JOIN track t ON t.videoId = at.videoId
  GROUP BY al.id`).all()
  .map((r) => ({ id: r.id, playlistId: r.playlistId, title: r.title, artistId: r.artistId, artistName: r.artistName, type: r.type, year: r.year, thumbnail: r.thumbnail, releaseDate: r.uploadDate || null, trackCount: r.trackCount, totalDurationSec: r.totalDurationSec ?? null, isFemale: !!r.isFemale, isChasid: !!r.isChasid, isKidZone: !!r.isKidZone }));

export const allPlaylists = (db) => db.prepare(`
  SELECT pl.id, pl.title, pl.artistId, pl.thumbnail, a.name AS artistName, a.isFemale, a.isChasid, a.isKidZone
  FROM playlist pl JOIN artist a ON a.id = pl.artistId`).all()
  .map((r) => ({ id: r.id, title: r.title, artistId: r.artistId, artistName: r.artistName, thumbnail: r.thumbnail, isFemale: !!r.isFemale, isChasid: !!r.isChasid, isKidZone: !!r.isKidZone }));

// Community playlists (pilot) ---------------------------------------------------------------------
// YTM playlists curated by community members (not owned by a whitelisted artist). Stored apart from the
// artist-owned `playlist` table. Purity is NOT enforced here — it's enforced when the playlist is opened
// (/playlist re-fetches and keeps only whitelisted tracks). These rows hold the discovery-time counts and
// the matched whitelisted membership, for search/index, the displayed "X of Y" counts, and yield reports.
export function upsertCommunityPlaylist(db, { id, title, author = null, thumbnail = null, total = 0 }, whitelistedTracks = [], ts = Date.now()) {
  const bl = blocklist();
  if (bl.playlistIds.has(id)) return { whitelisted: 0, total, blocked: true }; // never store a blocklisted playlist
  const mem = whitelistedTracks.filter((t) => t.videoId && !bl.videoIds.has(t.videoId)); // never store blocklisted junk
  const insPl = db.prepare(
    `INSERT INTO community_playlist(id,title,author,thumbnail,total,whitelisted,discoveredAt)
     VALUES(@id,@title,@author,@thumbnail,@total,@whitelisted,@discoveredAt)
     ON CONFLICT(id) DO UPDATE SET title=excluded.title, author=excluded.author, thumbnail=excluded.thumbnail,
       total=excluded.total, whitelisted=excluded.whitelisted, discoveredAt=excluded.discoveredAt`);
  const delMem = db.prepare("DELETE FROM community_playlist_track WHERE playlistId=?");
  const insMem = db.prepare(
    `INSERT INTO community_playlist_track(playlistId,videoId,pos,artistId) VALUES(@playlistId,@videoId,@pos,@artistId)
     ON CONFLICT(playlistId,videoId) DO UPDATE SET pos=excluded.pos, artistId=excluded.artistId`);
  const tx = db.transaction(() => { // whole playlist in one transaction (gotcha #10)
    insPl.run({ id, title, author, thumbnail, total, whitelisted: mem.length, discoveredAt: ts });
    delMem.run(id); // re-snapshot membership (a re-check may change which tracks are whitelisted)
    mem.forEach((t, i) => insMem.run({ playlistId: id, videoId: t.videoId, pos: t.pos ?? i, artistId: t.artistId ?? null }));
  });
  tx();
  return { whitelisted: mem.length, total };
}

// The displayed cover is derived from a WHITELISTED track in the playlist — NOT the curator's playlist
// cover (which can show non-whitelisted artwork, e.g. a mosaic of its non-whitelisted tracks). This keeps
// the image as whitelist-pure as the audio. `cover` subquery = first whitelisted track's videoId.
const ytThumb = (vid) => (vid ? `https://i.ytimg.com/vi/${vid}/mqdefault.jpg` : null);
const COVER_SQL = "(SELECT videoId FROM community_playlist_track WHERE playlistId=community_playlist.id ORDER BY pos LIMIT 1)";

// For the search index: community playlists shaped like the artist-playlist docs (title + artistName so
// buildIndex/search treat them uniformly), tagged source:"community" and carrying their counts.
// artistName is "" on purpose: a community playlist's "artist" is a random curator, NOT a real artist, so
// matching/boosting on it ranks curator-name hits above title-begins-with hits (wrong). Community playlists
// rank by TITLE only; the curator is kept in `author` for DISPLAY (categories maps it to the row's artist).
// Per-community-playlist content summary for SEARCH-time filtering: `fb`=1 if any member isn't in the
// corpus yet (unknown flags → always kept); `clsMask` ORs one bit per present member class, indexed
// (isFemale*4 + isVideo*2 + isKidZone). Lets searchCategories hide a playlist with no member surviving
// the active filter (e.g. an all-female list when female is blocked) without a per-query DB hit.
// A member's gender/KidZone come from its corpus track's artist (`a`) when harvested, else from its
// discovery-resolved artist (`am`, via community_playlist_track.artistId) — so an un-harvested member
// (e.g. a track on the artist's regular channel) still contributes its real class instead of being an
// "unknown" that fails open. `fb` (true unknown) is now ONLY a member with neither a corpus track NOR a
// resolved artist. isVideo is track-level (unknown → audio) for resolved-but-unharvested members.
const COMMUNITY_CONTENT_SQL = `SELECT cpt.playlistId AS pid,
    MAX(t.videoId IS NULL AND cpt.artistId IS NULL) AS fb,
    COALESCE(SUM(DISTINCT CASE WHEN (t.videoId IS NOT NULL OR cpt.artistId IS NOT NULL)
      THEN (1 << (
        (CASE WHEN COALESCE(a.isFemale,0)=1 OR COALESCE(am.isFemale,0)=1 OR cpt.videoId IN (SELECT videoId FROM _female) THEN 1 ELSE 0 END)*4
        + COALESCE(t.isVideo,0)*2
        + (CASE WHEN COALESCE(a.isKidZone,0)=1 OR COALESCE(am.isKidZone,0)=1 THEN 1 ELSE 0 END))) END), 0) AS clsMask
  FROM community_playlist_track cpt
  LEFT JOIN track t ON t.videoId=cpt.videoId
  LEFT JOIN artist a ON a.id=t.artistId
  LEFT JOIN artist am ON am.id=cpt.artistId
  GROUP BY cpt.playlistId`;

export const allCommunityPlaylists = (db) => db.prepare(
  `SELECT community_playlist.id, community_playlist.title, community_playlist.author, community_playlist.whitelisted,
          community_playlist.total, ${COVER_SQL} AS cover, c.fb, c.clsMask
   FROM community_playlist LEFT JOIN (${COMMUNITY_CONTENT_SQL}) c ON c.pid=community_playlist.id`).all()
  .map((r) => ({ id: r.id, title: r.title, artistName: "", author: r.author || "", thumbnail: ytThumb(r.cover),
    source: "community", whitelisted: r.whitelisted, total: r.total, fb: r.fb ? 1 : 0, clsMask: r.clsMask || 0 }));

// Detail-header metadata for the /playlist endpoint when the id is a community playlist (not in `playlist`).
export const communityPlaylistMeta = (db, id) => {
  const r = db.prepare(`SELECT id,title,author,whitelisted,total, ${COVER_SQL} AS cover FROM community_playlist WHERE id=?`).get(id);
  return r ? { ...r, thumbnail: ytThumb(r.cover) } : null;
};

// Browse-all list (powers the Community chip's "show all, no search" view). Best-populated first, so the
// richest community lists lead. Already-display-shaped rows (author → artist).
// With a content filter active, a playlist is KEPT only if ≥1 of its whitelisted members survives the
// filter — so an ALL-female playlist is hidden when female is blocked (it would open empty), an all-video
// list is hidden when videos are blocked, etc.; a MIXED list still shows (its allowed songs remain). The
// kept count becomes the displayed `whitelisted`, and the cover is taken from the first KEPT member. A
// member not in `track` (whitelisted channel, not yet in the corpus) has unknown flags → counted as kept,
// mirroring the /playlist serve-time behavior.
export const communityPlaylistList = (db, limit = 500, { allowFemale = true, kidZoneOnly = false, blockVideos = false } = {}) => {
  const lim = Math.max(1, limit | 0);
  if (allowFemale && !kidZoneOnly && !blockVideos) // fast path: no filter
    return db.prepare(`SELECT id,title,author,whitelisted,total, ${COVER_SQL} AS cover FROM community_playlist ORDER BY whitelisted DESC, total DESC, id LIMIT ?`)
      .all(lim)
      .map((r) => ({ id: r.id, title: r.title, artist: r.author || "Community playlist", thumbnail: ytThumb(r.cover), source: "community", whitelisted: r.whitelisted, total: r.total }));
  const keep = "((t.videoId IS NULL AND cpt.artistId IS NULL) OR ((@allowFemale=1 OR (COALESCE(a.isFemale,am.isFemale,0)=0 AND cpt.videoId NOT IN (SELECT videoId FROM _female))) AND (@kidZoneOnly=0 OR COALESCE(a.isKidZone,am.isKidZone,0)=1) AND (@blockVideos=0 OR COALESCE(t.isVideo,0)=0)))";
  return db.prepare(`
    SELECT cp.id, cp.title, cp.author, cp.total, k.kept AS kept,
      (SELECT videoId FROM community_playlist_track WHERE playlistId=cp.id AND pos=k.coverPos) AS cover
    FROM community_playlist cp
    JOIN (
      SELECT cpt.playlistId AS pid,
        SUM(CASE WHEN ${keep} THEN 1 ELSE 0 END) AS kept,
        MIN(CASE WHEN ${keep} THEN cpt.pos END) AS coverPos
      FROM community_playlist_track cpt
      LEFT JOIN track t ON t.videoId=cpt.videoId
      LEFT JOIN artist a ON a.id=t.artistId
      LEFT JOIN artist am ON am.id=cpt.artistId
      GROUP BY cpt.playlistId
    ) k ON k.pid=cp.id
    WHERE k.kept > 0
    ORDER BY k.kept DESC, cp.total DESC, cp.id
    LIMIT @limit`)
    .all({ allowFemale: allowFemale ? 1 : 0, kidZoneOnly: kidZoneOnly ? 1 : 0, blockVideos: blockVideos ? 1 : 0, limit: lim })
    .map((r) => ({ id: r.id, title: r.title, artist: r.author || "Community playlist", thumbnail: ytThumb(r.cover), source: "community", whitelisted: r.kept, total: r.total }));
};

// Post-filter whitelisted-track count for specific community playlists, so the COUNT shown next to a
// community playlist matches what actually plays under the filter (e.g. a mixed list's count excludes its
// female songs) — the same `keep` rule communityPlaylistList uses, so /search and /community agree. Returns
// Map(id -> {kept, cover}) where `cover` is the thumbnail of the first SURVIVING member (so a filtered card
// never shows a dropped/female member's art); null when no filter is active (caller keeps the stored count+cover).
export function communityKeptCounts(db, ids, { allowFemale = true, kidZoneOnly = false, blockVideos = false } = {}) {
  if (!ids || !ids.length || (allowFemale && !kidZoneOnly && !blockVideos)) return null;
  const keep = "((t.videoId IS NULL AND cpt.artistId IS NULL) OR ((@allowFemale=1 OR (COALESCE(a.isFemale,am.isFemale,0)=0 AND cpt.videoId NOT IN (SELECT videoId FROM _female))) AND (@kidZoneOnly=0 OR COALESCE(a.isKidZone,am.isKidZone,0)=1) AND (@blockVideos=0 OR COALESCE(t.isVideo,0)=0)))";
  const stmt = db.prepare(`SELECT SUM(CASE WHEN ${keep} THEN 1 ELSE 0 END) AS kept, MIN(CASE WHEN ${keep} THEN cpt.pos END) AS coverPos
    FROM community_playlist_track cpt LEFT JOIN track t ON t.videoId=cpt.videoId LEFT JOIN artist a ON a.id=t.artistId
    LEFT JOIN artist am ON am.id=cpt.artistId
    WHERE cpt.playlistId=@pid`);
  const coverStmt = db.prepare("SELECT videoId FROM community_playlist_track WHERE playlistId=? AND pos=?");
  const flags = { allowFemale: allowFemale ? 1 : 0, kidZoneOnly: kidZoneOnly ? 1 : 0, blockVideos: blockVideos ? 1 : 0 };
  const out = new Map();
  for (const id of ids) {
    const r = stmt.get({ ...flags, pid: id });
    const coverVid = r?.coverPos != null ? coverStmt.get(id, r.coverPos)?.videoId : null;
    out.set(id, { kept: r?.kept || 0, cover: coverVid ? ytThumb(coverVid) : null });
  }
  return out;
}

// Ids we've already discovered — so a re-run skips re-fetching them (unless RECHECK forces a re-validate).
export const communityPlaylistIds = (db) =>
  new Set(db.prepare("SELECT id FROM community_playlist").all().map((r) => r.id));

// "Remove what's not": drop a community playlist + its membership (e.g. it fell below the gate on a
// re-validate, or its whitelisted tracks were de-whitelisted). One transaction.
export function removeCommunityPlaylist(db, id) {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM community_playlist_track WHERE playlistId=?").run(id);
    db.prepare("DELETE FROM community_playlist WHERE id=?").run(id);
  });
  tx();
}

// Zemer-curated playlists --------------------------------------------------------------------------
// Hand-curated categories ("Shabbos", "Upbeat", …) authored in data/zemer-playlists.json:
//   { "playlists": [ { "id": "shabbos", "title": "Shabbos", "videoIds": […], "albumIds": ["MPRE…"] } ] }
// File order = display order; id order = track order (videoIds first, then each album expanded in place).
// Applied to the zemer_playlist tables by harvester/zemer-playlists.mjs (offline, DRY=1 previews); served
// by /zemer-playlists. Album items expand to member tracks at READ time via album_track, so a re-harvested
// album's new tracks appear without a re-apply. Only tracks present in the corpus are ever served (JOIN),
// so an id that isn't harvested yet is silently pending until it lands — never an error at serve time.
export const ZEMER_PLAYLISTS_PATH = process.env.ZEMER_PLAYLISTS || path.resolve(HERE, "../data/zemer-playlists.json");
export function loadZemerPlaylists() {
  try { return { playlists: JSON.parse(fs.readFileSync(ZEMER_PLAYLISTS_PATH, "utf8")).playlists || [] }; }
  catch { return { playlists: [] }; } // no/invalid file → empty (endpoint serves [])
}

// Replace the zemer_playlist tables with the curated doc (one transaction — the JSON is the source of
// truth, so removal from the file removes the playlist). Returns counts + the ids not (yet) in the corpus
// (curator feedback: a typo'd id would otherwise just silently never play). dry=1 validates without writing.
export function applyZemerPlaylists(db, doc = loadZemerPlaylists(), { dry = false } = {}) {
  const pls = doc.playlists || [];
  const seen = new Set();
  for (const p of pls) {
    if (!p?.id || !p?.title) throw new Error(`zemer-playlists: every playlist needs id + title (got ${JSON.stringify(p)})`);
    if (seen.has(p.id)) throw new Error(`zemer-playlists: duplicate playlist id "${p.id}"`);
    seen.add(p.id);
  }
  const hasTrack = db.prepare("SELECT 1 FROM track WHERE videoId=?");
  const hasAlbum = db.prepare("SELECT 1 FROM album WHERE id=?");
  const insPl = db.prepare("INSERT INTO zemer_playlist(id,title,pos) VALUES(?,?,?)");
  const insItem = db.prepare("INSERT OR REPLACE INTO zemer_playlist_item(playlistId,kind,refId,pos) VALUES(?,?,?,?)");
  const missing = [];
  let items = 0;
  const pass = () => pls.forEach((p, pi) => {
    if (!dry) insPl.run(p.id, p.title, pi);
    let pos = 0;
    for (const v of p.videoIds || []) { if (!hasTrack.get(v)) missing.push({ playlist: p.id, kind: "track", id: v }); if (!dry) insItem.run(p.id, "track", v, pos); pos++; items++; }
    for (const a of p.albumIds || []) { if (!hasAlbum.get(a)) missing.push({ playlist: p.id, kind: "album", id: a }); if (!dry) insItem.run(p.id, "album", a, pos); pos++; items++; }
  });
  if (dry) pass();
  else db.transaction(() => { db.prepare("DELETE FROM zemer_playlist_item").run(); db.prepare("DELETE FROM zemer_playlist").run(); pass(); })();
  return { playlists: pls.length, items, missing };
}

// Expanded, filtered, display-shaped tracks of one curated playlist. Direct track items keep file order;
// an album item expands in place in album order. The same videoId reached twice (listed directly AND via
// an album) appears ONCE (first position wins). Content filters follow albumDetail exactly: female =
// primary OR featuring (_female set), kidZone/video per artist/track flags; `dropId` is the server's
// blocked-ids predicate (gotcha #7 — applied here so list counts/covers/durations agree with the detail).
function zemerPlaylistTracks(db, id, { allowFemale = true, kidZoneOnly = false, blockVideos = false } = {}, dropId = null) {
  const rows = db.prepare(`
    SELECT x.ipos, x.spos, t.videoId, t.title, t.explicit, t.isVideo, t.durationSec, t.playCount,
           COALESCE(t.uploadDate, MAX(al.uploadDate)) AS releaseDate,
           a.name AS artistName, a.isKidZone,
           (a.isFemale=1 OR t.videoId IN (SELECT videoId FROM _female)) AS femInv
    FROM (
      SELECT pos AS ipos, -1 AS spos, refId AS videoId FROM zemer_playlist_item WHERE playlistId=@id AND kind='track'
      UNION ALL
      SELECT zpi.pos, at.pos, at.videoId FROM zemer_playlist_item zpi
        JOIN album_track at ON at.albumId=zpi.refId WHERE zpi.playlistId=@id AND zpi.kind='album'
    ) x
    JOIN track t ON t.videoId=x.videoId JOIN artist a ON a.id=t.artistId
    LEFT JOIN album_track at2 ON at2.videoId=t.videoId LEFT JOIN album al ON al.id=at2.albumId
    GROUP BY x.ipos, x.spos, t.videoId ORDER BY x.ipos, x.spos`).all({ id });
  const seen = new Set(), out = [];
  for (const r of rows) {
    if (seen.has(r.videoId)) continue;
    seen.add(r.videoId);
    if (dropId && dropId(r.videoId)) continue;
    if ((!allowFemale && r.femInv) || (kidZoneOnly && !r.isKidZone) || (blockVideos && r.isVideo)) continue;
    out.push({ videoId: r.videoId, title: r.title, artist: r.artistName, explicit: !!r.explicit, isVideo: !!r.isVideo,
      durationSec: r.durationSec ?? null, playCount: r.playCount ?? null, releaseDate: r.releaseDate ?? null });
  }
  return out;
}

// Card row for the curated list + header for the detail: post-filter count/runtime, cover = first
// SURVIVING track's art (never a filtered-out member's — same rule as community covers).
const zemerCard = (id, title, tracks) => ({ id, title, thumbnail: ytThumb(tracks[0].videoId), trackCount: tracks.length,
  totalDurationSec: tracks.some((t) => t.durationSec != null) ? tracks.reduce((s, t) => s + (t.durationSec || 0), 0) : null });

// Browse-all curated list (file order). A playlist with NO member surviving the active filter is hidden
// (gotcha #7 — an all-female list would open empty under allowFemale=0), matching the detail's 404.
export function zemerPlaylistList(db, cf = {}, dropId = null) {
  return db.prepare("SELECT id,title FROM zemer_playlist ORDER BY pos, id").all()
    .map((p) => { const tracks = zemerPlaylistTracks(db, p.id, cf, dropId); return tracks.length ? zemerCard(p.id, p.title, tracks) : null; })
    .filter(Boolean);
}

// One curated playlist + its tracks. null for an unknown id OR when every member is filtered out (the
// list hides it, so drilling in must 404 too — nothing leaks on drill-in).
export function zemerPlaylistDetail(db, id, cf = {}, dropId = null) {
  const p = db.prepare("SELECT id,title FROM zemer_playlist WHERE id=?").get(id);
  if (!p) return null;
  const tracks = zemerPlaylistTracks(db, id, cf, dropId);
  if (!tracks.length) return null;
  return { playlist: zemerCard(p.id, p.title, tracks), tracks };
}

// Detail pages -----------------------------------------------------------------------------------
export function artistDetail(db, artistId, { allowFemale = true, kidZoneOnly = false, blockVideos = false } = {}) {
  const a = db.prepare("SELECT id,name,thumbnail,isFemale,isKidZone FROM artist WHERE id=?").get(artistId);
  if (!a) return null;
  // Content gate (defense-in-depth, same predicate `/search` uses): a blocked-female user must never get a
  // female artist's page, and a KidZone-only user must never get a non-KidZone artist. Treat as not-found.
  if ((!allowFemale && a.isFemale) || (kidZoneOnly && !a.isKidZone)) return null;
  // The artist is gated above by its own gender; this additionally drops the artist's tracks that FEATURE
  // a female (in _female) when female is blocked — same featuring rule as /search.
  // Songs first by play count (real "Top songs"), then by index time; NULL plays sort last.
  // A track's date is its album's (inherited) else its own (standalone): COALESCE(album.uploadDate, track.uploadDate).
  const trk = db.prepare(`SELECT t.videoId, t.title, t.isVideo, t.explicit, t.durationSec, t.playCount,
      COALESCE(t.uploadDate, MAX(al.uploadDate)) AS releaseDate
    FROM track t LEFT JOIN album_track at ON at.videoId=t.videoId LEFT JOIN album al ON al.id=at.albumId
    WHERE t.artistId=@artistId AND (@allowFemale=1 OR t.videoId NOT IN (SELECT videoId FROM _female))
    GROUP BY t.videoId ORDER BY (t.playCount IS NULL), t.playCount DESC, t.harvestedAt`)
    .all({ artistId, allowFemale: allowFemale ? 1 : 0 });
  // Album rows carry aggregates computed from album_track ∪ track (trackCount + total runtime) so the app can
  // label "Album · 12 songs · 47 min" without a second call. Read-time only — no stored column.
  const alb = db.prepare(`SELECT al.id, al.playlistId, al.title, al.type, al.year, al.thumbnail, al.uploadDate,
      COUNT(at.videoId) AS trackCount, SUM(t.durationSec) AS totalDurationSec
    FROM album al LEFT JOIN album_track at ON at.albumId=al.id LEFT JOIN track t ON t.videoId=at.videoId
    WHERE al.artistId=? GROUP BY al.id ORDER BY (al.year IS NULL), al.year DESC`).all(artistId);
  const pl = db.prepare("SELECT id,title,thumbnail FROM playlist WHERE artistId=?").all(artistId);
  const song = (t) => ({ videoId: t.videoId, title: t.title, explicit: !!t.explicit, durationSec: t.durationSec ?? null, playCount: t.playCount ?? null, releaseDate: t.releaseDate ?? null });
  const al = (x) => ({ id: x.id, playlistId: x.playlistId, title: x.title, artist: a.name, type: x.type, year: x.year, thumbnail: x.thumbnail, releaseDate: x.uploadDate ?? null, trackCount: x.trackCount, totalDurationSec: x.totalDurationSec ?? null });
  return {
    artist: { id: a.id, name: a.name, thumbnail: a.thumbnail },
    songs: trk.filter((t) => !t.isVideo).map(song),
    videos: blockVideos ? [] : trk.filter((t) => t.isVideo).map(song),
    albums: alb.filter((x) => x.type !== "single").map(al),
    singles: alb.filter((x) => x.type === "single").map(al),
    playlists: pl.map((p) => ({ id: p.id, title: p.title, artist: a.name, thumbnail: p.thumbnail })),
  };
}

export function albumDetail(db, albumId, { allowFemale = true, kidZoneOnly = false, blockVideos = false } = {}) {
  const al = db.prepare("SELECT al.id,al.title,al.type,al.year,al.thumbnail,al.uploadDate,a.name artistName,a.isFemale,a.isKidZone FROM album al JOIN artist a ON a.id=al.artistId WHERE al.id=?").get(albumId);
  if (!al) return null;
  // Gate the whole album by its artist (same as artistDetail); then filter the track list per-track (a
  // compilation can mix artists / include video tracks).
  if ((!allowFemale && al.isFemale) || (kidZoneOnly && !al.isKidZone)) return null;
  const tracks = db.prepare(`SELECT t.videoId,t.title,t.explicit,t.isVideo,t.durationSec,t.uploadDate,a.name artistName,a.isKidZone, at.pos,
      (a.isFemale=1 OR t.videoId IN (SELECT videoId FROM _female)) AS femInv
    FROM album_track at JOIN track t ON t.videoId=at.videoId JOIN artist a ON a.id=t.artistId
    WHERE at.albumId=? ORDER BY at.pos`).all(albumId)
    .filter((t) => (allowFemale || !t.femInv) && (!kidZoneOnly || t.isKidZone) && (!blockVideos || !t.isVideo))
    .map((t) => ({ videoId: t.videoId, title: t.title, artist: t.artistName, explicit: !!t.explicit, durationSec: t.durationSec ?? null, trackNumber: t.pos + 1, releaseDate: t.uploadDate ?? al.uploadDate ?? null }));
  // Header aggregates from the FULL album (all tracks), so the count/runtime describe the album itself and
  // match the /artist list row even if content filters shorten the returned `tracks`.
  const agg = db.prepare(`SELECT COUNT(at.videoId) AS trackCount, SUM(t.durationSec) AS totalDurationSec
    FROM album_track at JOIN track t ON t.videoId=at.videoId WHERE at.albumId=?`).get(albumId);
  return { album: { id: al.id, title: al.title, type: al.type, year: al.year, thumbnail: al.thumbnail, artist: al.artistName, releaseDate: al.uploadDate ?? null, trackCount: agg.trackCount, totalDurationSec: agg.totalDurationSec ?? null }, tracks };
}

// Which of `ids` are whitelisted tracks we already hold (for playlist detail: a playlist may include
// non-whitelisted songs; we keep only the ones in the corpus). Returns videoId -> result row.
export function tracksByIds(db, ids) {
  const found = new Map();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = db.prepare(`SELECT t.videoId,t.title,t.explicit,t.isVideo,t.durationSec,a.name artistName,a.isKidZone,
        (a.isFemale=1 OR t.videoId IN (SELECT videoId FROM _female)) AS isFemale
      FROM track t JOIN artist a ON a.id=t.artistId WHERE t.videoId IN (${chunk.map(() => "?").join(",")})`).all(...chunk);
    // Carries the content flags so callers (the /playlist endpoint) can filter; membership users (.has) ignore them.
    for (const r of rows) found.set(r.videoId, { videoId: r.videoId, title: r.title, artist: r.artistName, explicit: !!r.explicit, isVideo: !!r.isVideo, durationSec: r.durationSec ?? null, isFemale: !!r.isFemale, isKidZone: !!r.isKidZone });
  }
  return found;
}

// Every channel id that counts as a whitelisted artist: the music channel ids PLUS the mapped
// regular-upload channel ids (so a playlist's videos uploaded to the artist's regular channel verify).
export const whitelistedChannelIds = (db) => new Set([
  ...db.prepare("SELECT id FROM artist").all().map((r) => r.id),
  ...db.prepare("SELECT regularChannelId FROM artist WHERE regularChannelId IS NOT NULL").all().map((r) => r.regularChannelId),
]);

// Recent tracks, newest first — powers the "New Releases" view. Ordered by the REAL release date when we
// have it (a track inherits the `uploadDate` of its album; dated via /player — see harvester/releases.mjs);
// tracks without a dated album fall back to `harvestedAt` (when we first indexed it) and sort below the
// dated ones. `releaseDate` is the precise ISO date when known; `addedAt` is the best-available ms date
// (release date when known, else index time) so the UI's "ago" is accurate. Carries the artist flags.
export function recentTracks(db, limit = 100) {
  return db.prepare(`
    SELECT t.videoId, t.title, a.name AS artistName, t.isVideo, t.explicit, t.harvestedAt, t.durationSec,
           (a.isFemale=1 OR t.videoId IN (SELECT videoId FROM _female)) AS isFemale, a.isChasid, a.isKidZone,
           COALESCE(t.uploadDate, MAX(al.uploadDate)) AS uploadDate
    FROM track t
    JOIN artist a ON a.id = t.artistId
    LEFT JOIN album_track at ON at.videoId = t.videoId
    LEFT JOIN album al ON al.id = at.albumId
    WHERE t.harvestedAt IS NOT NULL
    GROUP BY t.videoId
    ORDER BY (COALESCE(t.uploadDate, MAX(al.uploadDate)) IS NULL), COALESCE(t.uploadDate, MAX(al.uploadDate)) DESC, t.harvestedAt DESC, t.videoId
    LIMIT ?`).all(Math.max(1, limit | 0))
    .map((r) => ({ videoId: r.videoId, title: r.title, artist: r.artistName, isVideo: !!r.isVideo,
      explicit: !!r.explicit, durationSec: r.durationSec ?? null, releaseDate: r.uploadDate || null,
      addedAt: r.uploadDate ? Date.parse(r.uploadDate) : r.harvestedAt,
      isFemale: !!r.isFemale, isChasid: !!r.isChasid, isKidZone: !!r.isKidZone }));
}

// Recent albums/singles/EPs — ordered by REAL release date (`album.uploadDate`, dated via /player) newest
// first; undated albums fall back to their tracks' first-indexed time and sort below. Powers the New
// Releases Albums/Singles chips. `releaseDate` = precise ISO when known. Carries artist flags.
export function recentAlbums(db, limit = 100) {
  return db.prepare(`
    SELECT al.id, al.playlistId, al.title, al.type, al.year, al.thumbnail, al.uploadDate, a.name AS artistName,
           a.isFemale, a.isChasid, a.isKidZone, MAX(t.harvestedAt) AS harvestedAt
    FROM album al
    JOIN album_track at ON at.albumId = al.id
    JOIN track t ON t.videoId = at.videoId
    JOIN artist a ON a.id = al.artistId
    WHERE t.harvestedAt IS NOT NULL
    GROUP BY al.id
    ORDER BY (al.uploadDate IS NULL), al.uploadDate DESC, MAX(t.harvestedAt) DESC, al.id
    LIMIT ?`).all(Math.max(1, limit | 0))
    .map((r) => ({ id: r.id, playlistId: r.playlistId, title: r.title, artist: r.artistName, type: r.type,
      year: r.year, thumbnail: r.thumbnail, releaseDate: r.uploadDate || null,
      addedAt: r.uploadDate ? Date.parse(r.uploadDate) : r.harvestedAt,
      isFemale: !!r.isFemale, isChasid: !!r.isChasid, isKidZone: !!r.isKidZone }));
}

// Releases that still need a precise date but have a sample track we can /player-date. Recent first
// (year desc); pass minYear to restrict to recent releases (what New Releases actually needs dated).
export function albumsNeedingDate(db, { minYear = 0, limit = 100000 } = {}) {
  return db.prepare(`
    SELECT al.id, al.title, al.year,
           (SELECT videoId FROM album_track WHERE albumId = al.id ORDER BY pos LIMIT 1) AS sampleVideoId
    FROM album al
    WHERE al.uploadDate IS NULL AND (al.year IS NULL OR al.year >= ?)
    ORDER BY (al.type='single'), (al.year IS NULL), al.year DESC, al.id
    LIMIT ?`).all(minYear, Math.max(1, limit | 0))
    .filter((r) => r.sampleVideoId);
}
export const setAlbumUploadDate = (db, id, uploadDate) =>
  db.prepare("UPDATE album SET uploadDate=? WHERE id=?").run(uploadDate, id).changes;
export const datedAlbumCount = (db) =>
  db.prepare("SELECT COUNT(*) c FROM album WHERE uploadDate IS NOT NULL").get().c;

// Tracks whose OWN date matters and is obtainable: STANDALONE tracks (no album to inherit from) and VIDEOS
// (a music video is a real upload — its date is its own, not necessarily the album's). Album AUDIO tracks are
// SKIPPED: they're overwhelmingly YouTube Music "art tracks" with no /player date at all (~85%), and they
// correctly inherit their album's real date via COALESCE(track.uploadDate, album.uploadDate). Dating them
// would be mostly wasted no-date /player calls. So: precise own-date where it exists + matters; accurate
// album date otherwise. album.uploadDate remains the album-level date.
export function tracksNeedingDate(db, { limit = 100000 } = {}) {
  return db.prepare(`
    SELECT t.videoId, t.title
    FROM track t
    WHERE t.uploadDate IS NULL
      AND (t.isVideo = 1 OR NOT EXISTS (SELECT 1 FROM album_track at WHERE at.videoId = t.videoId))
    ORDER BY (t.harvestedAt IS NULL), t.harvestedAt DESC, t.videoId
    LIMIT ?`).all(Math.max(1, limit | 0));
}
export const setTrackUploadDate = (db, videoId, uploadDate) =>
  db.prepare("UPDATE track SET uploadDate=? WHERE videoId=?").run(uploadDate, videoId).changes;
export const datedTrackCount = (db) =>
  db.prepare("SELECT COUNT(*) c FROM track WHERE uploadDate IS NOT NULL").get().c;

export const harvestedArtistIds = (db) => db.prepare("SELECT DISTINCT artistId FROM track").all().map((r) => r.artistId);
// Every artist that has a row (incl. 0-track ones) — used by onboarding to skip already-known artists.
export const existingArtistIds = (db) => db.prepare("SELECT id FROM artist").all().map((r) => r.id);

// Pure planning + SAFETY check for a prune. Returns which current artists would be dropped and whether
// it's safe to do so: a prune is refused unless at least `minRatio` of the CURRENT corpus artists survive
// (are still whitelisted). Comparing survivors (corpus ∩ keep) — not the raw whitelist size — means a
// plausibly-sized but disjoint/wrong whitelist can't pass the guard and wipe everything. `minRatio` is
// validated here (NaN / out-of-range → 0.5) so a bad env value can't silently defeat the guard.
export function prunePlan(corpusIds, keepIds, minRatio = 0.5) {
  const keep = keepIds instanceof Set ? keepIds : new Set(keepIds);
  let r = Number(minRatio);
  if (!Number.isFinite(r) || r < 0 || r > 1) r = 0.5;
  const before = corpusIds.length;
  const dropIds = corpusIds.filter((id) => !keep.has(id));
  const survivors = before - dropIds.length;
  const safe = before === 0 || survivors >= before * r;
  return { before, survivors, toRemove: dropIds.length, dropIds, minRatio: r, safe };
}

// Remove every artist whose id is NOT in keepIds, plus all their tracks/albums/playlists/album_tracks,
// in ONE transaction. Maintenance uses this to drop artists removed from the whitelist — content-safety:
// a de-whitelisted artist must stop being searchable. Children are deleted before the artist row so the
// foreign keys stay satisfied. Returns { artists, ids }. (The CALLER must guard against an empty/broken
// whitelist — passing a tiny keep set would wipe the corpus; see harvester/prune.mjs.)
export function pruneArtists(db, keepIds) {
  const keep = keepIds instanceof Set ? keepIds : new Set(keepIds);
  const drop = db.prepare("SELECT id FROM artist").all().map((r) => r.id).filter((id) => !keep.has(id));
  if (!drop.length) return { artists: 0, ids: [] };
  const delAlbumTracks = db.prepare("DELETE FROM album_track WHERE albumId IN (SELECT id FROM album WHERE artistId=?)");
  const delTracks = db.prepare("DELETE FROM track WHERE artistId=?");
  const delAlbums = db.prepare("DELETE FROM album WHERE artistId=?");
  const delPlaylists = db.prepare("DELETE FROM playlist WHERE artistId=?");
  const delArtist = db.prepare("DELETE FROM artist WHERE id=?");
  const tx = db.transaction((ids) => {
    for (const id of ids) { delAlbumTracks.run(id); delTracks.run(id); delAlbums.run(id); delPlaylists.run(id); delArtist.run(id); }
  });
  tx(drop);
  return { artists: drop.length, ids: drop };
}

// Delete blocklisted videoIds (+ blocklisted artists and all their rows) from the corpus — the cleanup
// that complements upsertArtistCatalog's skip (which keeps them out going forward). One transaction.
export function pruneBlocklisted(db, bl = blocklist()) {
  let tracks = 0, artists = 0, playlists = 0;
  const tx = db.transaction(() => {
    for (const vid of bl.videoIds) {
      db.prepare("DELETE FROM album_track WHERE videoId=?").run(vid);
      db.prepare("DELETE FROM community_playlist_track WHERE videoId=?").run(vid);
      tracks += db.prepare("DELETE FROM track WHERE videoId=?").run(vid).changes;
    }
    // Re-sync community playlists' whitelisted counts to their (now blocklist-pruned) membership.
    if (bl.videoIds.size)
      db.prepare(`UPDATE community_playlist SET whitelisted =
        (SELECT COUNT(*) FROM community_playlist_track WHERE playlistId = community_playlist.id)`).run();
    for (const pid of (bl.playlistIds || [])) { // remove explicitly-blocklisted community playlists
      db.prepare("DELETE FROM community_playlist_track WHERE playlistId=?").run(pid);
      playlists += db.prepare("DELETE FROM community_playlist WHERE id=?").run(pid).changes;
    }
    for (const id of bl.artistIds) {
      if (!db.prepare("SELECT 1 FROM artist WHERE id=?").get(id)) continue;
      db.prepare("DELETE FROM album_track WHERE albumId IN (SELECT id FROM album WHERE artistId=?)").run(id);
      db.prepare("DELETE FROM track WHERE artistId=?").run(id);
      db.prepare("DELETE FROM album WHERE artistId=?").run(id);
      db.prepare("DELETE FROM playlist WHERE artistId=?").run(id);
      db.prepare("DELETE FROM artist WHERE id=?").run(id);
      artists++;
    }
  });
  tx();
  return { tracks, artists, playlists };
}
export const stats = (db) => ({
  tracks: db.prepare("SELECT COUNT(*) c FROM track").get().c,
  artists: db.prepare("SELECT COUNT(*) c FROM artist").get().c,
  videos: db.prepare("SELECT COUNT(*) c FROM track WHERE isVideo=1").get().c,
  albums: db.prepare("SELECT COUNT(*) c FROM album WHERE type!='single'").get().c,
  singles: db.prepare("SELECT COUNT(*) c FROM album WHERE type='single'").get().c,
  playlists: db.prepare("SELECT COUNT(*) c FROM playlist").get().c,
  communityPlaylists: db.prepare("SELECT COUNT(*) c FROM community_playlist").get().c,
  zemerPlaylists: db.prepare("SELECT COUNT(*) c FROM zemer_playlist").get().c,
});
