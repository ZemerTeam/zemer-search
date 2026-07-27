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
score = 2.0·session-cooc  +  1.25·library-cooc  +  0.2·same-artist(shrunk-reach)   (+ small tie jitter)
```

- **library co-occurrence** — tracks that co-live in the same devices' libraries (plays ∪ backfilled history
  ∪ favorites ∪ downloads). Broad taste similarity; the **coverage workhorse** (the backfilled libraries are
  what make most of the catalog seedable).
- **session co-occurrence** — tracks played in the same listening *session* (live plays, 30-min gap). The
  contextual "what actually plays next" signal; best at cross-artist coherence.
- **same-artist** — a small shrunk-reach boost so the seed's own artist stays present without dominating.

Both graphs are **cosine-normalized** with device-support ≥ 2 (a single device can't mint an edge), so a
globally-popular track doesn't get recommended for everything. Then: a **diversity cap** (≤ 2 of one artist
in a row), and a **popularity backfill** so the queue is endless.

### Cold seeds never fail

A seed with no co-occurrence data (a brand-new release, an obscure track) degrades gracefully, never empty,
never off-whitelist:

1. **song, no cooc → artist-level cooc**: aggregate the co-listening neighbors of the seed *artist*'s other
   tracks (a fresh single by a known artist still gets real relatedness).
2. **no artist signal → same-artist catalog**, then **era + content-class leaning popularity** (so the tail
   still feels of-a-piece).
3. **album** always opens with its own tracks (in order); **shuffle** never needs a seed.

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
too. Representative run (grows/tightens as telemetry accumulates):

| model | hit@20 (all) | hit@20 (cross-artist) | hit@20 (rare, debiased) |
|---|---|---|---|
| popularity (naive shuffle) | ~4–5% | ~6–8% | **0%** |
| same-artist | ~23% | ~1% | ~11% |
| **co-occurrence blend** | **~35%** | ~12% | **~22%** |

The blend is ~7–9× popularity and wins on rare, non-hit tracks (where popularity scores 0) — i.e. it surfaces
genuinely related material, not the same handful of hits. **Re-run this bench as data grows**; a good radio
should hold well above popularity. The engine weights and the bench's blend are kept in sync (the bench
comment flags it).

## Sequencing (app side)

Once `/radio` is live: un-hide + wire the artist Radio button, swap album automix + `LocalAlbumRadio` off
`YouTube.next()`, and point Home "Radio mode" at `kind=shuffle`. See the handoff thread. This supersedes the
per-user radio half of [radio-feasibility.md](radio-feasibility.md) (the synchronized-*stations* idea there
remains future work).
