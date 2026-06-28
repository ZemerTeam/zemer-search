# Working on zemer-search

A custom **whitelist-scoped, Hebrew-aware search engine** for the Zemer app. It replaces YouTube search
(which searches *all* of YouTube then drops everything non-whitelisted → sparse/empty results) with a
search over a **pre-built index of only the whitelisted artists' catalogs** — accurate by construction,
with cross-script (Hebrew ↔ romanized) and typo tolerance YouTube/`LIKE` can't do.

> **Sibling project, NOT the app.** The sibling `zemer-app` repo is **immutable** — read it to reuse/port
> code, never edit it. The app-side integration (a `SearchProvider`) is deferred and out of scope here.

Node ≥20, one dependency (`better-sqlite3`). `npm install` then see **Commands** below.

## The big picture

```
whitelist (Firestore)  →  harvester (InnerTube, IP-safe)  →  corpus.db (SQLite)  →  in-memory index  →  HTTP /search + web UI
                                                                    │                      ▲
                                                                    └── build-subset ──────┘ (same matcher, on-device fallback)
```

- **SQLite (`corpus/store.mjs`) is the durable source-of-truth.** It is **server-side only** — it never
  ships to a phone, so it has **no Android-version implications**.
- **The search engine is a pure-data in-memory index (`index/search.mjs`)** built from SQLite at startup
  and refreshed periodically. The *same matcher* serves the server (full corpus) and the planned
  on-device fallback (a gzipped subset). No Typesense, no Postgres — the corpus is small enough for RAM.
- **The on-device version must be pure Kotlin/JVM** (no SQLite-FTS, no platform ICU) so it behaves
  **identically on Android API 26 → 36**. Everything in `index/` is written to port cleanly: plain
  string ops, hand-rolled skeleton/Damerau, no platform deps.

## Layout

| Dir | What |
|-----|------|
| `harness/` | Ported InnerTube layer: `clients.mjs`, `lib.mjs`, `parsers.mjs`; **`net.mjs`** (gzip disk cache + bounded-concurrency rate-paced limiter + anti-bot circuit breaker; `cacheOnly` option for offline report passes); `browse.mjs` (artist/album/playlist parsers); **`search.mjs`** (IP-safe search via `net.mjs` — community-playlist discovery); **`player.mjs`** (IP-safe `/player` — the real release date, ISO `uploadDate`); `whitelist.mjs` (fetch Firestore whitelist, read-only); `status.mjs` (maintenance progress channel). Browse + search + player are **unauthenticated** — no cookie, no `visitorData`. |
| `harvester/` | `core.mjs` (shared per-artist harvest; shallow/deep), `harvest.mjs` (initial bulk), `onboard.mjs` (new artists), `refresh.mjs` (incremental; shallow daily / deep weekly), `prune.mjs` (drop de-whitelisted), **`playlists.mjs`** (community-playlist discovery — seed-search → whitelist-filter → quality-gate → store; revalidate prunes stale), **`releases.mjs`** (date releases precisely — one `/player` per album → `album.uploadDate`; makes New Releases accurate). |
| `scripts/`, `deploy/` | `maintain.sh` (refresh orchestrator: whitelist→onboard→prune→refresh under flock) + systemd timer/service units. |
| `corpus/store.mjs` | **SQLite** schema + store API (artist/track/album/playlist/album_track **+ community_playlist/community_playlist_track**). |
| `index/` | `normalize.mjs` (skeleton + Damerau + `skeletonKey`), **`search.mjs`** (the matcher), `synonyms.mjs`, `categories.mjs` (grouped/by-category search), `build-subset.mjs`, `*.test.mjs`. |
| `server/` | `api.mjs` (HTTP API + cluster + LRU cache; `/search` `/artist` `/album` `/playlist` `/new` `/community` `/health`+`maintenance`), `ui.html` (web UI: search chips + **Community** chip (browse-all, no search) + **New Releases** chip + live refresh-progress bar). |
| `bench/` | `relevance` `category-relevance` `audit` `fuzz` `deep-test` `loadtest` `bench` `diag-typos`. |
| `data/` | `corpus.db`, `whitelist.json`, `synonyms.json`, `blocklist.json` (curated exclusions: `videoIds`/`artistIds` + community `playlistIds` + `playlistTerms` title/curator screen), `playlist-seeds.json` (community-playlist discovery seed terms), `rejected-artists.txt` (generated: non-whitelisted artists seen in community playlists, for whitelist review), `.httpcache/` (gzipped, prunable). |
| `docs/` | Comprehensive deep-dive docs — read `docs/README.md`. |

## Commands

