# Zemer Stations — synchronized broadcast radio

The second radio product from [radio-feasibility.md](radio-feasibility.md): **one shared wall-clock
program per station — every listener hears the SAME track at the SAME moment**, like a real radio
station. Distinct from `/radio` (personalized queues): stations are lean-back, communal, and zero-choice.
Audio still streams from YouTube; the server owns only the *program*.

Launch catalog (all driven by the whitelist style tags, see [store.md](store.md)):
- **`chasidish`** — Chassidish Radio (`isChasid` artists; crowd-verified tags)
- **`dj`** — DJ / Remix Radio (`isDJ` artists)
- **`israeli`** — Israeli Radio (`!isAmerican` artists; the axis is crowd-verified and fully populated)

## How the broadcast works

**A materialized schedule** (`data/stations.json`, gitignored) is the single source of truth:
`[[videoId, startMs, durationSec], …]` per station, contiguous and gap-free. `harvester/stations.mjs`
regenerates on the twice-daily `zemer-autoplaylists` timer (12h cadence vs a 48h horizon = 4× safety
margin): it prunes entries older than 6h, keeps the **currently-playing + imminent entries (a 10-minute
guard window) IMMUTABLE — a regeneration can never jump a live listener mid-song** — and **rewrites the
un-aired future** under fresh pool filters before extending to +48h (so a newly-blocked id or
de-whitelisted artist is purged from the program within one run, ≤12h). Selection is fully deterministic
(an LCG carried in persisted state; the no-repeat/artist-spacing memories are rebuilt from the kept
entries across the rewrite) and every cluster worker serves the identical program.

**Serving is pure clock math** (`server/api.mjs` + `index/station.mjs#scheduleAt`): binary-search the
entry containing `Date.now()`, return it with `offsetMs` + upcoming entries + `serverTimeMs` (so clients
can correct their clock skew). No server session state; restarts/cluster-safe by construction.

## Programming (`index/station.mjs#extendSchedule`)

Per slot, deterministic weighted pick:

```
weight = (shrunkReach^1.6 + 0.015) × skipMul × (1 + 3·cooc(prev)) × jitter
```

- **Familiarity-first**: reach^1.6 leans hard toward what listeners actually play — measured at ship:
  **87% / 72% / 83%** of scheduled slots (chasidish/dj/israeli) come from listener-validated tracks vs
  pool baselines of 31% / 50% / 28%. The 0.015 floor keeps a discovery sprinkle (never a closed loop).
