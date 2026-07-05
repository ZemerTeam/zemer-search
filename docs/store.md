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
  isVideo INTEGER, explicit INTEGER, harvestedAt INTEGER,
  durationSec INTEGER,           -- track length (from album-page fixed columns); NULL until known
  playCount INTEGER,             -- landing "Songs"-shelf play count; NULL for tracks YT shows no stats for
  uploadDate TEXT                -- REAL per-track release date (ISO) — one /player on the track itself, for
)                                --   VIDEOS + STANDALONE tracks (album audio tracks inherit the album date); NULL until dated
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

-- Zemer-CURATED playlists — hand-picked categories of songs/albums ("Shabbos", "Upbeat", …), authored in
-- data/zemer-playlists.json and applied wholesale by harvester/zemer-playlists.mjs (the JSON is the source
-- of truth: removing a playlist from the file removes it here). Served by /zemer-playlists.
zemer_playlist (id TEXT PRIMARY KEY, title TEXT, pos INTEGER)   -- pos = display order = file order
zemer_playlist_item (
  playlistId TEXT, kind TEXT, refId TEXT,   -- kind 'track'|'album'; refId = videoId | album browseId
  pos INTEGER, PRIMARY KEY(playlistId, kind, refId)
)
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
>
> **Zemer-curated `album` items expand at READ time** (`zemer_playlist_item` kind `album` → its
> `album_track` members), so a re-harvested album's new tracks appear in the curated playlist without a
> re-apply. Only tracks present in the corpus are served (JOIN) — an id that isn't harvested yet is
> silently pending, never an error.

WAL mode (`journal_mode=WAL`, `synchronous=NORMAL`) → unlimited concurrent readers alongside the single
writer. Indexes on every `artistId` and `album_track.albumId`.

## Store API

