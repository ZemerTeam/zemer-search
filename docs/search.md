# The search matcher

`index/normalize.mjs` + `index/search.mjs` + `index/categories.mjs`. This is the heart of the project and
the most carefully tuned code — it is changed against **measurements** (the `bench/` harnesses), not
intuition. Every design choice below traces to a real query that broke without it.

## 1. Normalization (`normalize.mjs`)

Each string produces **two** token forms plus a ranking key.

### plainTokens(str)
`NFD` → strip combining marks (niqqud) → lowercase → **remove join-marks** → split on non-`[a-z0-9֐-׿]`.
- Keeps Latin **and** Hebrew (`֐-׿` = U+0590–05FF).
- **`JOINMARK = /['’‘`´"׳״]/`** — in-word apostrophes, curly quotes, backtick, acute, double-quote, Hebrew
  geresh `׳`, gershayim `״` — are **removed (joined)**, not treated as word breaks. So `L'Chaim` →
  `lchaim`, matching "lchaim", "l'chaim", and "lchaim" identically; `חב"ד` → `חבד`. (Splitting on the
  apostrophe made "oconnor" return nothing and ranked "lchaim" wrong — see gotchas.)

### skeletonTokens(str) — the cross-script lever
Hebrew is written without vowels, so we reduce a word to a folded **consonant skeleton**: romanize the
*strong* consonants, **drop the matres lectionis** (א ה ו י ע) and Latin vowels, fold ambiguous pairs
(b/v=ב, k/ch=כ/ק, p/f=פ, s/sh, t/th, tz=צ). A romanized query and the Hebrew title reduce to the *same*
skeleton:

```
kevakarat → kbkrt      ⟵  כבקרת → kbkrt
dudi polak → dd plk    ⟵  דודי פולק → dd plk
```

Tokens shorter than 2 chars are dropped (used for **matching**, the inverted index). The Hebrew map and
fold rules are hand-curated — no platform ICU, deterministic on every OS.

