#!/usr/bin/env bash

SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"
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
cleanup(){ selftest_cleanup_fixture_processes "${FIX:-}" "${SOCK:-}"; rm -rf "$FIX"; }
trap cleanup EXIT INT TERM

PROJ="$FIX/proj"
mkdir -p "$PROJ/seats" "$PROJ/bin"
cp "$GATE" "$PROJ/seats/fleet-gate.sh"
chmod +x "$PROJ/seats/fleet-gate.sh"
( cd "$PROJ" && git init -q && git remote add origin git@github.com:fixture-owner/fixture-product.git )

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
  "list --status")
    case "${3:-}" in
      open) f="${FIXTURE_OPEN_FILE:-}"; [ -n "$f" ] && cat "$f" || echo '[]' ;;
      in_progress) f="${FIXTURE_INPROG_FILE:-}"; [ -n "$f" ] && cat "$f" || echo '[]' ;;
      *) echo '[]' ;;
    esac ;;
  *) echo '[]' ;;
esac
STUB
chmod +x "$PROJ/bin/bd"
cat > "$PROJ/bin/gh" <<'STUB'
#!/usr/bin/env bash
if [ "${1:-}" = issue ] && [ "${2:-}" = list ]; then
  f="${FIXTURE_GH_ISSUES_FILE:-}"
  [ -n "$f" ] && cat "$f"
fi
STUB
chmod +x "$PROJ/bin/gh"

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
    FIXTURE_OPEN_FILE="${FIXTURE_OPEN_FILE:-}" FIXTURE_GH_ISSUES_FILE="${FIXTURE_GH_ISSUES_FILE:-}" \
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

phase "4. stale herald pid — every gate names the dead herald and last stderr"
mkdir -p "$PROJ/seats/run" "$PROJ/seats/logs"
printf '%s\n' 3999999 > "$PROJ/seats/run/herald.pid"
printf '%s\n' 'STOP: ENOENT rename herald.state.json.tmp -> herald.state.json' > "$PROJ/seats/logs/herald.stderr.log"
run "$FIX/status-live" "$FIX/ready-2" ""
if [ $RC -eq 0 ] && has "HERALD DEAD pid 3999999" && has "last stderr: STOP: ENOENT rename"; then
  pass "stale herald.pid is visible with the last stderr line"
else
  fail "stale herald.pid was not reported (rc=$RC): $OUT"
fi
rm -f "$PROJ/seats/run/herald.pid" "$PROJ/seats/logs/herald.stderr.log"

phase "5. inbox lag — undrained rows are visible with oldest age and herald deferral streak"
cat > "$PROJ/seats/inbox.jsonl" <<'JSONL'
{"id":"one","at":"2000-01-01T00:00:00.000Z","seat":"worker-1","class":"settle"}
{"id":"two","at":"2000-01-01T00:00:05.000Z","seat":"worker-2","class":"distress"}
JSONL
printf '%s\n' 0 > "$PROJ/seats/inbox.cursor"
cat > "$PROJ/seats/logs/herald.out.log" <<'LOG'
2026-09-10T00:00:00.000Z poke sent pane=wh-demo:bridge.0 inbox=1
2026-09-10T00:00:04.000Z poke deferred reason=not-idle pane=wh-demo:bridge.0 inbox=2
2026-09-10T00:00:08.000Z poke deferred reason=not-idle pane=wh-demo:bridge.0 inbox=2
LOG
run "$FIX/status-live" "$FIX/ready-2" ""
if [ $RC -eq 0 ] && has "INBOX LAG 2 undrained row(s)" && has "oldest" && has "herald deferral streak 2"; then
  pass "inbox cursor lag is printed with row count, oldest age, and deferral streak"
else
  fail "inbox lag was not reported (rc=$RC): $OUT"
fi
rm -f "$PROJ/seats/inbox.jsonl" "$PROJ/seats/inbox.cursor" "$PROJ/seats/logs/herald.out.log"

phase "6. open needs — count line names the needs list command"
cat > "$PROJ/seats/needs.jsonl" <<'JSONL'
{"type":"opened","id":"need-one","at":"2026-09-21T00:00:00.000Z","kind":"question","title":"One","body":"One","options":[],"machine":{}}
{"type":"opened","id":"need-two","at":"2026-09-21T00:01:00.000Z","kind":"question","title":"Two","body":"Two","options":[],"machine":{}}
{"type":"opened","id":"need-old","at":"2026-09-21T00:02:00.000Z","kind":"question","title":"Old","body":"Old","options":[],"machine":{}}
{"type":"answered","id":"need-old","at":"2026-09-21T00:03:00.000Z","from":"human","via":"cli","text":"done"}
JSONL
run "$FIX/status-live" "$FIX/ready-2" ""
if [ $RC -eq 0 ] && has "2 need(s) waiting on a human — bun seats/needs.ts list" && has "1 answer(s) waiting to be read — bun seats/needs.ts list --unread"; then
  pass "open human needs and unread answers are visible on every gate line"
