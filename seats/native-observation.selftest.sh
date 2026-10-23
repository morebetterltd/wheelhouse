#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-native-observation.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
selftest_install_cleanup_traps 'selftest_cleanup_fixture_processes "$FIX"; selftest_remove_fixture_dir "$FIX"'
selftest_copy_seat_runtime "$FIX/runtime" "${1:-$HERE}" || exit 2
bun "$HERE/fixtures/native-digest.ts" "$FIX/runtime" "$FIX"
bun "$HERE/fixtures/native-json.ts" "$FIX/runtime" "$FIX"
bun "$HERE/fixtures/native-birth.ts" "$FIX/runtime" "$FIX"
bun "$HERE/fixtures/native-prune.ts" "$FIX/runtime" "$FIX"
bun "$HERE/fixtures/native-recover.ts" "$FIX/runtime" "$FIX"
echo 'native-observation: PASS'