| Function | Purpose |
|----------|---------|
| `openCorpus(file?)` | Open + create schema + run migrations (see below). |
| `upsertArtistCatalog(db, artist, catalog)` | **One transaction**: upsert the artist (+ thumbnail + regularChannelId) and *all* its tracks/albums/playlists/album_tracks. The durable per-artist checkpoint. |
| `allTracks/allArtists/allAlbums/allPlaylists(db)` | Denormalized rows the index/bench/subset consume (artist flags joined in). |
| `artistDetail(db, id, opts?)` | Artist page: `{artist, songs, videos, albums, singles, playlists}`. `opts` = `{allowFemale, kidZoneOnly, blockVideos}`: a female (when `allowFemale:false`) / non-KidZone (when `kidZoneOnly`) artist returns **`null`** (→ 404); `blockVideos` empties `videos`. Songs/videos carry `durationSec`+`playCount` and **`songs` are sorted by `playCount` desc** (real "Top songs"); album/single rows carry `type`+`trackCount`+`totalDurationSec`. |
| `albumDetail(db, id, opts?)` | Album page: `{album, tracks}` (ordered via `album_track.pos`). Same `opts`: female/non-KidZone artist → `null`; tracks filtered **per-track** (compilations). Tracks carry `durationSec`+`trackNumber`; the `album` header carries `type`+`trackCount`+`totalDurationSec` (FULL-album aggregates, so they match the `/artist` list row even when filters shorten `tracks`). |
| `tracksByIds(db, ids)` | Which of `ids` are whitelisted tracks we hold (chunked for the 999-var limit) — for playlist filtering. Each row carries `isVideo/isFemale/isKidZone` so `/playlist` filters per song. |
| `whitelistedChannelIds(db)` | Set of **music ids ∪ regular channel ids** — for playlist whitelisting. |
| `harvestedArtistIds(db)` | Distinct artist ids with tracks (refresh iterates these). |
| `recentTracks/recentAlbums(db)` | New Releases rows ordered by REAL release date newest-first — a track's date is `COALESCE(track.uploadDate, album.uploadDate)`: **prefer the track's OWN date** (100% accurate per song), fall back to the album's only if a track isn't individually dated; undated falls back to `harvestedAt`. Each carries `releaseDate` (ISO when known). |
| `albumsNeedingDate(db,{minYear})` / `setAlbumUploadDate` / `datedAlbumCount` | Albums (incl. singles/EPs) still lacking a date but with a sample track (album-type first, recent-year first) / store a date / count dated. The album-level date; the first phase of `harvester/releases.mjs`. |
| `tracksNeedingDate(db,{limit})` / `setTrackUploadDate` / `datedTrackCount` | Tracks whose own date matters + is obtainable — **VIDEOS + STANDALONE** tracks (no album) still lacking a date. **Album AUDIO tracks are skipped**: they were released *with* their album, so inheriting its real date via `COALESCE` is equally accurate at ~1 `/player` per album instead of per track. / store a date / count dated. The second phase of `harvester/releases.mjs`. |
| `upsertCommunityPlaylist(db, pl, whitelistedTracks)` | **One transaction**: upsert a community playlist + re-snapshot its whitelisted membership (drops blocklisted ids; re-check shrinks the set cleanly). |
| `allCommunityPlaylists(db)` | Community playlists shaped like the artist-playlist docs (`{id, title, artistName:"", author, thumbnail, source:"community", whitelisted, total}`) for the search index. Also carries `fb` (has a not-yet-in-corpus member → unknown flags) + `clsMask` (one bit per present `isFemale·isVideo·isKidZone` member class) so `searchCategories` can hide a playlist with no member surviving the filter. |
| `communityPlaylistList(db, limit, opts?)` | Browse-all list for `/community`. With a filter active (`opts`), hides playlists with **zero** surviving members (all-female list when female blocked, etc.), reduces `whitelisted` to the kept count, and takes the cover from a kept track. |
| `communityKeptCounts(db, ids, opts?)` | `Map(id → {kept, cover})` for the given community playlists — `kept` = post-filter track count (so `/search` shows the **same reduced count** as `/community`), `cover` = thumbnail of the first **surviving** member (so a filtered card never shows a dropped/female member's art). Returns `null` when no filter is active (caller keeps the stored full count + cover). |
| `loadBlockedIds()` | Reads `data/blocked-ids.json` → `{global:Set, female:Set}` (the fetched `blockedContentIds` id-overrides; see Gotcha #7). Read fresh each call (an index reload picks up a new fetch). Empty when the file is absent. |
| `communityPlaylistMeta(db, id)` / `communityPlaylistIds(db)` | Detail-header lookup for `/playlist`; the set of already-discovered ids (so a re-run skips them unless `RECHECK=1`). |
| `loadZemerPlaylists()` / `applyZemerPlaylists(db, doc, {dry})` | Read `data/zemer-playlists.json` (`ZEMER_PLAYLISTS` overrides) / REPLACE the `zemer_playlist` tables with it (one transaction; throws on a missing id/title or duplicate playlist id). Returns `{playlists, items, missing}` — `missing` = ids not (yet) in the corpus, curator typo feedback. `dry:true` validates without writing. |
| `zemerPlaylistList(db, opts?, dropId?)` | Browse-all curated list for `/zemer-playlists` (file order). Rows `{id, title, thumbnail, trackCount, totalDurationSec}` are **post-filter**: `opts` = the content flags, `dropId` = the server's blocked-ids predicate — a playlist with **zero** surviving members is hidden (gotcha #7) and count/runtime reflect what actually plays. The store-level `thumbnail` is the first **surviving** track's art (data-layer fallback), but the **endpoint replaces it** with the generated text-cover URL (`/zemer-playlists/cover?id=…`) — curated playlists never display album art. |
| `zemerPlaylistDetail(db, id, opts?, dropId?)` | One curated playlist: `{playlist, albums, tracks}` — `albums` = the curated albums as browsable rows (curated order; per-album `trackCount`/`totalDurationSec` cover only its members serving in this playlist, post-filter; zero-survivor albums omitted); `tracks` = direct track items in file order, `album` items expanded **in place** via `album_track` (a videoId reached twice appears once, first position wins). Tracks carry `title/artist/explicit/isVideo/durationSec/playCount/releaseDate` (dates via the usual `COALESCE(track.uploadDate, album.uploadDate)`) + **`fromAlbum`** (entered via an album expansion vs a direct pick; a both-ways videoId takes the kind owning its kept position). `null` for an unknown id **or** when every member is filtered out (the list hides it, so drill-in 404s too). |
| `stats(db)` | `{tracks, artists, videos, albums, singles, playlists, communityPlaylists, zemerPlaylists}` — the live `/health` numbers. |

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
- **Female filtering includes FEATURED females, via a per-connection `_female` set.** `openCorpus` creates an
  empty temp table `_female(videoId)`; `setFemaleSet(db, videoIds)` repopulates it (the server calls this at
  index reload with the female-involved videoIds computed by `index/credits.mjs` — primary OR a credited
  female). Every female SQL predicate ORs membership in `_female` onto the primary `isFemale`
  (`allCommunityPlaylists.clsMask`, the `communityPlaylistList`/`communityKeptCounts` keep clause,
  `artistDetail`/`albumDetail`/`tracksByIds`/`recentTracks`). An **empty `_female` = primary-only filtering**,
  so tests/benches (which don't call `setFemaleSet`) behave exactly as before — and the server's SQL paths
  then match `/search`'s in-memory `femaleInvolved` filter exactly.
- **Community member gender is known even for un-harvested members** via `community_playlist_track.artistId`
  (the member's resolved whitelisted artist, recorded at discovery). `clsMask`/`fb` and the keep clause read
  the member's gender from its corpus track's artist (`a`) when harvested, else from the resolved artist
  (`am`, by `artistId`) — so a member whose track isn't harvested (e.g. on the artist's regular channel) no
  longer "fails open" (an all-female list with one such member used to show then open empty). `fb` (true
  unknown → fail-open) is now only a member with neither a corpus track nor a resolved artist. NULL
  `artistId` = the old behavior, so it's a no-op until `harvester/backfill-community-artists.mjs` runs.
- **Curated id overrides** (`loadBlockedIds` → `data/blocked-ids.json`, fetched from Firestore
  `blockedContentIds` by `harness/blocked-ids.mjs`): a flat id list (matched against a result's
  videoId/playlistId/channelId/browseId) — `global` ids dropped for everyone, `female` only when female is
  blocked. Applied **serve-time** by `searchCategories` (`cats.blocked`) + the API's `idDropped` on
  `/community` `/playlist` `/artist` `/album`; `female` videoIds also merge into the `_female` set. Pure
  filter — **no backfill, no corpus change**; empty list is a no-op. The curated patch for what auto-detection
  misses (Gotcha #7), e.g. a women's playlist surviving on one token male track (add its playlistId as `female`).
- **Track detail metadata** (`track.durationSec`, `track.playCount`) is extracted from the already-cached
  browse rows (album-page fixed columns → duration; landing "Songs"-shelf "N plays" → playCount). The harvest
  captures both (`core.mjs` merges them across shelves — duration lives on the album page, plays on the
  landing shelf); `harvester/backfill-track-meta.mjs` populates existing rows offline (cache-only). Emitted by
  `allTracks`/`artistDetail`/`albumDetail`/`tracksByIds`; **`artistDetail` sorts `songs` by `playCount` desc**
  (real "Top songs"), and `albumDetail` emits `trackNumber` (= `album_track.pos+1`). Both nullable = unknown
  (old behavior); measured 2026-07-01: durations **100%** (with the `/player` top-up), plays ~55% (only where
  YT shows them, never on videos).
- **Album aggregates** (`type`, `trackCount`, `totalDurationSec`) are computed at read time over `album_track`
  ∪ `track` — NO stored column. Emitted on `allAlbums` (→ `/search` album/single cards), `artistDetail` album
  rows, and the `albumDetail` header (the header count/runtime describe the FULL album, so they match the
  `/artist` list row even when content filters shorten the returned `tracks`). Lets the app label
  "Album · 12 songs · 47 min" without a second call.
- **`tracksByIds` chunks** the `IN (…)` to ≤ 500 ids per statement (SQLite's bound-variable limit).
- The DB is read **concurrently** by the API (a persistent WAL reader) while the harvester writes —
  that's exactly what WAL is for. The API sees the harvester's latest committed per-artist upserts.
