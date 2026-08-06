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
  - **Durable show art (read-time).** The harvested `thumbnail` is often a YouTube shape that is *advertised
    but never served* — `i.ytimg.com/pl_c/…/studio_square_thumbnail.jpg` and `…/podcasts_artwork/…/
    auto_created_podcast_show_avatar.jpg` both 404 even bare (dead path, not an expired `sqp` signature);
    ~89% of shows carried one. So every show/channel DTO resolves art at read time (`makeShowArtResolver` /
    `isDeadShowArt` in `corpus/podcasts.mjs`): keep a durable stored value, else the **host-channel yt3
    avatar** (via `channelId`, always 200), else a **first-episode `/vi` thumbnail**. Read-time so a
    re-harvest re-storing the dead url can't regress it; the wire contract is unchanged (same `thumbnail`
    field). Applied on `/podcasts`, `/podcast`, `/podcast-channel` (shows shelf + channel header), and the
    `/search`-folded podcast group (`allPodcastShowDocs`). The `content.zemer.io` mirror carries the same
    resolved value in its `podcastsWhitelist.thumbnailUrl` (backfilled from the same source).
- **`podcast_episode`** `videoId`(PK — the playable id), `showId`, `title`, `thumbnail`, `durationSec`,
  `publishedText` (raw label), `publishedAt` (ISO, from `/player`), `pos` (newest-first on the show page),
  `harvestedAt`.
- **`podcast_channel`** `id`(UC…, PK), `name`, `thumbnail` (avatar), `banner` (unused — avatar suffices),
  `description`, `harvestedAt`.

## Channel-level whitelist (same model as the artist whitelist)

Podcasts are whitelisted by **host channel** (`UC…`), not by show (`MPSP…`): approve a publisher and its whole
catalog is kosher, exactly like approving a music artist channel. The allow-set is derived at reload from the
show list in `data/podcasts-whitelist.json` (grouped by `channelId`) into `podcastAllow` (the approved `UC`
set, per-channel content flags, a grandfathered set, and the wholly-female-channel show set). Every podcast
endpoint applies a **serve-time channel-membership gate** (like community purity / blocked-ids), so a
de-approved channel's shows stop serving immediately, before prune.

- **Female / KidZone stay per item** (the music hybrid): a `channel.isFemale`/`isKidZone` flag applies only
  when *every* show on the channel is that (a wholly-female publisher), and per-item exceptions on a **mixed**
  channel are handled by `blockedContentIds` (female show `MPSP` / episode `videoId`), just like a whitelisted
  music artist's one blocked track. KidZone still hides all podcasts (no kid flag) unless a channel is
  `isKidZone`.
- **Grandfathered shows**: the few shows YouTube exposes no host `UC` for are kept as a small show-level
  allow-set (reachable via `/podcasts` + `/podcast?id=`, not the channel grid).
- `harness/podcasts-whitelist.mjs` fetches the per-show content flags and derives the channel + grandfathered
  lists into the whitelist file; the API also re-derives from the show list so it works with any file version.
- **Full-catalog auto-discovery** (`harvester/podcast-channels.mjs`): approving a channel surfaces its whole
  catalog, not just individually-whitelisted shows. For each approved channel it reads the YT Music landing
  **"Podcasts" shelf** (`parseChannelPodcastShelf`, valid `MPSP` show ids), harvests the shows not yet in the
  corpus, and they serve immediately (channel-membership gating needs no per-show whitelist entry). The shelf
  is a capped preview (~10); its "more" link routes to an empty Music view for podcast host channels (their
  shows live on the **regular** YouTube channel, and the regular-channel `PL` ids don't map to the Music
  `MPSP` show ids — gotcha #13), so a channel with >~10 shows keeps only its top shelf (one channel in this
  corpus). **Content note:** channel-level over-approves for podcasts far more than for music, because host
  channels aggregate unrelated creators. The rollout scan surfaced a mis-whitelisted channel (a Ukrainian
  tech network) and a mixed channel (a kosher show beside secular ones); both are handled by the standard
  tools (de-whitelist the channel / `blockedContentIds` per show). Always review a discovery scan's new shows
  before serving. Runs `DRY=1` for a blast-radius preview.
- The `content.zemer.io` mirror carries the channel allow-set at `/podcastChannelsWhitelist` (UC-keyed docs:
  `id, name, thumbnailUrl, isFemale, isKidZone, isVerified, showCount`), derived from the show docs by
  `scripts/write-podcast-channels.mjs`; the show-level `/podcastsWhitelist` stays as the harvest work-list.

