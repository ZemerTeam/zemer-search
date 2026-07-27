# Corpus freshness — new-release lag & the demand-driven refresh spec

**Status: SHIPPED (2026-07-26).** All three layers below are implemented, for **all artists**:
- **Feed-driven pre-harvest** (`harvester/prefetch-releases.mjs` + `zemer-prefetch.timer`, ~every 10 min): reads the releases feed and, for any release whose **album** (`browseId`) or single (`sampleVideoId`) isn't fully in the corpus, harvests that artist **deep + forced-fresh landing** so the new album's **tracklist** lands too. **Album-aware** (the point — RSS was blind to `OLAK` album drops). → Latest Releases / `/new` / `/album` are browsable + playable within minutes of a drop, not just listable.
- **Demand-driven on-open refresh** (`harvester/refresh-one.mjs`, triggered by `/artist` + `/album`): serves the corpus instantly, then if the artist is stale (`REFRESH_STALE_H`, default 6h) spawns a background single-artist re-harvest under the maintenance flock. Cross-worker atomic claim (`store.claimArtistRefresh` on the new `artist.refreshedAt` column) so only one worker triggers; IP-safe; Shabbat-gated. → whatever anyone opens is fresh within minutes.
- **Frequent all-artist shallow sweep** (`zemer-refresh-sweep.timer`, ~every 6h): the existing shallow refresh over **every** artist (a full paced sweep is ~6–7 min), so the all-artist ceiling for feed-missed content drops from ~24h to ~6h.

The daily `maintain.sh` shallow pass remains the floor. The analysis that motivated each layer is kept below.

---

### Original spec (research + rationale)

## The problem

Replacing the app's runtime InnerTube (search → search engine, home → `/home-rows`, artist/album → `/artist`/`/album`) means the app now shows what's in **`corpus.db`**, not YouTube's live catalog. So a **new release only appears once the harvester picks it up** — a freshness lag YouTube didn't have. This is the cost of the trade we made *for* purity + quality (no non-whitelisted junk, cross-script search, real dates); the goal here is to shrink the lag without giving any of that back.

**The lag is bounded, not unbounded.** The daily shallow refresh (`scripts/maintain.sh` via `zemer-refresh-daily.timer`, `Mon–Sat 03:00` + `Sat 22:00`, `MAX_AGE_H=20`) re-fetches every artist's **landing page** whose cache is >20 h old — i.e. **every artist ~daily** — and a new single/album shows on the landing. So **worst-case lag ≈ 24 h, average ~12 h** — with one exception: the refresh is **Shabbat-gated** (`ExecCondition harness/shabbat.mjs`), so a Friday-afternoon release can wait until Saturday-night/Sunday. That's largely moot in practice — the observant audience isn't opening the app during Shabbos — but it means the ≤24 h ceiling is a weekday figure. Measured confirmation: 38 artists gained a brand-new track in the last 24 h (the daily pass catching recent drops in real time). Deep pagination is the Sunday weekly pass; the daily shallow pass (~1 request/artist) is what governs new-release latency.

**Where it still bites:** a fan who opens an artist (or checks New Releases) in the hours right after a drop can miss it until the next 03:00 pass. That's the gap worth closing.

> Note on a metric that looks alarming but isn't: `track.harvestedAt` is a track's *first-seen* time, not the artist's last-check time (the upsert doesn't bump it when nothing changed). So "1,508/1,559 artists' newest track is >7 d old" just means most artists haven't *released* anything in a week — normal — **not** that they aren't being refreshed.

---

## The fix — three layers

### Layer 1 — demand-driven refresh on open  ★ primary, high-impact, low-cost

When the app opens an artist (`/artist`) or album (`/album`): **serve the corpus immediately** (fast, unchanged), **and if that artist is stale (> T hours) enqueue a background single-artist shallow re-harvest** (reusing the per-artist harvest in `harvester/core.mjs`). The next view is current.

