# Testing & measurement harnesses

The matcher is tuned against numbers. Everything here is **offline** (reads the live `corpus.db`, no
network) except `loadtest` (hits a running API). Run any via `npm run <name>`.

## Unit tests — `npm test` (`node --test index/ corpus/ harvester/`)

Pinned regression tests, one or more per **gotcha** (see [gotchas.md](gotchas.md)). If one goes red,
you've reintroduced a known bug. Covers: cross-script alignment, Damerau transposition, no-false-
positives, synonyms, begins-with > contains, skeleton-collapse, fuzzy-no-affinity, apostrophe-join, IDF,
the store's detail accessors + channel map + community-playlist round-trip/removal, and the
community-playlist admission gate + seed builder (`harvester/`).

## `relevance` — track ranking quality

For a deterministic sample of tracks, generates realistic queries (exact title, title prefix,
artist+title, typo) and measures **P@1 / P@3 / MRR** (does the source track rank #1 / top-3). Plus curated
"what a human types" queries asserting the **top** result is correct. Round-trip P@1 is partly bounded by
genuine ambiguity (a title prefix legitimately matches several songs) — read P@3 alongside it.

## `category-relevance` — entity (artist/album/single) search

Measures full-name / typed-prefix / typo **P@1 & P@3** for artists, albums, singles via the real
`searchCategories` path, plus an as-you-type partial-title → song metric. Current ballpark: **artists full
P@1 ~99% (P@3 100%), albums ~98%, singles ~91–94%**; prefix P@1 ~80–93%.

## `audit` — precision (false positives)

Runs a battery of varied queries (short prefixes, full names, cross-script, Hebrew, typos, **garbage**)
and flags any returned result with **no genuine textual connection** to the query. Target: **0 suspicious,
garbage → 0 results**. (Scaled checks over 1,000+ auto queries have shown **0.000%** false positives.)

## `fuzz` — crash + recall + integrity, maximum variation

Random *diverse* entities (not hand-picked) + 41 weird inputs (emoji, RTL marks, 600-char strings,
hashtags, quotes, geresh, numbers). Asserts: **0 crashes**, full-name **recall ~100%** per category
(checking the *correct* category — videos vs songs!), **0 false positives** on special-char queries, **0**
mis-shaped category results.

## `deep-test` — correctness beyond recall/precision

Content filtering (`blockVideos`/`allowFemale=false`/`kidZoneOnly` actually filter), playlist search
P@1/recall, **begins>contains for every category**, synonyms (`mbd → Mordechai Ben David`), and
determinism. Note: a few residual begins>contains "violations" are **cross-script skeleton collisions**
(e.g. "אקסן" shares the skeleton "ksn" with "chasunah") — confirmed test artifacts, not matcher bugs.

## `loadtest` — throughput (needs a running API)

`node bench/loadtest.mjs [total] [concurrency]` against `API` (default `http://localhost:7700`). Simulates
as-you-type traffic (every growing prefix of popular queries). `UNIQUE=1` forces all cache misses (worst
case). Reports req/s, avg/max latency, errors.

## `bench` / `diag-typos` — the original LIKE-vs-index proof + typo diagnostics

`bench` compares the index to the app's `title LIKE '%q%'` over the same whitelisted corpus (sampled).
`diag-typos` breaks down typo misses.

## `npm run verify` — the one-command accuracy gate

`node --test index/ corpus/ harvester/ && audit && fuzz && deep-test` — runs the full correctness/precision
suite in one go. **Must stay green.** Use it before/after any matcher change and as a regression gate.

## How to use them when changing the matcher

```bash
npm run verify                                  # correctness/precision — must stay green
npm run relevance && npm run category-relevance # ranking — compare before/after
```

The corpus grows during a harvest, so cross-run numbers drift a little — for a clean A/B, toggle the
change behind an env var and run both in one process, or pause the harvest.

## Keep testing as the corpus grows (standing directive)

The harvest indexes new artists continuously, so **re-run the suite as the corpus grows** — new material
exposes new edge cases (this is how the female-default, skeleton-collapse, fuzzy-affinity, and apostrophe
bugs were caught). The harnesses already sample **random, diverse** entities (not fixed subjects), so
each run uses fresh material. Re-run `npm run verify` at milestones (e.g. every few hundred newly-indexed
artists, and once the full ~1,608-artist harvest completes); investigate any new flag (most are the known
test artifacts in [gotchas.md](gotchas.md) — confirm before "fixing"). A query that returns a weak/empty
result for a **whitelisted but not-yet-harvested** artist is expected, not a bug.
