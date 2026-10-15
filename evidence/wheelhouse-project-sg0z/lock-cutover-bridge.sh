#!/usr/bin/env bash
# Migration-only bridge: outer official runner holds legacy host lock;
# inner official runner holds the merged, TMPDIR-independent host lock.
set -eu
cd "$SG0Z_GATE_ROOT"
unset WHEELHOUSE_SELFTEST_SWEEP_PATTERN
export WHEELHOUSE_SELFTEST_SWEEP_LOCK=/tmp/wheelhouse-selftest-sweep.lock
exec bash seats/selftest-sweep.sh
