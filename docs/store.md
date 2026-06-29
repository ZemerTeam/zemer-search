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
  year INTEGER, thumbnail TEXT,
  uploadDate TEXT                -- REAL release date (ISO-8601), dated via one /player on a sample track; NULL until dated
)
playlist (id TEXT PRIMARY KEY, title TEXT, artistId TEXT REFERENCES artist(id), thumbnail TEXT)
album_track (albumId TEXT, videoId TEXT, pos INTEGER, PRIMARY KEY(albumId, videoId))  -- album → tracks

-- Community playlists (PILOT) — YTM playlists curated by community members, NOT owned by a whitelisted
-- artist. Separate tables so the artist-owned `playlist` table is untouched and the pilot is reversible.
community_playlist (
  id TEXT PRIMARY KEY,             -- playlistId (no VL prefix)
  title TEXT, author TEXT,         -- curator display name (free text; not a whitelisted artist)
  thumbnail TEXT,
  total INTEGER, whitelisted INTEGER,   -- discovery-time counts (tracks on YTM / of those, whitelisted)
  discoveredAt INTEGER
)
community_playlist_track (playlistId TEXT, videoId TEXT, pos INTEGER, PRIMARY KEY(playlistId, videoId))
```

> **Purity is NOT enforced in these tables — it's enforced at SERVE time.** Opening any playlist hits
> `/playlist`, which re-fetches the playlist live and keeps only whitelisted tracks (`tracksByIds` ∪
> `whitelistedChannelIds`). So a community playlist can only ever render whitelisted tracks, regardless of
> what else it holds. `whitelisted`/`total` + `community_playlist_track` are the matched subset captured at
> discovery, powering search/index, the displayed "X of Y" counts, and the pilot yield report. See
> [harvester.md](harvester.md#community-playlists-pilot).
>
> **Metadata is user-generated, so it's hardened too:** the displayed **cover is derived from a whitelisted
> track** (`allCommunityPlaylists`/`communityPlaylistList`/`communityPlaylistMeta` build the thumbnail from
> the first `community_playlist_track` videoId — NOT the stored curator cover, which can show non-whitelisted
> art). The **title/curator screen** + **playlist removal** live in `blocklist.json` (`playlistTerms`,
> `playlistIds`); `upsertCommunityPlaylist` refuses a blocklisted id and `pruneBlocklisted` deletes blocklisted
> playlists (+ strips blocklisted videoIds from membership, re-syncing counts).

WAL mode (`journal_mode=WAL`, `synchronous=NORMAL`) → unlimited concurrent readers alongside the single
writer. Indexes on every `artistId` and `album_track.albumId`.

## Store API

| Function | Purpose |
|----------|---------|
| `openCorpus(file?)` | Open + create schema + run migrations (see below). |
| `upsertArtistCatalog(db, artist, catalog)` | **One transaction**: upsert the artist (+ thumbnail + regularChannelId) and *all* its tracks/albums/playlists/album_tracks. The durable per-artist checkpoint. |
| `allTracks/allArtists/allAlbums/allPlaylists(db)` | Denormalized rows the index/bench/subset consume (artist flags joined in). |
| `artistDetail(db, id, opts?)` | Artist page: `{artist, songs, videos, albums, singles, playlists}`. `opts` = `{allowFemale, kidZoneOnly, blockVideos}`: a female (when `allowFemale:false`) / non-KidZone (when `kidZoneOnly`) artist returns **`null`** (→ 404); `blockVideos` empties `videos`. |
| `albumDetail(db, id, opts?)` | Album page: `{album, tracks}` (ordered via `album_track.pos`). Same `opts`: female/non-KidZone artist → `null`; tracks filtered **per-track** (compilations). |
| `tracksByIds(db, ids)` | Which of `ids` are whitelisted tracks we hold (chunked for the 999-var limit) — for playlist filtering. Each row carries `isVideo/isFemale/isKidZone` so `/playlist` filters per song. |
| `whitelistedChannelIds(db)` | Set of **music ids ∪ regular channel ids** — for playlist whitelisting. |
| `harvestedArtistIds(db)` | Distinct artist ids with tracks (refresh iterates these). |
| `recentTracks/recentAlbums(db)` | New Releases rows ordered by REAL release date (`album.uploadDate`; a track inherits its album's) newest-first, undated falling back to `harvestedAt` below. Each carries `releaseDate` (ISO when known). |
| `albumsNeedingDate(db,{minYear})` / `setAlbumUploadDate` / `datedAlbumCount` | Releases still lacking a date but with a sample track (album-type first, recent-year first) / store a date / count dated. Powers `harvester/releases.mjs`. |
| `upsertCommunityPlaylist(db, pl, whitelistedTracks)` | **One transaction**: upsert a community playlist + re-snapshot its whitelisted membership (drops blocklisted ids; re-check shrinks the set cleanly). |
| `allCommunityPlaylists(db)` | Community playlists shaped like the artist-playlist docs (`{id, title, artistName:"", author, thumbnail, source:"community", whitelisted, total}`) for the search index. Also carries `fb` (has a not-yet-in-corpus member → unknown flags) + `clsMask` (one bit per present `isFemale·isVideo·isKidZone` member class) so `searchCategories` can hide a playlist with no member surviving the filter. |
| `communityPlaylistList(db, limit, opts?)` | Browse-all list for `/community`. With a filter active (`opts`), hides playlists with **zero** surviving members (all-female list when female blocked, etc.), reduces `whitelisted` to the kept count, and takes the cover from a kept track. |
| `communityKeptCounts(db, ids, opts?)` | `Map(id → post-filter track count)` for the given community playlists, so `/search` shows the **same reduced count** as `/community`. Returns `null` when no filter is active (caller keeps the stored full count). |
| `communityPlaylistMeta(db, id)` / `communityPlaylistIds(db)` | Detail-header lookup for `/playlist`; the set of already-discovered ids (so a re-run skips them unless `RECHECK=1`). |
| `stats(db)` | `{tracks, artists, videos, albums, singles, playlists, communityPlaylists}` — the live `/health` numbers. |

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
- **Content filters apply on EVERY result function, not just `/search`.** `artistDetail`/`albumDetail` gate
  the whole artist (`null` → 404) and filter tracks; `communityPlaylistList`/`communityKeptCounts` (+
  `allCommunityPlaylists.clsMask/fb`) hide community playlists with **no** member surviving the filter (e.g.
  an all-female list when female is blocked) and report the **post-filter** count. **Default-OPEN**: an
  absent flag = no filtering (so callers that omit it get everyone — gotcha #7).
- **`tracksByIds` chunks** the `IN (…)` to ≤ 500 ids per statement (SQLite's bound-variable limit).
- The DB is read **concurrently** by the API (a persistent WAL reader) while the harvester writes —
  that's exactly what WAL is for. The API sees the harvester's latest committed per-artist upserts.
