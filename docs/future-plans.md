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
| 1 | **Velocity-based Trending** — rank by reach *growth* week-over-week (acceleration), the truest "trending" signal, instead of recent-window reach. | Needs **≥2 weeks of live history** to compute a reliable slope. As of launch there were 4 days. Revisit ~2026-07-22+. | Medium (generator: compare current vs prior window per videoId). |
| 2 | **Fold live favorites/downloads into the ranking.** Today Favorites (and the loved-score's favorite/download terms) use the **backfill snapshot only** — live `topActions` is intentionally excluded because the stats server emits only a raw event **count** (`n`), not distinct-**device** reach, and mixing a count into a device-reach score over-ranks a song one device saved repeatedly. | Needs a small change **in the sibling `zemer-stats` repo**: emit `COUNT(DISTINCT device)` for live `topActions` (as it already does for `topActionsBackfilled`). Then `harvester/auto-playlists.mjs` folds it in (MAX with backfill, never sum — the overlap is total). | Small (one SQL change in zemer-stats + a few lines here). |
| 3 | **Exposure-bias ceiling on Trending.** Live plays partly measure *what the app surfaced*, not pure demand (e.g. a freshly-featured album dominates). The reach-primary + skip-dampener formula mitigates it, but can't remove it. | True fix needs **impression logging** (what was *shown*, not just played) from the app — not currently sent, and the app is immutable/out of scope here. Track as a known limit; revisit only if impression events are ever added. | Large (needs app-side event + new signal). |
| 4 | **Near-duplicate guard.** A song and its acapella/re-upload (different `videoId`, same title+artist) could both surface and split reach. Measured **0 occurrences** at launch, so not yet needed. | Latent, not active. Cheap to pre-empt: dedup by normalized `title`+`artistId` in the generator, keeping the higher-ranked id. Do anytime as future-proofing. | Small. |
| 5 | **Per-genre auto lists** (e.g. "Most played — Upbeat / Kumzitz / Acapella"): same engine, narrower slices. | Product/scope decision, not a correctness gap. Wants a genre/mood tag per track or artist to slice on. | Medium. |
| 6 | **Weight/param validation.** The loved-score weights (`backPlay/livePlay/favorite/download`), the shrinkage `PRIOR`, and the trending skip penalty are reasoned, not tuned against outcomes. | Needs enough click/play-through data to measure which weighting best predicts engagement. Revisit alongside #1. | Medium. |
| 7 | **Spotify-style chart movement (user request, 2026-07)** — per-song ↑/↓/NEW badges on the auto playlists vs a **fixed weekly anchor** (stable all week, "chart published" feel). Server-side: persist each run's ordering to a gitignored `auto-playlists-history.json` sidecar → emit `prevRank`/`delta`/`new` per track on `/zemer-playlists` detail (additive) → badges in the web UI. The same rank-history sidecar feeds #1 (velocity). **App shows the badges only after an app-side update** (fields will be waiting in the API; handoff doc on request, never in this repo). | Deferred by choice ("save for later"), not by data — buildable anytime; pairs naturally with #1. | Medium. |

## How to revisit

- **~2 weeks post-launch (≈2026-07-22):** do #1 (velocity Trending) + #2 (live favorites) together — that's the
  next real accuracy jump, and both want the same "more data has accumulated" precondition.
- **Anytime:** #4 (dup guard) as cheap insurance.
- **Only if the app ever ships impression events:** #3.
