#!/usr/bin/env bash
# fleet-gate.selftest.sh — hermetic checks for fleet-gate.sh's three states
# (cold+ready, cold+empty, live) plus its graceful-degrade paths. Never runs
# against live seats — everything is a fixture: a stub `bd` on PATH and a
# stub `adapter.ts` whose "status" output is swapped per phase via env vars.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
GATE="${1:-$HERE/fleet-gate.sh}"
[ -f "$GATE" ] || { echo "selftest: not found: $GATE" >&2; exit 2; }
command -v bun >/dev/null 2>&1 || { echo "selftest: bun is required" >&2; exit 2; }

FAILED=0
pass() { printf '  ok    %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; FAILED=$((FAILED + 1)); }
phase() { printf '\n%s\n' "$*"; }

FIX="$(mktemp -d "${TMPDIR:-/tmp}/wheelhouse-fleet-gate-selftest.$$.XXXXXX")"
FIX="$(cd "$FIX" && pwd -P)"
trap 'rm -rf "$FIX"' EXIT INT TERM

PROJ="$FIX/proj"
mkdir -p "$PROJ/seats" "$PROJ/bin"
cp "$GATE" "$PROJ/seats/fleet-gate.sh"
chmod +x "$PROJ/seats/fleet-gate.sh"

# Stub adapter.ts: prints whatever file $FIXTURE_STATUS_FILE points at for
# `status`, so one stub serves every phase without touching real seats.
cat > "$PROJ/seats/adapter.ts" <<'STUB'
if (process.argv[2] === "status") {
  const f = process.env.FIXTURE_STATUS_FILE;
  if (f) process.stdout.write(require("fs").readFileSync(f, "utf8"));
}
STUB

# Stub bd: `ready --json` and `list --status in_progress --limit 0 --json`
# each print whatever file the matching env var points at, defaulting to an
# empty JSON array — real bd's shape for "nothing found" closely enough for
# what this hook parses (a count of "id" occurrences).
cat > "$PROJ/bin/bd" <<'STUB'
#!/usr/bin/env bash
case "$1 $2" in
  "ready --json") f="${FIXTURE_READY_FILE:-}"; [ -n "$f" ] && cat "$f" || echo '[]'; ;;
  "list --status") f="${FIXTURE_INPROG_FILE:-}"; [ -n "$f" ] && cat "$f" || echo '[]'; ;;
  *) echo '[]' ;;
esac
STUB
chmod +x "$PROJ/bin/bd"

STOPPED_2="worker-a       STOPPED  stopped     last-event -
worker-b       STOPPED  stopped     last-event -
"
LIVE_1_OF_2="worker-a       RUNNING  pid 12345   last-event agent_start
worker-b       STOPPED  stopped     last-event -
"
READY_2='[{"id":"proj-1"},{"id":"proj-2"}]'
READY_0='[]'

run() {
  OUT="$(cd "$PROJ" && env PATH="$PROJ/bin:$PATH" \
    FIXTURE_STATUS_FILE="${1:-}" FIXTURE_READY_FILE="${2:-}" FIXTURE_INPROG_FILE="${3:-}" \
    bash seats/fleet-gate.sh 2>&1)"
  RC=$?
}
has() { case "$OUT" in *"$1"*) return 0 ;; *) return 1 ;; esac; }

phase "1. cold + ready — seats cold, work ready: loud nudge fires"
printf '%s' "$STOPPED_2" > "$FIX/status-stopped"
printf '%s' "$READY_2" > "$FIX/ready-2"
run "$FIX/status-stopped" "$FIX/ready-2" ""
if [ $RC -eq 0 ] && has "0/2 seats live" && has "2 ready" && has "SEATS COLD WITH READY WORK"; then
  pass "cold+ready prints counts and the loud nudge"
else
  fail "cold+ready did not match (rc=$RC): $OUT"
fi

phase "2. cold + empty — seats cold, no ready work: plain line, no nudge"
printf '%s' "$READY_0" > "$FIX/ready-0"
run "$FIX/status-stopped" "$FIX/ready-0" ""
if [ $RC -eq 0 ] && has "0/2 seats live" && has "0 ready" && ! has "SEATS COLD WITH READY WORK"; then
  pass "cold+empty prints counts with no nudge"
else
  fail "cold+empty did not match (rc=$RC): $OUT"
fi

phase "3. live — a seat is running, even with ready work: no nudge"
printf '%s' "$LIVE_1_OF_2" > "$FIX/status-live"
run "$FIX/status-live" "$FIX/ready-2" ""
if [ $RC -eq 0 ] && has "1/2 seats live" && has "2 ready" && ! has "SEATS COLD WITH READY WORK"; then
  pass "live seat suppresses the nudge regardless of ready count"
else
  fail "live phase did not match (rc=$RC): $OUT"
fi

phase "4. graceful degrade — bd absent: silent, exit 0"
run "$FIX/status-stopped" "$FIX/ready-2" ""
NOBD_OUT="$(cd "$PROJ" && env PATH="/usr/bin:/bin" \
  FIXTURE_STATUS_FILE="$FIX/status-stopped" bash seats/fleet-gate.sh 2>&1)"
NOBD_RC=$?
if [ $NOBD_RC -eq 0 ] && [ -z "$NOBD_OUT" ]; then
  pass "no bd on PATH: silent, exit 0"
else
  fail "no bd on PATH should be silent+0 (rc=$NOBD_RC): $NOBD_OUT"
fi

phase "5. graceful degrade — adapter.ts absent: silent, exit 0"
rm "$PROJ/seats/adapter.ts"
run "" "$FIX/ready-2" ""
if [ $RC -eq 0 ] && [ -z "$OUT" ]; then
  pass "no adapter.ts: silent, exit 0"
else
  fail "no adapter.ts should be silent+0 (rc=$RC): $OUT"
fi

printf '\n'
if [ $FAILED -eq 0 ]; then
  echo "fleet-gate.sh works on this machine."
  exit 0
fi
echo "$FAILED check(s) failed."
exit 1
