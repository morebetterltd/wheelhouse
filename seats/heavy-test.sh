#!/usr/bin/env bash
# One host FIFO for project benches, reviews, and selftest sweeps.
# Execute: bash seats/heavy-test.sh <command> [args...]
# Or source at the top of a Bash bench, before any work: . "$ROOT/seats/heavy-test.sh"

wheelhouse_admit_heavy_test() {
  local root helper lock rc option
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)" || return 2
  helper="${WHEELHOUSE_SELFTEST_SWEEP_LOCK_HELPER:-$root/seats/selftest-sweep-lock.ts}"
  lock="${WHEELHOUSE_SELFTEST_SWEEP_LOCK:-/tmp/wheelhouse-selftest-sweep.lock}"
  export WHEELHOUSE_HEAVY_TEST_PAUSE="${WHEELHOUSE_HEAVY_TEST_PAUSE:-$root/seats/run/host-guard-pause}"
  [ -r "$helper" ] || { echo "STOP: heavy-test lock helper missing or unreadable: $helper" >&2; return 2; }
  if bun "$helper" inherited "$lock"; then return 0; else rc=$?; fi
  [ "$rc" = 75 ] || return "$rc"
  if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    [ "$#" -gt 0 ] || { echo 'usage: heavy-test.sh <command> [args...]' >&2; return 2; }
    exec bun "$helper" supervise "$lock" "$BASH" -c 'exec "$@"' heavy-test "$@"
  fi
  # A bench's own EXIT traps and exec must not replace lock release. Re-enter
  # under the existing supervisor, preserving cwd, argv and shell options.
  local options=()
  for option in ${SHELLOPTS//:/ }; do options+=( -o "$option" ); done
  [ -f "$0" ] || { echo 'STOP: heavy-test admission requires a Bash script' >&2; return 2; }
  exec bun "$helper" supervise "$lock" "$BASH" "${options[@]}" -- "$0" "$@"
}
if [ "${BASH_SOURCE[0]}" = "$0" ] && [ "$#" -eq 0 ]; then
  echo 'usage: heavy-test.sh <command> [args...]' >&2
  exit 2
fi
wheelhouse_admit_heavy_test "$@" || exit "$?"
if [ "${BASH_SOURCE[0]}" = "$0" ]; then exec "$@"; fi
unset -f wheelhouse_admit_heavy_test
