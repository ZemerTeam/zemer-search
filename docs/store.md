# Corpus store (`corpus/store.mjs`)

The SQLite source-of-truth. **Server-side only** — never ships to a phone (no Android implications).
Built on `better-sqlite3` (synchronous, fast, file-backed). Path is env-configurable: `CORPUS_DB`
(default `data/corpus.db`).

## Schema

```sql
artist (
  id TEXT PRIMARY KEY,           -- YouTube MUSIC channel id (UC…), == whitelist id
  name TEXT, thumbnail TEXT,
  regularChannelId TEXT,         -- the artist's REGULAR upload channel (channel map; see harvester.md)
  isFemale INTEGER, isChasid INTEGER, isKidZone INTEGER   -- content-filter flags (denormalized to here)
)
track (
  videoId TEXT PRIMARY KEY, title TEXT, artistId TEXT REFERENCES artist(id),
  isVideo INTEGER, explicit INTEGER, harvestedAt INTEGER
)
album (
  id TEXT PRIMARY KEY,           -- album browseId (MPRE…)
  playlistId TEXT, title TEXT, artistId TEXT REFERENCES artist(id),
  type TEXT,                     -- 'album' | 'single' | 'ep'
  year INTEGER, thumbnail TEXT
)
playlist (id TEXT PRIMARY KEY, title TEXT, artistId TEXT REFERENCES artist(id), thumbnail TEXT)
album_track (albumId TEXT, videoId TEXT, pos INTEGER, PRIMARY KEY(albumId, videoId))  -- album → tracks
```

WAL mode (`journal_mode=WAL`, `synchronous=NORMAL`) → unlimited concurrent readers alongside the single
writer. Indexes on every `artistId` and `album_track.albumId`.

## Store API

| Function | Purpose |
|----------|---------|
| `openCorpus(file?)` | Open + create schema + run migrations (see below). |
| `upsertArtistCatalog(db, artist, catalog)` | **One transaction**: upsert the artist (+ thumbnail + regularChannelId) and *all* its tracks/albums/playlists/album_tracks. The durable per-artist checkpoint. |
| `allTracks/allArtists/allAlbums/allPlaylists(db)` | Denormalized rows the index/bench/subset consume (artist flags joined in). |
| `artistDetail(db, id)` | Artist page: `{artist, songs, videos, albums, singles, playlists}`. |
| `albumDetail(db, id)` | Album page: `{album, tracks}` (ordered via `album_track.pos`). |
| `tracksByIds(db, ids)` | Which of `ids` are whitelisted tracks we hold (chunked for the 999-var limit) — for playlist filtering. |
| `whitelistedChannelIds(db)` | Set of **music ids ∪ regular channel ids** — for playlist whitelisting. |
| `harvestedArtistIds(db)` | Distinct artist ids with tracks (refresh iterates these). |
| `stats(db)` | `{tracks, artists, videos, albums, singles, playlists}` — the live `/health` numbers. |

## Migrations & re-harvest

- **Additive column** → `openCorpus` runs a guarded `ALTER TABLE` (see `regularChannelId`: it checks
  `PRAGMA table_info` and adds the column if missing). New `CREATE TABLE IF NOT EXISTS` tables are safe.
- **Breaking schema change** → drop `corpus.db` (+ `-wal`/`-shm`) and re-harvest. **Re-harvest is free**:
  every fetched page is in the gzipped `net.mjs` cache, so the harvest replays the cache into the new
  schema with **0 live YouTube calls**.

## Gotchas

- **Whole mutation in ONE `db.transaction`.** `upsertArtistCatalog` writes the artist + all its rows
  atomically. Never split a row's writes across two operations.
- **Content flags live on `artist`** and are joined onto tracks/albums/playlists at read time
  (`allTracks` etc.). The search's content filter reads them off the denormalized result.
- **`tracksByIds` chunks** the `IN (…)` to ≤ 500 ids per statement (SQLite's bound-variable limit).
- The DB is read **concurrently** by the API (a persistent WAL reader) while the harvester writes —
  that's exactly what WAL is for. The API sees the harvester's latest committed per-artist upserts.
