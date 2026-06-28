# Server API & Web UI

`server/api.mjs` (HTTP + cluster + cache) and `server/ui.html` (the web UI). Deployable as **one Node
process + one `corpus.db` file** — no external search engine.

## Endpoints

| Method/Path | Returns |
|-------------|---------|
| `GET /` | The web UI (`ui.html`). |
| `GET /search?q=…&allowFemale=0&kidZone=1&blockVideos=1&k=8` | Ranked, **category-grouped**, content-filtered results: `{q, count, categories:{artists, songs, albums, singles, videos, playlists}}`. |
| `GET /artist?id=UC…` | Artist catalog `{artist, songs, videos, albums, singles, playlists}` (from the DB). |
| `GET /album?id=MPRE…` | `{album, tracks}` (from the DB, ordered). |
| `GET /playlist?id=…` | `{playlist, tracks}` — fetched **on demand** (cached) from YouTube and filtered to whitelisted-corpus / whitelisted-channel tracks. |
| `GET /health` | Live `{tracks, artists, videos, albums, singles, playlists, indexed, whitelistTotal, worker}`. |
| `POST /reload` | Rebuild the in-memory index now. |

Content-filter query params map to `searchCategories` options; the API always passes **explicit
booleans** (e.g. `allowFemale = param !== "0"`), so defaults are well-defined.

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
  · Videos · Playlists. The chip filters the displayed category **client-side from the already-fetched
  data** (no refetch on chip change).
- A single **Material 3 switch** — "Hide female singers" — the only on-screen content filter (sets
  `allowFemale=0`); **videos and KidZone content are included by default**.
- **Minimum 3 characters** before any results appear — 1–2 char queries are too broad to rank accurately.
- App-style 64dp rows: 48dp thumbnail (circle for artists), `titleSmall`/`bodySmall`, `⋮` overflow.
- **Detail pages** for artist/album/playlist; the **artist page has its own category chips** (All ·
  Albums · Singles & EPs · Songs · Videos · Playlists — only the non-empty ones).
- A **live indicator** (pulsing dot + numbers flash green on growth + "harvesting X/Y artists … updating
  live") so it's obvious the corpus is growing without refreshing.
- **As-you-type speed:** debounced + an **AbortController** cancels the previous in-flight request on
  every keystroke (no wasted server work, no stale results), system font (no web-font fetch).

## Env config

`PORT` (7700), `WORKERS` (1 | a number | `auto`), `RELOAD_MS` (30000), `CACHE_MAX` (5000), `CORPUS_DB`,
`REL_FLOOR` (matcher precision floor, 0.4). See [deployment.md](deployment.md).
(The `/playlist` endpoint does a live **unauthenticated** browse — no cookie.)
