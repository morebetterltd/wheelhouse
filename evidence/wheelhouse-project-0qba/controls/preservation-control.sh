#!/usr/bin/env bash
set -uo pipefail
. "$QUEUE_CODE_ROOT/seats/selftest-lib.sh"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-queue-preservation.XXXXXX")" || exit 2
trap 'selftest_remove_fixture_dir "$FIX"' EXIT
export WHEELHOUSE_QUEUE_TEST_CASE=integrity
bun "$QUEUE_NEG_DRIVER" "$FIX" "$QUEUE_CODE_ROOT/seats/selftest-sweep.sh" "$QUEUE_BAD_HELPER"
