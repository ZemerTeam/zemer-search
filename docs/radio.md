# Zemer Radio — corpus-native "what plays next"

Zemer Radio replaces the app's `YouTube.next()` (artist/album/song Radio buttons + Home "Radio mode") with
a **whitelist-pure, corpus-native continuation**. It chooses the *sequence* of videoIds; audio still streams
from YouTube (irreducible). This is the last app-runtime InnerTube *browse* call on those surfaces — see the
InnerTube-retirement north star in [architecture.md](architecture.md).

> **The bar is BETTER than InnerTube, not worse.** We measured before shipping (see [Quality](#quality)).

## Why a corpus radio can win

Two axes, both decisive for *this* audience:

1. **Purity (structural, unbeatable).** Every track is whitelisted/kosher **by construction**. `YouTube.next()`
   on a niggun/chassidic seed drifts into mainstream/secular content within a few tracks — the founding
   failure this whole project exists to fix. YT *cannot* not do that; we can't leak off-whitelist.
2. **Coherence (measured).** Corpus-native co-listening ("people who play this play that") predicts the next
   track **7× better than popularity** and beats same-artist, including on rare/non-hit tracks — see below.

## The model (`index/radio.mjs`)

Pure data (no DB, no platform deps — ports to Kotlin identically, like all of `index/`). Per candidate:

```
score = 2.0·session-cooc + 1.25·library-cooc + 0.2·same-artist(shrunk-reach) + 0.08·artist-tier   (+ tie jitter)
```

- **library co-occurrence** — tracks that co-live in the same devices' libraries (plays ∪ backfilled history
  ∪ favorites ∪ downloads). Broad taste similarity; the **coverage workhorse** (the backfilled libraries are
  what make most of the catalog seedable).
- **session co-occurrence** — tracks played in the same listening *session* (live plays, 30-min gap). The
  contextual "what actually plays next" signal; best at cross-artist coherence.
- **same-artist** — a small shrunk-reach boost so the seed's own artist stays present without dominating.
- **artist tier** (`graph.art`) — the *coverage* tier: **artist×artist** co-occurrence over device libraries,
  far denser than track×track (~2× the artist coverage — an artist only needs 2 devices holding *anything*
  of theirs), pulling related artists' top tracks into the queue. **Must stay below same-artist**
  (bench-measured: sub-same-artist weights are safe on every cut and lift the no-track-cooc fallback zone;
  bigger weights drown the seed artist's own catalog and collapse it).

Both graphs are **cosine-normalized** with device-support ≥ 2 (a single device can't mint an edge), so a
globally-popular track doesn't get recommended for everything. Then: a **skip dock** (below), a **diversity
cap** (≤ 2 of one artist in a row), and a **popularity backfill** so the queue is endless.

### Skip dock + feedback-loop guard (2026-07-29)

Radio is the app's #1 play source, so two negative-signal protections apply:

- **Skip dock** — every ordering (cooc head, seeded backfill, shuffle) is multiplied by a shrunk
  listen-through rate (`(listened + 2.5)/(plays + 5)`, vs the 50% norm; floored at 0.35, never an
  exclusion). A track users bail on — on any surface — sinks in radio. Per-track `[listened, total]`
  arrives in the graph artifact (`skip`, plays ≥5 only).
- **Feedback-loop guard** (in zemer-stats `radioGraph`) — **radio-sourced plays are excluded from the
  session graph** (the engine's own sequencing must not become its own training signal: recommend A→B →
  passive acceptance → stronger A→B edge → recommend harder), and **live plays must be listened (≥50% /
  ≥45s) to join a device's library** (a 5-second skip is negative signal, not taste — before this, an
  autoplayed-and-skipped track *strengthened* the very edge that queued it). Bench effect of the cleaner
  semantics: blend hit@20 33→42% on deliberate-session gold.

The production KPI is the **daily radio skip%** (`radioDaily` on the zemer-stats dashboards; ~70–78%
during the YouTube.next() era — watch it fall as the corpus-native radio rolls out, and tune against it).

### Acapella exclusion (product rule, 2026-07-29)

Radio (all kinds, incl. shuffle) **never plays acapella** — the same master set that excludes acapella
from Trending/Top Downloaded/stations (curated `acapella` videoIds read un-gated + `acapella-auto` + the
strict clear-label title marker) — with exactly two exceptions:
1. **The Three Weeks** (the Hebrew-calendar gate, `corpus/season.mjs#inThreeWeeks`, passed per-request as
   `acapellaOk`) — in-season, acapella flows normally.
2. **Acapella-intent seeds**: an acapella `song` seed, an `album`/`playlist` containing acapella, or a
   **majority-acapella artist** (an acapella group's own radio must not exclude its own catalog).

### Cold seeds never fail

A seed with no co-occurrence data (a brand-new release, an obscure track) degrades gracefully, never empty,
never off-whitelist:

1. **song, no cooc → artist-level cooc**: aggregate the co-listening neighbors of the seed *artist*'s other
   tracks (a fresh single by a known artist still gets real relatedness).
2. **no track signal → the artist tier** (related artists' top tracks via `graph.art`), then **same-artist
   catalog**, then **era + content-class leaning popularity** (so the tail still feels of-a-piece).
3. **album** always opens with its own tracks (in order); **shuffle** never needs a seed.

**The seed always leads the queue:** a `song` seed plays **that song** first, an `artist` seed leads with one
of the **artist's own songs** (popularity-leaning, jittered per session), an `album` seed opens with the
album's tracks in order — then the radio expansion follows.

The unvalidated fallback tail (pure popularity) is the *only* part not backed by the measurement below; the
co-occurrence head is.

### Endless, stateless continuation

The full ordering is a deterministic function of `(kind, seed, flags, rngSeed)` — **not** of the page offset.
A **fixed-length canonical station** (500 tracks, diversified) is materialized identically for every page, so
paging is a pure prefix slice — no dup, no skip — and it survives the cluster + restarts with **no server
session state**. The API's `continuation` token is just `base64url({kind, seed, flags, rngSeed, offset})`
(opaque to the app; it only scopes the user's own queue, so it isn't signed). `rngSeed` (minted once per fresh
station) gives per-session variety while keeping pages reproducible.

## The graph artifact

Device-level co-listening is sensitive, so it **never leaves the telemetry process** — the boundary already
enforced for search queries in zemer-stats. Instead:

- **zemer-stats** computes the graph (`store.radioGraph`) and serves only **aggregated** neighbor lists at
  `GET /radio-graph` (STATS_KEY-gated, cached ~6h): `{pop:{id:reach}, lib:{id:[[nbr,score]]}, sess:{…}}` — no
  device rows, no sessions. Same privacy bar as `topPlays`/`topBackfilled`.
- **zemer-search** `harvester/radio-graph.mjs` fetches it, **corpus-intersects** (drops every id — seed key or
  neighbor — not in the current corpus, so a de-whitelisted/never-harvested track can't surface), and writes
  the gitignored `data/radio-graph.json`. Runs with `auto-playlists` on the twice-daily `zemer-autoplaylists`
  timer (Shabbat-gated); fail-safe (a down `/radio-graph` leaves the last-good graph) and a no-op when
  unchanged. The API reload gate watches the file's mtime → picks it up with **no restart**.

Missing graph entirely ⇒ the engine falls back to same-artist + popularity, so `/radio` still works (just less
tailored) before the first fetch.

## The endpoint

`GET /radio?kind=artist|album|song|shuffle|playlist&seed=<id>&allowFemale=&blockVideos=&kidZone=&limit=` →
`{tracks:[ZemerTrack], continuation}`; `GET /radio?continuation=<token>` pages it. Full contract in
[api.md](api.md). Content flags + blocked-ids are applied **in-engine**, identical to `/search` (a
female-blocked queue never contains a female-involved track; verified).

**`kind=playlist`** expands from the playlist's *member* tracks (the same seed-set mechanism as `kind=album`):
the server resolves membership — **community** playlists carry it stored (`community_playlist_track`, pure
corpus), any other playlist resolves via one IP-safe live fetch (as `/playlist` does) — and the engine
aggregates the members' co-occurrence neighbors. Non-corpus members are dropped in-engine, so it stays
whitelist-pure. This is the last radio surface (playlist menu "Start radio").

## Quality

Measured by `zemer-stats/bench/radio-eval.mjs` — **held-out next-track prediction**: build the graph on 80% of
devices, then on the remaining held-out device sessions ask "given the track playing, does the model rank the
one the user *actually* played next in the top 20?" Popularity-debiased (rare gold) and cross-artist reported
too. Latest run (2026-07-29, deliberate-session gold under the feedback-loop-guard semantics; grows/tightens
as telemetry accumulates — re-run rather than trust these):

| model | hit@20 (all) | hit@20 (cross-artist) | hit@20 (rare, debiased) |
|---|---|---|---|
| popularity (naive shuffle) | ~4% | ~7% | **0%** |
| same-artist | ~28% | ~1% | ~16% |
| **blend + artist tier** | **~42%** | ~13% | **~32%** |

The blend is ~10× popularity and wins on rare, non-hit tracks (where popularity scores 0) — i.e. it surfaces
genuinely related material, not the same handful of hits. **Re-run this bench as data grows**; a good radio
should hold well above popularity. The engine weights and the bench's blend are kept in sync (the bench
comment flags it).

## Sequencing (app side)

Once `/radio` is live: un-hide + wire the artist Radio button, swap album automix + `LocalAlbumRadio` off
`YouTube.next()`, and point Home "Radio mode" at `kind=shuffle`. See the handoff thread. This supersedes the
per-user radio half of [radio-feasibility.md](radio-feasibility.md) (the synchronized-*stations* idea there
remains future work).