else
  fail "open/unread needs count was not reported (rc=$RC): $OUT"
fi
cat >> "$PROJ/seats/needs.jsonl" <<'JSONL'
{"type":"read","id":"need-old","at":"2026-09-21T00:04:00.000Z","by":"commander","via":"show"}
JSONL
run "$FIX/status-live" "$FIX/ready-2" ""
if [ $RC -eq 0 ] && has "2 need(s) waiting on a human — bun seats/needs.ts list" && ! has "answer(s) waiting to be read"; then
  pass "read marker after the human answer clears the unread gate line"
else
  fail "read marker did not clear unread gate line (rc=$RC): $OUT"
fi
cat >> "$PROJ/seats/needs.jsonl" <<'JSONL'
{"type":"message","id":"need-one","at":"2026-09-21T00:05:00.000Z","from":"human","via":"desk","text":"human follow-up"}
JSONL
run "$FIX/status-live" "$FIX/ready-2" ""
if [ $RC -eq 0 ] && has "1 answer(s) waiting to be read — bun seats/needs.ts list --unread"; then
  pass "human message after any read marker reopens the unread gate line"
else
  fail "human message did not create unread gate line (rc=$RC): $OUT"
fi
: > "$PROJ/seats/needs.jsonl"
run "$FIX/status-live" "$FIX/ready-2" ""
if [ $RC -eq 0 ] && ! has "need(s) waiting on a human" && ! has "answer(s) waiting to be read"; then
  pass "zero human needs and unread answers is silent"
else
  fail "zero needs/unread should be silent (rc=$RC): $OUT"
fi
rm -f "$PROJ/seats/needs.jsonl"

phase "7. GitHub issues — untraced open issues are listed, traced issues are silent"
printf '%s\n' 'https://github.com/fixture-owner/fixture-product/issues/41' 'https://github.com/fixture-owner/fixture-product/issues/42' > "$FIX/gh-open-issues"
printf '%s\n' '[{"id":"proj-traced","description":"Trace: https://github.com/fixture-owner/fixture-product/issues/41"}]' > "$FIX/open-traced-one"
FIXTURE_GH_ISSUES_FILE="$FIX/gh-open-issues" FIXTURE_OPEN_FILE="$FIX/open-traced-one" run "$FIX/status-live" "$FIX/ready-2" ""
if [ $RC -eq 0 ] && has "1 GITHUB ISSUE(S) NOT ON THE BOARD: #42" && has "Triage into beads (Trace: <issue url>)"; then
  pass "untraced open GitHub issue is listed on the fleet gate line"
else
  fail "untraced GitHub issue was not listed (rc=$RC): $OUT"
fi
printf '%s\n' '[{"id":"proj-traced-41","description":"Trace: https://github.com/fixture-owner/fixture-product/issues/41"},{"id":"proj-traced-42","description":"Trace: https://github.com/fixture-owner/fixture-product/issues/42"}]' > "$FIX/open-traced-all"
FIXTURE_GH_ISSUES_FILE="$FIX/gh-open-issues" FIXTURE_OPEN_FILE="$FIX/open-traced-all" run "$FIX/status-live" "$FIX/ready-2" ""
if [ $RC -eq 0 ] && ! has "GITHUB ISSUE(S) NOT ON THE BOARD"; then
  pass "all open GitHub issues traced by open beads leaves the gate line silent"
else
  fail "traced GitHub issues should be silent (rc=$RC): $OUT"
fi
unset FIXTURE_GH_ISSUES_FILE FIXTURE_OPEN_FILE

phase "8. graceful degrade — bd absent: silent, exit 0"
run "$FIX/status-stopped" "$FIX/ready-2" ""
NOBD_OUT="$(cd "$PROJ" && env PATH="/usr/bin:/bin" \
  FIXTURE_STATUS_FILE="$FIX/status-stopped" bash seats/fleet-gate.sh 2>&1)"
NOBD_RC=$?
if [ $NOBD_RC -eq 0 ] && [ -z "$NOBD_OUT" ]; then
  pass "no bd on PATH: silent, exit 0"
else
  fail "no bd on PATH should be silent+0 (rc=$NOBD_RC): $NOBD_OUT"
fi

phase "9. graceful degrade — adapter.ts absent: silent, exit 0"
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
