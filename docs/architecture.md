# Architecture

## The problem

Zemer's online search calls YouTube Music search (`WEB_REMIX`) and then drops every result whose artist
isn't on the whitelist (`OnlineSearchViewModel` → `filterWhitelisted`). Because YouTube searches *all* of
YouTube, most results are off-whitelist and get thrown away → sparse or empty pages. Titles are also
Hebrew, often vowel-less and mixed with embedded romanizations (`כבקרת` = "Kevakarat"), and the app's
fallback is `title LIKE '%query%'`, which finds nothing for a romanized or slightly-misspelled query.

## The solution: search a pre-built whitelisted index

Instead of "search everything, filter after", we **harvest every whitelisted artist's complete catalog
once** and search *that*. Accurate by construction (no off-corpus noise), and we own ranking + fuzzy
matching.

## Hybrid, one engine in two places

```
                        ┌─────────────────────────────────────────────────────────────┐
  Firestore whitelist ─▶│ harvester (harness/ + harvester/)  — IP-safe InnerTube        │
                        │   complete discography per artist → SQLite corpus.db          │
                        └───────────────┬─────────────────────────────────────────────┘
                                        │
                         ┌──────────────▼───────────────┐         ┌──────────────────────────┐
                         │ corpus/store.mjs  (SQLite)    │         │ index/build-subset.mjs    │
                         │ durable source-of-truth       │         │ gzipped compact subset    │
                         └──────────────┬───────────────┘         └────────────┬─────────────┘
                                        │ allTracks/allArtists/…                │
                ┌───────────────────────▼─────────────────┐      ┌─────────────▼──────────────┐
   SERVER ────▶ │ index/search.mjs  (in-memory matcher)    │      │  ON-DEVICE (planned)        │
                │ index/categories.mjs (grouped search)    │      │  pure-Kotlin in-memory      │
                │ server/api.mjs  HTTP + cluster + cache   │ ═══▶ │  index, SAME algorithm      │
                │ server/ui.html  web UI                   │ same │  offline / API-down fallback│
                └──────────────────────────────────────────┘ code └─────────────────────────────┘
```

- **Server (primary):** harvest → SQLite → in-memory index loaded by the `/search` API. ~0 MB downloaded
  per query, always fresh.
- **On-device (fallback, deferred):** a small gzipped subset → the *same* matcher in pure Kotlin. Works
  offline / when the API is down.

## Why SQLite + in-memory (and not Typesense / Postgres)

This was an explicit decision (an earlier prototype used Typesense). For a **small, curated, read-only-
at-request-time, single-writer** corpus (~69k tracks at full harvest):

- **The search path never touches the DB.** Queries hit the in-memory inverted index (RAM, ~ms). SQLite
  is read once at startup + on reload to *build* the index.
- **SQLite fits perfectly:** WAL mode → unlimited concurrent readers; the only writer is the harvester;
  users never write → zero write contention. Detail reads (`/artist`, `/album`) are microsecond indexed
  selects, LRU-cached on top.
- **Fewest moving parts:** one Node process + one `corpus.db` file. No container, no daemon. Horizontally
  scalable by replicating the small read-only file to each node (no central DB bottleneck).
- **Typesense/Postgres** would add an external system to operate for a corpus small enough to live in RAM,
  and the hand-rolled matcher already beats `LIKE` decisively while we fully control its ranking + the
  cross-script behavior (which off-the-shelf engines don't do for Hebrew).

## Android-version strategy (hard requirement)

The on-device fallback must behave **identically on minSdk 26 (Android 8) → targetSdk 36**. Therefore
everything in `index/` is **pure string/data ops** with no platform-version-variable dependencies:

- **No SQLite FTS** (Android's bundled SQLite didn't reliably ship FTS5 until ~API 30). On-device search
  is a pure in-memory inverted index, not an FTS DB.
- **No platform ICU / `android.icu`** (its Unicode data differs per OS version → non-identical results).
  Romanization is a hand-curated map + `NFD` + combining-mark strip (available since API 1).
- **SQLite here is server-only.** It never ships to a phone, so the DB choice has *zero* Android
  implications. (Repeat: the on-device index is built from a gzipped subset, in pure Kotlin.)

## Data flow per request

`GET /search?q=…` → `searchCategories` runs the in-memory `search()` over **seven** category indexes
(artists, songs, albums, singles, videos, playlists, community), applies the content filter, returns the
top-k per category as `SongItem`-shaped JSON (song rows carry `durationSec`+`playCount`; album rows carry
`type`+`trackCount`+`totalDurationSec`). The web UI renders them as filter-chip categories like the app. The
index is rebuilt from `corpus.db` every `RELOAD_MS` (default 30 s) so newly-harvested entities appear.

See [search.md](search.md) for the matcher, [api.md](api.md) for the server, [store.md](store.md) for the
schema, [harvester.md](harvester.md) for harvesting.
