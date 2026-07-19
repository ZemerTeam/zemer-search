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
| 1 | **Velocity-based Trending** — rank by reach *growth* week-over-week (acceleration), the truest "trending" signal, instead of recent-window reach. | Needs **≥2 weeks of live history** AND post-Tisha-b'Av windows (the Three Weeks skews both sides of the comparison). **Groundwork shipped 2026-07-19:** the rank-history sidecar snapshots the raw 7-day reach twice daily, so "reach 7 days ago" is read from disk — no stats-server change needed. Revisit ~2026-07-27+. | Medium (generator-only now: compare current `topPlays` vs the sidecar snapshot nearest T−7d). |
| 2 | **Fold live favorites/downloads into the ranking.** Today Favorites (and the loved-score's favorite/download terms) use the **backfill snapshot only** — live `topActions` was originally excluded because it carried only a raw event count. | **Stats-server prerequisite DONE 2026-07-16**: live `topActions` now emits `COUNT(DISTINCT device)` per row (per-kind capped). Remaining: a few generator lines (MAX with backfill, never sum — the overlap is total) — deferred until **post-Tisha-b'Av** so the first folded-in favorites reflect normal (non-mourning-season) taste. | Small (generator-only now). |
| 3 | **Exposure-bias ceiling on Trending.** Live plays partly measure *what the app surfaced*, not pure demand (e.g. a freshly-featured album dominates). The reach-primary + skip-dampener formula mitigates it, but can't remove it. | True fix needs **impression logging** (what was *shown*, not just played) from the app — not currently sent, and the app is immutable/out of scope here. Track as a known limit; revisit only if impression events are ever added. | Large (needs app-side event + new signal). |
| 4 | ~~**Near-duplicate guard.**~~ **SHIPPED 2026-07-19** (`harvester/dedup.mjs`, unit-pinned): every ranked list dedups on artist + variant-marker signature + normalized title, before its slice. Conservative by design — variant markers (acapella/live/etc.) and cross-artist same-titles never collapse. Zero behavior change at ship (0 dups in live data). | — | Done. |
| 5 | **Per-genre auto lists** (e.g. "Most played — Upbeat / Kumzitz / Acapella"): same engine, narrower slices. | Product/scope decision, not a correctness gap. Wants a genre/mood tag per track or artist to slice on. | Medium. |
| 6 | **Weight/param validation.** The loved-score weights (`backPlay/livePlay/favorite/download`), the shrinkage `PRIOR`, and the trending skip penalty are reasoned, not tuned against outcomes. | Needs enough click/play-through data to measure which weighting best predicts engagement. Revisit alongside #1. | Medium. |
| 7 | **Spotify-style chart movement (user request, 2026-07)** — per-song ↑/↓/NEW badges on the auto playlists vs a **fixed weekly anchor** (stable all week, "chart published" feel). **The rank-history sidecar is LIVE since 2026-07-19** (orderings recorded twice daily), so history is already accumulating; remaining work: emit `prevRank`/`delta`/`new` per track on `/zemer-playlists` detail (additive) → badges in the web UI. **App shows the badges only after an app-side update** (fields will be waiting in the API; handoff doc on request, never in this repo). | Deferred by choice ("save for later"), not by data — buildable anytime; pairs naturally with #1. | Medium (recorder done; consumer + UI remain). |

## How to revisit

- **Post-Tisha-b'Av (≈2026-07-27+):** do #1 (velocity Trending) + #2 (live favorites) + #7's consumer/UI
  together — the next real accuracy jump. #1's and #7's data recorder is already live (2026-07-19), and #2's
  stats-server prerequisite (per-device counts on live actions) shipped 2026-07-16 — so all three are
  generator/UI work on data that's already flowing.
- **Only if the app ever ships impression events:** #3.
