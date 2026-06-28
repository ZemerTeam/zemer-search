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
  let v = [], a = [];
  try { const j = JSON.parse(fs.readFileSync(BLOCKLIST_PATH, "utf8")); v = j.videoIds || []; a = j.artistIds || []; }
  catch { /* no/invalid blocklist → empty */ }
  _blocklist = { videoIds: new Set(v), artistIds: new Set(a) };
  return _blocklist;
}

export function openCorpus(file = DB_PATH) {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
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
      thumbnail  TEXT
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
    CREATE INDEX IF NOT EXISTS idx_album_artist ON album(artistId);
    CREATE INDEX IF NOT EXISTS idx_playlist_artist ON playlist(artistId);
  `);
  // Migrate existing DBs (CREATE TABLE IF NOT EXISTS won't add a new column to an existing table).
  if (!db.prepare("PRAGMA table_info(artist)").all().some((c) => c.name === "regularChannelId"))
    db.exec("ALTER TABLE artist ADD COLUMN regularChannelId TEXT");
  return db;
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
    `INSERT INTO track(videoId,title,artistId,isVideo,explicit,harvestedAt) VALUES(@videoId,@title,@artistId,@isVideo,@explicit,@harvestedAt)
     ON CONFLICT(videoId) DO UPDATE SET title=excluded.title`);
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
    for (const t of tracks) insTrack.run({ videoId: t.videoId, title: t.title, artistId: artist.id, isVideo: t.isVideo ? 1 : 0, explicit: t.explicit ? 1 : 0, harvestedAt: ts });
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
           t.isVideo, t.explicit, a.isFemale, a.isChasid, a.isKidZone
    FROM track t JOIN artist a ON a.id = t.artistId
  `).all().map((r) => ({
    videoId: r.videoId, title: r.title, artistId: r.artistId, artistName: r.artistName,
    isVideo: !!r.isVideo, explicit: !!r.explicit, isFemale: !!r.isFemale, isChasid: !!r.isChasid, isKidZone: !!r.isKidZone,
  }));
}

export const allArtists = (db) => db.prepare(
  "SELECT id, name, thumbnail, isFemale, isChasid, isKidZone FROM artist WHERE name IS NOT NULL").all()
  .map((r) => ({ id: r.id, name: r.name, thumbnail: r.thumbnail, isFemale: !!r.isFemale, isChasid: !!r.isChasid, isKidZone: !!r.isKidZone }));

export const allAlbums = (db) => db.prepare(`
  SELECT al.id, al.playlistId, al.title, al.artistId, al.type, al.year, al.thumbnail,
         a.name AS artistName, a.isFemale, a.isChasid, a.isKidZone
  FROM album al JOIN artist a ON a.id = al.artistId`).all()
  .map((r) => ({ id: r.id, playlistId: r.playlistId, title: r.title, artistId: r.artistId, artistName: r.artistName, type: r.type, year: r.year, thumbnail: r.thumbnail, isFemale: !!r.isFemale, isChasid: !!r.isChasid, isKidZone: !!r.isKidZone }));

export const allPlaylists = (db) => db.prepare(`
  SELECT pl.id, pl.title, pl.artistId, pl.thumbnail, a.name AS artistName, a.isFemale, a.isChasid, a.isKidZone
  FROM playlist pl JOIN artist a ON a.id = pl.artistId`).all()
  .map((r) => ({ id: r.id, title: r.title, artistId: r.artistId, artistName: r.artistName, thumbnail: r.thumbnail, isFemale: !!r.isFemale, isChasid: !!r.isChasid, isKidZone: !!r.isKidZone }));

// Detail pages -----------------------------------------------------------------------------------
export function artistDetail(db, artistId) {
  const a = db.prepare("SELECT id,name,thumbnail FROM artist WHERE id=?").get(artistId);
  if (!a) return null;
  const trk = db.prepare("SELECT videoId,title,isVideo,explicit FROM track WHERE artistId=? ORDER BY harvestedAt").all(artistId);
  const alb = db.prepare("SELECT id,playlistId,title,type,year,thumbnail FROM album WHERE artistId=? ORDER BY (year IS NULL), year DESC").all(artistId);
  const pl = db.prepare("SELECT id,title,thumbnail FROM playlist WHERE artistId=?").all(artistId);
  const song = (t) => ({ videoId: t.videoId, title: t.title, explicit: !!t.explicit });
  const al = (x) => ({ id: x.id, playlistId: x.playlistId, title: x.title, artist: a.name, year: x.year, thumbnail: x.thumbnail });
  return {
    artist: { id: a.id, name: a.name, thumbnail: a.thumbnail },
    songs: trk.filter((t) => !t.isVideo).map(song),
    videos: trk.filter((t) => t.isVideo).map(song),
    albums: alb.filter((x) => x.type !== "single").map(al),
    singles: alb.filter((x) => x.type === "single").map(al),
    playlists: pl.map((p) => ({ id: p.id, title: p.title, artist: a.name, thumbnail: p.thumbnail })),
  };
}

