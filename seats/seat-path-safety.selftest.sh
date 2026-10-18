#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
SOURCE="${1:-$HERE/..}"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-seat-path-safety.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
cleanup(){ trap '' INT TERM HUP; selftest_remove_fixture_dir "$FIX"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
selftest_copy_seat_runtime "$FIX/runtime" "$SOURCE/seats"
bun "$HERE/fixtures/seat-path-safety.ts" "$FIX" "${2:-all}"
