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
# HTTP_BENCH_TIMEOUT: whole-run resource policy in seconds (default 3600).
# Expiry reports the last observed state, then TERM/KILLs only this bench's
# private process group (5s teardown grace). This is not a throughput SLA.
# Exit 0 only if both deployables did their job: the API served a record it
# had stored, and the worker consumed a queued job that the API then reported
# as done. A running container is not a pass.
#
set -euo pipefail

# When installed at wheelhouse/crew/bench.sh; do this before any heavy work.
WHEELHOUSE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
. "$WHEELHOUSE_ROOT/seats/heavy-test.sh"

# --- clause 1: one command, artifact in, exit code out -------------------
[ $# -eq 2 ] || { printf 'usage: %s <release-manifest> <output-dir>\n' "$0" >&2; exit 2; }
MANIFEST="$1"
OUT="$2"
[ -f "$MANIFEST" ] || { printf 'bench: no such manifest: %s\n' "$MANIFEST" >&2; exit 2; }
mkdir -p "$OUT"
case "$MANIFEST" in /*) ;; *) MANIFEST="$PWD/$MANIFEST" ;; esac
case "$OUT" in /*) ;; *) OUT="$PWD/$OUT" ;; esac

HTTP_BENCH_TIMEOUT="${HTTP_BENCH_TIMEOUT:-3600}"
case "$HTTP_BENCH_TIMEOUT" in ''|*[!0-9]*|????????*) printf 'bench: HTTP_BENCH_TIMEOUT must be 1..2147483 seconds\n' >&2; exit 2;; esac
[ "$HTTP_BENCH_TIMEOUT" -ge 1 ] && [ "$HTTP_BENCH_TIMEOUT" -le 2147483 ] \
  || { printf 'bench: HTTP_BENCH_TIMEOUT must be 1..2147483 seconds\n' >&2; exit 2; }
# heavy-test.sh already requires Bun. Supervise a private worker group so the
# policy also interrupts a blocked curl/docker command: a Bash signal trap
# alone can wait forever for a foreground command. The re-entry value is bound
# to this direct parent's PID, not a generic inherited "skip timeout" flag.
if [ "${WHEELHOUSE_HTTP_BENCH_SUPERVISOR:-}" != "$PPID" ]; then
  exec bun - "$BASH" "$0" "$MANIFEST" "$OUT" "$HTTP_BENCH_TIMEOUT" <<'SUPERVISE'
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
const [bash, script, manifest, out, seconds] = process.argv.slice(2);
const stateFile = path.join(out, 'bench-state.txt');
fs.writeFileSync(stateFile, 'initialising bench\n');
const child = spawn(bash, [script, manifest, out], {
  detached: true, stdio: 'inherit',
  env: { ...process.env, WHEELHOUSE_HTTP_BENCH_SUPERVISOR: String(process.pid) },
});
let expired = false, interrupted = 0, grace;
function stopGroup() {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  if (!grace) grace = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      console.error('[bench] teardown grace expired; killing only owned bench group');
      try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    }
  }, 5000);
}
function expire() {
  expired = true;
  let last = 'state unavailable';
  try { last = fs.readFileSync(stateFile, 'utf8').trim(); } catch {}
  const line = `[bench] FAIL: HTTP_BENCH_TIMEOUT policy expired after ${seconds}s; last state: ${last}`;
  fs.writeFileSync(path.join(out, 'timeout.txt'), line + '\n');
  console.error(line);
  stopGroup();
}
const timer = setTimeout(expire, Number(seconds) * 1000);
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  process.on(signal, () => { interrupted = code; stopGroup(); });
}
child.on('error', error => { clearTimeout(timer); console.error(error); process.exitCode = 1; });
child.on('close', (code, signal) => {
  clearTimeout(timer); if (grace) clearTimeout(grace);
  process.exitCode = expired ? 124 : interrupted || (signal ? 1 : code ?? 1);
});
SUPERVISE
fi

log()  { printf '[bench] %s\n' "$*"; }
fail() { printf '[bench] FAIL: %s\n' "$*" >&2; exit 1; }

# Readiness is an observed result, not N seconds on a quiet host. The bench's
# supervisor above owns the whole-run bound; these loops stop on the event
# or a native terminal failure. Keep the last input/result for a failed review.
bench_state() {
  printf '%s\n' "$*" > "$OUT/bench-state.new"
  mv -f "$OUT/bench-state.new" "$OUT/bench-state.txt"
}
container_running() {
  local name="$1" running
  docker inspect --format '{{.State.Running}}' "$name" > "$OUT/container-state.stdout" 2> "$OUT/container-state.stderr" \
    || fail "cannot observe container $name; see container-state.stdout/container-state.stderr"
  running="$(cat "$OUT/container-state.stdout")"
  [ "$running" = true ] || fail "container $name is not running (last state '$running')"
}

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
bench_state "pulling reviewed images"
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
while :; do
  container_running "$DB"
  bench_state "database container up; awaiting pg_isready"
  ready_rc=0
  docker exec "$DB" pg_isready -q -U postgres > "$OUT/db-ready.stdout" 2> "$OUT/db-ready.stderr" || ready_rc=$?
  printf 'pg_isready rc=%s\n' "$ready_rc" >> "$OUT/readiness.log"
  bench_state "database container up; pg_isready rc=$ready_rc"
  [ "$ready_rc" = 0 ] && break
  case "$ready_rc" in 1|2) ;; *) fail "database readiness command failed (rc=$ready_rc); see db-ready.stderr";; esac
  sleep 1
done

log "migrating from empty"
docker run --rm --network "$NET" \
  -e DATABASE_URL="postgres://postgres:bench@$DB:5432/tideline" \
  "$API_IMG" tideline-migrate > "$OUT/migrate.log" 2>&1 \
  || { cat "$OUT/migrate.log" >&2; fail "migration failed"; }

# --- start both deployables ----------------------------------------------
docker run -d --name "$API" --network "$NET" -p 127.0.0.1::8080 \
  -e DATABASE_URL="postgres://postgres:bench@$DB:5432/tideline" \
  "$API_IMG" >/dev/null
docker run -d --name "$WORKER" --network "$NET" \
  -e DATABASE_URL="postgres://postgres:bench@$DB:5432/tideline" \
  "$WRK_IMG" >/dev/null
docker port "$API" 8080/tcp > "$OUT/port.stdout" 2> "$OUT/port.stderr" \
  || fail "cannot observe API port; see port.stdout/port.stderr"
PORT="$(awk -F: 'NF==2 && $1=="127.0.0.1" && $2~/^[0-9]+$/ && $2>0 && $2<65536 {p=$2; good++} END {if (NR!=1 || good!=1) exit 1; print p}' "$OUT/port.stdout")" \
  || fail "API binding is not one isolated loopback endpoint; see port.stdout"
BASE="http://127.0.0.1:$PORT"
log "api binding observed at $BASE; awaiting health response"

while :; do
  container_running "$API"
  bench_state "API container up; endpoint not answering; awaiting health response"
  health_rc=0
  curl -fsS "$BASE/healthz" > "$OUT/health.stdout" 2> "$OUT/health.stderr" || health_rc=$?
  printf 'healthz rc=%s\n' "$health_rc" >> "$OUT/readiness.log"
  bench_state "API container up; endpoint health rc=$health_rc"
  [ "$health_rc" = 0 ] && break
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
while :; do
  bench_state "API and worker launched; awaiting job state (last '$STATE')"
  curl -fsS "$BASE/v1/readings/$ID" -o "$OUT/job-state.json" || fail "cannot observe job state"
  STATE=$(jq -r '.summary_state' < "$OUT/job-state.json") || fail "invalid job state JSON"
  printf 'job state=%s\n' "$STATE" >> "$OUT/readiness.log"
  bench_state "job state '$STATE'"
  case "$STATE" in
    done|failed) break;;
    queued|pending|running) ;;
    *) fail "unknown job state '$STATE'; see job-state.json";;
  esac
  container_running "$API"
  container_running "$WORKER"
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
