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

**A materialized, APPEND-ONLY schedule** (`data/stations.json`, gitignored) is the single source of truth:
`[[videoId, startMs, durationSec], …]` per station, contiguous and gap-free. `harvester/stations.mjs`
extends each schedule to **+48h** on the twice-daily `zemer-autoplaylists` timer (12h cadence = 4× safety
margin) and prunes entries older than 6h. Append-only is the crucial invariant: **published entries are
never rewritten, so a regeneration can never jump a live listener mid-song.** Selection is fully
deterministic (an LCG carried in persisted state) — concurrent generator runs produce identical output,
and every cluster worker serves the identical program.

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
denominator at build time: tagged artists only, **no female-involved tracks** (same featuring rule as
`/search`), **no globally-blocked ids**, **audio only** (no videos), real durations (≥30s). A track
blocked *after* scheduling stands ≤12h (until the next run); the app also applies its own blocked list at
play time (see the handoff doc). Stations are NOT kidZone-filtered — the app hides station cards in
kidZone mode.

## Endpoints

- **`GET /stations`** → `{count, stations:[{id, title, thumbnail, live, nowPlaying:{title, artist,
  thumbnail}}], serverTimeMs}` — the card list (thumbnail = the generated broadcast-style SVG cover,
  `/stations/cover?id=…`: same palette/design language as the playlist covers, with on-air waves + LIVE
  badge).
- **`GET /station?id=<id>&next=<1..10>`** → `{station:{id,title,thumbnail}, serverTimeMs, horizonMs,
  now:{videoId,title,artist,artistId,thumbnail,durationSec,startMs,endMs,offsetMs}, next:[…]}` —
  tune-in: play `now.videoId` seeking to `offsetMs` (corrected by the client's measured skew vs
  `serverTimeMs`), preload `next`. `404` unknown id; `503` = schedule exhausted (generator down —
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
