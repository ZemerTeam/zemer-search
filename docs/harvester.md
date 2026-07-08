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
   harvest **stops immediately** to protect the IP. The same breaker catches the **soft gate** — a valid
   200 JSON with `playabilityStatus.reason` "Sign in to confirm you're not a bot" (seen on `/player`
   mid-sweep): latched cooldown, **never cached**, and a previously-cached gate response reads as a cache
   **miss** so later runs retry it live.

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

**Whitelist-purity guard (`ownsRow`).** YouTube Music's artist **Songs/Videos shelves are polluted** — the
"Videos" feed (and its `more` pagination) mixes in rows uploaded by *other* channels: foreign garbage
(Tamil/Lil Wayne/gospel), third-party Jewish covers, and re-uploads (e.g. YBC videos posted by "EG
Productions"). Stamping the page artist on every shelf row stored that junk under a whitelisted artist. So
`add()` now keeps a row only if its **own** artist channel (`rowArtistId` — captured per row by
`songFromMRLIR` and `fromTwoRow`) is whitelisted: `ownsRow(rowArtistId, owned, whitelist)` where `owned` =
the artist's own music + regular channel and `whitelist` = the full whitelisted-channel set (so feat.
collabs by other whitelisted artists survive). A row with **no** captured artist is trusted to the page.
Callers (`harvest`/`onboard`/`refresh`) pass the whitelist set. **`harvester/reconcile.mjs`** is the
one-time cleanup for already-stored junk: it re-parses every artist from the **cache** (offline, zero
YouTube calls) and purges tracks whose row artist is a non-whitelisted uploader — purging **only** rows it
positively finds as foreign (a cache miss never deletes). `DRY=1` reports first. Same whitelist-purity rule
the community playlists use (gotcha #17).

**Prefer-video for cross-listed ids (gotcha #18).** A `videoId` can be a music VIDEO on one artist's page
and an audio SONG on another's; since it's stored once (PK), it could land as a song and never appear in the
Videos category. `add()` upgrades `isVideo` when the same id reappears on the Videos shelf, and
`upsertArtistCatalog` does `ON CONFLICT … isVideo=MAX(track.isVideo, excluded.isVideo)` (never downgrades).
**`harvester/backfill-video-flags.mjs`** (cache-only, `DRY=1`) flips already-stored songs to video for ids
listed as a video anywhere. Attribution stays the PK owner (no duplicate same-id results).

**Track detail metadata (durations + play counts).** The cached browse rows already carry a track's duration
(album-page fixed column) and play count (landing "Songs" shelf "N plays") — the parser now extracts both
(`browse.mjs`), the harvest stores + merges them across shelves (`core.mjs`), and
**`harvester/backfill-track-meta.mjs`** (cache-only, `DRY=1`) fills existing rows by re-parsing offline via
`harvestArtist` — **zero YouTube calls**. Drives `durationSec`, `playCount` (real "Top songs" sort), and
`trackNumber` on the detail endpoints.
**`harvester/backfill-durations-player.mjs`** tops the durations up from cached **`/player`** responses
(`videoDetails.lengthSeconds`) — the dating pass (`releases.mjs`) caches `/player` for exactly the tracks
album pages don't cover (videos + standalone), so this is a free cache read (`LIVE=1` fetches the few
uncached stragglers, IP-safe). Together (measured 2026-07-01): **durations 100%** (70,392/70,392).

**Community member artist resolution.** A community-playlist member whose track isn't harvested (e.g. on the
artist's regular channel) has no corpus row, so the content filter couldn't tell its gender and an all-female
list with one such member wrongly failed open (showed, then opened empty). Discovery now records each
member's resolved whitelisted artist in `community_playlist_track.artistId`, so the filter (`clsMask` +
counts) reads its gender even un-harvested. **`harvester/backfill-community-artists.mjs`** (cache-only,
`DRY=1`) fills it in for already-stored playlists by re-parsing their cached pages — offline, no fetch.

