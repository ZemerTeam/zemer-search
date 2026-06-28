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
| `N` | 20 | harvest | How many whitelisted artists to harvest. |
| `MIN_INTERVAL_MS` / `JITTER_MS` | 900 / — | net | Live-request pacing (IP safety). |
| `MAX_AGE_H` | 12 | refresh | TTL (hours) for re-fetching landing/shelf pages. |

## Typical production setup

```bash
# 1. build/refresh the corpus (cron, e.g. nightly) — unauthenticated, no cookie
MAX_AGE_H=12 node harvester/refresh.mjs

# 2. serve (e.g. systemd), one worker per core
PORT=7700 WORKERS=auto CORPUS_DB=/var/lib/zemer-search/corpus.db node server/api.mjs
```

Put it behind a reverse proxy (TLS, gzip). `/health` is a cheap liveness probe.

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
