#!/usr/bin/env bash
#
# bench.sh — EXAMPLE IMPLEMENTATION, from an invented project called Tideline.
#
# Tideline ships two deployables from one root: an HTTP API and a job worker.
# The artifact is therefore a RELEASE MANIFEST naming both image digests, not
# an image — see BENCH.md beside this file for why, and for the eight clauses
# each block below is satisfying.
#
# Usage:  bench.sh <release-manifest> <output-dir>
#
# Exit 0 only if both deployables did their job: the API served a record it
# had stored, and the worker consumed a queued job that the API then reported
# as done. A running container is not a pass.
#
set -euo pipefail

# --- clause 1: one command, artifact in, exit code out -------------------
[ $# -eq 2 ] || { printf 'usage: %s <release-manifest> <output-dir>\n' "$0" >&2; exit 2; }
MANIFEST="$1"
OUT="$2"
[ -f "$MANIFEST" ] || { printf 'bench: no such manifest: %s\n' "$MANIFEST" >&2; exit 2; }
mkdir -p "$OUT"
case "$MANIFEST" in /*) ;; *) MANIFEST="$PWD/$MANIFEST" ;; esac
case "$OUT" in /*) ;; *) OUT="$PWD/$OUT" ;; esac

log()  { printf '[bench] %s\n' "$*"; }
fail() { printf '[bench] FAIL: %s\n' "$*" >&2; exit 1; }

# Every name carries a run id, so concurrent runs do not collide and a leaked
# container from an earlier run is not mistaken for this one's (clause 8).
# $$ alone is not enough for that claim: pids recycle, and a fresh container or
# namespace hands out low, predictable ones — two runs a day apart can collide.
# Date plus a random suffix makes the name unique in practice; nothing here
# depends on it being unique in principle.
RUN="tideline-bench-$(date +%Y%m%d-%H%M%S)-$$-${RANDOM}"
NET="$RUN-net"
DB="$RUN-db"
API="$RUN-api"
WORKER="$RUN-worker"

# --- clause 6: it always tears down --------------------------------------
# On success, on failure, and on interrupt. The trap covers INT and TERM as
# well as EXIT, because a bench that only cleans up on a clean exit leaks
# exactly when a human gets impatient and hits Ctrl-C.
#
# ORDER MATTERS HERE: the misuse checks above run BEFORE this trap is installed,
# which is what lets them exit 2 rather than being rewritten to 1 by cleanup's
# PASSED guard. Move the trap above them and `bench.sh` with no arguments starts
# reporting a failed bench instead of a usage error. There is nothing to tear
# down before this line, which is why it is safe here and only here.
PASSED=0
cleanup() {
  rc=$?
  # Disarm first, or this runs twice on a signal: the INT trap fires, cleanup
  # ends in `exit`, and that exit re-enters the same function through the EXIT
  # trap. Pass two would find the containers already gone, and `>` truncates
  # before docker fails — so the evidence this function exists to capture is
  # overwritten with "No such container", on exactly the interrupted run where
  # a human most wants the logs. Measured; not a theoretical race.
  trap - EXIT INT TERM
  # An interrupted run must not exit 0. When a signal DOES reach this handler,
  # $? can be 0 — the run was killed partway and nothing had failed yet — so
  # without the flag an interrupted bench reports success to anything reading
  # the exit code. See BENCH.md clause 6 for which signals reach it at all;
  # SIGINT often does not, and that is a property of how it was delivered.
  [ "$PASSED" = "1" ] || [ "$rc" -ne 0 ] || rc=1
  log "tearing down $RUN"
  for c in "$WORKER" "$API" "$DB"; do
    docker logs "$c" > "$OUT/$c.log" 2>&1 || true
    docker rm -f "$c" >/dev/null 2>&1 || true
  done
  docker network rm "$NET" >/dev/null 2>&1 || true
  log "torn down"
  exit $rc
}
trap cleanup EXIT INT TERM

# --- clause 2: it exercises the BUILT ARTIFACT ---------------------------
# The digests in the manifest, pulled as-is. Never `docker build` from the
# working tree, and never the dev server: what ships is what gets tested.
API_IMG=$(sed -n 's/^api: *//p'    "$MANIFEST")
WRK_IMG=$(sed -n 's/^worker: *//p' "$MANIFEST")
[ -n "$API_IMG" ] && [ -n "$WRK_IMG" ] || fail "manifest names no api/worker image: $MANIFEST"
case "$API_IMG$WRK_IMG" in
  *@sha256:*) ;;
  *) fail "manifest must pin digests, not tags — a tag can move between build and bench" ;;
esac
cp "$MANIFEST" "$OUT/release-manifest.txt"
log "api    $API_IMG"
log "worker $WRK_IMG"
docker pull --quiet "$API_IMG" >/dev/null || fail "cannot pull $API_IMG"
docker pull --quiet "$WRK_IMG" >/dev/null || fail "cannot pull $WRK_IMG"

