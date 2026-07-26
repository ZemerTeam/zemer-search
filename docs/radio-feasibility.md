# Zemer Radio — feasibility research

**Status:** research only, nothing implemented. Assesses two distinct products:
1. **Per-user radio** — a seed (song/artist) → an endless, whitelist-pure, related queue (like today's radio, but recommended *from* the corpus instead of filtered *down* from YouTube).
2. **Zemer Stations** — a **synchronized broadcast**: one server-programmed stream where every listener hears the same track at the same wall-clock moment (a real station, not personalized radio, and deliberately **not** a loop of the auto-playlists).

All figures below were measured against the live VPS corpus + `zemer-stats` telemetry on 2026-07-26; see the **Evidence** section for provenance and caveats.

---

## Data landscape

| | |
|---|---|
| Corpus | 71,692 tracks · 1,625 artists (1,559 with tracks) · 13,913 albums · 58,982 album→track links |
| Artist depth | median **15** tracks/artist, p90 113, max 1,221; **986 artists ≥10 tracks, 678 ≥20**; 8,230 tracks (11.5%) carry a `feat/ft` credit |
| Telemetry | **419 devices** with play history, ~83k (device,track) pairs; **16,967 distinct tracks appear in play events** (live + backfill; ≈24% of the catalog — a few may be non-corpus tracks users played) |
| Track length | median **4 min**, p10 2 min, p90 8 min |
| **Duration coverage** | **100%** (71,658/71,692; and 99.9% of *live-played corpus tracks*, 8,157/8,162) — the enabler for a synchronized timeline |
| Radio today | 5,220 plays / **199 devices (~half the fleet)** — real, existing demand |

Today's radio already filters YouTube's `next()` results to the whitelist (it is **not** a purity leak). Its weakness is the *inverse*: it recommends across all of YouTube then discards most of it, so the kosher queue is **shallower and more generic than a corpus-native engine would produce** — the same "search all of YouTube, drop the rest" flaw the search engine was built to fix.

---

## Part 1 — Per-user radio: **feasible now** (3-layer signal)

**Layer A — device co-occurrence (the smart core; feasible now for the head/torso).**
"Listeners who played X also played Y." Depth is real: a popular seed has **~1,700 neighbors with ≥3 co-play devices**; **~2,500 tracks are ≥5-device seedable, ~4,730 ≥3-device**. Spot-checks were coherent down to the mid-tier (a 30-device seed → same-lane contemporary artists, not random). Because the catalog is a **single homogeneous domain** (Jewish music, no secular), even popularity-biased co-occurrence stays on-genre — the usual "radio drifts into generic hits" failure is milder here.

**Layer B — artist/album graph (fallback; feasible now, everywhere).**
Covers the long tail (54,725 tracks never played, ~67k below the ≥3-device co-occurrence bar): seed → same artist (median 15 tracks; 986 artists sustain ≥10), its albums (58,982 links), and the 11.5% feat-collab edges. Guarantees an on-topic queue for *any* seed, including brand-new/unplayed songs (cold-start).

**Layer C — popularity/recency fill.** Trivial (Top 50 / reach already computed) — diversity + endlessness.

**Architecture:** pure-data → **IP-safe** and **Kotlin-portable** (like the matcher); the *recommendation* logic can even run on-device — but "offline" is only true over already-downloaded tracks, since playback still fetches audio from YouTube. Content-filtered + season-aware for free. A precomputed related-tracks table (a generator over `zemer-stats`, like `auto-playlists`) + a `/radio` endless endpoint. App side is low-friction: a clean `Queue` interface (`getInitialStatus`/`nextPage`/`playSource`) already exists; a `ZemerRadioQueue` slots in like `YouTubeQueue`/`LocalAlbumRadio`.

---

### Scope note — long-press **Shuffle** rides on this, it's not a separate task

Shuffle splits by whether the entity carries a YouTube `shuffleEndpoint`:
- **Zemer-native entities** (search results, Zemer curated + auto playlists, Latest Releases, library/downloads) set `shuffleEndpoint = null` — the whole filtered list is already in hand, so Shuffle is a **local `ListQueue(items.shuffled())`, no InnerTube.** Already done.
- **YouTube-native screens** (a YouTube artist page's Shuffle, `YouTubeAlbumMenu`/`YouTubePlaylistMenu`) build a `WatchEndpoint(shuffleEndpoint…)` → `YouTubeQueue` → `YouTube.next()` = **InnerTube.**

So there is **no standalone "replace Shuffle" task**: (a) a *finite* shuffle becomes local automatically the moment its screen is migrated to a corpus-backed artist/album/playlist (`shuffleEndpoint` → `null` → `ListQueue`), and (b) the *endless* YouTube **artist shuffle** (`RDAO…` → `next()`) is really artist-radio, so it **folds into Zemer Radio (artist-seeded)**. Both are already legs on the InnerTube-replacement map — Shuffle just comes along.

---

## Part 2 — Synchronized stations: **feasible now**, and cheaper to scale than per-user radio

**The only viable sync model** (we don't host or own the audio — playback stays per-client via YouTube, for IP-safety and ToS): **the server publishes a schedule; clients self-sync by wall clock.** No streaming, no transcoding, no per-listener server cost.

- **Enabler (confirmed): 100% duration coverage** → the scheduler computes an exact timeline `[{videoId, startEpoch, durSec}, …]`.
- **Artifact:** `/station/<id>/schedule` — a rolling playout log (next few hours), regenerated *ahead* by a scheduler. Tiny JSON, cacheable/CDN-able → **scales to unlimited listeners at zero marginal server cost** (a real edge over per-user radio, which computes per seed).
- **Client tune-in:** fetch server time once (compute clock skew); find the entry where `start ≤ now < start+dur`; play that `videoId` **seeked to `now − start`**; advance per schedule. A `StationQueue` implements the existing `Queue` interface.
- **Precision:** device clock (NTP) + buffering → a few seconds' skew — "same song, ~same place, together," not sample-accurate. Fine for the goal.
- **Edge cases:** a track a client can't play (region/age — rare here) → idle to the next boundary rather than diverge (sync preserved); transitions prefetch the next entry.

### Stations must NOT duplicate the auto-playlists
A "Top 50 Station" would just be the Top 50 playlist on loop. Stations differentiate on three axes a browse-list structurally cannot:
1. **Live & shared** — synchronized, communal (klal Yisrael together). A *kind of experience*, not a list.
2. **Continuous whole-catalog flow** — a co-occurrence graph-walk pulls hits **+ deep cuts + new releases** into a coherent endless journey across the whole 71k-track world, never a fixed 50.
3. **Contextual / day-part / seasonal programming** — the schedule *changes with time*: Erev Shabbos (calmer), Motzei Shabbos (upbeat), late-night (hartzig), and **Acapella during the Three Weeks** (reusing all the seasonal infra). A playlist is static; a station has a clock.

Concrete non-dup lineup: a main **Zemer Radio** (always-on whole-catalog flow), an **Acapella** station (seasonal, communal), and **day-part** variants — none mirroring Top 50 / Trending / Favorites / Downloaded.

---

## Co-occurrence, deeper — the engine behind *flow*

Raw co-play is popularity-biased: `co(A,B) ≈ pop(A)·pop(B)/N`. Normalizations:

| Metric | Formula | Behavior |
|---|---|---|
| Lift / PMI | `co·N / (dev(A)·dev(B))` | True affinity, but **over-rewards rare pairs** — needs a hard support floor |
| **Jaccard** | `co / (dev(A)+dev(B)−co)` | Bounded, **stable**, self-penalizes popularity mismatch — best default |
| Conditional | `P(B\|A) = co/dev(A)` | **Asymmetric** — the right shape for "what plays next" |

**Recommended:** Jaccard (affinity) blended with `P(B|A)` (direction), a **co≥3 support floor**, and **shrinkage** `co/(co+k)` so a 3-device pair can't outrank a 30-device pair at equal Jaccard — the discipline that keeps 419-device noise out.

**Sequencing = a graph walk, not a sort.** From the current track, pick the next by weighted-random among top-k normalized neighbors, with an **artist-exclusion window** (no repeat artist within N) and a **recency window** (no repeat track within M). That produces a *programmed-feeling journey* (hit → related deep cut → related new release → back toward a hit) — what makes a station feel curated and stops it being a chart on loop. Cold nodes (thin co-occurrence) fall to the artist/album graph, then re-enter the co-occurrence graph when it reconnects.

---

## Risks / open questions

- **Co-occurrence quality is spot-checked, not audited** — 2 seeds looked coherent; a fuller quality pass is warranted before building. The homogeneous-domain "stays on-genre" claim is reasoning, not a measurement.
- **419-device noise** — the support floor + shrinkage are load-bearing; without them the tail is junk.
- **Concurrency is modest today** — see the Evidence caveat: ~80–90 *distinct devices active per peak hour* is **not** instantaneous concurrency (which is a fraction of that — likely low double digits now). "Everyone together" is an early-days communal feature that pays off as adoption grows (and a live station can itself *drive* concurrency).
- **Clock discipline** — needs a server-time handshake; standard.
- **Mid-track join seek** — assumes the player reliably seeks into a freshly-loaded YouTube stream on tune-in; needs verification (buffering latency is a minor UX cost).
- **Scheduler must run ahead** with fail-safe filler (never runs dry) — same discipline as the auto-playlists apply.
- **"Live" UX tradeoff** — on a true station a user can't skip (or "skip = leave live / go personalized"); product decision.
- **Editorial posture** — a programmed broadcast is a more editorial act than a search tool, though it only sequences content users can already play; low concern, worth a glance.
- **Recompute cost** — per-track neighbor computation over ~83k pairs is cheap now; all-pairs co-occurrence scales super-linearly, so watch it as telemetry grows (bounded top-k per track keeps it fine).

---

## Verdicts

- **Per-user radio:** feasible now. Co-occurrence carries the popular head/torso with coherent results; artist/album graph guarantees coverage + cold-start; popularity fills. Pure-data, IP-safe, app-integratable (recommendation logic is portable/on-deviceable; playback still needs network except over downloads).
- **Synchronized stations:** feasible now, and the "published schedule + client wall-clock seek" model scales more cheaply than per-user radio. 100% duration coverage is the enabler and it's there. The real work is **programming quality** (the co-occurrence flow) and treating stations as a *live, contextual, whole-catalog* experience — explicitly not chart loops.
- **The weak categories don't block either** — co-occurrence flow + day-part/season context carry the programming without genre tags.

---

## Evidence (provenance + caveats)

All measured 2026-07-26 against `/root/deployed-apps/zemer-search/data/corpus.db` and `/root/deployed-apps/zemer-stats/data/stats.db` on the VPS.

- **Corpus counts** — `COUNT(*)` on `track`/`artist`/`album`/`album_track`; tracks/artist percentiles from `GROUP BY artistId`.
- **Co-occurrence** — device→track sets from `ev_play ∪ ev_play_backfill` (419 devices, ~83k pairs); per-seed neighbor counts by shared-device count; quality eyeballed on 2 seeds (1 top-tier, 1 ~30-device). **Caveat: a 2-seed spot check, not a systematic audit.**
- **Seedable coverage** — distinct-device count per track: ≥1 → 16,967; ≥2 → 7,723; ≥3 → 4,730; ≥5 → 2,500; ≥10 → 948.
- **Duration** — `durationSec IS NOT NULL AND >0`: 71,658/71,692 (100%); 8,157/8,162 **live-played corpus tracks** (99.9%). (Note: the 8,162 here is distinct *live* `ev_play` tracks that are in the corpus — a narrower set than the 16,967 live+backfill play-event universe above; they are not the same denominator.)
- **Listening rhythm** — `ev_play` grouped by UTC hour, last 7d: peak 17:00–21:00 UTC at 68–92 **distinct devices per hour**. **Caveat: devices-active-per-hour ≠ instantaneous concurrent listeners** (the latter is materially lower).
- **Radio usage** — `ev_play WHERE source='radio' OR source LIKE 'radio:%'`: 5,220 plays / 199 devices.
- **App integration** — `~/repos/ZemerTeam/zemer-app` `playback/queues/`: `Queue` interface (`getInitialStatus`/`nextPage`/`playSource`); `YouTubeQueue` already applies `filterWhitelisted`.
