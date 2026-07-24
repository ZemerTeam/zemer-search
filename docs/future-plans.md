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
| 3 | **Exposure-bias ceiling on Trending.** Live plays partly measure *what the app surfaced*, not pure demand. | **Server + generator SHIPPED 2026-07-24, DORMANT:** zemer-stats accepts batched `impression` events (`/stats topImpressions` = per-video distinct-device exposure) and Trending multiplies in an exposure dampener (`exposureMult`: up to a 35% dock, saturating) — no impression data → multiplier 1, ranking unchanged. **Remaining: the app must ship impression logging** (handoff doc `zemer-tracking-impression-events-request.md`, 2026-07-24); the dampener engages by itself as data flows. | App-side only. |
| 4 | ~~**Near-duplicate guard.**~~ **SHIPPED 2026-07-19** (`harvester/dedup.mjs`, unit-pinned): every ranked list dedups on artist + variant-marker signature + normalized title, before its slice. Conservative by design — variant markers (acapella/live/etc.) and cross-artist same-titles never collapse. Zero behavior change at ship (0 dups in live data). | — | Done. |
| 5 | **Per-genre auto lists** (e.g. "Most played — Upbeat / Kumzitz / Acapella"): same engine, narrower slices. | Product/scope decision, not a correctness gap. Wants a genre/mood tag per track or artist to slice on. | Medium. |
| 6 | **Weight/param validation.** The loved-score weights (`backPlay/livePlay/favorite/download`), the shrinkage `PRIOR`, and the trending skip penalty are reasoned, not tuned against outcomes. | Needs enough click/play-through data to measure which weighting best predicts engagement. Revisit alongside #1. | Medium. |
| 7 | ~~**Spotify-style chart movement**~~ **SHIPPED 2026-07-24** (`server/chart-badges.mjs`, unit-pinned): `/zemer-playlists?id=auto-*` detail rows carry additive `prevRank`/`delta`/`new` (+ `playlist.anchorDate`), computed on RAW chart ranks (viewer content filters can't fabricate movement) against a fixed weekly anchor — the first applied sidecar ordering of the last completed UTC week, rolling Sundays; young history falls back to the series start. Web UI renders ▲/▼/–/NEW on the new **Zemer Playlists** chip. **App badges still need an app-side update** (fields are waiting in the API; handoff doc on request, never in this repo). | Done (server+web). |

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
| **Exposure dampener activates (#3)** | The **app** shipping impression logging (handoff doc `zemer-tracking-impression-events-request.md`, delivered 2026-07-24). Server + generator are deployed dormant. **Verify:** the run log gains `exposure dampener active (N exposed ids)`. | App side |
| **Chart badges in the app (#7)** | An app-side update rendering `prevRank`/`delta`/`new`, already served by `/zemer-playlists?id=auto-*`. The web UI and the tracking dashboard's **Chart movement** card (self-gating, shipped 2026-07-24) already show them. | App side |
| **CTR per surface** | Impression data flowing (same trigger as #3). Then "shown to N devices, played by M" becomes computable per surface — a tracking-dashboard card. | Us, after #3 |
| **Weight validation (#6)** | Enough click/play-through data to measure which weighting predicts engagement. Pairs naturally with velocity now being live. | Us |
| **Per-genre auto lists (#5)** | A product decision + a genre/mood tag per track or artist to slice on. | You |
| **Next season's acapella cold-start** | Next year's 17 Tammuz. This season's window (1,598 plays / 97 devices, 2026) sits in the stats DB — seed the initial order from it if the early-season window is thin. | Us, next year |

## How to revisit

- ~~Post-Tisha-b'Av batch (#1 + #2 + #7)~~ — **shipped together 2026-07-24**. Velocity runs in reach-mode
  fallback until both compared windows clear the season (first clean activation ≈2026-08-06 — watch the
  run log flip to "VELOCITY mode").
- **When the app ships impression events** (handoff doc delivered 2026-07-24): #3's dampener engages by
  itself — verify with the run log's "exposure dampener active" line, then consider surfacing CTR-per-surface
  on the tracking dashboard.
- **Next season's acapella cold-start:** this season's Three-Weeks window (1,598 plays / 97 devices, 2026)
  is recorded in the stats DB — seed next year's `auto-acapella-top-50` initial order from it if the early
  window is thin.