## Genres (`podcast_show.genres`, the podcast `/genres`)

Zemer-style genre slugs **per SHOW** (not per channel — a publisher hosts multiple genres, the same reason
music genre is a release property, not an artist one; and YouTube's own podcast categories are empty/useless).
Curated in **`data/podcast-genres.json`** (the durable source of truth) and applied by
**`harvester/podcast-genres.mjs`** → `podcast_show.genres` (comma-separated), REPLACE-WHOLESALE and idempotent
(the harvest never touches the column, so it survives re-harvest), `DRY=1` previews. Vocabulary (20):
`gemara parsha chassidus mussar halacha machshava tefilla stories history kiruv family parnassah health news
people music chizuk shiur moadim women` (a slug outside the set is dropped + reported, never written). Served
by **`GET /podcast-genres`** — no `id` = the catalog `{id,title,showCount}` with POST-FILTER counts; `?id=<slug>`
= the approved shows in that genre — same channel-membership + female/KidZone + blocked gate as `/podcasts`.
Genres ride the show DTO everywhere and fold into the on-device subset (`podcasts` shard, appended field).

## Endpoints (`server/api.mjs`)

All whitelist-pure; all honor `allowFemale`/`blockVideos`/`kidZone` (parity) + the `blockedContentIds`
serve-time pass (matched against `videoId` / show `id` / `channelId`), identical to music.

| Endpoint | Returns |
|----------|---------|
| `GET /podcast-channels` | `{channels:[{id:UC…,name,thumbnail,showCount,episodeCount}], version}` — the **channel grid** (approved publishers, durable avatar); the browse entry point |
| `GET /podcasts` | `{podcasts:[{id,name,author,channelId,thumbnail,episodeCountText}], version}` — the show list (channel-gated) |
| `GET /podcasts/version` | `{version}` — the `podcastDatabaseNumber/latest` gate, for skip-refetch |
| `GET /podcast?id=MPSP…&offset=` | `{podcast:{…,description,categories}, episodes:[…], nextOffset}` — 30/page, newest-first by `pos`; 404 if the host channel isn't approved |
| `GET /podcast-channel?id=UC…` | `{channel:{id,name,thumbnail,banner?,description?}, shows:[…], episodes:[…latest by date]}` — 404 unless `UC` is an approved publisher |
| `GET /podcasts/new-episodes?k=50` | `{episodes:[…]}` — latest across **all** approved shows, newest-first by real `publishedAt` |
| `/search?q=` | also returns `categories.podcasts` + `categories.episodes` (real matcher), channel-gated like the browse endpoints |

**Episode shape** (every list): `{videoId, title, podcastId, podcastName?, channelId?, thumbnail,
durationSeconds, publishedAt}`. `durationSeconds` = `0` only when YouTube has no length; `publishedAt` is a
real `YYYY-MM-DD` (what makes new-episodes sortable across shows). `/podcasts`, `/podcast`, `/podcast-channel`
are LRU-cached (cleared each reload). Account state (subscriptions / saved / for-later) is **not** a server
concern — it stays on the app's InnerTube account sync.

## Notes / gotchas

- **Whitelist purity is by construction** — only `podcastsWhitelist` shows are harvested, so a wrong `MPSP` id
  in Firestore harvests wrong content. (Seen: id `MPSPPL-Prl…` "Nexus" = a secular HVAC podcast — a whitelist
  data error, fixed in Firestore, not code. Same class as the music female-mismarks.)
- **`channelId` load-bearing** (channel-level whitelisting keys on it), resolved from the show header at
  harvest; some show pages carry NO host-channel link, so the harvest **falls back to the whitelist-provided
  `channelId`** (`harvester/podcasts.mjs`) rather than shipping it null (which would drop the show to
  grandfathered). A show with no host UC anywhere is grandfathered (a small show-level allow-set).
- **Prune is CHANNEL-aware, not show-whitelist-aware.** A show survives `PRUNE` iff its host channel is an
  approved publisher (or it is grandfathered), NOT iff its `MPSP` is individually whitelisted; otherwise the
  daily channel-catalog discovery's shows would be deleted on the next prune pass (they aren't individually
  listed; they live by channel membership). A show on a de-approved channel is still dropped.
- **A blocked SHOW blocks its EPISODES too.** `blockedContentIds` on a show `MPSP` drops its browse AND its
  episodes from the cross-show episode lists (`/search` folding, `/podcasts/new-episodes`, `/podcasts/trending`,
  a channel's latest shelf): those check the episode's `videoId` AND its parent `podcastId`, so a blocked
  show can't leak via episode search.
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
