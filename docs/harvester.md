# Harvester

`harness/` (the InnerTube + net layer) + `harvester/` (the harvest logic). Turns the whitelist into a
complete-discography corpus, safely.

## The InnerTube layer (`harness/`)

Ported from the app's `tests/` so it reproduces the app's exact request path.

- Browse and search are **unauthenticated** — no cookie, no `visitorData`. (A stale/flagged shared
  `visitorData` actually caused *empty* results; sending none is reliable — see commit `df162b8`.)
- `clients.mjs` — the `WEB_REMIX` client constants (mirrors `YouTubeClient.kt`).
- `browse.mjs` — `postBrowse({browseId, params, continuation, maxAgeMs})` + faithful parsers:
  `parseArtistPage` (sections: songs shelf, album/single/playlist carousels, **+ the artist's regular
  channel id** from the header subscribe button, **+ header thumbnail**), `parseArtistItems` /
  `parseArtistItemsContinuation` (grid/shelf pagination), `parsePlaylistPage` (album/playlist tracks).
  Rows parse to `{kind: "song"|"album"|"playlist", …}`; `songFromMRLIR` also extracts the **per-row
  artist channel id** (used for playlist whitelisting).
- `whitelist.mjs` — fetches the world-readable Firestore `artistsWhitelist` collection (project/apiKey
  from the app's `google-services.json`, **read-only**) → `data/whitelist.json` (~1608 artists).

## The IP-safe net layer (`harness/net.mjs`) — the most important safety code

**Every** YouTube request goes through `cachedPost(url, headers, body, {maxAgeMs})`:

1. **Gzipped disk cache** keyed by `sha1(POST url body)` in `data/.httpcache/*.json.gz`. A page is
   fetched **at most once, ever** (browse JSON compresses ~10×). `maxAgeMs` lets maintenance re-fetch a
   stale landing page (default = forever).
2. **Single-flight + rate limit:** one live request at a time, ≥ `MIN_INTERVAL_MS` (default 900) +
   `JITTER_MS` between live requests.
3. **Anti-bot abort:** if YouTube returns a "Sorry…" challenge page, it returns `{blocked:true}` and the
   harvest **stops immediately** to protect the IP.

`netStats()` reports live/cache/block counts. **Never add a raw `fetch`** — route through `net.mjs`.

> A full 1,608-artist harvest is many thousands of paced requests over hours. Let it grow **politely over
> time** (it self-aborts on a block, and the cache makes every restart resume for free). Don't blast it.

## Per-artist harvest (`harvester/core.mjs`)

`harvestArtist(artist, browse, {landingMaxAgeMs})` returns the artist's complete catalog as **typed
entities**:

- **tracks** — the Songs shelf + Videos shelf, fully paginated via continuations, **plus every album's
  tracks** (each album page is `browse("VL"+playlistId)`). This album expansion is what makes it a
  *complete* discography rather than just the Songs shelf.
- **albums** — album/single/EP entities with `{id (MPRE browseId), playlistId, title, type, year,
  thumbnail}`. `type` is derived from the release subtitle ("Album • 2023" / "Single • 2024").
- **playlists** — the artist's playlist entities `{id, title, thumbnail}`.
- **albumTracks** — `(albumId, videoId, pos)` membership, captured during album expansion (powers the
  album detail page).
- **regularChannelId** — the artist's regular-upload channel (from the page header subscribe button).
- **thumbnail** — the artist image.

`browse` is injected so callers control cache policy and so a block throws `BlockError` (clean abort).

## Initial vs incremental

- **`harvester/harvest.mjs`** (`N`): first N whitelisted UC artists, forever-cache.
  Upserts **one artist's whole catalog per `db.transaction`** → durable per-artist checkpoints (crash/
  kill safe), not only-at-the-end. Aborts on block (resume later from cache).
- **`harvester/refresh.mjs`** (`MAX_AGE_H`, default 12): re-harvests the artists already in `corpus.db`,
  re-fetching landing + shelf pages with a **TTL** (to catch new releases) while immutable album pages
  keep their forever-cache. Upserts only-new via `INSERT … ON CONFLICT`. Run on a schedule (daily).

## The channel map & issue #108

The whitelist holds YouTube **Music** channel ids. Artists' *uploads* (live videos, older content, music
videos) live on their **regular** YouTube channel — a *different* id. The harvest stores
`artist.regularChannelId` so playlist tracks uploaded to the artist's regular channel can be verified as
whitelisted (`whitelistedChannelIds` = music ids ∪ regular ids).

**Issue #108:** content that exists *only* on an artist's regular channel (not surfaced on their YT Music
page) is **not harvested yet**. Closing it means harvesting each regular channel's Videos/Releases/
Playlists tabs and deduping by videoId — bounded by the IP/storage budget. The channel map is the
groundwork.

## Whitelist data quality

zemer-search is a faithful mirror of the whitelist — it indexes *exactly* what's whitelisted. So it
doubles as a **whitelist auditor**: an off-policy artist in Firestore becomes searchable and obvious here
(the app shows them too, for the same reason). Fix such entries in Firestore, then re-fetch the whitelist
and re-harvest. (zemer-search has **zero** leakage beyond the whitelist — verified by `fuzz`.)