### skeletonKey(str) — word-ALIGNED skeleton (for ranking boosts only)
One slot per *plain* token, **no length filter** (a token that skeletonizes to nothing keeps its plain
form). This preserves word count/order so the exact/begins **boosts** can't be fooled. **Critical
distinction:** matching uses `skeletonTokens` (filtered); the exact/begins boosts use `skeletonKey`.
Without it, "Yoni Shlomo" → `"slm"` (Yoni drops) would *exactly equal* the one-word query "shlomo" →
`"slm"` and steal a false exact-match boost. With it, "Yoni Shlomo" → `"n slm"` ≠ `"slm"`. (Gotcha #3.)

### damerau(a, b, max)
Damerau-Levenshtein (optimal string alignment) with an early cap. **Adjacent transposition = 1 edit** —
the single most common real typo. Used for typo tolerance on Latin/plain tokens only.

## 2. The index (`buildIndex(tracks, synonyms)`)

For each doc, four token sets go into two **fields** (TITLE and ARTIST) across two scripts:

- `plain` field: inverted index `token → Map<docIdx, fieldMask>` over plain title+artist tokens.
- `skel` field: same, over skeleton tokens.
- Per field: **IDF** per token (`log(1 + N/df)`), a sorted vocab (for binary-search prefix), and a
  boundary-padded **bigram index** (for sub-linear fuzzy candidate generation).
- Per doc, four **keys** for exact/begins comparison: `titleP`, `artistP` (plain joined) and `titleS`,
  `artistS` (**`skeletonKey`** joined).

`fieldMask`: `TITLE=1`, `ARTIST=2`. Tracked so a match knows *where* it landed.

It scales sub-linearly: **prefix** via binary search over the sorted vocab; **fuzzy** via boundary-padded
bigram candidates (only tokens sharing a 2-gram with the query are distance-checked) — never a full-vocab
scan. ~2–5 ms/search over tens of thousands of tracks.

## 3. Matching a query token (`matchToken`)

For one query token, against one field, produce `Map<doc, {w, mask}>`:

- **exact** (`weights.exact`), **prefix** (`weights.prefix`, ≥ `minPrefix` chars, binary-searched),
  **fuzzy** (`weights.fuzzy`, bigram candidates, `damerau ≤ cap`, both tokens ≥3).
- `w = baseWeight × idf(matchedToken)`.
- **A fuzzy match contributes `mask = 0`** (Gotcha #4) — it still adds to the score but is *not* a
  confident field hit, so it can't grant artist-affinity or a position boost. (Without this, "yom"
  fuzzy-matches "**you**" in "Thank You Hashem" → false affinity.)

Weight tables:

| | exact | prefix | fuzzy | notes |
|---|---|---|---|---|
| `PLAIN` | 10 | 6 | 5 | completed Latin word |
| `PLAIN_LAST` | 10 | **9** | 5 | the **last** query token = the word being typed; prefix is near-exact intent, `minPrefix` 2 |
| `SKEL` | 8 | 0 | **0** | skeleton: exact only (no prefix for completed words, **no fuzzy ever** — Gotcha #2) |
| `SKEL_LAST` | 8 | 7 | 0 | last token: enable skeleton prefix for cross-script as-you-type |

**Skeleton matching is skipped when the query skeleton token is < 3 chars** (Gotcha #1): `"avr"` → `"br"`
would match "Beri"/"Bronx"/"Barditchover". Short queries rely on the precise plain prefix.

## 4. Scoring & ranking (`search`)

```
base   = Σ(idf-weighted token matches)
       + coverage × 8                          // matching MORE query words wins, even common ones
       + (origCount ≥ 2 ? artistCov × 25 : 0)  // multi-word artist-affinity (Gotcha #5)
boost  = 1 + (cov == whole query ? 0.4 : 0)
       + artist:  exact +2.5  |  begins-with +1.6  |  contains +0.8     // exact > begins > contains
       + title:   exact +2.0  |  begins-with +1.4                       // (Gotcha — begins checked BEFORE contains)
score  = base × boost
```

- **coverage** = `popcount` of a per-query-token bitmask (integer ops, no per-doc Sets → fast). The gate:
  a result must cover `≥ ceil(origCount/2)` query words to qualify.
- **artistCov** = query words that matched the ARTIST field via a *strong* (non-fuzzy) hit. The affinity
  (`×25`) makes a track *by* the searched artist beat one that merely *mentions* them in a title — but
  **only for multi-word queries** (for a single common word like "tov", a coincidental mid-artist-name
  match would otherwise beat a title that *begins* with the word; there the position boosts decide).
- **Position boosts are exact > begins-with > contains**, checked in that order so a name/title that
  merely *contains* the query never ties one that *begins* with it. The skeleton variants use `skKey`
  (the `skeletonKey` of the query) and only when it's ≥3 chars.
- **Precision floor (`REL_FLOOR`, default 0.4):** after sorting, keep only results within `REL_FLOOR ×
  topScore`. *Fewer or no results over weak, likely-wrong ones.* Garbage queries (no real match) → 0
  results.

Deterministic: stable sort by `score → shorter title → id`.

## 5. Category (grouped) search (`categories.mjs`)

`buildCategories(corpus)` builds **seven** independent in-memory indexes — `artists`, `songs`, `videos`,
`albums`, `singles`, `playlists` (artist-owned), and `community` (community-curated) — each a `buildIndex`
over that entity type shaped as `{title, artistName, …payload}`. `searchCategories(cats, q, opts)` runs
`search()` on each and returns the top-k per category, applying the content filter.

**`allowed(t, o)` — content filters apply ONLY when explicitly requested** (Gotcha #7):
`o.allowFemale === false` filters female; `o.kidZoneOnly` keeps only KidZone; `o.blockVideos` removes
videos. An *unset* flag means no filtering. (The API maps the user's settings to explicit booleans; a
caller that omits one must get everyone, not silently zero female artists.)

**Community playlists filter by SURVIVAL, not `allowed()`** (a community playlist has no single artist).
`communitySurvives(p, o)` keeps one only if ≥1 of its whitelisted members would survive the filter — so an
all-female list is hidden when female is blocked, an all-video list when videos are blocked; **exact,
including conjunctions** (female+video blocked hides a list whose only non-female tracks are videos). It
reads a compact per-playlist class bitmask (`clsMask`) + a fallback flag (`fb` = a not-yet-in-corpus member
→ always kept) carried in the index doc, so there's **no per-query DB hit**. The `/search` endpoint then
reduces each surviving community playlist's displayed `whitelisted` to its post-filter count
(`communityKeptCounts`), so the number matches `/community` and what actually plays.

## 6. Synonyms (`synonyms.mjs`)

`data/synonyms.json` is groups of equivalent surface forms for things the skeleton can't infer —
abbreviations/acronyms (`["mbd","mordechai ben david"]`). At query time a query that hits any token of a
group is expanded with the group's tokens, so "mbd" finds "Mordechai Ben David". The coverage bar stays
on the *original* query (expansion adds match opportunities, never raises the threshold).

## Tuning workflow

1. Reproduce/measure: `npm run relevance`, `npm run category-relevance`, `npm run deep-test`.
2. Change a constant / rule in `search.mjs`.
3. Re-measure **all** of: `npm test` (pinned gotcha tests), `audit` (false positives → must stay 0),
   `fuzz` (recall + crashes), `relevance` + `category-relevance` (ranking). A/B on the *same* corpus when
   the corpus is growing (the harvest changes it between runs), e.g. via an env toggle.

See [gotchas.md](gotchas.md) for the full bug-and-fix catalog and [testing.md](testing.md) for what each
harness measures.