## Initial harvest, onboarding, refresh, prune

The four entry points (all upsert **one artist's whole catalog per `db.transaction`** → durable per-artist
checkpoints, crash/kill safe; all abort on the first anti-bot block and resume from cache; all exit `75`
on a block so the wrapper can stop the pipeline):

- **`harvester/harvest.mjs`** (`N`): first N whitelisted UC artists, full catalog, forever-cache. The
  initial bulk build.
- **`harvester/onboard.mjs`**: harvests only the **new** whitelisted artists (in `whitelist.json` but not
  yet in `corpus.db`); existing artists are skipped. Full catalog. **Only persists an artist with ≥1
  track** — a transient fetch error yields 0 tracks and is *not* written (so it isn't stranded as a
  0-track row; it's retried next run). A no-op (0 live requests) when nothing is new.
- **`harvester/refresh.mjs`** (`MAX_AGE_H` default 20, `SHALLOW`): re-harvests **all** artist rows in
  `corpus.db` (incl. 0-track ones, so a transiently-failed harvest recovers), re-fetching landing + shelf
  pages with a **TTL** to catch new releases while immutable album pages keep their forever-cache. Upserts
  only-new (`INSERT … ON CONFLICT`); **never deletes**, so a shallow pass can't shrink the corpus. On a
  block it writes a `"blocked"` status (distinct from `"done"`).
  - **deep** (default — bare `node harvester/refresh.mjs`): full pagination of every song/video/album
    shelf. Preserves the historical refresh behavior, so an existing cron keeps catching items anywhere.
  - **shallow** (`SHALLOW=1`): landing page + its carousels + (new) album expansion only — ~1 request/
    artist; new releases surface at the top of the landing carousels. The fast daily pass.
- **Blocklist (`data/blocklist.json`** — `{videoIds:[…], artistIds:[…]}`, committed like `synonyms.json`):
  curated junk to exclude **regardless of the whitelist** — for track-level junk under an otherwise-wanted
  artist (the whitelist is artist-granularity). `upsertArtistCatalog` never stores a blocklisted id (so a
  re-harvest can't re-add it) and `prune.mjs` deletes any existing blocklisted rows (`pruneBlocklisted`).
- **`harvester/prune.mjs`** (`PRUNE_MIN_RATIO` default 0.5): applies the blocklist, then removes artists no longer on the whitelist
  (and all their rows, one transaction) so a de-whitelisted artist stops being searchable. **Safety guard
  (`prunePlan`, unit-tested):** refuses unless ≥ `PRUNE_MIN_RATIO` of the **current** artists *survive*
  (corpus ∩ whitelist) — comparing survivors, not raw whitelist size, so a plausibly-sized-but-wrong
  whitelist can't wipe the corpus. A bad ratio value falls back to 0.5.

**`scripts/maintain.sh [shallow|deep]`** orchestrates the lot under a `flock`, in order: `whitelist`
refetch → `onboard` → **`prune` → `refresh`** (prune first so refresh doesn't re-harvest doomed artists).
An anti-bot block in any step **aborts the whole pipeline** (no more live requests at a flagged IP). Uses
a fast-but-IP-safe profile (`CONCURRENCY=5`, `MIN_INTERVAL_MS=200`). Schedule daily shallow + weekly deep,
gated by the accurate **Shabbat gate** (`harness/shabbat.mjs`) — see [deployment.md](deployment.md).

**`harvester/mirror-sync.mjs`** (every 10 min via `zemer-mirror-sync.timer`, Shabbat-gated) keeps the corpus
in sync with the **whitelist mirror** (`content.zemer.io`) *between* daily runs: it reads the mirror's
whitelist **version gate** (advances only on a real content change) plus its blocked-id list — **zero
Firestore reads**. Blocked-ids changed → rewrite `data/blocked-ids.json` (the API auto-reloads; newly-blocked
content disappears). Whitelist gate changed → pull `/whitelist` from the mirror, rewrite
`data/whitelist.json`, then **onboard** the new artists and **prune** the de-whitelisted, under the
maintenance flock (non-blocking — a held lock or an anti-bot block leaves the gate uncommitted so the next
run retries). Net effect: a newly-whitelisted artist is fully searchable within **~10 minutes**. Unchanged =
two tiny GETs, a true no-op. `DRY=1` previews.

## Community playlists (pilot)

Goal: surface **community-built YTM playlists** (curated by users, not whitelisted artists) — *as many as
possible* — while serving **whitelisted tracks only**. Two independent guarantees:

- **Purity (hard).** The `/playlist` endpoint re-fetches a playlist live and keeps only its whitelisted
  tracks (`tracksByIds` ∪ `whitelistedChannelIds`). This is **id-based**, so opening *any* playlist —
  community, artist, or even unindexed — can only ever render whitelisted tracks. Discovery never weakens
  this; a community playlist is just "a community ordering of (the whitelisted subset of) some tracks."
- **Admission (quality).** `admitPlaylist({total, whitelisted})` admits only if **≥ `MIN_WL_TRACKS`**
  (default 4) **AND ≥ `MIN_WL_RATIO`** (default 0.5) whitelisted — so we don't surface a 4%-whitelisted
  fragment. This is *not* a purity gate (purity is the serve-time filter); it's a "is this a coherent
  list?" gate. **Never** admit on "contains *any* whitelisted track" — that's the leaky inverse (gotcha #14).

**`harvester/playlists.mjs`** (`npm run playlists`) — there is no global "all playlists" enumeration on
YouTube, so discovery **seeds from search** (IP-safe via `harness/search.mjs` → `net.mjs`):

1. **Seeds** (`buildSeeds`): curated topical terms (`data/playlist-seeds.json`) + whitelisted artist names
   + (with `FIRSTNAMES=1`) each artist's first name. `SEEDS=topics|artists|both` (default `both`), `N` caps
   the seed budget. Full sweep: `SEEDS=both FIRSTNAMES=1 N=4000`.
2. **Discover**: search each seed with the community-playlist `SearchFilter` → candidate playlist ids
   (already-known ids skipped unless `RECHECK`/`REVALIDATE`).
3. **Check + gate**: fetch each candidate's tracks (`CAP` default 300), intersect with the corpus, apply
   `admitPlaylist`. Keepers → `upsertCommunityPlaylist` (playlist + whitelisted membership, one
   transaction). `PAGES` sets search pages per seed.
4. **"Remove what's not"**: `RECHECK=1` re-validates re-discovered playlists and **deletes** ones that now
   fail the gate; `REVALIDATE=1` re-checks **every** stored community playlist (even if not re-found) and
   deletes failures + refreshes the rest. `pruneBlocklisted` also strips blocklisted videoIds from
   community membership and re-syncs counts.

**Metadata safety (the audio is already pure; this hardens what's *displayed*).** A playlist's title,
curator name, and cover are user-generated:
- **Cover** — derived from a **whitelisted track** at read time (`store.mjs`), never the curator's cover
  image (which can be a mosaic of the playlist's non-whitelisted tracks). Applies retroactively to all rows.
- **Title / curator text** — screened at admission against `blocklist.json` `playlistTerms` (case-insensitive
  substrings); a hit rejects the playlist (and removes it on `REVALIDATE`/`RECHECK`). You own this list.
- **Specific removals** — `blocklist.json` `playlistIds` (your manual backstop). `upsertCommunityPlaylist`
  refuses a blocklisted id; `pruneBlocklisted` deletes existing ones.

**Whitelist-review report.** Each run writes `data/rejected-artists.json` (gitignored, regenerated per run):
the **non-whitelisted artist channels** whose tracks were dropped from the community playlists, tallied and
sorted by frequency (`count  artistName  channelId  channelUrl  sample_track`) — the strongest candidates
to add to the whitelist lead. It can also be produced **from cache** (no live requests) via the net layer's
`cacheOnly` option, so it's safe to regenerate alongside a running scan.

IP-safe like every other step: paced/cached/circuit-broken, aborts on the first anti-bot block → exit 75.
Re-runs are free (cache replay). Progress writes to the status channel → the web UI shows "Discovering
community playlists (discover|check) — N / total"; results get their **own Community chip** (browse-all via
`/community`, no search needed). Stored in `community_playlist` / `community_playlist_track`
([store.md](store.md)); separate from the artist-owned `playlist` table, so the pilot is fully reversible.

## Zemer-curated playlists

**`harvester/zemer-playlists.mjs`** applies the hand-curated playlists file into `corpus.db` — **fully
offline** (no network, runs anywhere, no Shabbat/IP concerns). These are Zemer's own editorial categories
("Shabbos", "Upbeat", …), served by `/zemer-playlists` and intended as the app's "Zemer playlists" section.

```jsonc
// data/zemer-playlists.json (committed, like blocklist.json — the curated input)
{ "playlists": [
  { "id": "shabbos", "title": "Shabbos", "videoIds": ["…"], "albumIds": ["MPRE…"] },
  { "id": "year-2026", "title": "Year of 2026", "year": 2026 }
] }
```

- **The JSON is the source of truth.** Every apply REPLACES the `zemer_playlist` tables wholesale
  (`applyZemerPlaylists`, one transaction) — removing a playlist from the file removes it from the server.
  File order = display order; id order = track order (`videoIds` first, then each album in place).
- **Album ids expand at READ time** to their `album_track` members, so a re-harvested album's new tracks
  appear in the curated playlist without a re-apply.
- **A `year` entry is a fully DYNAMIC rule** (it can't also list ids): everything released in that year
  (by the resolved real release date), newest first, computed at read time — the playlist grows with
  every harvest all year, and past years are naturally frozen.
- **Unknown ids are pending, not errors**: only corpus tracks are served, so a not-yet-harvested id simply
  contributes nothing until it lands. The apply **reports** every id not in the corpus (typo feedback);
  `DRY=1` validates + reports without writing.
- **No reload step**: writing `corpus.db` bumps its mtime, so a running API picks the change up on its
  next reload tick (same change-gate as the harvest).

```bash
DRY=1 node harvester/zemer-playlists.mjs   # validate + report (incl. ids not in the corpus)
node harvester/zemer-playlists.mjs         # apply → corpus.db
```

### Auto (data-driven) playlists — `harvester/auto-playlists.mjs`

Alongside the hand-curated categories, three playlists are **generated from anonymous usage telemetry** (the
sibling `zemer-stats` server, `tracking.zemer.io`): **Top 50** (`auto-top-50`), **Trending** (`auto-trending`),
**Favorites** (`auto-favorites`). It fetches `GET /stats` (key from `STATS_KEY`, base from `STATS_URL`), scores
every song, and writes the results as ordinary `auto-*` playlist blocks into the **gitignored**
`data/zemer-playlists-auto.json` — which `loadZemerPlaylists()` merges *in front of* the curated file, then
`applyZemerPlaylists` writes the union. **The curated file is never touched**, so `git pull` on the VPS never
conflicts with runtime-generated content. The app renders these identically to curated ones — no app/schema/
endpoint change; content filters (female/blocked/kidzone/video) are applied downstream by `/zemer-playlists`.

- **Ranking uses live AND backfill telemetry, never summed naively.** Each signal is scored by a *shrunk,
  saturating* distinct-device reach `s(d)=d/(d+PRIOR)` (magnitude-aware but damped at small n; needs no
  magnitude constant that would rot as data grows), then blended by intent weight:
  - **Top 50 = loved-score** = `1.0·backfill-plays + 0.6·live-plays·(1−skip) + 1.2·favorites + 0.3·downloads`.
    Backfill leads because it is the DEPTH today (live tracking is only days old) and is **unbiased by what we
    surfaced** (live plays partly measure freshly-featured content); favorites weigh most per-listener (intent);
    downloads are weak corroboration (noisy: auto-download-on-like/retries). Signals with total overlap
    (live vs backfill favorites/downloads) are combined by **MAX, not sum**.
  - **Trending** = short-window (`TRENDING_DAYS=7`) live plays only, skip-penalized, precision-floored
    (`devices≥3`, `skipRate<0.5`). Backfill is frozen history → excluded here by design.
  - **Favorites** = favorite-primary, download-corroborated (an item needs ≥1 real favorite to seed).
- **Self-calibrating, no re-tuning.** Backfill grows as more users update to the tracking build (deduped
  server-side), and live grows forever; because weighting keys off each signal's *reach*, whichever has more
  evidence earns more weight automatically. Regenerating on the timer folds new data in for free.
- **"Just works" guarantees.** A down/empty `/stats` **aborts without touching the file or DB** (last-good
  playlists stay live); atomic write (tmp→rename); a **no-op when the generated ids are unchanged** (no needless
  index reload); only servable (in-corpus) ids are included, so the lists actually fill to N.

```bash
STATS_URL=… STATS_KEY=… node harvester/auto-playlists.mjs         # generate + apply (env from .env locally)
DRY=1 STATS_URL=… STATS_KEY=… node harvester/auto-playlists.mjs   # print what it would write, no write
```

Runs twice daily via `deploy/zemer-autoplaylists.timer` (Shabbat-gated). Knobs: `TOP_N=50`, `TRENDING_N=25`,
`TRENDING_DAYS=7`, `FAV_N=30`.

## Release dating (New Releases accuracy)

Browse pages carry only a release **year**; the real date lives in the `/player` microformat (`uploadDate`,
full ISO-8601). **`harvester/releases.mjs`** (`npm run releases`) dates releases *cheaply*: for each album
lacking `uploadDate` but with a sample track (we already store `album_track`), it fetches **one `/player`**
on that sample and stores the date on the album — **one request per release, never per track**. Incremental
(skips already-dated albums; `/player` responses are cached, so re-runs replay free), album-type + recent-year
first, IP-safe (paced, aborts on a block → exit 75). A song inherits its album's date, so dating albums also
orders the New Releases Songs list. A **second phase** dates **videos + standalone tracks** with one `/player`
on the track ITSELF → `track.uploadDate`, because their own date matters (a music video or a real single's
release isn't the album's). **Album AUDIO tracks are skipped**: they were released *with*
their album, so inheriting its real date via `COALESCE(track.uploadDate, album.uploadDate)` is equally
accurate at **~1 `/player` per album instead of per track**. Net: **precise own-date where it matters,
accurate album date otherwise** — no wasted per-art-track sweep. **Client fallback:** `/player` is tried as
WEB_REMIX first (YouTube Music — the bulk of ids are already in its cache) and falls back to the plain **WEB**
client, which returns the exact date for uploads WEB_REMIX can't see (LOGIN_REQUIRED music videos, art tracks
with no WEB_REMIX microformat) — this is what lifts album/track date coverage to near-total. Knobs: `TRACKS=0` = albums only, `ALBUMS=0` =
tracks only, `MIN_YEAR` gates albums (tracks run only at `MIN_YEAR=0`). **`/player` is blocked from datacenter
IPs**, so this runs off-datacenter (a residential host) and the dates are shipped into the server `corpus.db`
(the album/track upserts leave `uploadDate` untouched, so shipped dates survive re-harvest).

This is what makes New Releases truthful: `recentAlbums`/`recentTracks` order by the real date, and `/new`
shows **only items dated within a window** (default 10 days). Without it, ordering fell back to `harvestedAt`
(index time) and old catalog we'd *just indexed* looked "new". Env: `MIN_YEAR` (restrict to recent),
`LIMIT`, plus the usual `net.mjs` pacing vars. Standalone **videos** (not in an album) aren't dated yet, so
they don't appear in the windowed view — closing that would need a `/player` per video.

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
