# Gotchas & the bug catalog

Institutional memory. Every entry is a **real bug** that was found by a test and fixed, with the fix and
the regression guard. Don't reintroduce them — there's a pinned unit test for each.

## Matcher

| # | Symptom | Root cause | Fix | Guard |
|---|---------|-----------|-----|-------|
| 1 | "avr" returned "Beri", "Bronx", "Barditchover" | `"avr"` skeletonizes to `"br"` (2 chars); a 2-char skeleton matches a huge set | **Skip skeleton matching when the query skeleton < 3 chars**; short queries use the precise plain prefix | `search.test.mjs` precision tests |
| 2 | Garbage ("blarghnod") returned ~19 results | skeleton **fuzzy** (Damerau on already-lossy skeletons) matches noise to real words | **`SKEL.fuzzy = 0`** — skeleton does exact (+ as-you-type prefix) only; vowel-typos are already absorbed | "no skeleton fuzzy" test; `audit` garbage→0 |
| 3 | "shlomo" ranked "Yoni Shlomo" as an *exact* match | the skeleton **key** dropped short tokens → "Yoni Shlomo" → `"slm"` == query `"slm"` | **`skeletonKey`** = word-aligned skeleton (one slot/plain token, nothing dropped) for the exact/begins **boosts**; matching still uses `skeletonTokens` | "begins-with … token-dropping skeleton" test |
| 4 | "yom" ranked "Shabbos Yom Menucha / Thank You Hashem" above the begins-match "Yom Zeh" | "yom" **fuzzy-matched "you"** in the artist → spurious artist-affinity (+25) | **A fuzzy match contributes mask 0** — no affinity, no position boost | "fuzzy artist match grants no affinity" test |
| 5 | "tov" ranked "…/ Key **Tov** Orchestra" above "Tov Hashem Lakol" (begins) | a single common word mid-artist-name got the full affinity | **Artist-affinity only for multi-word queries** (`origCount ≥ 2`); single words let position boosts decide | `deep-test` begins>contains |
| 6 | begins-with tied / lost to contains (artists) | the `artistCov` (contains) branch fired *before* begins-with, masking it | **Order boosts exact > begins-with > contains**, begins checked first | "begins-with ranks above contains" test |
| 7 | "lchaim" found L'Chaim only #2; "oconnor" found nothing | apostrophe **split** the word: `L'Chaim` → `["l","chaim"]` | **Join, don't split** in-word apostrophes / geresh ׳ / gershayim ״ / quotes (`JOINMARK`) | "in-word apostrophes join" test |

## Content / data

| # | Symptom | Root cause | Fix |
|---|---------|-----------|-----|
| 8 | Searching a female artist's exact name returned **0** | `allowed()` filtered female content when `allowFemale` was merely *unset* (falsy), not explicitly `true` | **Filters apply only when explicitly requested** (`o.allowFemale === false ? …`). Lifted artist recall 94.7% → 100%. |
| 9 | An off-policy artist (one that shouldn't be whitelisted) appeared in results | **bad whitelist data** in Firestore (the app shows it too) — *not* a search bug; zemer-search has 0 leakage beyond the whitelist | Fix the whitelist in Firestore, re-fetch + re-harvest. zemer-search is a useful whitelist *auditor*. |
| 10 | With female blocked, drilling into an artist/album/playlist (or a community playlist) still showed female content | Content filters were applied to `/search` + `/new` only; `/artist` `/album` `/playlist` `/community` ignored the flags | Apply the flags on **every** result endpoint: detail → 404 when the artist is filtered; album/playlist filter per-track; community playlists hidden when no member survives (`communitySurvives`). The app's **Zemer** provider renders results raw (not `filterWhitelisted`-gated like the YouTube provider), so the server must filter — and the app must send the flags on **every** request (default-OPEN). |
| 11 | A female artist's playlist appeared in search and **opened empty** | The `/search` `community` category didn't apply the female filter, so an all-female community playlist surfaced; opening it (InnerTube + `filterWhitelisted`, which *is* gated) dropped every track → empty | Hide community playlists with no surviving member; reduce a mixed list's shown count to the post-filter total so it matches what plays. |
| 12 | With female blocked, a **male**-primary track that *featured* a female (`… (feat. Franciska)`) still showed | Only the **primary** artist's `isFemale` was checked; the featured credit lives in the TITLE | Drop a track if **any** credited artist is a known female (`index/credits.mjs`: `femaleInvolved` = primary OR a title/artist-string credit matching a female whitelist entry). Whole-token, whitelist-validated; **skeleton match cross-script only** (same-script collides, e.g. "Asher Weiss"→"srss"="Sarah Shasho"). |
| 13 | A community member whose track isn't harvested (on the artist's **regular channel**, #108) made an all-female list **fail open** (show, then open empty) | `clsMask` only knew a member's gender from a corpus `track` row; an un-harvested member was "unknown" → fail-open | Record each member's resolved artist at discovery (`community_playlist_track.artistId`); `clsMask`/counts read its gender even un-harvested. `harness/backfill-community-artists.mjs` fills existing rows (offline). |
| 14 | A women's community playlist **survived on one token male track** + showed a **female cover** under female-block | Member-survival kept it alive; the card cover was the static first member (often female) | Hide a community playlist that is itself a female artist's own playlist (`femaleOwned`: id matches a female-owned artist playlist or curator is a known female). Covers are filter-aware (`communityKeptCounts` → `{kept, cover}` = first **surviving** member; `/playlist` uses the first surviving track). |
| 15 | Auto-detection can't catch every female leak (a feat not in the title, a borderline playlist) | Title/flag heuristics have limits | Curated **`blockedContentIds`** id-overrides (Firestore → `data/blocked-ids.json`): `global` ids dropped for all, `female` when female blocked; matched on videoId/playlistId/channelId; applied serve-time on **every** endpoint (`blockedDoc`/`idDropped`). Refreshed several times a day (`zemer-overrides` timer); audited: every female artist by first+last name with female blocked → 0 female items. |
| 16 | `artists`/`albums`/`singles`/`playlists` capped at **6** in `/search` even at high `k` | Those categories were hard-pinned to 6 while songs/videos/community honored `k` | Every category honors the request's `k` (filter-then-slice). |
| 17 | A track ended up with a **play count OR a duration, but not both** | Duration lives on the **album page** (fixed column), the play count on the artist **landing "Songs" shelf** — the harvest dedups a videoId across shelves and the first path dropped the other's metadata | `core.mjs` `add()` **merges** on re-encounter: fill `durationSec` if missing, keep the **MAX** `playCount`. Both are extracted from the already-cached rows (no new fetches); `harvester/backfill-track-meta.mjs` fills existing rows offline. `/artist` sorts songs by `playCount` (real "Top songs"). Nullable = unknown; coverage is cache-dependent (durations ~97%, plays ~55% — plays only exist where YT shows them, never on videos). |
| 18 | Album cards had no size info | `trackCount`/`totalDurationSec` weren't computed | **Read-time aggregates** over `album_track`∪`track` (NO stored column) on `allAlbums`/`artistDetail`/`albumDetail`; header uses the FULL-album total so it matches the list row even when filters shorten the returned tracks. |

## Methodology / test traps (not search bugs — measure correctly)

- **Videos are their own category.** A benchmark that searches a *video* track's title against the
  `songs` category will report a false "recall miss". Check the category matching `isVideo`.
- **Same-title collisions.** Many tracks share an exact title; returning *a* same-title track is correct
  even if not the exact source videoId. Don't count it as a miss.
- **Cross-script skeleton collisions.** Different words can share a consonant skeleton ("אקסן" vs
  "chasunah" → both "ksn"). A naive begins-check mislabels these; the matcher correctly ranks the real
  match above the collision.
- **Corpus grows mid-run.** During a harvest, two benchmark runs see different corpora — for a clean A/B
  toggle the change behind an env var and run both in one process.

## Operational

- **Re-harvest is free** (cache replay), so prefer drop-`corpus.db`-and-re-harvest for a schema change
  over a fragile migration — *unless* the API is live (then use a guarded `ALTER`, as `regularChannelId`
  does, to avoid downtime).
- **Restart the API after editing the matcher.** The index reloads its *data* every `RELOAD_MS`, but the
  `search.mjs` *module* is loaded once at startup — a code change needs a process restart.
- **`pkill -f` self-matches.** A `pkill -f "api.mjs"` can kill its own shell (the command line contains
  "api.mjs"). Prefer stopping the tracked background task, or `fuser -k <port>/tcp`.
- **`&`-backgrounding inside a one-shot wrapper dies.** Run a long server *as* the background process
  (no trailing `&` + `echo`), or its child gets reaped when the wrapper exits.
