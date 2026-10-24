#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-adapter-resume.XXXXXX")"
selftest_isolate_git "$FIX"
selftest_install_cleanup_traps 'selftest_cleanup_fixture_processes "$FIX"; selftest_remove_fixture_dir "$FIX"'
mkdir -p "$FIX/source"
selftest_copy_seat_runtime "$FIX/source" "$HERE"
bun "$HERE/fixtures/adapter-resume.ts" "$FIX" "$FIX/source" "$HERE/fixtures/adapter-resume-peer.ts"
