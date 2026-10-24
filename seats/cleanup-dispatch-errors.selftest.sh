#!/usr/bin/env bash
# Real startup/teardown errors must survive the fixture's cleanup path.
set -uo pipefail
S="$(cd "$(dirname "$0")" && pwd -P)"
. "$S/selftest-lib.sh"
SOURCE="${1:-$S/fixtures/cleanup-dispatch.ts}"
BASE_PATH="$PATH"
ROOTS=()
cleanup() {
  local root rc=0
  for root in ${ROOTS[@]+"${ROOTS[@]}"}; do
    selftest_cleanup_fixture_processes "$root" || rc=1
    selftest_remove_fixture_dir "$root" || rc=1
  done
  return "$rc"
}
selftest_install_cleanup_traps cleanup
failed=0
for mode in startup both teardown; do
  export PATH="$BASE_PATH"
  FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-cleanup-errors.$mode.XXXXXX")" || exit 2
  selftest_isolate_git "$FIX" || exit 2
  ROOTS+=("$FIX")
  graph_env="$(selftest_scratch_graph "$FIX/graph")" || exit 2
  eval "$graph_env"
  selftest_copy_seat_runtime "$FIX/project" "$S" || exit 2
  bun "$S/fixtures/cleanup-dispatch-errors.ts" "$FIX" "$mode" "$SOURCE" || failed=$((failed+1))
  if [ -n "${WHEELHOUSE_CLEANUP_ERRORS_EVIDENCE:-}" ]; then
    destination="$WHEELHOUSE_CLEANUP_ERRORS_EVIDENCE/$mode"
    [ ! -e "$destination" ] && [ ! -L "$destination" ] || exit 2
    mkdir -p "$WHEELHOUSE_CLEANUP_ERRORS_EVIDENCE" || exit 2
    cp -Rf "$FIX/result" "$destination" || exit 2
  fi
done
printf 'cleanup dispatch error fixtures: %s failures=%s\n' "$([ "$failed" = 0 ] && printf PASS || printf FAIL)" "$failed"
[ "$failed" = 0 ]
