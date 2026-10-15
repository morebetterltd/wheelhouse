#!/usr/bin/env bash
# Real private-lock runners: clean teardown, group leak, detached scratch leak.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-sweep-survivors.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
trap 'selftest_remove_fixture_dir "$FIX"' EXIT
bun "$HERE/fixtures/sweep-survivors.ts" "$FIX" "$HERE"
