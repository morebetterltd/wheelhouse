#!/usr/bin/env bash
# Real detached RPC fixture, including loss of BOTH sweep output readers.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-adapter-interrupt.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
cleanup(){ selftest_cleanup_fixture_processes "$FIX" >/dev/null 2>&1 || true; selftest_remove_fixture_dir "$FIX"; }
selftest_install_cleanup_traps cleanup
EVIDENCE="${WHEELHOUSE_ADAPTER_INTERRUPT_EVIDENCE:-$FIX/evidence}"
bun "$HERE/fixtures/adapter-interrupt.ts" "$HERE" "$FIX" "$EVIDENCE" "${1:-$HERE/selftest-sweep.sh}"
