# Future plans — revisit list

Deliberately-deferred improvements, with **why they're deferred** and **what unblocks them**. These are not
bugs or gaps in shipped behavior — they're the next quality steps once data or scope supports them. Review
this list periodically (and whenever the telemetry corpus grows meaningfully).

> Context: the data-driven auto playlists (Top 50 / Trending / Favorites / Year — see
> [harvester.md](harvester.md#auto-data-driven-playlists--harvesterauto-playlistsmjs)) went live **2026-07-08**,
> when live telemetry was only ~4 days old and backfill was ~44% device-ingested. Several items below are
> deferred purely because they need more accumulated data to be worth doing.

## Auto playlists

| # | Improvement | Why deferred / what unblocks it | Effort |
|---|-------------|--------------------------------|--------|
| 1 | ~~**Velocity-based Trending**~~ **SHIPPED 2026-07-24** (`harvester/trending.mjs`, unit-pinned): Trending's primary sort is reach growth vs the sidecar snapshot nearest T−7d, with a **self-activating seasonal guard** — velocity engages only when both compared windows are fully clear of The Three Weeks (Hebrew-calendar-recurring), reach mode is the standing fallback. First clean activation ≈2026-08-06 (both windows post-fast); the run logs the active mode. | Done. |
| 2 | ~~**Fold live favorites/downloads into the ranking.**~~ **SHIPPED 2026-07-24**: favorite/download reach = MAX(backfill snapshot, live `topActions` per-device counts) — never summed (total, un-dedupable overlap). Rows from an older stats server carry no `devices` → backfill-only, the old behavior. | Done. |
| 3 | **Exposure-bias ceiling on Trending.** Live plays partly measure *what the app surfaced*, not pure demand. | **Server + generator SHIPPED 2026-07-24, OFF BY DEFAULT** — it never self-engages. zemer-stats accepts batched `impression` events (`topImpressions` = per-video distinct-device exposure; `impressionSurfaces` = which surfaces report), and Trending multiplies in `1 − 0.35·(exposedDevices / impressionDevices)` — a **share of the instrumented audience** (adoption-invariant), measured over its own longer `EXPOSURE_DAYS` window (28d) so the dock cannot oscillate with the rank it caused. Engaging requires **all three** of `EXPOSURE_DAMPENER=on`, every surface in `EXPOSURE_REQUIRED_SURFACES` reporting ≥10 devices, and ≥60% device coverage over ≥20 devices. **Remaining: the app must ship impression logging** (handoff doc `zemer-tracking-impression-events-request.md`; client complete, unreleased as of 2026-07-24). | App, then a deliberate flip |
| 4 | ~~**Near-duplicate guard.**~~ **SHIPPED 2026-07-19** (`harvester/dedup.mjs`, unit-pinned): every ranked list dedups on artist + variant-marker signature + normalized title, before its slice. Conservative by design — variant markers (acapella/live/etc.) and cross-artist same-titles never collapse. Zero behavior change at ship (0 dups in live data). | — | Done. |
| 5 | **Per-genre auto lists** (e.g. "Most played — Upbeat / Kumzitz / Acapella"): same engine, narrower slices. | Product/scope decision, not a correctness gap. Wants a genre/mood tag per track or artist to slice on. | Medium. |
| 6 | **Weight/param validation.** The loved-score weights (`backPlay/livePlay/favorite/download`), the shrinkage `PRIOR`, and the trending skip penalty are reasoned, not tuned against outcomes. | Needs enough click/play-through data to measure which weighting best predicts engagement. Revisit alongside #1. | Medium. |
| 7 | ~~**Spotify-style chart movement**~~ **SHIPPED 2026-07-24** (`server/chart-badges.mjs`, unit-pinned): `/zemer-playlists?id=auto-*` detail rows carry additive `prevRank`/`delta`/`new` (+ `playlist.anchorDate`), computed on RAW chart ranks (viewer content filters can't fabricate movement) against a fixed weekly anchor — the first applied sidecar ordering of the last completed UTC week, rolling Sundays; young history falls back to the series start. Web UI renders ▲/▼/–/NEW on the new **Zemer Playlists** chip. **App badges still need an app-side update** (fields are waiting in the API; handoff doc on request, never in this repo). | Done (server+web). |

## Zemer Radio (shipped 2026-07-26; deferred follow-ups from the 2026-07-29 improvement review)

Shipped that review's top block (skip dock, feedback-loop guard, `radioDaily` KPI). Deferred, in rough
priority order (see [radio.md](radio.md) for the shipped design):

| # | Improvement | Why deferred / what unblocks it | Effort |
|---|-------------|--------------------------------|--------|
| R1 | **Directional session transitions** — ordered A→B edges ("what plays after X") instead of symmetric same-session co-presence. | Needs denser session data (session graph is the thinner of the two); revisit when session seed nodes grow ~3×. Same pipeline, better edge. | Medium |
| R2 | **Variant dedup in the queue** — reuse `dedup.mjs` signatures in the diversifier so "Song / Song (Acapella) / Song (Live)" don't stack in one station. | Not yet observed as a real complaint; cheap whenever wanted. | Small |
| R3 | **Personal context (`exclude=` recent ids)** — the app passes recently-heard videoIds so radio doesn't repeat across sessions; transient query param, server stays anonymous. | Needs an app-side change; bundle with their next radio pass. | Small (server) |
| R4 | **Collab/feat graph for the zero-telemetry tail** — artist↔artist edges parsed from feat./collab credits (`credits.mjs`), covering the ~800 artists with no telemetry at all. | Worth building when tail-seed radio gets real usage; no data dependency. | Medium |
| R5 | **Discovery slots** — occasionally inject a related artist's NEW release (ties radio to the freshness system). | Product call. | Small |
| R6 | **Learned weights** — replace the hand blend (2/1.25/0.2/0.08) with weights tuned on the bench + live skip outcomes. | Needs the release-fleet `radioDaily` signal (below) + more data; pairs with auto-playlists #6. | Medium |
| R7 | ~~**Zemer Stations**~~ **SHIPPED (server) 2026-07-29** — synchronized broadcast, 3 stations (chasidish / dj / israeli) driven by the whitelist style tags: append-only wall-clock schedules, familiarity-first programming (87/72/83% listener-validated slots), skip-dock self-improvement, `/stations` + `/station` + broadcast-style covers. See [stations.md](stations.md). **Remaining: the app side** (Zemer Radio home row + tune-in playback — handoff doc delivered). | Done (server) |

## Backfill ↔ live reconciliation roadmap (the long arc behind items #1/#2/#6)

The standing rule never changes: **the raw tables stay segregated forever** (a zemer-stats hard
invariant) — reconciliation happens only at the scoring layer. What evolves is the *balance*:

- **Now:** backfill is the depth (unbiased by what we surfaced), live is current taste. Blended by
  shrunk device-reach (`1.0·backfill + 0.6·live·(1−skip)`), total-overlap signals MAX-merged, never
  summed (device double-counting is unresolvable from aggregates).
- **The crossover happens on its own:** backfill is **fossilizing naturally** — only ~34% of devices
  had backfilled as of 2026-07-19 and the share is *falling*, because new installs have little or no
  local history to upload. Once the pre-tracking fleet has updated, the backfill corpus is effectively
  frozen, while live reach compounds forever. Because the blend keys on evidence volume, live's weight
  rises without a manual flip. When engagement data suffices, item #6 replaces the reasoned weights
  with measured ones.
- **End state — backfill keeps exactly two jobs:** (1) the **all-time base layer of Top 50** (old plays
  are real plays; a "recent-era" list, if ever wanted, is built by time-decaying live data — not by
  deleting backfill), and (2) the **cold-start prior for the future recommender** — reconciled
  per-device there, under the zemer-stats caveats (snapshot∪live favorites never summed per device;
  backfilled downloads = weak corroboration; backfill plays are ≥10s-only, so they can never feed
  skip/negative-signal models).
- **Never:** summing counts across tables, clamping backfill timestamps into live windows, or letting
  backfill feed any windowed/live metric.

## Queued — what happens next, and what triggers it

Nothing here needs a decision today; each line names the **trigger** that makes it actionable, so this
table is the thing to re-read whenever one of those fires.

| What | Waiting on | Who acts |
|------|-----------|----------|
| **Velocity Trending activates** | Both compared windows clear of The Three Weeks — **≈2026-08-06**. Self-activating: nothing to deploy. **Verify:** the `zemer-autoplaylists` run log flips from `reach mode` to `VELOCITY mode`. | Nobody — confirm only |
| **Exposure dampener activates (#3)** | In order: (a) the **app** ships impression logging (home + search + the `zemer:` chart screens); (b) set `EXPOSURE_REQUIRED_SURFACES` to the surfaces that release instruments — **mandatory**, an unset list keeps the gate closed forever; (c) wait until every declared surface reports ≥10 devices AND coverage ≥60% over ≥20 devices; (d) let chart-screen impressions accumulate **a full week** — a `DRY=1` diff taken mid-rollout measures the rollout, not the dampener; (e) run that diff, share it, then set `EXPOSURE_DAMPENER=on` deliberately. **Verify:** the run log prints `exposure dampener ON (28d exposure window) — coverage N%…`; until then it prints exactly why it is off. | App, then us |
| **Chart badges in the app (#7)** | An app-side update rendering `prevRank`/`delta`/`new`, already served by `/zemer-playlists?id=auto-*`. The web UI and the tracking dashboard's **Chart movement** card (self-gating, shipped 2026-07-24) already show them. | App side |
| ~~**CTR per surface**~~ **DROPPED from v1** (app-side review, 2026-07-24) | Not computable as designed: `play.source` is the *queue context*, not the row tapped — home taps report `zemer:…`/`playlist:…` (never a `home:*` surface), so featured surfaces would read ~0% CTR, and `radio` autoplay reports plays that were never shown at all. Needs a **separate `play.surface`** plumbed from the tapped UI row through queue construction — its own app-side request, not a free consequence of impressions. | Deferred |
| **Weight validation (#6)** | Enough click/play-through data to measure which weighting predicts engagement. Pairs naturally with velocity now being live. | Us |
| **Radio release verdict** | The Zemer-radio app build reaching a RELEASE (it's nightly-only as of 2026-07-29, so the `radioDaily` dashboard card currently measures the old `YouTube.next()` baseline, ~66–78% skip). At release: compare before/after on that card — the honest scoreboard for corpus-native radio — then revisit R6 (learned weights). | App ships, then us — verify |
| **#108 regular-channel harvest** | Promised to the app (artist/album handoff): 63 of the 66 track-less whitelisted artists have a `regularChannelId` whose uploads we don't harvest. Needs a harvest pass over regular channels (scope: whitelist-purity rules already exist — `ownsRow`). Closes the empty-`/artist` gap. | Us |
| **NY-align the non-dashboard day boundaries** | Deliberately deferred (operator call, 2026-07-29 — dashboards were the priority and are done): the home-row daily rotation flips at midnight UTC (= 7–8pm NY) and the chart week rolls Sunday 00:00 UTC (= Motzei Shabbos NY). Flip both to America/New_York midnights if the evening flip ever bothers users. | You (say go), then us |
| **Per-genre auto lists (#5)** | A product decision + a genre/mood tag per track or artist to slice on. | You |
| **Next season's acapella cold-start** | Next year's 17 Tammuz. This season's window (1,598 plays / 97 devices, 2026) sits in the stats DB — seed the initial order from it if the early-season window is thin. | Us, next year |

## How to revisit

- ~~Post-Tisha-b'Av batch (#1 + #2 + #7)~~ — **shipped together 2026-07-24**. Velocity runs in reach-mode
  fallback until both compared windows clear the season (first clean activation ≈2026-08-06 — watch the
  run log flip to "VELOCITY mode").
- **When the app ships impression events** (handoff doc delivered 2026-07-24): #3's dampener does **not**
  engage by itself — follow the flip runbook in the Queued table above. The run log states the gate's
  decision and its reason on every run.
- **Next season's acapella cold-start:** this season's Three-Weeks window (1,598 plays / 97 devices, 2026)
  is recorded in the stats DB — seed next year's `auto-acapella-top-50` initial order from it if the early
  window is thin.