```bash
npm install                                                   # better-sqlite3
node harness/whitelist.mjs                                    # → data/whitelist.json (reads app google-services.json read-only)
N=100 node harvester/harvest.mjs                             # → corpus.db (per-artist durable upserts; no cookie — browse is unauthenticated)
node harvester/onboard.mjs                                    # harvest only NEW whitelisted artists (diff vs corpus)
node harvester/refresh.mjs                                    # re-harvest existing artists; DEFAULT deep (full); SHALLOW=1 = fast landing-only
node harvester/prune.mjs                                      # drop de-whitelisted artists (survivor-guard) + apply data/blocklist.json
node harvester/playlists.mjs                                  # discover COMMUNITY playlists (SEEDS=both FIRSTNAMES=1 N=4000 = full sweep; REVALIDATE=1 prunes stale)
node harvester/releases.mjs                                   # date releases via /player → album.uploadDate (MIN_YEAR=2025 = recent only); makes New Releases real-date-accurate
scripts/maintain.sh shallow|deep                             # orchestrate whitelist→onboard→prune→refresh (flock; cron/systemd; shallow daily / deep weekly)
npm test                                                      # unit tests (index/ + corpus/ + harvester/)
npm run verify                                                # FULL accuracy gate: test + audit + fuzz + deep-test (must stay green)
npm run relevance | category-relevance | audit | fuzz | deep-test   # individual measurement harnesses (offline)
npm run api                                                   # HTTP API + web UI on :7700  (WORKERS=auto to cluster)
npm run loadtest                                              # throughput test against a running API
```

## How the matcher ranks (read `docs/search.md` for the full spec)

Per query, every result gets `score = (idf-weighted token matches + coverage + multi-word artist-affinity) × position-boost`, then a precision floor trims weak hits. The levers:

- **IDF** — a match on a rare/distinctive token outweighs a common one ("live", "feat", a year).
- **Two scripts** — plain Latin tokens **and** a Hebrew-aware **consonant skeleton** (so romanized
  "kevakarat" → `kbkrt` aligns with Hebrew "כבקרת" → `kbkrt`).
- **Position boost: exact > begins-with > contains** (for both title and artist fields).
- **As-you-type** — the *last* query token is treated as a near-exact **prefix** (the word being typed).
- **Precision-first** — better to return fewer/no results than wrong ones (`REL_FLOOR`).

## ⚠️ GOTCHAS — every one of these was a real bug; don't reintroduce them

1. **Skeleton matching is OFF below 3 chars.** `"avr"` skeletonizes to `"br"` (2 chars), which would
   match "Beri", "Barditchover", "Bronx"… Short queries rely on the precise plain prefix. Skeleton
   *matching* and skeleton *boosts* both gate on a ≥3-char skeleton (`skKey`).
2. **Skeleton FUZZY is OFF entirely** (`SKEL.fuzzy = 0`). Fuzzy-on-skeleton is double-lossy and matches
   garbage to real words. Cross-script works via *exact* skeleton alignment; vowel-typos are already
   absorbed by dropping vowels.
3. **`skeletonKey` is word-ALIGNED; `skeletonTokens` is filtered.** The exact/begins **boosts** must use
   `skeletonKey` (one slot per plain token, nothing dropped). Otherwise "Yoni Shlomo" → `"slm"` collapses
   and *exactly* equals the one-word query "shlomo" → `"slm"`, stealing a false exact-match boost.
   Token **matching** still uses `skeletonTokens` (filtered ≥2).
4. **A FUZZY match contributes mask 0** — no artist-affinity, no position boost. Else "yom" fuzzy-matches
   "**you**" in "Thank You Hashem" and grants a coincidental track the artist-affinity.
5. **Artist-affinity is multi-word only** (`origCount >= 2`). For a single common word ("tov") a
   coincidental mid-artist-name match would otherwise beat a title that *begins* with the word.
6. **In-word apostrophes / geresh ׳ / gershayim ״ / quotes JOIN, not split** (`JOINMARK` in
   `normalize.mjs`). So `L'Chaim` → `lchaim`, and "lchaim" == "l'chaim". Splitting made "oconnor" return
   nothing and "lchaim" rank wrong.
7. **Content filters apply only when EXPLICITLY requested.** `allowed()` filters female/kidzone/video
   *only* when the flag is set — an unset `allowFemale` must NOT silently drop female artists. (The API
   always passes explicit booleans; a caller that omits one gets everyone.)
8. **Videos are their own category, not songs.** A live-recording track is in `videos`, not `songs` —
   benchmarks must check the right category or you'll see phantom "recall misses".
9. **Same-title collisions are not bugs.** Many tracks share a title; returning *a* same-title track is
   correct even if it isn't the exact source videoId.
10. **`database.query`-style mistakes don't apply here** but the analogue does: do a whole per-artist
    upsert in **one** `db.transaction` (`upsertArtistCatalog`) — never split a row's writes.
