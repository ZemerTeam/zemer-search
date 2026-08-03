# zemer-search

A custom search engine for **Zemer** that searches a **pre-built index of only the whitelisted artists'
catalogs** instead of searching all of YouTube and filtering afterward. Accurate by construction (no
off-corpus noise), with **Hebrew-aware fuzzy matching** that YouTube and a SQL `LIKE` cannot do. It has
since grown into the corpus-native backend for most of the app's content surfaces (search, artist/album,
home rows, radio, stations, genres, curated + data-driven playlists, and podcasts), replacing InnerTube for
discovery while playback stays on YouTube.

> The sibling `zemer-app` repo is treated as **immutable**: code is *ported* from it, never edited. **All
> inputs are env-configurable** so this deploys to a real server unchanged (one Node process plus one DB
> file). Live at `search.zemer.io`.

## Architecture

**Hybrid, one search engine in two places:**

- **Server (primary):** harvest every whitelisted artist's complete catalog into a **SQLite** corpus store
  (`corpus.db`), then load an **in-memory index** behind the HTTP API. No Typesense, no Postgres: the corpus
  is small, so it lives in RAM, and the server is one Node process plus one SQLite file. The on-device
  matcher and the server matcher are the **same code**.
- **On-device (fallback):** a compact, gzipped, sharded subset feeds a **pure-Kotlin-portable in-memory
  index** (prototyped here in JS). It works offline or when the API is down. **No SQLite-FTS, no platform
  ICU**, so it behaves identically on Android API 26 to 36. (SQLite is used only *server-side* as the corpus
  store; it never ships to a phone, so it has no Android-version implications.)

### The fuzzy lever: a Hebrew-aware consonant skeleton

Hebrew is vowel-less, so we reduce both the indexed text **and** the query to a folded **consonant
skeleton**: romanize the strong consonants, drop the matres lectionis (א ה ו י ע) and Latin vowels, and fold
ambiguous pairs (b/v=ב, k/ch, p/f, s/sh, t/th, tz). A romanized query then aligns with the Hebrew title:
`kevakarat` to `kbkrt`, matching `כבקרת` to `kbkrt`. Pure string ops (`index/normalize.mjs`), plus Damerau
distance (a transposition counts as one edit) and synonym groups (abbreviations the skeleton cannot infer).
The matcher scales sub-linearly: prefixes via binary search, fuzzy via a boundary-padded **bigram candidate
index** (no full-vocab scan), giving sub-millisecond to low-ms searches depending on corpus size. A second
searchable name/title per script (`artist.altName` / `track.altTitle`) lifts cross-script recall further.

## What it serves

All content surfaces are **whitelist-pure** and apply the same content filters (`allowFemale`, `blockVideos`,
`kidZone`) plus a curated `blockedContentIds` pass:

- **Search** (`/search`): grouped by category (artists, songs, albums, singles, videos, artist playlists,
  community playlists, and podcasts + episodes), the way YouTube Music presents results.
- **Browse and drill-in** (`/artist`, `/album`, `/playlist`, `/new`): real release dates for New Releases,
  song durations and play counts, numbered album tracklists.
- **Community playlists** (`/community`): discovered YT Music playlists, kept whitelist-pure by serve-time
  filtering (never an admission gate), covers derived from a surviving member track.
- **Zemer Playlists** (`/zemer-playlists`): the hand-curated categories plus **data-driven `auto-*` charts**
  (Top 50, Trending, Favorites, Top Downloaded, Year-of, seasonal Acapella) generated from the `zemer-stats`
  telemetry server, with chart-movement badges (up/down, NEW, RE) anchored to a fixed weekly reference.
- **Genres** (`/genres`): a browsable style/occasion/non-music index over per-song genre slugs.
- **Home rows** (`/home-rows`): telemetry-ranked top albums/videos/artists plus a daily-rotating Top Community
  row.
- **Zemer Radio** (`/radio`): corpus-native, whitelist-pure "what plays next", a co-occurrence blend over an
  aggregated graph from `zemer-stats`, replacing `YouTube.next()`.
- **Zemer Stations** (`/stations`, `/station`): synchronized broadcast radio (one shared wall-clock program
  per station), audio-only pools, pure clock-math tune-in.
- **Podcasts** (`/podcasts`, `/podcast`, `/podcast-channel`, `/podcasts/new-episodes`, `/podcasts/trending`,
  `/podcasts/version`): corpus-native podcast discovery (shows, episodes, host channels) with a `/player`
  duration and date top-up and data-driven Top Podcasts / Trending Episodes. **Server-side and live; the app
  client is on a branch and not yet released.**
- **User-shared playlists** (`/user-playlist` POST, `/user_playlist/<id>`): person-to-person unguessable
  links, members corpus-validated at create, filters applied at serve. **Server-side implemented; the app
  client is not shipped yet.**
- **On-device subset** (`/subset/manifest`, `/subset/<shard>`): the content-addressed, gzipped offline
  fallback; the app pulls only the shards that changed.

Playback is never served here: every result carries the YouTube `videoId` the app streams through its own
InnerTube plus cipher pipeline (the irreducible core).

## Telemetry-driven surfaces

The data-driven charts, radio graph, home rows, and podcast surfaces are generated from the separate
`zemer-stats` server (anonymous, device-based telemetry: no account, no IP). Each generator is fail-safe: a
down or empty `/stats` leaves the last-good artifact in place. Nothing user-identifying is stored, and the
aggregation lives off-box.

## Measuring

Benchmarks run against the live corpus, so results reflect whatever is indexed:

