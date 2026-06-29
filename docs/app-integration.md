# App-side integration (DEFERRED — touches `zemer-app`)

This is **out of scope** while `zemer-app` is immutable. It's documented so the path is clear when the
freeze lifts. Nothing here has been built; do not start it without explicit go-ahead.

## Goal

Replace the app's "search YouTube → `filterWhitelisted`" online-search path with zemer-search, keeping the
exact output types so the existing screens render + play results unchanged.

## Shape

A `SearchProvider` interface producing today's `SearchSummaryPage` / `SearchResult` of `YTItem`, with:

- **`RemoteIndexSearchProvider`** (primary) — calls the zemer-search `/search` API, maps the grouped JSON
  back to `YTItem`s. The user's content settings (`allowFemaleSingers`, `blockVideos`, KidZone) map to the
  `allowFemale`/`blockVideos`/`kidZone` query params.
  - ⚠️ **The server is DEFAULT-OPEN** (omit a flag → unfiltered for it) and the Zemer provider renders
    results **raw** (it is NOT run through `filterWhitelisted` like the YouTube provider). So the server is
    the **sole** filter for Zemer results — the app must send **all** flags on **every** request
    (summary / each category / suggestions / pagination), explicitly, **fail-closed**. The server then does
    the rest: hides all-female community playlists, reduces mixed counts, 404s filtered detail. See the
    full APK guide (`../../ZEMER_SEARCH_CONTENT_FILTER_APK_GUIDE.md`).
- **`LocalIndexSearchProvider`** (offline fallback) — the **same matcher as `index/search.mjs`, ported to
  pure Kotlin**, over a bundled gzipped subset (`index/build-subset.mjs` output). Must be pure Kotlin/JVM:
  **no SQLite-FTS, no platform ICU** → identical on Android 8 → 15 (see [architecture.md](architecture.md)).
- Keep `YouTubeSearchProvider` (current behavior) as an optional last-ditch fallback.

**Fallback orchestration:** remote → on timeout/offline/5xx → local → (optional) YouTube. Keep
`filterWhitelisted` as a cheap safety net (a near-no-op since the index is pre-scoped).

## Integration point

`viewmodels/OnlineSearchViewModel.kt` — swap the `YouTube.search*()` calls in
`loadSummary()/loadFiltered()/loadMore()` for the provider.

## Shipping the on-device subset

Mirror `PlayerConfigStore` / `LatestReleasesStore`: a bundled baseline subset + a runtime fetch of an
updated subset with **ETag/304 + TTL + atomic write + epoch**. On load, parse the compact gzipped file
into the in-memory inverted index and search in pure Kotlin. `build-subset.mjs` already emits a compact,
content-scoped, gzipped artifact (~2 MB per 100k tracks; thumbnails derived from videoId, artist/album
interned, flags packed).

## Could this replace the Firestore whitelist?

Discussed but not decided. zemer-search already mirrors the whitelist (`artist` table), so the server
*could* become the source of truth (one system for store + search). Trade-off: you'd give up Firestore's
free admin console + Google-managed uptime for the content-safety boundary. The search engine doesn't
require this either way. **Crashlytics is separate** and would stay regardless.

## Pre-reqs before starting

1. The freeze on `zemer-app` is lifted.
2. The server is deployed and stable (see [deployment.md](deployment.md)).
3. The corpus is reasonably complete (full harvest done; ideally #108 closed for regular-channel content).