- **Why it's cheap:** only **a few hundred distinct artists are ever viewed** — measured **≥284** via artist-context plays (1,698 plays / 284 artists / 128 devices), a **lower bound** since a browse that didn't lead to a play isn't counted, but clearly a small fraction of the 1,559. Demand-driven refresh only ever touches *viewed* artists — the long tail nobody opens is never triggered. A per-artist shallow harvest is ~1 landing request, paced through `net.mjs`.
- **Freshness delivered:** anything anyone looks at refreshes within seconds–minutes of being viewed → practical lag drops from "≤24 h" to "the next open." Caveat: the **first** viewer right after a drop still sees stale until the background job finishes (seconds–minutes later); the second viewer, and that first viewer's next open, are fresh.
- **Design decisions (the spec):**
  - **Staleness signal `T`:** need a per-artist "last refreshed" timestamp. Two options — (a) a new `artist.refreshedAt` column bumped by every refresh (clean, explicit), or (b) reuse the `net.mjs` landing-page cache mtime (no schema change, but couples to cache internals). Recommend (a). Suggested `T ≈ 6 h` (frequent-enough freshness without redundant harvests).
  - **Trigger mechanism:** the API must kick a harvest without blocking the response. The reusable entry is `core.mjs`'s exported **`harvestArtist(artist, browse, {shallow:true})`** — the exact per-artist path `refresh.mjs` loops over. There is **no single-artist CLI today**, so either (a) call `harvestArtist()` from an in-process bounded queue on the server's own `net.mjs` limiter (simplest), or (b) add a one-artist arg to `refresh.mjs` and `spawn` it. Must **dedupe** (don't re-trigger an artist already in-flight or refreshed < T ago) and **coordinate with the maintenance flock** (skip/defer if a full refresh holds it).
  - **First-view freshness (optional, opt-in):** for the freshest-but-slower path, `/artist` could do **one synchronous landing fetch** on a very-stale open and merge new items into the response. Cost: added latency + one server-side InnerTube call per stale open. Recommend **async by default**, sync only above a high staleness bar (or off).
- **IP budget:** bounded by viewed-artist count (~284) × (opens beyond T) — trivial next to the existing ~9 min/day full shallow pass, all under `net.mjs` pacing. App stays InnerTube-free (server does the fetch).

### Layer 2 — RSS "new-drop" detector  ○ optional accelerator, NOT a fix

Poll each regular channel's uploads feed (`youtube.com/feeds/videos.xml?channel_id=…`) — a lightweight XML GET, **not** an InnerTube browse — to notice a new upload cheaply, then targeted-harvest just that artist.

- **Measured reality:** works for **~2/3** of channels (4 of 6 sampled returned 4–15 recent entries with timestamps) but **~1/3 return nothing** (Topic/auto channels with no standard uploads feed), and it is **blind to music-channel-only album drops** (albums/`OLAK` releases that never appear as a regular-channel video upload).
- **Verdict:** a useful *accelerator* for faster single/video detection on active regular channels, but **partial** — it can't replace the daily browse refresh (which catches albums + the RSS-blind third). **Defer** unless faster single/video latency is specifically wanted; if built, it only *prioritizes* which artists to re-harvest sooner, never the sole signal.

### Layer 3 — the baseline daily refresh  ● keep as the floor

The existing daily shallow pass stays as the safety net — it catches everything Layers 1–2 miss (un-viewed artists, music-channel albums, RSS-blind channels) and sets the ≤24 h ceiling. **Optional tightening:** a "hot subset" (most-viewed or recently-active artists — the ~284) refreshed more often than daily (e.g. every few hours) shaves the baseline lag for the artists that matter most, at negligible IP cost.

---

## Latest Releases must be instant — feed-driven pre-harvest

**Requirement:** the home tab's **Latest Releases** must be usable *as soon as a release arrives*, not on the daily-harvest delay. This is the *discovery* case (the user isn't opening a known artist), so the on-open demand-driven refresh above does **not** cover it.

