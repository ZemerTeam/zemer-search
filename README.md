# zemer-search

A custom search engine for **Zemer** that searches a **pre-built index of only the whitelisted artists'
catalogs** instead of searching all of YouTube and filtering afterward. Accurate by construction (no
off-corpus noise), with **Hebrew-aware fuzzy matching** YouTube/`LIKE` can't do.

> The sibling `zemer-app` repo is treated as **immutable** — code is *ported* from it, never edited.
> App-side integration is a deferred later step. **All inputs are env-configurable** so this deploys
> to a real server unchanged (one Node process + one DB file).

## Architecture
**Hybrid, one search engine in two places:**
- **Server (primary):** harvest every whitelisted artist's complete catalog → **SQLite** corpus store
  (`corpus.db`) → an **in-memory index** loaded by the HTTP `/search` API. No Typesense, no Postgres —
  the corpus is small, so it lives in RAM; the server is **one Node process + one SQLite file**, trivial
  to deploy. The on-device matcher and the server matcher are the **same code**.
- **On-device (fallback):** a compact, gzipped subset → the **pure-Kotlin-portable in-memory index**
  (prototyped here in JS). Works offline / when the API is down. **No SQLite-FTS, no platform ICU** →
  identical on Android API 26 → 36. (SQLite is used only *server-side* as the corpus store; it never
  ships to a phone, so it has no Android-version implications.)

### The fuzzy lever: a Hebrew-aware consonant skeleton
Hebrew is vowel-less, so we reduce both the indexed text **and** the query to a folded **consonant
skeleton** — romanize the strong consonants, drop the matres lectionis (א ה ו י ע) + Latin vowels, fold
ambiguous pairs (b/v=ב, k/ch, p/f, s/sh, t/th, tz). A romanized query aligns with the Hebrew title:
`kevakarat → kbkrt` ⟵ `כבקרת → kbkrt`. Pure string ops (`index/normalize.mjs`), plus Damerau distance
(transposition = 1 edit) and synonym groups (abbreviations the skeleton can't infer). The matcher scales
**sub-linearly**: prefix via binary search, fuzzy via a boundary-padded **bigram candidate index** (no
full-vocab scan) → sub-millisecond to low-ms per search depending on corpus size.

## Measuring

Run the benchmarks against the live corpus — results reflect whatever is indexed:

```bash
npm test                    # unit tests (normalize, search, store)
npm run verify              # full gate: tests + audit + fuzz + deep-test
npm run bench               # typo recall vs app LIKE, cross-script, subset size
npm run relevance           # per-query ranking spot-check
npm run category-relevance  # ranked results per category
```

## Quickstart
```bash
npm install                                                 # better-sqlite3
node harness/whitelist.mjs                                  # → data/whitelist.json (reads app's google-services.json read-only)

# harvest (writes corpus.db; per-artist durable upserts; cached + paced; aborts on anti-bot block)
# no cookie needed — browse/search are unauthenticated
N=100 node harvester/harvest.mjs
node harvester/refresh.mjs                                  # incremental maintenance (run on a schedule)

npm test                                                    # unit tests
npm run bench                                               # vs the app's LIKE search (sampled)
node index/query.mjs "kevakarat"                            # ad-hoc query
node index/build-subset.mjs                                 # → data/subset.json.gz (ship to the app)
npm run api                                                 # GET /search?q=...&allowFemale=0&kidZone=1&blockVideos=1&k=10  (POST /reload after a refresh)
```
Env: `CORPUS_DB`, `PORT`, `MIN_INTERVAL_MS`/`JITTER_MS` (harvest pacing), `MAX_AGE_H` (refresh TTL).

## Layout
- `harness/` — ported InnerTube request layer (`lib.mjs`, `clients.mjs`), the **cached +
  rate-limited net layer** (`net.mjs`, gzipped disk cache + TTL), browse/artist parser (`browse.mjs`),
  whitelist fetcher.
- `harvester/` — `core.mjs` (shared per-artist complete-catalog harvest), `harvest.mjs` (initial),
  `refresh.mjs` (incremental). IP-safe: cached, paced, **aborts on the first anti-bot block**.
- `corpus/store.mjs` — **SQLite** source-of-truth (normalized artist/track, WAL, per-artist upserts).
- `index/` — `normalize.mjs` (skeleton + Damerau), `search.mjs` (bigram/binary-search in-memory engine),
  `synonyms.mjs`, tests, `query.mjs`, `build-subset.mjs`.
- `server/api.mjs` — HTTP search API (SQLite → in-memory matcher; content-filter scoping; `/reload`).
- `bench/` — `bench.mjs` (vs `LIKE`), `diag-typos.mjs`.
- `data/` — `corpus.db`, `whitelist.json`, the gzipped HTTP cache (`.httpcache/`, prunable).

## Constraints honored
- **IP-safe:** all YouTube traffic single-flight, paced, jittered, **cached** (never re-fetched), stops
  on the first anti-bot page; benchmark is 100% offline.
- **Disk-safe:** HTTP cache gzipped; `corpus.db` compact; no Typesense container.
- **Cross-version:** on-device search is pure-Kotlin/JVM-portable (no FTS5, no platform ICU).
- **Server-portable:** one Node process + one SQLite file; all paths/secrets via env.
- **`zemer-app` immutable; no commits anywhere.**

## Status / next
Server path proven end-to-end. The harvest is growing the corpus toward the full 1,608 artists
(politely, in the background). Remaining: finish the harvest, a daily `refresh` schedule, an expanded
synonym list, and the deferred app-side `SearchProvider` integration (touches `zemer-app`).

## License

GNU General Public License v3.0 — see [`LICENSE`](LICENSE). zemer-search ports InnerTube request/parser
code from [Zemer](https://github.com/ZemerTeam/zemer-app), which is based on
[Metrolist](https://github.com/MetrolistGroup/Metrolist); both are GPLv3, so this project is GPLv3 as well.
