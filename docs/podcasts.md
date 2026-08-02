# Zemer Podcasts — corpus-native podcast discovery

Podcasts are a **whitelist-scoped, corpus-native discovery surface**, built the same way music is: a Firestore
whitelist → an IP-safe InnerTube harvest → durable SQLite → an in-memory-free direct read served over HTTP.
It replaces the app's InnerTube podcast-discovery calls and its direct Firestore `podcastsWhitelist` read.

**Playback stays InnerTube.** A podcast episode is a YouTube video with a real `videoId`; the app streams it
through the existing InnerTube + cipher pipeline exactly like a song. This migration is **discovery-only** —
the server never returns audio URLs. Every episode any endpoint returns carries its `videoId`; the app plays
that. (Full app-side contract + rationale: `handoff-docs/zemer-app-podcasts-request.md`.)

```
podcastsWhitelist (Firestore)  →  harvest (InnerTube browse, IP-safe)  →  corpus.db (podcast_* tables)  →  HTTP /podcasts*
   podcastDatabaseNumber/latest  ─────────────────────────────────────────────────────────────────────→  version gate
                                    /player top-up (durations + real ISO dates)  ──┘
```

## Vocabulary (keep these two separate)

- **Show** — a series (id `MPSP…`). What the whitelist lists and `/podcast` opens. The client keys/routes on it.
- **Host channel** — the YouTube channel (`UC…`) that publishes one or more shows. `/podcast-channel` opens it.
  A show carries a `channelId` pointing at its host; resolved at harvest (the whitelist rarely carries it).

## Pipeline