- **Self-improving**: `skipMul` is the same shrunk listen-through dock as `/radio`, fed by ALL play
  sources — once the app tags station plays (`source: "station:<id>"`), a track skipped on-air sinks in
  the next schedule automatically. Station plays are **excluded from session-graph training** in
  zemer-stats (same feedback-loop guard as radio: the scheduler's own sequence must not train itself).
- **Flow**: the co-occurrence bonus chains neighbors of the previous track (graph `lib`+`sess`), so the
  program transitions rather than shuffles (unit-pinned: >60% cluster-coherent transitions on a wired
  synthetic).
- **Variety**: no artist within **3 consecutive slots** (stronger than "not in a row"); a track cannot
  return until ~**half the pool** has played (capped 4,000). Both unit-pinned. Tiny pools relax the
  memory instead of deadlocking.

## Pool policy (a shared stream must be kosher for every listener)

A synchronized station cannot be personalized, so pools are pre-filtered to the strictest common
denominator at build time: tagged artists only, **no female-involved tracks** (the `/search` featuring
rule AND the curated blocked-ids `female` overrides), **NO SEASONAL MUSIC** (`purim` `pesach` `chanukah` `yamim-noraim` `succos` `shavuos-simchas-torah` `lag-baomer` `tu-bishvat` `three-weeks` — a station is one shared year-round stream, so a Purim song in Elul is jarring for every listener at once and nobody can skip it; the recurring `shabbos`/`melave-malka`/`rosh-chodesh` genres stay in, being ordinary listening here. Seasonal material lives on its own surfaces: the curated/auto seasonal playlists and genre radio, which IS skippable and asked for deliberately), **NO ACAPELLA** (product rule — the same master set
that excludes acapella from Trending/Top Downloaded: curated `acapella` videoIds read un-gated +
`acapella-auto` + the strict clear-label title marker), **no globally-blocked ids**, **audio only** (no
videos), real durations (≥30s). Audio-only has a second layer beyond the stored `isVideo` flag: the
**`/player`-classified exclusion list** `data/player-video-ids.json` (gitignored; from
`backfill-video-type-player.mjs`, see [harvester.md](harvester.md)) — real videos that were harvested off a
Songs shelf and stored `isVideo=0` (real case, 2026-07-30: a wedding-recap clip aired). Both the pool filter
and serve-time `servable()` honor the flag AND the list, so an exposed video falls out of the broadcast
immediately, not at the next rewrite. The list is **stations-only by design** — search categories and
`blockVideos` filtering are untouched (a corpus `isVideo` flip would visibly move ~1.2k tracks app-wide).
Post-scheduling takedowns are three-layered: the **API drops blocked / out-of-corpus ids at SERVE time** (the ~10-min overrides-timer SLA, gotcha #7 — an unservable live entry
makes the broadcast momentarily "between tracks": the next servable entry is served as `now` with a
NEGATIVE `offsetMs`, i.e. "starts in |offset| ms"), the **generator purges them from the un-aired future**
each run (≤12h), and the **app applies its own blocked list** at play time (handoff doc). Stations are NOT
kidZone-filtered — the app hides station cards in kidZone mode.

## Two kinds of station

**Artist-tagged** stations slice the roster by curated whitelist flags (`chasidish`, `dj`, `israeli`).
**Genre-pooled** stations slice by `track.genres` — a property of the RELEASE, so they express things an
artist tag cannot (`nigunim`, `calm`/Chill). A genre station must clear two gates or it is skipped and
its previous schedule carried forward: **≥150 pool tracks** after the kosher-for-all filters, and **≥20%
of that pool already listened to** by the audience. Stations are programmed familiarity-first, so a pool
nobody has played produces a stream nobody recognises — `instrumental` sat at 13% listened and would have
aired 27% listener-validated slots against 67–88% for every other station, so it is not in the catalog.
See [genres.md](genres.md).

## Endpoints

- **`GET /stations`** → `{count, stations:[{id, title, thumbnail, live, nowPlaying:{title, artist,
  thumbnail}}], serverTimeMs}` — the card list (thumbnail = the generated broadcast-style SVG cover,
  `/stations/cover?id=…`: same palette/design language as the playlist covers, with on-air waves + LIVE
  badge).
- **`GET /station?id=<id>&next=<1..10>`** → `{station:{id,title,thumbnail}, serverTimeMs, horizonMs,
  now:{videoId,title,artist,artistId,thumbnail,durationSec,startMs,endMs,offsetMs}, next:[…]}` —
  tune-in: play `now.videoId` seeking to `offsetMs` (corrected by the client's measured skew vs
  `serverTimeMs`), preload `next`. `offsetMs` may be **negative** (a takedown gap — the served track
  *starts in* |offset| ms; see content policy). Blocked/out-of-corpus ids never appear in
  `now`/`next`/`nowPlaying`. `404` unknown id; `503` = schedule exhausted (generator down —
  fail-soft, the app hides the card).
- Served from an mtime-cached artifact read; a torn/missing file keeps last-good (a generator swap can
  never 500 a tune-in).

## Ops

- `node harvester/stations.mjs` (offline; `DRY=1` previews; `STATION_HORIZON_H` overrides). Runs as the
  third `ExecStart` of `zemer-autoplaylists.service`.
- `/station.horizonMs` is the watchdog: it should sit between ~36h (just before a run) and ~48h. Falling
  below 12h means the generator has missed ≥3 runs.
- Adding a station = one line in `harvester/stations.mjs`'s `STATIONS` catalog (id, title, artist
  predicate) + optionally a fixed color in `STATION_COLOR`.

## App-side contract

See the handoff doc (`zemer-app-stations.md`, outside this repo): the "Zemer Radio" home row, the tune-in
sync algorithm (skew correction, drift handling, track-boundary refetch), pause semantics (resume = jump
to live, not resume — it's a broadcast), and the `source: "station:<id>"` telemetry that closes the
self-improvement loop.
