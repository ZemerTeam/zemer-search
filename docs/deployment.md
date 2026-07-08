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

**Serve** (systemd, boot-enabled, `Restart=always`). Bind **localhost** and put it behind a co-located
reverse proxy or **Cloudflare tunnel** (the tunnel/proxy is the only ingress; `HOST=127.0.0.1` keeps the
port off the public internet). `/health` is a cheap liveness probe. Install the API unit from
[`deploy/zemer-search-api.service`](../deploy/zemer-search-api.service) (edit `WorkingDirectory`):
```bash
sudo cp deploy/zemer-search-api.service /etc/systemd/system/zemer-search.service
sudo systemctl daemon-reload && sudo systemctl enable --now zemer-search
# Cloudflare tunnel / nginx ingress → http://localhost:7700
```
> **Cloudflare tunnel in a Docker container?** A bridge-network `cloudflared` can't reach the host's
> `127.0.0.1`. Either run it with `--network host` (keep `HOST=127.0.0.1`), or set `HOST=172.17.0.1` (the
> docker bridge gateway — private, not public), point the ingress at `http://172.17.0.1:7700`, and order the
> service `After=docker.service` so the bridge interface exists before it binds.

Or run it directly (dev): `HOST=127.0.0.1 PORT=7700 WORKERS=auto node server/api.mjs`. The index reload is
**change-gated** (rebuilds only when `corpus.db`/`-wal` changes), so a steady server has no periodic stall
and picks up a freshly-synced corpus within one `RELOAD_MS` tick; `POST /reload` forces it. On a shared box,
`WORKERS=1` is lean; raise it (or `auto`) for multi-core throughput (rebuilds then stagger across workers).

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
| **daily shallow** | **Mon–Sat 03:00** | new releases for all artists + onboard + prune (refreshes landing-shelf **play counts**) | ~10–12 min |
| **weekly deep** | **Sun 03:00** | full re-pagination backfill (catches anything buried; refreshes **durations + play counts** from album/landing pages) | longer |
| **mirror-sync** | **every 10 min** | watch the whitelist mirror (`content.zemer.io`); on a version-gate change, onboard new artists + prune de-whitelisted + rewrite `blocked-ids.json` — zero Firestore reads | ~2 GETs when unchanged |

**Shabbat gate (accurate zmanim):** the timers run all week; every maintenance service carries
`ExecCondition=/usr/bin/env node harness/shabbat.mjs`, which **skips** the run from **20 min before candle
lighting until havdalah** using accurate weekly **Brooklyn, NY** times from the Hebcal Shabbat API
(geonameid 5110302; handles multi-day Yom Tov). Times are cached to `data/shabbat.json` (refetched only when
stale — the frequent timers keep it warm, so **no network call happens on Shabbos itself**); if Hebcal is
unreachable with no cache it **fails safe** to a conservative static NY window (Fri 15:00 → Sat 22:00 ET).
This replaced the old static `OnCalendar` split (Sat-22:00-UTC = 6pm EDT Saturday — *during* Brooklyn
Shabbos). The daily (Mon–Sat) and weekly (Sun) timers are still split by day so they never contend for the
flock (the weekly deep is never skipped). Album track-lists are immutable
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

