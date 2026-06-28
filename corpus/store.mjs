// SQLite corpus store — the durable source-of-truth for the harvested catalog (replaces the prototype
// tracks.json). Normalized: artist holds the per-artist content flags; track/album/playlist reference it.
// WAL mode for durable, concurrent reads. The harvester upserts ONE artist's whole catalog per
// transaction, so a long harvest checkpoints continuously (crash/kill safe) instead of only at the end.
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Env-configurable so it deploys to a server unchanged (CORPUS_DB=/var/lib/zemer-search/corpus.db).
export const DB_PATH = process.env.CORPUS_DB || path.resolve(HERE, "../data/corpus.db");

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
  const { tracks = [], albums = [], playlists = [], albumTracks = [], thumbnail = null, regularChannelId = null } = catalog;
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

export const harvestedArtistIds = (db) => db.prepare("SELECT DISTINCT artistId FROM track").all().map((r) => r.artistId);
export const stats = (db) => ({
  tracks: db.prepare("SELECT COUNT(*) c FROM track").get().c,
  artists: db.prepare("SELECT COUNT(*) c FROM artist").get().c,
  videos: db.prepare("SELECT COUNT(*) c FROM track WHERE isVideo=1").get().c,
  albums: db.prepare("SELECT COUNT(*) c FROM album WHERE type!='single'").get().c,
  singles: db.prepare("SELECT COUNT(*) c FROM album WHERE type='single'").get().c,
  playlists: db.prepare("SELECT COUNT(*) c FROM playlist").get().c,
});
