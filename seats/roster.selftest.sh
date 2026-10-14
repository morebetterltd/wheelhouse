#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd -P)
. "$HERE/selftest-lib.sh"
IMPL=${1:-$HERE/roster.ts}
FIX=$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-roster.XXXXXX") || exit 2
selftest_isolate_git "$FIX" || exit 2
trap 'selftest_remove_fixture_dir "$FIX"' EXIT
mkdir -p "$FIX/install/seats"
SELECTED=${WHEELHOUSE_ROSTER_CASE:-all}
RAN=0
check() {
  local name=$1 expected=$2 needle=$3 rc=0
  [ "$SELECTED" = all ] || [ "$SELECTED" = "$name" ] || return 0
  RAN=$((RAN+1))
  if [ "${4:-explicit}" = default ]; then
    bun "$FIX/install/seats/roster.ts" check > "$FIX/out" 2> "$FIX/err" || rc=$?
  else
    bun "$IMPL" check --root "$FIX/install" > "$FIX/out" 2> "$FIX/err" || rc=$?
  fi
  [ "$rc" -eq "$expected" ] || { echo "FAIL $name: exit $rc, expected $expected"; cat "$FIX/out" "$FIX/err"; exit 1; }
  if [ "$expected" -eq 0 ]; then
    grep -qx 'roster: producer check OK' "$FIX/out" && [ ! -s "$FIX/err" ] || { echo "FAIL $name: missing success or unexpected error"; exit 1; }
  else
    grep -qF "$needle" "$FIX/err" && [ ! -s "$FIX/out" ] || { echo "FAIL $name: missing diagnostic $needle"; cat "$FIX/err"; exit 1; }
  fi
  echo "PASS roster $name"
}
write() { printf '%s\n' "$1" > "$FIX/install/seats/seats.json"; }
write '{"seats":{"worker":{"role":"worker"}}}'
check builder-without-producer 2 'builder seats require a non-shadow producer'
write '{"seats":{"worker":{"role":"worker"},"producer":{"role":"producer","harness":"claude-code"}}}'
check standing-producer 0 ''
write '{"commander":{"role":"commander","external":true},"seats":{"worker":{"role":"worker"},"producer":{"role":"producer","external":true,"runtime":"commander-subagent"}}}'
check subagent-producer 0 ''
write '{"commander":{"role":"producer","external":true},"seats":{"worker":{"role":"worker"}}}'
check commander-not-producer 2 'builder seats require'
write '{"seats":{"worker":{"role":"worker"},"producer":{"role":"producer","shadow":true}}}'
check shadow-not-producer 2 'builder seats require'
write '{"seats":{"worker":{"role":"worker"},"producer":{"role":"producer","external":true}}}'
check unrecorded-subagent 2 'external producer must name runtime commander-subagent'
write '{"seats":{"producer":{"role":"producer","shadow":"false"}}}'
check invalid-flag 2 'shadow must be boolean'
write '{"seats":{}}'
check no-builders 0 ''
printf '%s\n' '{"roles":{"workers":{"min":0,"max":1}}}' > "$FIX/install/seats/pool.json"
check unstaffed-pool-without-producer 2 'builder seats require'
write '{"seats":{"producer":{"role":"producer","external":true,"runtime":"commander-subagent"}}}'
check unstaffed-pool-with-producer 0 ''
printf '%s\n' '{bad pool' > "$FIX/install/seats/pool.json"
check unreadable-pool 2 'cannot read roster metadata'
printf '%s\n' '{"roles":[]}' > "$FIX/install/seats/pool.json"
check malformed-pool 2 'roles must be an object'
rm -f "$FIX/install/seats/pool.json"
write '{"seats":[]}'
check malformed-seats 2 'seats must be an object'
write '{"seats":{"worker":null}}'
check malformed-seat 2 'role must be a non-empty string'
write '{bad roster'
check unreadable-roster 2 'cannot read roster metadata'
rm -f "$FIX/install/seats/seats.json"
check missing-roster 2 'cannot read roster metadata'
write '{"seats":{"worker":{"role":"worker"},"producer":{"role":"producer","external":true,"runtime":"commander-subagent"}}}'
cp -f "$IMPL" "$FIX/install/seats/roster.ts"
for source in pool.ts harness.ts credential-shapes.ts; do cp -f "$HERE/$source" "$FIX/install/seats/$source"; done
check default-root 0 '' default
if [ "$SELECTED" = all ] || [ "$SELECTED" = usage ]; then
  RAN=$((RAN+1))
  rc=0; bun "$IMPL" check --root > "$FIX/out" 2> "$FIX/err" || rc=$?
  [ "$rc" -eq 3 ] && grep -qF 'usage: roster.ts check' "$FIX/err" || { echo 'FAIL roster usage'; exit 1; }
  echo 'PASS roster usage'
fi
[ "$RAN" -gt 0 ] || { echo "FAIL unknown roster case: $SELECTED"; exit 1; }
echo "roster.selftest: PASS ($RAN checks)"
