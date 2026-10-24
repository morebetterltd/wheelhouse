#!/usr/bin/env bash
# Native isolated launch/readiness/exit observations, including removed checks.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-daemon-readiness.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
selftest_install_cleanup_traps 'selftest_cleanup_fixture_processes "$FIX"; selftest_remove_fixture_dir "$FIX"'
bun "$HERE/fixtures/daemon-readiness.ts" "$FIX" "$HERE"
