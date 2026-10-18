#!/usr/bin/env bash
set -eu
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-capture-guards.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
trap 'selftest_cleanup_fixture_processes "$FIX"; selftest_remove_fixture_dir "$FIX"' EXIT
bun "$HERE/fixtures/capture-guards.ts" "$HERE" "$FIX"
