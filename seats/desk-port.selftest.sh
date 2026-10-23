#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
FIX=""
. "$HERE/selftest-lib.sh"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-desk-port.XXXXXX")"
selftest_isolate_git "$FIX"
selftest_install_cleanup_traps 'selftest_cleanup_fixture_processes "$FIX"; selftest_remove_fixture_dir "$FIX"'
bun "$HERE/fixtures/desk-port.ts" "$FIX" "$(dirname "$HERE")"
bun "$HERE/fixtures/desk-port-consumers.ts" "$FIX" "$(dirname "$HERE")"
