#!/usr/bin/env bash
# Independently runnable, read-only graph protocol case; no bd mutations.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd -P)"
. "$HERE/selftest-lib.sh"
PRUNE="${1:-$HERE/prune.ts}"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-prune-prefix.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
cleanup(){ selftest_cleanup_fixture_processes "$FIX"; selftest_remove_fixture_dir "$FIX"; }
selftest_install_cleanup_traps cleanup
selftest_copy_seat_runtime "$FIX/root" "$HERE"
cp -f "$PRUNE" "$FIX/root/seats/prune.ts"
git -C "$FIX/root" init -q -b main
# Admission above is unbounded; this hard limit applies only to the helper.
trap 'exit 142' ALRM
perl -e 'alarm 120; exec @ARGV or die $!' bun "$HERE/fixtures/prune-prefix.ts" "$FIX/root"