# --- clause 3: it starts from clean state, every run ----------------------
# A throwaway database per run: created here, migrated from empty, dropped by
# the trap. No volume, so nothing survives the container. A bench that reuses
# a database inherits the last run's rows and can pass on data it did not
# create — which is the same defect as a snapshot, wearing a schema.
docker network create "$NET" >/dev/null
docker run -d --name "$DB" --network "$NET" \
  -e POSTGRES_PASSWORD=bench -e POSTGRES_DB=tideline \
  postgres:16-alpine >/dev/null
log "waiting for the database to accept connections"
for _ in $(seq 1 60); do
  docker exec "$DB" pg_isready -q -U postgres && break
  sleep 1
done
docker exec "$DB" pg_isready -q -U postgres || fail "database never became ready"

log "migrating from empty"
docker run --rm --network "$NET" \
  -e DATABASE_URL="postgres://postgres:bench@$DB:5432/tideline" \
  "$API_IMG" tideline-migrate > "$OUT/migrate.log" 2>&1 \
  || { cat "$OUT/migrate.log" >&2; fail "migration failed"; }

# --- start both deployables ----------------------------------------------
docker run -d --name "$API" --network "$NET" -p 0:8080 \
  -e DATABASE_URL="postgres://postgres:bench@$DB:5432/tideline" \
  "$API_IMG" >/dev/null
docker run -d --name "$WORKER" --network "$NET" \
  -e DATABASE_URL="postgres://postgres:bench@$DB:5432/tideline" \
  "$WRK_IMG" >/dev/null
BASE="http://127.0.0.1:$(docker port "$API" 8080/tcp | head -1 | sed 's/.*://')"
log "api listening at $BASE"

for _ in $(seq 1 30); do
  curl -fsS "$BASE/healthz" >/dev/null 2>&1 && break
  sleep 1
done

# --- clause 4: liveness is not success -----------------------------------
# Everything above proves two containers are running. None of it proves the
# service does its job. A Tideline API with every route removed still answers
# /healthz, and a worker with its handler unregistered still holds a process.
# So: store a record through the public API, read it back, then queue a job
# and require the WORKER to be the thing that completes it.
log "asserting the api stores and serves a record"
CREATED=$(curl -fsS -X POST "$BASE/v1/readings" \
  -H 'content-type: application/json' \
  -d '{"station":"bench-01","height_cm":214}' \
  -o "$OUT/create.json" -w '%{http_code}') || fail "POST /v1/readings failed"
[ "$CREATED" = "201" ] || { cat "$OUT/create.json" >&2; fail "POST returned $CREATED, expected 201"; }
ID=$(jq -r '.id' < "$OUT/create.json")
[ -n "$ID" ] && [ "$ID" != "null" ] || fail "created record carries no id"

curl -fsS "$BASE/v1/readings/$ID" -o "$OUT/read.json" || fail "GET /v1/readings/$ID failed"
jq -e --arg id "$ID" '.id == $id and .station == "bench-01" and .height_cm == 214' \
  < "$OUT/read.json" >/dev/null \
  || { cat "$OUT/read.json" >&2; fail "the record served back is not the record stored"; }
log "api: stored and served the same record"

log "asserting the worker consumes a job"
curl -fsS -X POST "$BASE/v1/readings/$ID/summarise" -o "$OUT/queue.json" \
  || fail "POST .../summarise failed"
STATE=""
for _ in $(seq 1 45); do
  STATE=$(curl -fsS "$BASE/v1/readings/$ID" | jq -r '.summary_state')
  [ "$STATE" = "done" ] && break
  [ "$STATE" = "failed" ] && break
  sleep 1
done
[ "$STATE" = "done" ] || fail "job never completed; last state '$STATE' (worker log in $OUT/$WORKER.log)"
curl -fsS "$BASE/v1/readings/$ID" -o "$OUT/summarised.json"
jq -e '.summary | type == "string" and length > 0' < "$OUT/summarised.json" >/dev/null \
  || fail "job reported done but produced no summary — the worker marked, it did not do"
log "worker: consumed the job and produced its output"

# --- clause 7: measurements are not verdicts ------------------------------
# This number is reported, never compared to a threshold. It is here so a
# reviewer can see a trend across runs, and it CANNOT distinguish a slow
# service from a loaded bench host — this runs alongside a database and two
# containers on whatever machine invoked it.
{
  printf 'measurement: %s sequential GETs of /v1/readings/%s\n' 20 "$ID"
  for _ in $(seq 1 20); do
    curl -fsS -o /dev/null -w '%{time_total}\n' "$BASE/v1/readings/$ID"
  done
} > "$OUT/latency.txt"
log "measurement written to $OUT/latency.txt (not a threshold; see BENCH.md clause 7)"

# --- clause 5: it retains evidence ---------------------------------------
# The trap writes all three container logs. Everything a non-author needs to
# believe this result is already in $OUT: the manifest actually benched, the
# migration output, the created and served records, and the logs.
PASSED=1
log "PASS: api served what it stored, worker completed the job it was given"
