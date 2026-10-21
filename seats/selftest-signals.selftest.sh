#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-selftest-signals.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
selftest_install_cleanup_traps 'selftest_cleanup_fixture_processes "$FIX"; selftest_remove_fixture_dir "$FIX"'
bun "$HERE/fixtures/selftest-signals.ts" "$HERE" "$FIX" "$@"
# Keep selected legacy trap controls focused; the complete suite also probes
# cancellation while suite/watchdog identities are still being published.
if [ "$#" -eq 0 ]; then
  bun "$HERE/fixtures/sweep-startup-signals.ts" "$HERE" "$FIX"
fi
