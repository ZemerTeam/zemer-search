# Deployment & operations

zemer-search runs on a dev PC today but is built to **lift onto a server unchanged** — it's one Node
process + one SQLite file, all inputs env-configurable.

## What ships

- The code (`harness/ harvester/ corpus/ index/ server/` + `package.json`).
- `data/corpus.db` (the built corpus) — or rebuild it on the server from the cache/whitelist.
- `node_modules` (just `better-sqlite3`; `npm ci` on the target).

The gzipped HTTP cache (`data/.httpcache/`) is **local + disposable** — it rebuilds, or copy it to make
the first server-side harvest free.

## Environment variables

| Var | Default | Used by | Purpose |
|-----|---------|---------|---------|
| `CORPUS_DB` | `data/corpus.db` | all | SQLite path (e.g. `/var/lib/zemer-search/corpus.db`). |
| `PORT` | 7700 | API | HTTP port. |
| `WORKERS` | 1 | API | `auto` = one worker per core (production); a number; 1 for dev. |
| `RELOAD_MS` | 30000 | API | In-memory index rebuild interval. |
| `CACHE_MAX` | 5000 | API | LRU query-cache size. |
| `REL_FLOOR` | 0.4 | matcher | Precision floor (drop results below this fraction of the top score). |
| `CONCURRENCY` | 1 | net | Max live requests in flight. **1 = single-flight.** `maintain.sh` sets 5. Higher = faster, still rate-capped. |
| `MIN_INTERVAL_MS` / `JITTER_MS` | 900 / 500 | net | Min gap + jitter between live request **starts** (the aggregate-rate cap). `maintain.sh` sets 200/200 (~3 req/s with concurrency 5). |
| `BLOCK_COOLDOWN_MS` | 300000 | net | After an anti-bot page, back off this long before any live request (circuit breaker; auto-recovers). |
| `MAX_AGE_H` | 20 | refresh | TTL (hours) for re-fetching landing/shelf pages. |
| `SHALLOW` | — | refresh | `1` = fast landing-only pass (daily). Unset = **deep** full pagination (default; weekly). |
| `PRUNE_MIN_RATIO` | 0.5 | prune | Refuse to prune unless ≥ this fraction of **current** artists survive (corpus-wipe guard; bad value → 0.5). |
| `BLOCKLIST` | `data/blocklist.json` | store | Curated `{videoIds,artistIds}` excluded regardless of whitelist (upsert skips them; prune removes them). |
| `ZEMER_APP` | `../zemer-app` | whitelist | Path to the app repo for `google-services.json` (whitelist creds). |
| `N` | 20 | harvest | (initial) how many whitelisted artists to harvest. |

## Typical production setup

**Serve** (systemd), one worker per core. Put it behind a reverse proxy (TLS, gzip); `/health` is a
cheap liveness probe:
```bash
PORT=7700 WORKERS=auto CORPUS_DB=/var/lib/zemer-search/corpus.db node server/api.mjs
```

**Maintain the corpus** with the orchestrator `scripts/maintain.sh [shallow|deep]` (no cookie needed). It
runs the whole pipeline under a `flock`, in order: `whitelist` refetch → `onboard` new artists → `prune`
de-whitelisted → `refresh` (deep, or shallow when invoked `shallow`). **Prune runs before refresh** so
refresh never wastes paced requests re-harvesting artists about to be deleted. On an anti-bot block in any
network step the **whole pipeline aborts** (exit 75) — no more live requests at a flagged IP. The pipeline
uses a fast-but-IP-safe profile (`CONCURRENCY=5`, `MIN_INTERVAL_MS=200` → ~3 req/s, bounded, never a
burst). On the same box the API auto-reloads `corpus.db` within `RELOAD_MS`, so there is **no reload step**.

```bash
scripts/maintain.sh shallow     # daily: fast landing-only refresh (SHALLOW=1), catches new releases
scripts/maintain.sh deep        # weekly: full-pagination backfill (refresh default)
```

### Schedule (recommended — fast + reliable)

| Job | When | What | Cost (this profile) |
|-----|------|------|------|
| **daily shallow** | **Mon–Fri 03:00, Sat 22:00** | new releases for all artists + onboard + prune | ~10–12 min |
| **weekly deep** | **Sun 03:00** | full re-pagination backfill (catches anything buried) | longer |

**Shabbat-aware:** nothing runs on Saturday until after Shabbat — the Saturday pass is at **22:00**, and
Friday's is at 03:00 (before Shabbat). Sunday is the deep pass. The schedule is split by day so the daily
and weekly never contend for the flock (the weekly deep is never skipped). Album track-lists are immutable
(forever-cached); a **shallow** pass re-pulls only each
artist's landing (~1 request/artist) to catch new releases, while **deep** re-paginates every shelf. The
bounded-concurrency limiter (above) makes both ~3× faster than serial while staying well under anti-bot
thresholds. A block aborts the pipeline (exit 75; the gzip cache resumes free next run), and `prune`
refuses to run on a too-small/mismatched whitelist (`PRUNE_MIN_RATIO`).

Install the systemd units from [`deploy/`](../deploy) (edit `WorkingDirectory` + `ZEMER_APP` first):
```bash
sudo cp deploy/zemer-refresh@.service /etc/systemd/system/
sudo cp deploy/zemer-refresh-daily.timer deploy/zemer-refresh-weekly.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now zemer-refresh-daily.timer zemer-refresh-weekly.timer
systemctl list-timers 'zemer-refresh*'     # next-run times   ·   journalctl -u 'zemer-refresh@*' -f
```

Cron alternative (Shabbat-aware — Mon–Fri AM + Sat after Shabbat shallow, Sunday deep):
```cron
0 3  * * 1-5  cd /path/to/zemer-search && ZEMER_APP=/path/to/zemer-app scripts/maintain.sh shallow >> /var/log/zemer-refresh.log 2>&1
0 22 * * 6    cd /path/to/zemer-search && ZEMER_APP=/path/to/zemer-app scripts/maintain.sh shallow >> /var/log/zemer-refresh.log 2>&1
0 3  * * 0    cd /path/to/zemer-search && ZEMER_APP=/path/to/zemer-app scripts/maintain.sh deep    >> /var/log/zemer-refresh.log 2>&1
```

## Horizontal scaling

The API is **stateless** and the DB is **read-only at request time**, so scale out by running N instances
each with its own copy of `corpus.db` (a small, compact file), behind a load balancer. Refresh the file
periodically (rsync from the harvester box, then `POST /reload`). No shared/central database — that's the
advantage of SQLite + in-memory here. One harvester writes the canonical `corpus.db`; serving replicas
only read.

## Capacity (measured)

- **Cached (realistic as-you-type):** ~9,000 req/s, 0 errors — the server isn't the bottleneck (users
  share prefixes → high cache hit). 
- **Uncached worst case:** ~312 req/s per core (full search) → near-linear with `WORKERS` (1,787 on 8).
- A 16-core box handles thousands of concurrent users; scale out for more.

## Operational notes

- **Restart after a matcher/UI code change** (the index reloads data on a timer, but the module loads
  once). The harvest and API are independent processes.
- **The harvest self-protects:** it aborts on the first anti-bot page and resumes from cache. A full
  1,608-artist harvest should grow *over time*, not in one blast.
- **Schema change:** drop `corpus.db` and re-harvest (free, cache replay) on a fresh box; on a live box
  use a guarded `ALTER` in `openCorpus` to avoid downtime.
- **Secret** `google-services.json` (whitelist/Firestore fetch) is a read-only input provided via env /
  secret store — never baked into the image or committed. (No cookie is needed: browse + search are
  unauthenticated.)
