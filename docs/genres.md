# Genres & style — two layers, resolved at read time

Zemer describes style at **two different levels**, on purpose. They are never merged, because they mean
different things and carry different authority.

| | `artist.isChasid` / `isDJ` / `isAmerican` / `isKidZone` / `isFemale` | `track.genres` |
|---|---|---|
| Level | the **artist** | the **release** (album-anchored — gotcha #22) |
| Coverage | every artist, so every song | ~16% of songs |
| Authority | curated / crowd-verified by people | derived, evidence-gated (+ curated seeding) |
| Answers | "what kind of artist is this?" | "what kind of record is this song from?" |

## Why they are NOT merged

A chasidish singer releases an Israeli-pop single; a children's-music artist records a wedding album. The
artist attribute stays true while the release differs — collapsing them into one field destroys that, and
destroys the ability to tell curated data from derived data.

The failure mode is real and was hit during development: the slug now called `nigunim` was briefly named
`chasidish`, which made it look comparable to `artist.isChasid`. Chasidish-pop singers legitimately have
zero *nigunim*, so the comparison produced a list of "wrong" flags for artists whose flags were correct.
**A slug that sounds like a flag is not that flag.**

## How consumers should resolve them

**1. Use `track.genres` for POSITIVE selection.** "Give me acapella songs", "give me a Purim playlist".
Genres are precise where present.

**2. Absent genres mean UNKNOWN, never "none of these."** 84% of songs have no genre yet, and even a
genred song may carry an incomplete label (a release categorised by language can omit its form). Never
write `NOT genres LIKE '%x%'` to mean "is not x".

**3. Use artist flags for POLICY filtering.** `isFemale`, `isKidZone` and the blocked-ids overrides decide
what a given listener may see. That is an eligibility question about the artist, and it applies to every
song regardless of genre coverage.

**4. For a VETO, union every evidence source — never require genre coverage.** The station rule "no
acapella, ever" is enforced as *curated list* ∪ *strict title marker* ∪ *`genres` contains `acapella`*. A
song only needs to trip one. Over-exclusion is the safe direction: a false positive benches one song, a
false negative airs acapella where the product forbids it.

**5. Don't derive artist flags from genres.** Genres describe releases; a body of releases is not an
artist attribute (an artist with one kids album is not a KidZone artist). Flags are curated upstream in
the whitelist and flow in through the mirror — that is where corrections belong.

## Seeding: curated lists outrank derivation

A hand-curated Zemer playlist whose membership **is** a genre seeds that slug directly — a human verified
those songs, which beats any inference. Today that is the master `acapella` list plus the strict-marker
`acapella-auto` list. Seeding **adds** and never replaces: a song can be both an Israeli release and an
acapella cut, and 12 such songs were exactly that case.

Before seeding, of curated acapella songs that carried any derived genre, **98% (484/496)** already had
`acapella` — the derivation and the curation agreed independently. The gap was coverage, and seeding
closed it (acapella 605 → 2,261 songs).

## The vocabulary (35 slugs)

- **Style** — `nigunim` `yiddish` `israeli` `mizrachi` `yemenite` `acapella` `chazzanus` `carlebach`
  `instrumental` `dance` `electronic` `workout` `calm` `lullaby` `kids` `wedding` `march` `english`
- **Occasion** — `purim` `pesach` `chanukah` `yamim-noraim` `succos` `shavuos-simchas-torah` `lag-baomer`
  `tu-bishvat` `three-weeks` `rosh-chodesh` `shabbos` `melave-malka`
- **Non-music** — `shiur` `parsha` `story` `comedy` `podcast`. These exist for **exclusion**: a shiur or a
  children's story must never air on a music station.

**Slugs are the stable contract; the DISPLAY LABEL is Zemer's own voice** (`GENRE_TITLES` in
`server/api.mjs`) — `calm` shows as *Chill*, `dance` as *Freilach*, `wedding` as *Chasunah*, `yemenite`
as *Teimani*, `shabbos` as *Shabbos Table*. Labels are the words this audience actually uses and are ours
to change freely; a client must key off the slug, never the label.

