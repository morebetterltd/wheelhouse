#!/usr/bin/env bash
# Real intake/claims CLIs; every verdict follows a child process exit, not a timer.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-isa-signals.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
trap 'selftest_remove_fixture_dir "$FIX"' EXIT
selftest_copy_seat_runtime "$FIX/project" "$HERE"
bun "$HERE/fixtures/isa-signals.ts" "$FIX/project" "${1:-$FIX/project/seats/isa-signals.ts}"