**What the app does today (verified):** Latest Releases is **not** corpus- or InnerTube-sourced — it fetches an **external curated feed**, flipphoneguy-api `/zemer/recent-releases.json` (etag-cached, `ignoreUnknownKeys`, `.filterWhitelisted(database)`, isolated so a feed failure can't hurt Home). So **discovery is already instant** — the feed lists new releases fast, filtered to the whitelist.

**The real gap is instant *playability via corpus*.** A brand-new feed release may not be harvested yet, so opening it through `/album` (the corpus, once we retire InnerTube on album-open) would 404. The clean fix — and a *better* freshness signal than the per-channel RSS above — is a **feed-driven pre-harvest**: the **server** subscribes to the same flipphoneguy recent-releases feed and **harvests those items immediately** (a handful of releases, high-signal, **album-aware** — which per-channel RSS was blind to), so `/album`/`/new`/`/artist` carry them within minutes of the feed publishing. This makes Latest Releases instant-playable **without the app touching InnerTube**, and keeps `/new` (our corpus New-Releases surface) current too.

**Two layers, two cases:** feed-driven pre-harvest = *discovery* freshness (Latest Releases, `/new`); demand-driven on-open = *artist-page* freshness. Together they close the lag for both the things users discover and the things they navigate to. (Belt-and-suspenders: the app can also keep playing a just-arrived feed release directly from the feed's own ids until the corpus catches up — but pre-harvest should make that window seconds, not hours.)

## Recommendation & sequencing

1. **Layer 1 (demand-driven on open)** — the core fix. Closes the gap to minutes for the ~284 artists anyone actually views; no app change; purity + IP-safety + app-InnerTube-free all preserved. Start with `artist.refreshedAt` + an in-process deduped, flock-aware trigger, async-only.
2. **Layer 3 hot-subset cadence** — cheap complement; a few-hourly shallow pass over the viewed set, so even a *first* view is usually fresh and `/new` stays current.
3. **Layer 2 (RSS)** — defer; revisit only if single/video latency needs to be sub-hour and the ~2/3 coverage + album-blindness are acceptable as an accelerator.

**Not a fatal flaw:** the lag is bounded (≤24 h today) and the tradeoff bought the whole reason the corpus exists. Layer 1 reduces it to minutes for viewed content at trivial cost.

---

## Open questions
- `refreshedAt` column vs `net.mjs` cache-mtime as the staleness signal (recommend the column).
- Trigger: in-process queue vs `spawn`ed child; how it shares/limits `net.mjs` concurrency with a possibly-running maintenance refresh (flock).
- First-view freshness: async-only (simplest) vs opt-in synchronous merge (freshest, slower, per-open InnerTube).
- `/new` freshness: does it need its own faster pass, or does the hot-subset cadence cover it?
- Does `/album` open also warrant a trigger, or is artist-open enough (albums are usually reached via an artist)?

---

## Evidence (measured 2026-07-26, live VPS)
- **Refresh cadence:** `harvester/refresh.mjs` `MAX_AGE_H` default 20 h; `zemer-refresh-daily.timer` `Mon–Sat 03:00` + `Sat 22:00`; deep Sunday. Shallow = landing-only (~1 req/artist).
- **Recent-drop catch:** 38 of 1,559 artists have a track first-seen in the last 24 h (daily pass catching new releases).
- **Artist-view volume:** `ev_play WHERE source LIKE 'artist:%'` → 1,698 plays, **284 distinct artists**, 128 devices. (`ev_open` carries only `{ts,device}` — no artist target — so artist-context plays are the proxy.)
- **RSS feasibility:** `videos.xml?channel_id=` over 6 regular channels → entry counts 0, 4, 7, 15, 15, 15 (≈2/3 usable); Topic/no-upload channels return 0; music-channel album releases don't appear.
- **Harvest pace:** `net.mjs` maintenance opt-in `CONCURRENCY=5`, `MIN_INTERVAL_MS=200` (~3 req/s); full shallow of 1,559 artists ≈ 9 min.