Each slug names exactly what it is. Occasion slugs are legitimate at release level (a record genuinely
*is* a Purim album) in a way they never were at artist level.

## Companion field

`track.energy` (0..1) is acoustic **intensity**, not tempo — see gotcha #23. It is orthogonal to genre and
useful for ordering *within* a style (mellow vs driving), never for classifying one.

## App-facing surface

| Endpoint | What |
|---|---|
| `GET /genres` | The catalog: `{count, genres:[{id, title, trackCount, kind}]}`, most-populated first. `kind` is `style` \| `occasion` \| `non-music`, so a client can group them — and so a music surface can EXCLUDE `non-music` rather than feature it. Counts are POST-FILTER, so a viewer never sees a count they cannot reach. |
| `GET /genres?id=<slug>` | The genre as a BROWSABLE PAGE, like an artist page: `{genre:{id,title,kind,trackCount,artistCount,albumCount,singleCount,songCount,videoCount}, artists[], albums[], singles[], songs[], videos[], offset, nextOffset}`. Every `*Count` in `genre` is the **TRUE total**; the returned `artists`/`albums`/`singles` arrays are the top **`k`** (default 20, max 60) for the summary card, and `songs`/`videos` are the first `limit`/`offset` page. Artists and releases are derived from the surviving member tracks, so every count is reachable. An album counts for a genre when **≥2 of its members** carry it. 404 on an unknown or fully-filtered genre. |
| `GET /genres?id=<slug>&facet=<artists\|albums\|singles\|songs\|videos>` | **SHOW-ALL paging for one list.** Returns `{genre, facet, items, offset, nextOffset}` — the full entity list (not capped at `k`), paged by `limit` (≤200) + `offset`. This is how the app reaches EVERY artist/album/etc. past the summary cap (e.g. acapella has 239 artists). `items` is the same row shape that list uses on the summary page. |
| `GET /radio?kind=genre&seed=<slug>` | Genre radio — a PERSONALIZED, SKIPPABLE queue. Opens on one of the genre's own popular songs (jittered per session), then expands through co-occurrence like any other seed. Asking for `acapella` IS acapella intent, so that seed lifts the year-round exclusion. |
| Stations | A genre can also back a **synchronized broadcast** station (`nigunim`, `calm`) — see the distinction below and [stations.md](stations.md). |

### Two different products — do not conflate them

| | `/radio?kind=genre` | a genre STATION |
|---|---|---|
| Shape | a personalized queue built for THIS listener | one shared wall-clock program |
| Control | **skippable**, endless, continuation-paged | lean-back; you tune in to whatever is playing |
| Filters | honors the caller's content flags | pre-filtered kosher-for-all (cannot be personalized) |
| State | stateless + deterministic per session | a materialized schedule everyone hears together |

Occasion genres are **excluded from stations year-round** for the same reason acapella is: a shared
stream cannot be personalized, so out-of-season music hits everyone at once and nobody can skip past it.
They remain fully available through browsing and genre radio, which are opt-in and skippable.

Browsing a genre and hitting play should give the **skippable queue**. A station is a deliberate,
separate "tune in" action. Only a handful of genres back stations (they must clear the pool + familiarity
gates); every genre supports radio and browsing.

Song rows across `/radio` and `/genres` carry `genres` when known (omitted when not — absent means unknown).

**Genres are a SEED and a FILTER, never a ranking term.** Adding genre/energy affinity to the radio blend
was measured on held-out next-track prediction and made it **worse** — 39.9% → 32.9% hit@20 overall, and
30.1% → 20.7% on rare (popularity-debiased) gold. Co-occurrence already encodes style from real listening;
descriptive metadata layered on top displaces it. Don't re-add it without re-running that bench.
