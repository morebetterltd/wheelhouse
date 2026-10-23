#!/usr/bin/env bash
# Keep a failed/interrupted census's real native evidence outside suite CLEAN.
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd -P)"
. "$HERE/selftest-lib.sh"
[ "$#" = 2 ] || { echo 'usage: adapter-census-run.sh <fresh-project> <adapter.ts>' >&2; exit 2; }
owned=0
if [ -n "${WHEELHOUSE_CENSUS_EVIDENCE:-}" ]; then
  evidence="$WHEELHOUSE_CENSUS_EVIDENCE" # Explicit fixture callers keep successes too.
else
  evidence="$(selftest_make_fixture_dir "${WHEELHOUSE_SELFTEST_ARTIFACT_ROOT:-${TMPDIR:-/tmp}}/wheelhouse-adapter-census.XXXXXX")" || exit 2
  owned=1
fi
rc=0
WHEELHOUSE_CENSUS_EVIDENCE="$evidence" bun "$HERE/fixtures/adapter-census.ts" "$1" "$2" || rc=$?
if [ "$rc" = 0 ] && [ "$owned" = 1 ]; then
  selftest_remove_fixture_dir "$evidence" || exit 2
elif [ "$rc" != 0 ]; then
  printf 'adapter-census: private failure evidence retained at %s\n' "$evidence" >&2
fi
exit "$rc"
