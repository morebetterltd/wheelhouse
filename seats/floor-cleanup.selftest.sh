#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
if ! command -v tmux >/dev/null 2>&1 || ! command -v expect >/dev/null 2>&1; then
  echo 'floor-cleanup: SKIP native tmux and Expect required'
  exit 0
fi
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-floor-cleanup.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
cleanup() { selftest_cleanup_fixture_processes "$FIX"; selftest_remove_fixture_dir "$FIX"; }
selftest_install_cleanup_traps cleanup
bun "$HERE/fixtures/floor-cleanup.ts" "$HERE/.." "$FIX"
