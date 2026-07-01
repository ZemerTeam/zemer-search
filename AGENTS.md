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
| `harness/` | Ported InnerTube layer: `clients.mjs`, `lib.mjs`, `parsers.mjs`; **`net.mjs`** (gzip disk cache + bounded-concurrency rate-paced limiter + anti-bot circuit breaker; `cacheOnly` option for offline report passes); `browse.mjs` (artist/album/playlist parsers); **`search.mjs`** (IP-safe search via `net.mjs` — community-playlist discovery); **`player.mjs`** (IP-safe `/player` — the real release date, ISO `uploadDate`); `whitelist.mjs` (fetch Firestore whitelist, read-only); **`blocked-ids.mjs`** (fetch Firestore `blockedContentIds` → `data/blocked-ids.json`: per-id `female`/`global` overrides, read-only); `status.mjs` (maintenance progress channel). Browse + search + player are **unauthenticated** — no cookie, no `visitorData`. |
| `harvester/` | `core.mjs` (shared per-artist harvest; shallow/deep), `harvest.mjs` (initial bulk), `onboard.mjs` (new artists), `refresh.mjs` (incremental; shallow daily / deep weekly), `prune.mjs` (drop de-whitelisted), **`reconcile.mjs`** (purge tracks whose row-artist is a non-whitelisted uploader — cleans YT Music's polluted artist shelves; offline/cache-only), **`playlists.mjs`** (community-playlist discovery — seed-search → whitelist-filter → quality-gate → store; revalidate prunes stale), **`releases.mjs`** (date releases precisely — one `/player` per album → `album.uploadDate`, then one per STANDALONE track → `track.uploadDate`; makes New Releases accurate. `/player` is blocked from datacenters → run off-datacenter, ship dates in). |
| `scripts/`, `deploy/` | `maintain.sh` (refresh orchestrator: whitelist+blocked-ids→onboard→prune→refresh under flock) + systemd timer/service units (`zemer-refresh@`, `zemer-playlists`, and **`zemer-overrides`** — the several-times-a-day id-override fetch). |
| `corpus/store.mjs` | **SQLite** schema + store API (artist/track/album/playlist/album_track **+ community_playlist/community_playlist_track**; `track` carries **`durationSec`/`playCount`**; album `type`/`trackCount`/`totalDurationSec` are read-time aggregates). |
| `index/` | `normalize.mjs` (skeleton + Damerau + `skeletonKey`), **`search.mjs`** (the matcher), `synonyms.mjs`, `categories.mjs` (grouped/by-category search), **`credits.mjs`** (featuring female detection — `buildFemaleMatcher`/`isFemaleInvolved`; whole-token + cross-script-only skeleton, whitelist-validated), `build-subset.mjs`, `*.test.mjs`. |
| `server/` | `api.mjs` (HTTP API + cluster + LRU cache; `/search` `/artist` `/album` `/playlist` `/new` `/community` `/health`+`maintenance`), `ui.html` (web UI: search chips + **Community** chip (browse-all, no search) + **New Releases** chip + live refresh-progress bar; renders song **durations**+**play counts**, album **`N songs · MM min`**, numbered album-detail tracklists). |
| `bench/` | `relevance` `category-relevance` `audit` `fuzz` `deep-test` `loadtest` `bench` `diag-typos`. |
| `data/` | `corpus.db`, `whitelist.json`, `blocked-ids.json` (fetched id-overrides: `{global:[…], female:[…]}` — global ids hidden always, female ids when female blocked; mirrors the app's `blockedContentIds`), `synonyms.json`, `blocklist.json` (curated exclusions: `videoIds`/`artistIds` + community `playlistIds` + `playlistTerms` title/curator screen), `playlist-seeds.json` (community-playlist discovery seed terms), `rejected-artists.json` (generated: non-whitelisted artists seen in community playlists, for whitelist review), `.httpcache/` (gzipped, prunable). |
| `docs/` | Comprehensive deep-dive docs — read `docs/README.md`. |

## Commands

```bash
npm install                                                   # better-sqlite3
node harness/whitelist.mjs                                    # → data/whitelist.json (reads app google-services.json read-only)
node harness/blocked-ids.mjs                                  # → data/blocked-ids.json (Firestore blockedContentIds: per-id female/global overrides, read-only)
N=100 node harvester/harvest.mjs                             # → corpus.db (per-artist durable upserts; no cookie — browse is unauthenticated)
node harvester/onboard.mjs                                    # harvest only NEW whitelisted artists (diff vs corpus)
node harvester/refresh.mjs                                    # re-harvest existing artists; DEFAULT deep (full); SHALLOW=1 = fast landing-only
node harvester/prune.mjs                                      # drop de-whitelisted artists (survivor-guard) + apply data/blocklist.json
DRY=1 node harvester/reconcile.mjs                           # report tracks whose row-artist is a non-whitelisted uploader (shelf pollution); drop DRY=1 to purge (offline, cache-only)
DRY=1 node harvester/backfill-video-flags.mjs               # report cross-listed songs that are really videos; drop DRY=1 to flip isVideo=1 (offline, cache-only)
DRY=1 node harvester/backfill-community-artists.mjs         # resolve each community-playlist member's artist (so un-harvested members' gender is known); drop DRY=1 to write (offline, cache-only)
DRY=1 node harvester/backfill-track-meta.mjs               # extract track durationSec + playCount from the cached pages (album durations + landing "Songs"-shelf plays); drop DRY=1 to write (offline, cache-only)
node harvester/playlists.mjs                                  # discover COMMUNITY playlists (SEEDS=both FIRSTNAMES=1 N=4000 = full sweep; REVALIDATE=1 prunes stale)
node harvester/releases.mjs                                   # date releases via /player → album.uploadDate + standalone track.uploadDate (MIN_YEAR=2025 = recent albums only; TRACKS=0 = albums only; ALBUMS=0 = tracks only); makes New Releases real-date-accurate. /player is datacenter-blocked → run off-datacenter
scripts/maintain.sh shallow|deep                             # orchestrate whitelist+blocked-ids→onboard→prune→refresh (flock; cron/systemd; shallow daily / deep weekly)
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
7. **Content filters apply only when EXPLICITLY requested, and on EVERY result endpoint.** `allowed()`
   filters female/kidzone/video *only* when the flag is set — an unset `allowFemale` must NOT silently drop
   female artists (the API passes explicit booleans; a caller that omits one gets everyone — **default-OPEN**).
   The flags (`allowFemale`/`blockVideos`/`kidZone`) are honored not just by `/search` + `/new` but by
   `/artist` `/album` `/playlist` `/community` too (added so nothing leaks on drill-in): detail returns 404
   when the whole artist is filtered; album/playlist filter per-track; **community playlists are hidden when
   no member survives the filter** (all-female list hidden when female blocked — exact incl. conjunctions, via
   `communitySurvives`/`clsMask`), with their displayed count reduced to the post-filter total.
   A community member whose TRACK isn't harvested (e.g. on the artist's regular channel, issue #108) used to
   be an unknown that **failed open** (an all-female playlist with one such member showed, then opened empty).
   Now discovery records each member's resolved artist in `community_playlist_track.artistId`, so `clsMask`
   reads its gender even un-harvested (`fb` = truly-unknown only: no corpus track AND no resolved artist).
   **`harvester/backfill-community-artists.mjs`** (cache-only, `DRY=1`) backfills it for existing rows; it's
   a no-op until then (NULL artistId = the old behavior). NOTE: this resolves via `artist.isFemale`, so a
   whitelist mis-flag (a male marked female) still mis-filters — fix the whitelist (Firestore), not the code.
   **Female filtering is "any credited artist", not just the primary** (`index/credits.mjs`): a male-primary
   track that FEATURES a female (the credit is usually in the TITLE, e.g. `(feat. Franciska)`) is dropped
   under `allowFemale=0`. Each entity doc carries `femaleInvolved` (primary `isFemale` **OR** a credited name
   matching a known-female whitelist entry); `allowed()` uses it. The candidate name is validated against the
   female whitelist (whole-token normalized equality; **skeleton matching is CROSS-SCRIPT only** — same-script
   skeleton collides, e.g. "Asher Weiss"→"srss"="Sarah Shasho", so it's gated to Hebrew↔romanized). Unknown
   names never drop a track. The server publishes the female-involved videoIds to a per-connection temp table
   `_female` (`setFemaleSet`, populated at reload) so the SQL paths (community `clsMask`/counts, `/artist`
   `/album` `/playlist` `/new`) filter identically; empty `_female` = primary-only (so tests/bench are
   unchanged). NOTE: a male mis-flagged `isFemale=1` in the whitelist (a Firestore data error, e.g. seen for
   `Ari Lesser`) over-filters his own AND feat. tracks — fix the whitelist, not the matcher.
   **Curated id overrides (`blockedContentIds`).** Auto-detection can't catch everything — a women's community
   playlist that survives on one token male track, or a female collaborator not named in a track's text. The
   read-only Firestore `blockedContentIds` collection (fetched to `data/blocked-ids.json` by
   `harness/blocked-ids.mjs`, `{global:[…], female:[…]}`) is the curated patch, mirroring the app: an id
   (matched against a result's `videoId`/`playlistId`/`channelId`/`browseId`) listed `global` is dropped for
   everyone, `female` only when female is blocked. Applied serve-time on **EVERY** result endpoint:
   `searchCategories` (`blockedDoc`, via `cats.blocked`, on every category incl. community) + `/community`
   `/playlist` `/artist` `/album` `/new` (`idDropped`, incl. their sub-lists); `female` videoIds also join the
   `_female` set so community counts treat them as female. **No backfill — pure serve-time filter**; empty list
   = no-op. To hide a women's playlist, add its **playlistId** as `female` in Firestore. The list is fetched
   **~every 10 min** by `deploy/zemer-overrides.timer` (lightweight Firestore read, no harvest; **writes
   `blocked-ids.json` only when the list actually changed**, so an unchanged fetch is a no-op and triggers no
   index reload) AND on every
   `maintain.sh` run, and the API re-applies it on its next reload tick (`blocked-ids.json` is in the reload
   change-gate — **no restart**).
   **Community covers are filter-aware** (`communityKeptCounts` returns `{kept, cover}`; `/playlist` uses the
   first surviving track): a filtered card shows the first SURVIVING member's art, never a dropped/female one.
   **A female artist's OWN playlist discovered as community is hidden** when female is blocked even if it has a
   male collab track (`femaleOwned`: the community id matches a female-owned artist playlist, or its curator is
   a known female artist) — member-survival alone would otherwise keep it alive. Verified by a full audit
   (every female-whitelisted artist, queried by first + last name with female blocked, returns **0** female
   items across all categories).
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
17. **Harvest only the artist's OWN content — YT Music's artist Songs/Videos shelves are POLLUTED.** The
    "Videos" feed (and its "more" pagination) for an artist mixes in rows uploaded by **other** channels —
    foreign garbage (Tamil/Lil Wayne/gospel), third-party Jewish covers, and re-uploads (e.g. YBC videos
    posted by "EG Productions"). The harvest used to stamp the page artist on every shelf row, so that junk
    got stored under a whitelisted artist. **Fix:** `core.mjs` `add()` keeps a row only if its OWN artist
    channel (`rowArtistId`, captured by `songFromMRLIR` **and now `fromTwoRow`**) is whitelisted —
    `ownsRow(rowArtistId, owned, whitelist)`: the artist's own music/regular channel, or any whitelisted
    artist (so feat. collabs survive). A row with **no** captured artist is trusted to the page. Callers pass
    the whitelist channel set. **`harvester/reconcile.mjs`** is the one-time cleanup: it re-parses every
    artist from cache (offline) and purges already-stored tracks whose row artist is a non-whitelisted
    uploader (`DRY=1` to report first). This is the **same whitelist-purity rule** community playlists use.
18. **A video is a video — prefer `isVideo=1` for cross-listed ids.** The same `videoId` can be a music
    VIDEO on one artist's page and an audio SONG on another's (e.g. a Lev Tahor music video that's also an
    Eli Schwebel single). Since a `videoId` is stored ONCE (PK, first-harvest wins), it could land as a
    song and then never surface in the Videos category. **Fix:** harvest now prefers video — `core.mjs`
    `add()` upgrades `isVideo` when the same id is re-seen on the Videos shelf, and the upsert does
    `ON CONFLICT … isVideo=MAX(track.isVideo, excluded.isVideo)` (never downgrades). **`harvester/backfill-video-flags.mjs`**
    (cache-only, `DRY=1` to report) flips already-stored songs to video for ids listed as a video anywhere.
    Attribution stays single (the PK owner) — that's intentional; full multi-artist attribution would mean
    duplicate same-id results.
19. **Track detail metadata lives on DIFFERENT shelves — the harvest must MERGE it.** A track's **duration**
    is on the **album page** (fixed column) and its **play count** is on the artist **landing "Songs" shelf**;
    the same `videoId` appears on both, and the harvest dedups it. So `core.mjs` `add()` merges on
    re-encounter — **fill `durationSec` if missing, keep the MAX `playCount`** — else a track gets one but not
    the other. Both are already in the cached pages (parsed by `browse.mjs`, no new fetches); `insTrack`
    upserts `durationSec=COALESCE(…)` and `playCount=NULLIF(MAX(…),0)` (never downgrade; unknown stays NULL).
    **`harvester/backfill-track-meta.mjs`** (cache-only, `DRY=1`) populates existing rows offline; the harvest
    fills them going forward (deep weekly refreshes both; shallow daily refreshes plays). `artistDetail` sorts
    `songs` by `playCount` desc = real **"Top songs"**. Coverage is cache-dependent (durations ~97%, plays
    ~55% — plays only where YT shows them, **never on videos**); nullable = unknown = old behavior.
    **Album aggregates** (`type`/`trackCount`/`totalDurationSec`) are **read-time** over `album_track`∪`track`
    (NO stored column) on `allAlbums` (→ `/search` cards), `artistDetail` rows, and the `albumDetail` header
    (full-album total, so it matches the list row even when filters shorten the returned tracks). The **web UI**
    (`ui.html`) renders all of it: song duration + plays, album `Album · N songs · MM min`, numbered
    album-detail tracklists, New Releases durations (`fmtDur`/`fmtRuntime`/`fmtPlays`).

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
