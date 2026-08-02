# Deploying the podcast subsystem (systemd)

Install steps for the Zemer Podcasts pipeline (`docs/podcasts.md`). Two timers, mirroring the existing
music pipeline: a frequent IP-safe harvest, and a daily proxy-routed `/player` top-up for episode
durations + real dates.

> **VPS deployment path:** the units below ship the committed placeholder `WorkingDirectory=/opt/zemer-search`
> (+ `Environment=ZEMER_APP=/opt/zemer-app` on the harvest unit) — the same placeholders every committed
> unit in `deploy/` carries. On this VPS the checkout lives at `/root/deployed-apps/zemer-search`, so before
> installing, rewrite `WorkingDirectory` (and `ZEMER_APP`, and the `EnvironmentFile` paths) to the real
> paths — exactly as you already do for `zemer-prefetch.service`, `zemer-dating.service`, etc.

## Units

| Unit | What it runs | Cadence | Template it mirrors |
|------|--------------|---------|---------------------|
| `zemer-podcasts.service` + `.timer` | whitelist refetch → onboard (`NEW=1`) → prune (`PRUNE=1`) → refresh (`MAX_AGE_H=12`) | ~every 6h (01/07/13/19:15 UTC) | `zemer-prefetch.*` + `zemer-refresh-sweep.*` (flock, Shabbat gate, `-`-prefixed steps) |
| `zemer-podcast-durations.service` + `.timer` | `harvester/podcast-durations.mjs` (`/player` → `durationSec` + ISO `publishedAt`) through the residential proxy | daily 05:45 UTC | `zemer-dating.*` (identical `PROXY_URL` / 3s TCP probe / `dating.env` / flock) |

Both are Shabbat-gated in code (`ExecCondition=/usr/bin/env node harness/shabbat.mjs`) and take the shared
maintenance flock (`/tmp/zemer-maintain.lock`, `flock -n`) so they never collide with `maintain.sh` or each
other on the single-writer `corpus.db`.

The durations job reuses the **same** `dating.env` (`PROXY_URL=…`) as `zemer-dating.service` — no new secret
file. `/player` is datacenter-blocked, so it skips gracefully (condition-unmet, not failure) when the
residential proxy host is asleep / off the tailnet; the backlog just waits for the next tick.

## Install

```bash
# (after editing WorkingDirectory / ZEMER_APP / EnvironmentFile paths in each unit to match this box)
cp deploy/zemer-podcasts.service          /etc/systemd/system/
cp deploy/zemer-podcasts.timer            /etc/systemd/system/
cp deploy/zemer-podcast-durations.service /etc/systemd/system/
cp deploy/zemer-podcast-durations.timer   /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now zemer-podcasts.timer zemer-podcast-durations.timer
```

> **Deploy gotcha (same as the other units):** a `git pull` alone does NOT update installed units — you must
> re-copy the `.service`/`.timer` files into `/etc/systemd/system/` and `systemctl daemon-reload` whenever
> they change.

## One-time seed (before the timers carry it)

The timers only onboard/refresh incrementally. Do the initial full harvest + first durations backfill by
hand once (both IP-safe / proxy-routed, so run them under the flock, off-Shabbat):

```bash
# 1) Full initial harvest of every whitelisted show + all episodes + host-channel avatars.
node harness/podcasts-whitelist.mjs                                   # → data/podcasts-whitelist.json
node harvester/podcasts.mjs                                           # full pass (no MAX_AGE_H/NEW/PRUNE)

# 2) First durations + ISO-date backfill. /player is datacenter-blocked → run residential OR via the proxy:
PROXY_URL=http://<residential-proxy-host>:<port> \
CONCURRENCY=2 MIN_INTERVAL_MS=500 node harvester/podcast-durations.mjs
```

The initial durations backfill can be large (one `/player` per episode) — it is idempotent (fills NULLs
only) and paced, so it is safe to run over several sittings; the daily timer tops up the remainder.

## Backups — add `data/podcasts-whitelist.json`

`data/podcasts-whitelist.json` is a **new durable artifact** (the podcast roster + version gate — the same
class as `data/whitelist.json`). It must be added to the daily backup. The podcast **tables**
(`podcast_show`/`podcast_episode`/`podcast_channel`) already ride along in the nightly `corpus.db` snapshot,
so **only the whitelist JSON needs adding**.

The VPS backup script lives at `/root/backups/zemer/backup.sh` (NOT in this repo — it cannot be edited under
the code freeze). Make this one-line change there when the freeze lifts: in the `tar` invocation that builds
`search-data-json.tgz`, add `data/podcasts-whitelist.json` to the file list, right beside the existing
`data/whitelist.json` entry. e.g.:

```diff
-  tar czf "$DEST/search-data-json.tgz" -C "$REPO" data/whitelist.json data/blocked-ids.json ...
+  tar czf "$DEST/search-data-json.tgz" -C "$REPO" data/whitelist.json data/podcasts-whitelist.json data/blocked-ids.json ...
```

(Match the actual file list / variable names in the live `backup.sh` — the point is a single added path,
`data/podcasts-whitelist.json`, inside the `search-data-json.tgz` tar.) After the edit, run `backup.sh` (not
`publish.sh`) once and verify the artifact is present: `tar tzf .../search-data-json.tgz | grep podcasts-whitelist`.