```bash
npm test                    # unit tests (normalize, search, store, harvester, server, parsers)
npm run verify              # full gate: tests + audit + fuzz + deep-test
npm run bench               # typo recall vs the app's LIKE, cross-script, subset size
npm run relevance           # per-query ranking spot-check
npm run category-relevance  # ranked results per category
```

## Quickstart

```bash
npm install                                       # better-sqlite3
node harness/whitelist.mjs                        # -> data/whitelist.json (reads the app's google-services.json read-only)

# harvest (writes corpus.db; per-artist durable upserts; cached and paced; aborts on an anti-bot block)
# no cookie needed: browse and search are unauthenticated
N=100 node harvester/harvest.mjs
node harvester/refresh.mjs                         # incremental maintenance (run on a schedule)

npm test
node index/query.mjs "kevakarat"                   # ad-hoc query
node index/build-subset.mjs                        # -> data/subset/ (sharded on-device snapshot; served at /subset)
npm run api                                        # GET /search?q=...&allowFemale=0&kidZone=1&blockVideos=1&k=10
```

Env: `CORPUS_DB`, `HOST`/`PORT`, `WORKERS` (cluster), `RELOAD_MS`, `MIN_INTERVAL_MS`/`CONCURRENCY` (harvest
pacing), `MAX_AGE_H` (refresh TTL), `STATS_URL`/`STATS_KEY` (telemetry generators), `PROXY_URL` (route
`/player` traffic through a residential proxy). See `docs/` for the full contracts.

## Layout

- `harness/` : ported InnerTube request layer (`lib.mjs`, `clients.mjs`), the **cached, rate-limited,
  anti-bot-aware net layer** (`net.mjs`, gzipped disk cache with an optional `PROXY_URL`), browse/artist and
  playlist parsers (`browse.mjs`), IP-safe `search.mjs` and `player.mjs`, the podcast page parser
  (`podcast-browse.mjs`), whitelist and blocked-ids fetchers, the podcast whitelist fetcher, and the Shabbat
  gate (`shabbat.mjs`).
- `harvester/` : per-artist harvest (`core.mjs`, `harvest.mjs`, `onboard.mjs`, `refresh.mjs`, `prune.mjs`,
  `reconcile.mjs`), community playlists, releases dating, the telemetry generators (`auto-playlists.mjs`,
  `radio-graph.mjs`, `stations.mjs`), and the podcast pipeline (`podcasts.mjs`, `podcast-durations.mjs`,
  `podcast-surfaces.mjs`). IP-safe: cached, paced, aborts on the first anti-bot block.
- `corpus/store.mjs` : the **SQLite** source-of-truth (artist, track, album, playlist, community, curated
  playlists, home ranks, durations and play counts, genres, energy). `corpus/podcasts.mjs` adds the podcast
  tables and read layer in the same DB.
- `index/` : `normalize.mjs` (skeleton plus Damerau), `search.mjs` (the bigram / binary-search engine),
  `categories.mjs` (grouped search), `credits.mjs` (featuring-female detection), `radio.mjs` (Zemer Radio),
  `station.mjs` (Stations scheduler), `synonyms.mjs`, `build-subset.mjs` (the sharded on-device snapshot),
  and pinned unit tests.
- `server/api.mjs` : the HTTP API (SQLite to in-memory matcher, cluster, LRU cache, content-filter scoping)
  plus `ui.html`, a small web UI. Endpoints: `/search`, `/artist`, `/album`, `/playlist`, `/new`,
  `/community`, `/zemer-playlists`, `/home-rows`, `/genres`, `/radio`, `/stations`+`/station`,
  `/user-playlist`+`/user_playlist/<id>`, `/podcasts`+`/podcast`+`/podcast-channel`+`/podcasts/*`,
  `/subset/manifest`+`/subset/<shard>`, `/health`, `/reload`.
- `scripts/`, `deploy/` : the maintenance orchestrator (`maintain.sh`) plus systemd timer/service units, all
  Shabbat-gated.
- `bench/`, `docs/`, `data/` : benchmarks, the deep-dive docs (start at `docs/README.md`), and the runtime
  data (`corpus.db`, the gitignored artifacts, the gzipped HTTP cache).

## Constraints honored

- **IP-safe:** all YouTube traffic is bounded-concurrency, rate-paced, jittered, and **cached** (never
  re-fetched), and it stops on the first anti-bot page. Benchmarks are 100% offline.
- **Disk-safe:** the HTTP cache is gzipped, `corpus.db` is compact, no Typesense container.
- **Cross-version:** on-device search is pure-Kotlin/JVM-portable (no FTS5, no platform ICU), identical on
  API 26 to 36.
- **Server-portable:** one Node process plus one SQLite file, all paths and secrets via env.
- **`zemer-app` is immutable**, and the docs (`AGENTS.md` and `docs/`) stay in lockstep with the code.

## Status

The server path is proven end-to-end and deployed. The full whitelisted-artist harvest is complete and grows
on Shabbat-gated maintenance timers (shallow daily, deep weekly, plus a fast all-artist sweep). Most of the
app's InnerTube discovery has been replaced by corpus-native surfaces (search, home rows, artist, album,
radio, and now podcasts). The remaining app-side work is the client integration for **podcasts** and
**user-shared playlists** (both live on the server, not yet shipped in the app) and the last few InnerTube
edge surfaces.

## License

GNU General Public License v3.0, see [`LICENSE`](LICENSE). zemer-search ports InnerTube request and parser
code from [Zemer](https://github.com/ZemerTeam/zemer-app), which is based on
[Metrolist](https://github.com/MetrolistGroup/Metrolist); both are GPLv3, so this project is GPLv3 as well.