11. **Re-harvesting is FREE and never re-fetches.** Every fetched page is in the gzipped `net.mjs` cache,
    so killing + restarting the harvest replays the cache into `corpus.db`. A *schema* change → drop
    `corpus.db` and re-harvest (cache replay rebuilds it), or add a `PRAGMA`/`ALTER` migration in
    `openCorpus` (see `regularChannelId`).
12. **IP safety is non-negotiable.** All YouTube traffic goes through `net.mjs`: a **bounded-concurrency,
    rate-paced** limiter (`CONCURRENCY` in flight — default **1 = single-flight**; each start spaced
    ≥`MIN_INTERVAL_MS`+jitter so the aggregate rate is capped regardless of concurrency), gzipped disk
    cache (fetched at most once), and an **anti-bot circuit breaker** (first "Sorry…" page latches a
    `BLOCK_COOLDOWN_MS` back-off that short-circuits all in-flight/pending live requests; callers also
    abort). Library default stays serial; the maintenance pipeline opts into speed (`CONCURRENCY=5`,
    `MIN_INTERVAL_MS=200` → ~3 req/s, still far below anti-bot thresholds, never a burst). Never add a raw
    fetch. A full 1,608-artist harvest is many requests — let it grow politely.
13. **The whitelist is YouTube **music** channels; uploads use a different **regular** channel.** The
    channel map (`artist.regularChannelId`, from the page's subscribe button) bridges them for playlist
    whitelisting. Content only on the regular channel isn't harvested yet (issue #108).
14. **Community playlists are whitelist-pure by SERVE-TIME filtering, NOT by the admission gate.** A
    community playlist (`community_playlist`) can be admitted with non-whitelisted tracks in it — opening
    it (`/playlist`) re-fetches live and keeps only whitelisted tracks (`tracksByIds` ∪
    `whitelistedChannelIds`), so it can NEVER serve a non-whitelisted track. `admitPlaylist`'s
    `MIN_WL_TRACKS`/`MIN_WL_RATIO` is a *quality* gate (is the whitelisted subset a coherent list?), not a
    purity gate. NEVER "admit any playlist containing a whitelisted track" — that's the leaky inverse.
    Discovery (`harvester/playlists.mjs`) seeds search; it does NOT enumerate all of YouTube (impossible).
    The audio is pure, but a playlist's **metadata is user-generated** — so the displayed **cover is derived
    from a whitelisted track** (`store.mjs` read funcs, NOT the curator's cover image, which can show
    non-whitelisted art), and **title/curator text is screened** at admission via `blocklist.playlistTerms`
    (+ `playlistIds` to remove specific ones). `REVALIDATE=1` reapplies all of this to existing rows.
15. **Community playlists rank by TITLE only** (`allCommunityPlaylists` sets `artistName: ""`, keeps the
    curator in `author` for display). The curator is a random uploader; matching/boosting on it ranked
    curator-name hits above title-begins-with hits. Artist-owned playlists still rank on the (real) artist.
16. **New Releases = REAL dates, not index time.** `album.uploadDate` (ISO, from one `/player` per release —
    `harvester/releases.mjs`) drives `recentAlbums`/`recentTracks`; `/new` shows only items with a real date
    **inside a window** (default 10 days). Undated items (no `/player` date yet — incl. standalone videos)
    are excluded from the window, NOT shown as "new". `harvestedAt` is only a last-resort fallback ordering.

## Editing the matcher safely

`index/search.mjs` is tuned against measurements, not vibes. Before/after **any** change: **`npm run
verify`** (test + audit + fuzz + deep-test — must stay green), and for ranking, `npm run relevance` and
`npm run category-relevance`. The benchmarks read the live `corpus.db`. There are pinned unit tests for
every gotcha above; if one goes red you've reintroduced a known bug. **Re-run `npm run verify` as the
corpus grows** — new indexed material exposes new edge cases (that's how most gotchas were found); the
harnesses sample random/diverse entities each run.

## Constraints (hard)

- **No commits/pushes** unless told. **`zemer-app` is immutable.**
- **Keep the docs 100% current.** Any change to behavior/API/UI/schema/matcher → update `AGENTS.md` **and**
  `docs/` in the *same* pass. They are hand-authored (not generated) and must never drift from the code.
- **IP-safe** (cached/paced/abort), **storage-safe** (gzip cache; `corpus.db` is compact), **deployable**
  (one Node process + one DB file; all paths/secrets via env), **cross-version** (on-device = pure Kotlin).
- Secret `google-services.json` (whitelist/Firestore fetch) is a read-only input — never commit it.
  (Harvesting needs **no** cookie/`innertube_cookie.txt` — browse + search are unauthenticated.)
