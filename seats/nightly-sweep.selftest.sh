#!/usr/bin/env bash
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-nightly-sweep.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
cleanup(){ selftest_cleanup_fixture_processes "${FIX:-}" ""; selftest_remove_fixture_dir "$FIX"; }
selftest_install_cleanup_traps cleanup
if bun "$HERE/fixtures/nightly-sweep.ts" "$HERE" "$FIX"; then
  echo 'nightly-sweep.selftest: PASS'
else
  echo 'nightly-sweep.selftest: FAIL' >&2
  exit 1
fi