| Step | File | What |
|------|------|------|
| Whitelist | `harness/podcasts-whitelist.mjs` | Firestore `podcastsWhitelist` (`id`/`podcastId`, `name`/`podcastName`, `channelId`, `thumbnailUrl`) + `podcastDatabaseNumber/latest` version → `data/podcasts-whitelist.json`. Read-only google-services.json, same as the artist whitelist. |
| Parse | `harness/podcast-browse.mjs` | Port of the app's `YouTube.podcast()` + `PodcastPage.kt`. Show page = `browse(MPSP…)` via the shared `postBrowse` (IP-safe). Episodes are `musicMultiRowListItemRenderer` (continuations may emit `musicResponsiveListItemRenderer`); the subtitle is scanned order-independently for a duration (`m:ss`) vs a date/label. |
| Store | `corpus/podcasts.mjs` | `podcast_show` / `podcast_episode` / `podcast_channel` in the same `corpus.db` (server-side only, no Android implication). Upsert is one transaction per show; episodes reconcile (durations/dates COALESCE'd so a top-up survives re-harvest, dropped episodes pruned). |
| Harvest | `harvester/podcasts.mjs` | Per show: browse page 1 + paginate every episode, upsert; then resolve each host channel's avatar (one browse each). Whitelist-pure by construction. IP-safe (aborts on anti-bot block → exit 75). |
| Dates + durations | `harvester/podcast-durations.mjs` | Browse pages carry only a date label and no length, so one `/player` per episode fills **`durationSec`** (`videoDetails.lengthSeconds`) **and a real ISO `publishedAt`** (`microformat.uploadDate`). WEB_REMIX→WEB fallback. `/player` is datacenter-blocked → run off-datacenter (residential) or via `PROXY_URL`. Idempotent (fills NULLs only). |

**Cookieless.** Podcast browse works unauthenticated (verified), same as music/search — no cookie, no visitorData.
(The app uses `setLogin=true`; we don't need it.)

### Cadence knobs (`harvester/podcasts.mjs`)
- default (no env) — full pass, forever-cache. Initial harvest.
- `NEW=1` — only shows not yet in the corpus (onboard).
- `MAX_AGE_H=12` — **refresh**: re-fetch each show page older than 12h so new episodes land (continuations
  ride fresh tokens off a re-fetched page 1).
- `PRUNE=1` (full pass only) — drop de-whitelisted shows + their episodes + orphan channels.
- `N=`, `DRY=1` — cap / preview.

## Schema (`corpus/podcasts.mjs` — new tables in `corpus.db`)

- **`podcast_show`** `id`(MPSP…, PK), `name`, `author`, `channelId`, `thumbnail`, `description`, `categories`
  (JSON), `episodeCountText`, `harvestedAt`.
- **`podcast_episode`** `videoId`(PK — the playable id), `showId`, `title`, `thumbnail`, `durationSec`,
  `publishedText` (raw label), `publishedAt` (ISO, from `/player`), `pos` (newest-first on the show page),
  `harvestedAt`.
- **`podcast_channel`** `id`(UC…, PK), `name`, `thumbnail` (avatar), `banner` (unused — avatar suffices),
  `description`, `harvestedAt`.

## Endpoints (`server/api.mjs`)

All whitelist-pure; all honor `allowFemale`/`blockVideos`/`kidZone` (parity) + the `blockedContentIds`
serve-time pass (matched against `videoId` / show `id` / `channelId`), identical to music.

| Endpoint | Returns |
|----------|---------|
| `GET /podcasts` | `{podcasts:[{id,name,author,channelId,thumbnail,episodeCountText}], version}` — replaces the Firestore read |
| `GET /podcasts/version` | `{version}` — the `podcastDatabaseNumber/latest` gate, for skip-refetch |
| `GET /podcast?id=MPSP…&offset=` | `{podcast:{…,description,categories}, episodes:[…], nextOffset}` — 30/page, newest-first by `pos` |
| `GET /podcast-channel?id=UC…` | `{channel:{id,name,thumbnail,banner?,description?}, shows:[…], episodes:[…latest by date]}` |
| `GET /podcasts/new-episodes?k=50` | `{episodes:[…]}` — latest across **all** whitelisted shows, newest-first by real `publishedAt` |
| `/search?q=` | now also returns `categories.podcasts` + `categories.episodes` (substring over show name / episode title) |

**Episode shape** (every list): `{videoId, title, podcastId, podcastName?, channelId?, thumbnail,
durationSeconds, publishedAt}`. `durationSeconds` = `0` only when YouTube has no length; `publishedAt` is a
real `YYYY-MM-DD` (what makes new-episodes sortable across shows). `/podcasts`, `/podcast`, `/podcast-channel`
are LRU-cached (cleared each reload). Account state (subscriptions / saved / for-later) is **not** a server
concern — it stays on the app's InnerTube account sync.

## Notes / gotchas

- **Whitelist purity is by construction** — only `podcastsWhitelist` shows are harvested, so a wrong `MPSP` id
  in Firestore harvests wrong content. (Seen: id `MPSPPL-Prl…` "Nexus" = a secular HVAC podcast — a whitelist
  data error, fixed in Firestore, not code. Same class as the music female-mismarks.)
- **`channelId` load-bearing** — resolved from the show header at harvest; 167/169 shows carry one. A show
  with no resolvable host ships without it and the client falls back to the show page.
- **`banner` not harvested** — the app uses the avatar; the field exists in the channel shape but is absent.
- **Whitelist expansion** — YouTube-Music-matching an external RSS list to `MPSP` ids is a one-off research
  task (name search → show-card `MPSP` extraction → name-similarity score, niqqud-stripped); exact-name
  matches are safe to whitelist, partials need review.

## Telemetry & data-driven surfaces (parity with music Top 50 / Trending)

Podcasts use the **same anonymous device telemetry** as music (`tracking.zemer.io`), because an episode is a
`videoId` and `ev_play` already carries `secs`/`dur`/`source`. The app emits episode `play` events with a
**`podcast…` source** (so podcast and music never conflate) and `dur` REQUIRED, plus a **`subscribe`** action
(the podcast "favorite"). App contract: `handoff-docs/zemer-app-podcast-tracking-request.md`.

- **Stats side** (`tracking.zemer.io/store/store.mjs` `summary()`): a `podcast` section scoped to
  `source LIKE 'podcast%'` — `topEpisodes` (device reach × **completion ≥ 0.20**, i.e. 20% of the episode
  heard, NOT the song world's flat 20s), `topSubscribes` (show/channel subscribe reach). Podcast plays are
  **excluded from the music `topPlays`** so a hit episode can't invade the music Top 50. The ingest accepts
  `subscribe`/`unsubscribe`; the title-resolver maps episode/show/channel ids to names.
- **Surface generator** (`harvester/podcast-surfaces.mjs`): fetches `/stats`, rolls episodes up to their show
  via the corpus episode→show map, and writes gitignored `data/podcast-surfaces.json` —
  `topShows` (score = qualified listens + `SUB_WEIGHT`×subscribe reach) and `trendingEpisodes`
  (reach × avg-completion; velocity is a later refinement, as music Trending started reach-primary).
  Fail-safe: a down/empty `/stats` leaves the last-good file. Runs on the twice-daily `zemer-autoplaylists`
  timer beside `radio-graph`.
- **Endpoints**: `GET /podcasts?sort=top` (Top Podcasts — telemetry order, alphabetical fallback) and
  `GET /podcasts/trending` (Trending Episodes). Both read the surfaces artifact live.

## Deploy

`deploy/zemer-podcasts.{service,timer}` (harvest: whitelist→onboard→prune→refresh, Shabbat-gated, under the
maintenance flock, ~6h) + `deploy/zemer-podcast-durations.{service,timer}` (the `/player` top-up through the
residential proxy, mirroring `zemer-dating`) + the `podcast-surfaces` step on `zemer-autoplaylists`. Install
steps + the one-line backup.sh change to include `data/podcasts-whitelist.json`: `deploy/PODCASTS-DEPLOY.md`.
