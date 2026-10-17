#!/usr/bin/env bash
set -u
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-scratch-path.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
trap 'selftest_remove_fixture_dir "$FIX"' EXIT
exec > >("$HERE/evidence-scrub.sh") 2> >("$HERE/evidence-scrub.sh" >&2)
bun "$HERE/fixtures/scratch-path.mjs" "$FIX" "${1:-${WHEELHOUSE_SCRATCH_PATH_SOURCE:-$HERE}}"
