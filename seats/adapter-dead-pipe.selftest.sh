#!/usr/bin/env bash
set -eu
HERE="$(cd "$(dirname "$0")" && pwd -P)"
export WHEELHOUSE_CONTRACT_FIXTURE="$HERE/fixtures/contracts/valid.md"
. "$HERE/selftest-lib.sh"
SOURCE="${1:-$HERE/..}"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-adapter-dead-pipe.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
cleanup() { selftest_cleanup_fixture_processes "$FIX"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
bun "$HERE/fixtures/dead-seat-pipe.ts" "$SOURCE" "$FIX" guard
printf '%s\n' 'adapter-dead-pipe.selftest: PASS'