export function albumDetail(db, albumId) {
  const al = db.prepare("SELECT al.id,al.title,al.year,al.thumbnail,a.name artistName FROM album al JOIN artist a ON a.id=al.artistId WHERE al.id=?").get(albumId);
  if (!al) return null;
  const tracks = db.prepare(`SELECT t.videoId,t.title,t.explicit,a.name artistName
    FROM album_track at JOIN track t ON t.videoId=at.videoId JOIN artist a ON a.id=t.artistId
    WHERE at.albumId=? ORDER BY at.pos`).all(albumId)
    .map((t) => ({ videoId: t.videoId, title: t.title, artist: t.artistName, explicit: !!t.explicit }));
  return { album: { id: al.id, title: al.title, year: al.year, thumbnail: al.thumbnail, artist: al.artistName }, tracks };
}

// Which of `ids` are whitelisted tracks we already hold (for playlist detail: a playlist may include
// non-whitelisted songs; we keep only the ones in the corpus). Returns videoId -> result row.
export function tracksByIds(db, ids) {
  const found = new Map();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = db.prepare(`SELECT t.videoId,t.title,t.explicit,a.name artistName
      FROM track t JOIN artist a ON a.id=t.artistId WHERE t.videoId IN (${chunk.map(() => "?").join(",")})`).all(...chunk);
    for (const r of rows) found.set(r.videoId, { videoId: r.videoId, title: r.title, artist: r.artistName, explicit: !!r.explicit });
  }
  return found;
}

// Every channel id that counts as a whitelisted artist: the music channel ids PLUS the mapped
// regular-upload channel ids (so a playlist's videos uploaded to the artist's regular channel verify).
export const whitelistedChannelIds = (db) => new Set([
  ...db.prepare("SELECT id FROM artist").all().map((r) => r.id),
  ...db.prepare("SELECT regularChannelId FROM artist WHERE regularChannelId IS NOT NULL").all().map((r) => r.regularChannelId),
]);

// Recently-added tracks, newest first — powers the "New Releases" view. `addedAt` is when we first
// indexed the track (harvestedAt), a proxy for release recency; true upload dates would need a per-track
// /player fetch (a follow-up). Carries the artist content flags so the API can apply the same filters.
export function recentTracks(db, limit = 100) {
  return db.prepare(`
    SELECT t.videoId, t.title, a.name AS artistName, t.isVideo, t.explicit, t.harvestedAt,
           a.isFemale, a.isChasid, a.isKidZone
    FROM track t JOIN artist a ON a.id = t.artistId
    WHERE t.harvestedAt IS NOT NULL
    ORDER BY t.harvestedAt DESC, t.videoId
    LIMIT ?`).all(Math.max(1, limit | 0))
    .map((r) => ({ videoId: r.videoId, title: r.title, artist: r.artistName, isVideo: !!r.isVideo,
      explicit: !!r.explicit, addedAt: r.harvestedAt,
      isFemale: !!r.isFemale, isChasid: !!r.isChasid, isKidZone: !!r.isKidZone }));
}

// Recent albums/singles/EPs — ordered by when their tracks were first indexed (a new release's tracks
// have a fresh harvestedAt; re-confirming an existing one doesn't touch it). Powers the New Releases
// Albums/Singles chips. Carries artist flags for the same content filtering.
export function recentAlbums(db, limit = 100) {
  return db.prepare(`
    SELECT al.id, al.playlistId, al.title, al.type, al.year, al.thumbnail, a.name AS artistName,
           a.isFemale, a.isChasid, a.isKidZone, MAX(t.harvestedAt) AS addedAt
    FROM album al
    JOIN album_track at ON at.albumId = al.id
    JOIN track t ON t.videoId = at.videoId
    JOIN artist a ON a.id = al.artistId
    WHERE t.harvestedAt IS NOT NULL
    GROUP BY al.id
    ORDER BY addedAt DESC, al.id
    LIMIT ?`).all(Math.max(1, limit | 0))
    .map((r) => ({ id: r.id, playlistId: r.playlistId, title: r.title, artist: r.artistName, type: r.type,
      year: r.year, thumbnail: r.thumbnail, addedAt: r.addedAt,
      isFemale: !!r.isFemale, isChasid: !!r.isChasid, isKidZone: !!r.isKidZone }));
}

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
  let tracks = 0, artists = 0;
  const tx = db.transaction(() => {
    for (const vid of bl.videoIds) {
      db.prepare("DELETE FROM album_track WHERE videoId=?").run(vid);
      tracks += db.prepare("DELETE FROM track WHERE videoId=?").run(vid).changes;
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
  return { tracks, artists };
}
export const stats = (db) => ({
  tracks: db.prepare("SELECT COUNT(*) c FROM track").get().c,
  artists: db.prepare("SELECT COUNT(*) c FROM artist").get().c,
  videos: db.prepare("SELECT COUNT(*) c FROM track WHERE isVideo=1").get().c,
  albums: db.prepare("SELECT COUNT(*) c FROM album WHERE type!='single'").get().c,
  singles: db.prepare("SELECT COUNT(*) c FROM album WHERE type='single'").get().c,
  playlists: db.prepare("SELECT COUNT(*) c FROM playlist").get().c,
});
