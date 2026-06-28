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