**Community-playlist discovery** runs on its own weekly timer (separate from `maintain.sh`; browse+search
only, no `/player`, so it's fine on a datacenter IP). It discovers from the topical seeds + revalidates the
stored playlists (prune stale, refresh counts, regenerate the rejected-artists review list). It's cheap and
incremental: the searches re-fetch on a TTL (`SEARCH_MAX_AGE_H`, so each run surfaces NEW playlists) while
the revalidation of already-stored playlists is served from the gzip cache (no network):
```bash
sudo cp deploy/zemer-playlists.service deploy/zemer-playlists-weekly.timer /etc/systemd/system/  # edit WorkingDirectory
sudo systemctl daemon-reload && sudo systemctl enable --now zemer-playlists-weekly.timer         # Sun 05:00, Shabbat-gated
```

**Auto (data-driven) playlists** (`harvester/auto-playlists.mjs` + `zemer-autoplaylists.timer`, twice daily,
Shabbat-gated) regenerate **Top 50 / Trending / Favorites** from the `zemer-stats` telemetry server's `/stats`
into the gitignored `data/zemer-playlists-auto.json`, then apply the merged (auto + curated) doc — the API
reloads on its next tick, no restart. The stats read **KEY is a secret**: keep it out of the committed unit —
put `STATS_KEY=…` in a non-committed, chmod-600 file the unit loads (`EnvironmentFile=-/opt/zemer-search/.env`,
the same `.env` the repo uses locally). A down/empty `/stats` leaves the existing playlists untouched.
```bash
sudo cp deploy/zemer-autoplaylists.service deploy/zemer-autoplaylists.timer /etc/systemd/system/  # edit WorkingDirectory
echo 'STATS_KEY=…' | sudo tee -a /opt/zemer-search/.env && sudo chmod 600 /opt/zemer-search/.env  # secret, not committed
sudo systemctl daemon-reload && sudo systemctl enable --now zemer-autoplaylists.timer             # 08:00/20:00, Shabbat-gated
```

**Whitelist mirror sync** (`harvester/mirror-sync.mjs` + `zemer-mirror-sync.timer`, every 10 min, Shabbat-gated)
watches the whitelist mirror's version gate (`content.zemer.io/whitelist/version`, which advances only on a
real content change). On a change it pulls the whitelist + `blockedContentIds` **from the mirror** (zero
Firestore reads), rewrites `data/whitelist.json`/`data/blocked-ids.json`, and reconciles the corpus —
**onboard** newly-whitelisted artists (full per-artist harvest → searchable within ~10 min instead of the
03:00 daily) and **prune** de-whitelisted — under the maintenance flock (non-blocking: a held lock or an
anti-bot block leaves the gate uncommitted so the next run retries). Unchanged = two tiny GETs, no harvest.
`DRY=1` previews.
```bash
sudo cp deploy/zemer-mirror-sync.service deploy/zemer-mirror-sync.timer /etc/systemd/system/  # edit WorkingDirectory
sudo systemctl daemon-reload && sudo systemctl enable --now zemer-mirror-sync.timer           # every 10 min, Shabbat-gated
```

**Conditional id-overrides** (the Firestore `blockedContentIds` list — per-id `female`/`global` blocks the app
honors; see [search.md](search.md) + gotcha #7) are fetched to `data/blocked-ids.json` by
`harness/blocked-ids.mjs`. `maintain.sh` refreshes it alongside the whitelist (step 1b), **and** a dedicated
`zemer-overrides` timer re-fetches it **~every 10 min** (Shabbat-gated) so a curated change (e.g. hiding a
women's playlist) takes effect within ~10 min — the API picks up the new file on its next reload tick
(`blocked-ids.json` is in the reload change-gate, so **no restart**). It's cheap because the fetcher **rewrites
`blocked-ids.json` only when the list actually changed**, so the frequent unchanged fetches are true no-ops
(no mtime change → no index reload); a real edit triggers one reload. Lightweight Firestore read, no harvest,
fine on any IP:
```bash
sudo cp deploy/zemer-overrides.service deploy/zemer-overrides.timer /etc/systemd/system/  # edit WorkingDirectory + ZEMER_APP
sudo systemctl daemon-reload && sudo systemctl enable --now zemer-overrides.timer          # every 10 min, Shabbat-gated
```

Cron alternative (gate each job yourself with `node harness/shabbat.mjs &&` — exit 0 = safe to run):
```cron
0 3 * * 1-6  cd /path/to/zemer-search && node harness/shabbat.mjs && ZEMER_APP=/path/to/zemer-app scripts/maintain.sh shallow >> /var/log/zemer-refresh.log 2>&1
0 3 * * 0    cd /path/to/zemer-search && node harness/shabbat.mjs && ZEMER_APP=/path/to/zemer-app scripts/maintain.sh deep    >> /var/log/zemer-refresh.log 2>&1
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
