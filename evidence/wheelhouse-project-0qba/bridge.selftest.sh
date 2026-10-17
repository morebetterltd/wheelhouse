#!/usr/bin/env bash
set -eu
cd "$QUEUE_GATE_ROOT"
unset WHEELHOUSE_SELFTEST_SWEEP_PATTERN
export WHEELHOUSE_SELFTEST_SWEEP_LOCK=/tmp/wheelhouse-selftest-sweep.lock
exec bash seats/selftest-sweep.sh
