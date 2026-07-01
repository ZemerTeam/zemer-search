# Server API & Web UI

`server/api.mjs` (HTTP + cluster + cache) and `server/ui.html` (the web UI). Deployable as **one Node
process + one `corpus.db` file** — no external search engine.

## Endpoints

| Method/Path | Returns |
|-------------|---------|
| `GET /` | The web UI (`ui.html`). |
| `GET /search?q=…&allowFemale=0&kidZone=1&blockVideos=1&k=8` | Ranked, **category-grouped**, content-filtered results: `{q, count, categories:{artists, songs, albums, singles, videos, playlists}}`. The `playlists` category includes both artist-owned **and** community-discovered playlists (each row carries `source: "artist"\|"community"`). Song/video rows also carry `durationSec` + `playCount` (nullable). **Detail metadata:** `/artist` `songs`/`videos` carry `durationSec`+`playCount` and `songs` are sorted by `playCount` desc (real "Top songs"); `/album` `tracks` carry `durationSec`+`trackNumber`; `/playlist` `tracks` carry `durationSec`. **Album objects** (album/single rows in `/search` + `/artist`, and the `/album` header) carry `type` (album/single/ep), `trackCount`, `totalDurationSec` — read-time aggregates over `album_track`∪`track` (no stored column). Extracted from cache (no new fetches) — nullable where unknown. |
| `GET /artist?id=UC…&allowFemale=0&kidZone=1&blockVideos=1` | Artist catalog `{artist, songs, videos, albums, singles, playlists}` (from the DB). Honors the content-filter flags: a female artist (`allowFemale=0`) or a non-KidZone artist (`kidZone=1`) returns **404** (treated as not-found); `blockVideos` empties the `videos` category. Songs/videos carry `durationSec`+`playCount` and **`songs` are sorted by `playCount` desc** (real "Top songs"); album/single rows carry `type`+`trackCount`+`totalDurationSec`. |
| `GET /album?id=MPRE…&allowFemale=0&kidZone=1&blockVideos=1` | `{album, tracks}` (from the DB, ordered). Honors the flags: a female/non-KidZone artist's album → **404**; `blockVideos` drops video tracks; filtered **per track** so a mixed compilation keeps only allowed tracks. Tracks carry `durationSec`+`trackNumber`; the `album` header carries `type`+`trackCount`+`totalDurationSec` (full-album aggregates). |
| `GET /playlist?id=…&allowFemale=0&kidZone=1&blockVideos=1` | `{playlist, tracks, total, whitelisted}` — fetched **on demand** (cached) from YouTube and filtered to whitelisted-corpus / whitelisted-channel tracks. Works for **any** playlist id: artist-owned, community-discovered, or even an unindexed id (the filter is purely id-based, so it can never serve a non-whitelisted track). The header meta falls back to `community_playlist` when the id isn't an artist playlist. The content-filter flags are applied **per song** — a mixed (e.g. male+female) playlist keeps the allowed songs and drops only the filtered ones; it is **never** blocked wholesale (an all-female list just opens empty for a blocked-female user). Tracks carry `durationSec`. |
| `GET /new?k=60&days=10&allowFemale=0&kidZone=1&blockVideos=1` | `{count, categories:{songs, videos, albums, singles}, source}` — recent releases with REAL release dates, **within the window** (`days`, default 10), newest first; each item carries `releaseDate` (ISO) + `addedAt` (+ `durationSec` where known). **Primary source = the releases feed** (`RELEASES_FEED`, real `/player` dates maintained off-datacenter, same Firestore whitelist) → `source:"feed"`; filtered by our corpus' artist content-flags. If the feed is unreachable it **falls back to corpus** `recentAlbums`/`recentTracks` (real `album.uploadDate` where dated, else `harvestedAt`) → `source:"corpus"`. The web UI labels feed-sourced results ("Pulled from … latest-releases feed"). Not LRU-cached (the feed has its own ~5-min TTL). Same content-filter params as `/search`. |
| `GET /community?allowFemale=0&kidZone=1&blockVideos=1` | `{count, playlists}` — community-discovered playlists (no cap by default; `k` is just a sanity bound), best-populated first (`whitelisted` desc). Powers the **Community** chip's "show all without a search" browse view. Each row `{id, title, artist (curator), thumbnail (from a whitelisted track), source:"community", whitelisted, total}`. **Honors the content flags:** a playlist is shown only if ≥1 of its whitelisted tracks survives the filter — so an **all-female list is hidden when female is blocked** (an all-video list when videos are blocked, etc.); a **mixed** list still shows, with `whitelisted` reduced to the kept count and the cover taken from a kept track. |
| `GET /health` | Live `{tracks, artists, videos, albums, singles, playlists, communityPlaylists, indexed, whitelistTotal, worker, maintenance}`. `maintenance` is `{phase, mode, done, total, pct, newTracks, blocks}` while a harvest/refresh/**playlist-discovery** run is active (written to `data/.maintain-status.json` by the harvester steps; `null`/absent once a run stops updating). `whitelistTotal` is re-read each reload so it isn't stale after a whitelist refetch. |
| `POST /reload` | Rebuild the in-memory index now. |

### Content-filter flags (the app forwards the user's Firebase settings)

Every result-bearing endpoint accepts the same three flags, applied uniformly so nothing leaks on
drill-in (`contentFlags()` in `api.mjs`):

| Flag | Sense | Effect |
|------|-------|--------|
| `allowFemale=0` | allow (omit/`1` = allow) | drop female artists, and their songs inside albums/playlists |
| `blockVideos=1` | block (omit/`0` = allow) | drop video tracks / empty the `videos` category |
| `kidZone=1` | mode (omit/`0` = off) | restrict to KidZone artists only |

- **Default-OPEN:** an **absent** flag = no filtering, so the web demo and other callers get the full
  catalog (gotcha #7). **The app must send all three explicitly** for a restricted user and should
  **fail closed** (never omit one). Polarity is mixed by design (`allowFemale` vs `blockVideos`) — send the
  right sense. The API passes explicit booleans through, so defaults are well-defined.
- **Where applied:** `/search`, `/new`, `/artist`, `/album`, `/playlist`, `/community`. Artist/album detail
  return **404** when the whole artist is filtered; album/playlist additionally filter **per track**, so a
  mixed playlist keeps its allowed songs and drops only the filtered ones — never blocked wholesale.
- **Community playlists** — in **both** the `/community` browse list **and** the `community` category of
  `/search` — hide any playlist with **zero** members surviving the filter: an **all-female list is hidden
  when female is blocked** (it would open empty), an all-video list when videos are blocked, a non-KidZone
  list in KidZone mode. The survival test is **exact** including conjunctions (female+video blocked hides a
  list whose only non-female tracks are videos). A **mixed** list still shows, and its `whitelisted` count
  is **reduced to the post-filter total in BOTH `/community` and `/search`** (so the number matches what
  actually plays — e.g. a mixed list shows `67` unfiltered, `62` with `allowFemale=0`, identical on both
  endpoints). **Both** `/community` and `/search` take the cover from the first **surviving** member (so a
  filtered card never shows a dropped/female member's art — `communityKeptCounts` returns `{kept, cover}`).
  Survival is computed from a compact per-playlist class bitmask carried in the in-memory index for `/search`
  (no per-query DB hit) and a direct query for `/community`; the reduced `/search` count comes from
  `communityKeptCounts`. A community playlist that is itself **a female artist's own playlist** (`femaleOwned`:
  its id matches a female-owned artist playlist, or its curator is a known female artist) is hidden under
  `allowFemale=0` **regardless of member survival** — so it can't stay visible on a male collab track.
- **Curated id overrides** (`blockedContentIds` → `data/blocked-ids.json`, fetched by `harness/blocked-ids.mjs`):
  a flat id list mirroring the app — `global` ids dropped for everyone, `female` ids when female is blocked,
  matched against a result's `videoId`/`playlistId`/`channelId`/`browseId`. Applied serve-time on **every**
  endpoint: `/search` (every category), `/community`, `/playlist`, `/artist`, `/album`, `/new`. The curated
  patch for what auto-detection can't catch (a women's playlist surviving on one token male track → add its
  **playlistId** as `female`). Refreshed ~every 10 min (the `zemer-overrides` timer; writes only on a real
  change, so unchanged fetches don't reload); the API re-applies
  it on its next reload tick (no restart). **No backfill** — pure filter; empty list is a no-op.
- **Defense-in-depth:** the app should also drop any `isVideo`/female item it receives. One edge: a
  playlist track on a whitelisted channel but **not yet in the corpus** has an unknown `isVideo`, so
  `blockVideos` can't catch it server-side (female/KidZone still filter via the artist) — the client
  backstop covers that case.

## Scaling to thousands of concurrent users

Three mechanisms, all in `api.mjs`:

1. **In-memory index** — search never touches SQLite; it's RAM lookups (~2–5 ms). The hot path is
   CPU-bound, not IO-bound.
2. **LRU query cache** (`CACHE_MAX`, default 5000) — as-you-type hammers the same prefixes (users share
   them), so identical queries return instantly. **Cleared on every index reload** → never stale beyond
   one cycle. Covers `/search`, `/artist`, `/album`, `/playlist`. (`/health` is live, not cached.)
3. **Multi-core cluster** (`WORKERS=auto` → one per core; default 1 for dev). Node is single-threaded;
   the cluster forks workers and the OS load-balances connections. Each worker holds its own in-memory
   index (the corpus is small). Reloads are **staggered** across workers so they don't all stall during a
   rebuild.

Horizontally scalable beyond one box: stateless + read-only DB → ship `corpus.db` to each node, refresh
periodically; no central DB bottleneck.

**Measured** (`npm run loadtest`, 0 errors): **~9,000 req/s cached** (server isn't the bottleneck, the
load generator is) · **uncached worst case 312 req/s per core → ~1,800 on 8 cores** (near-linear). On a
16-core box that's thousands of concurrent users comfortably, more with the cache (high hit rate for
as-you-type).

## The Web UI (`server/ui.html`)

Self-contained HTML/CSS/JS that **mirrors the app's search screen** (Material 3, seed `#ED5564`, the
exact dark surfaces/typography from `zemer-app`'s `Theme.kt`/`Dimensions.kt`):

- A pill **search bar** + horizontal **filter-chip row**: All · Artists · Albums · Songs · Singles & EPs
  · Videos · Playlists · **Community** · **New Releases** (last). The category chips filter the displayed
  results **client-side from the already-fetched** search data (no refetch on chip change). **Playlists**
  is artist-owned playlists; **Community** is community-curated playlists (own ranked slot). The Community
  chip also **browses all without a search** — with an empty box it fetches `/community` and lists every
  community playlist (best-populated first); typing a query filters it via the search `community` category.
  **New Releases** is a browse view (no query needed) — it fetches `/new` and shows recently-added releases
  with **its own category sub-chips** (Songs · Videos · Albums · Singles & EPs; empty ones hidden) and an
  "added Xd ago" date per row; typing a query leaves it back into search. (True upload dates would need a per-track
  `/player` fetch — a planned follow-up; today it shows when the track was indexed.)
- **Detail metadata is rendered inline** — song rows show a right-aligned **duration** (`4:45`) and a
  **play count** in the subtitle (`21M plays`); album/single rows show `Album · 15 songs · 26 min`
  (type · count · runtime); the **album detail** view shows a numbered tracklist with per-track durations
  and a header runtime; New Releases rows show durations too. All null-tolerant (a missing value renders
  nothing), via the `fmtDur`/`fmtRuntime`/`fmtPlays` helpers.
- **No on-screen content filters** — the web UI always shows everything (never sends `allowFemale`/
  `kidZone`/`blockVideos`). The API still honors those query params for other callers (gotcha #7).
- **Minimum 3 characters** before any results appear — 1–2 char queries are too broad to rank accurately.
- App-style 64dp rows: 48dp thumbnail (circle for artists), `titleSmall`/`bodySmall`, `⋮` overflow.
  Tapping a **song** opens a Material-3 "Download the app to listen" dialog (link to `ghtrack.zemer.io/download`) —
  playback is in the app, not the browser; it does **not** link out to YouTube Music.
- **Detail pages** for artist/album/playlist; the **artist page has its own category chips** (All ·
  Albums · Singles & EPs · Songs · Videos · Playlists — only the non-empty ones).
- A **live indicator** (pulsing dot + numbers flash green on growth + "harvesting X/Y artists … updating
  live") so it's obvious the corpus is growing without refreshing.
- A **maintenance/refresh progress bar** (spinner + "Refreshing catalog — N / total · pct% · +N new" + a
  thin progress bar) shown from `/health.maintenance` while a harvest/refresh run is active, and
  auto-hiding when idle. Same M3 surfaces as the rest of the UI. It also covers **community-playlist
  discovery** ("Discovering community playlists (discover|check) — N / total"), so a `npm run playlists`
  run shows live progress in the UI just like a refresh.
- **As-you-type speed:** debounced + an **AbortController** cancels the previous in-flight request on
  every keystroke (no wasted server work, no stale results), system font (no web-font fetch).
- **Embed mode:** loading with `?embed=1` adds `class="embed"` to `<html>` and hides the live-corpus stats
  line — for embedding the search UI inside zemer.io.

## Env config

`PORT` (7700), `HOST` (`0.0.0.0`; set `127.0.0.1` in production behind a reverse proxy / Cloudflare tunnel
so the port isn't exposed), `WORKERS` (1 | a number | `auto`), `RELOAD_MS` (30000), `CACHE_MAX` (5000),
`CORPUS_DB`, `REL_FLOOR` (matcher precision floor, 0.4), `RELEASES_FEED` (New Releases feed URL),
`FEED_TTL_MS` (feed cache, 300000). See [deployment.md](deployment.md).
(The `/playlist` endpoint does a live **unauthenticated** browse — no cookie.)

**Reload is change-gated:** the `RELOAD_MS` tick only rebuilds the in-memory index when `corpus.db`
(or its `-wal`) actually changed (mtime/size) — so a steady server never pays the rebuild stall; it picks
up a freshly-synced corpus within one tick. `POST /reload` forces a rebuild. With `WORKERS>1`, rebuilds are
staggered across workers so a rebuild never stalls serving.
