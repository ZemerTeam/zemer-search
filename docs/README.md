# zemer-search documentation

Comprehensive docs for the Zemer custom search engine. Start with [`../AGENTS.md`](../AGENTS.md) for the
quick orientation + the gotcha list; come here for the deep dives.

## Contents

| Doc | What it covers |
|-----|----------------|
| [architecture.md](architecture.md) | The hybrid design, module map, data flow, why SQLite + in-memory (and not Typesense/Postgres), Android-version strategy. |
| [search.md](search.md) | **The matcher in full** — normalization, the Hebrew consonant skeleton, IDF, the scoring formula, exact/begins/contains, as-you-type, the precision floor, and the reasoning behind every constant. |
| [harvester.md](harvester.md) | Harvesting a complete discography, the IP-safe net layer, the cache, the channel map, incremental refresh, issue #108. |
| [store.md](store.md) | SQLite schema, the store API, migrations, track detail metadata (durations/plays/track numbers + album aggregates), why re-harvest is free. |
| [api.md](api.md) | HTTP endpoints, the web UI, scaling (cluster + LRU cache + staggered reload), env config. |
| [stations.md](stations.md) | **Zemer Stations** — the synchronized-broadcast radio (one shared wall-clock program per station): the append-only-guard-window scheduler, familiarity-first programming, kosher-for-all pools (no acapella), serve-time purity, tune-in clock math, ops watchdogs. |
| [genres.md](genres.md) | Style at two levels — curated artist flags vs album-anchored `track.genres` (35 slugs), why they are never merged, and how a consumer resolves them at read time (positive selection, policy filtering, veto-by-union). |
| [radio.md](radio.md) | **Zemer Radio** — the corpus-native, whitelist-pure `/radio` continuation that replaces `YouTube.next()`: the co-occurrence blend, cold-seed fallback, the aggregated graph artifact + privacy boundary, stateless continuation, and the held-out quality measurement (beats popularity ~7×). |
| [podcasts.md](podcasts.md) | **Zemer Podcasts** — corpus-native podcast discovery (shows/episodes/host channels) replacing the app's InnerTube podcast calls + Firestore read: the whitelist→harvest→SQLite→`/podcasts*` pipeline, the `/player` duration+ISO-date top-up, and the endpoint contract (playback stays InnerTube). |
| [testing.md](testing.md) | Every benchmark/test harness, what each measures, current numbers, how to read them. |
| [deployment.md](deployment.md) | Running on a server, env vars, horizontal scaling, operational notes. |
| [gotchas.md](gotchas.md) | The bug catalog — every real bug found + the fix + the regression test. Institutional memory. |
| [future-plans.md](future-plans.md) | **Revisit list** — deliberately-deferred improvements (velocity Trending, live favorites, dup guard, …), why each is deferred, and what unblocks it. Review periodically as the telemetry corpus grows. |

## One-paragraph summary

The app's YouTube search returns mostly off-whitelist noise that gets filtered to nothing. zemer-search
harvests every whitelisted artist's complete catalog into a SQLite corpus, builds a pure-data in-memory
index over it, and serves a ranked, category-grouped, content-filtered `/search` API + a web UI that
mirrors the app's search screen. The matcher does cross-script (Hebrew ↔ romanized) and typo-tolerant
ranking with a precision-first philosophy ("fewer/no results over wrong ones"). It's deployable as one
Node process + one DB file, scales to thousands of concurrent users via a query cache + multi-core
cluster, and the *same* matcher is designed to run on-device (pure Kotlin, identical on Android 8 → 15)
as an offline fallback.
