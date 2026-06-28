#!/usr/bin/env bash
# Maintenance orchestrator for zemer-search.
#
#   scripts/maintain.sh [shallow|deep]      (default: shallow)
#     shallow → fast daily pass  (landing pages only, ~1 request/artist; sets SHALLOW=1)
#     deep    → weekly backfill  (full pagination; the refresh default)
#
# Pipeline:  whitelist refetch → onboard new artists → prune de-whitelisted → refresh (deep|shallow).
# Prune runs BEFORE refresh so refresh never wastes IP-paced requests re-harvesting artists that are
# about to be deleted. On an anti-bot block in any network step the whole pipeline ABORTS immediately
# (exit 75) — we never fire more live requests at a flagged IP; the gzip cache makes the next run resume
# for free. The API on the same box auto-reloads corpus.db within RELOAD_MS, so there's no reload step.
# A single flock prevents the daily and weekly runs from overlapping on the single-writer DB.
#
# Env: ZEMER_APP (path to zemer-app, for the whitelist Firestore creds), MAX_AGE_H (default 20),
#      MIN_INTERVAL_MS (request pacing), CORPUS_DB, MAINTAIN_STATUS, ZEMER_LOCK.
set -uo pipefail

MODE="${1:-shallow}"
if [ "$MODE" != "shallow" ] && [ "$MODE" != "deep" ]; then
  echo "usage: $0 [shallow|deep]" >&2; exit 2
fi

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO" || exit 1
LOCK="${ZEMER_LOCK:-/tmp/zemer-maintain.lock}"
export MAX_AGE_H="${MAX_AGE_H:-20}"
# Fast-but-IP-safe live-request profile: bounded concurrency + paced rate (~3-4 req/s aggregate, far
# below anti-bot thresholds, never a burst). Override any of these via env to go gentler or faster.
export CONCURRENCY="${CONCURRENCY:-5}"
export MIN_INTERVAL_MS="${MIN_INTERVAL_MS:-200}"
export JITTER_MS="${JITTER_MS:-200}"
if [ "$MODE" = "shallow" ]; then export SHALLOW=1; else unset SHALLOW; fi  # refresh defaults to deep

log() { echo "[$(date -Is)] $*"; }
status() { node --input-type=module -e "import('./harvester/status.mjs').then(m=>m.setStatus(JSON.parse(process.argv[1])))" "$1" 2>/dev/null || true; }

# Single-writer DB → never overlap runs. Non-blocking: if another run holds the lock, skip this one.
exec 9>"$LOCK" || { log "ERROR cannot open lock $LOCK"; exit 1; }
if ! flock -n 9; then log "another maintenance run holds the lock — skipping this $MODE run"; exit 0; fi

log "=== maintain ($MODE) start ==="
rc=0

# 1) Whitelist refetch (roster + content flags). Needs google-services.json via ZEMER_APP. On failure we
#    keep the existing whitelist and SKIP onboard + prune (both must act on a current, known-good list).
status '{"phase":"whitelist","done":0,"total":0}'
wl_ok=1
if node harness/whitelist.mjs; then log "whitelist: refreshed"; else wl_ok=0; rc=1; log "WARN whitelist refetch FAILED — skipping onboard + prune (refresh still runs)"; fi

# 2) Onboard newly-whitelisted artists (only with a fresh whitelist).
blocked=0
if [ "$wl_ok" = 1 ]; then
  if node harvester/onboard.mjs; then log "onboard: done"; else rc=$?; [ "$rc" = 75 ] && blocked=1; log "WARN onboard exited $rc$([ "$blocked" = 1 ] && echo ' (anti-bot block)')"; fi
fi

# Stop on a detected anti-bot block — do NOT issue more live requests at a flagged IP (#1 constraint).
if [ "$blocked" = 1 ]; then
  log "=== maintain ($MODE) ABORTED on anti-bot block — resume from cache next run ==="
  exit 75
fi

# 3) Prune de-whitelisted artists BEFORE refresh (guarded against a bad whitelist; saves refresh requests).
if [ "$wl_ok" = 1 ]; then
  if node harvester/prune.mjs; then log "prune: done"; else rc=$?; log "WARN prune exited $rc"; fi
fi

# 4) Refresh existing artists for new releases (the network-heavy step; runs last).
if node harvester/refresh.mjs; then log "refresh ($MODE): done"; else rc=$?; [ "$rc" = 75 ] && log "WARN refresh anti-bot block (exit 75)" || log "WARN refresh exited $rc"; fi

log "=== maintain ($MODE) end (rc=$rc) ==="
exit "$rc"
