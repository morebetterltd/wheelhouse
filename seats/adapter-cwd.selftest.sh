#!/usr/bin/env bash
# Keep the full hermetic adapter suite runnable outside any source checkout.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-adapter-cwd.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
selftest_install_cleanup_traps 'selftest_cleanup_fixture_processes "$FIX"; selftest_remove_fixture_dir "$FIX"'
mkdir -p "$FIX/unrelated" "$FIX/tmp"
# No source tree exists here. A caller-relative runtime copy must fail, rather
# than accidentally finding another checkout's seats/ directory.
[ ! -e "$FIX/unrelated/seats" ]
if (cd "$FIX/unrelated" && TMPDIR="$FIX/tmp" WHEELHOUSE_SKIP_REAL_PI=1 bash "$HERE/adapter.selftest.sh" < /dev/null); then
  echo 'adapter-cwd.selftest: PASS (full adapter suite from unrelated cwd)'
else
  rc=$?
  echo "adapter-cwd.selftest: FAIL (adapter exit $rc from unrelated cwd)" >&2
  exit "$rc"
fi
