#!/usr/bin/env bash
# Set executable discovery before Bun starts: Bun 1.2 may cache its spawn PATH.
# Called inside an already-admitted selftest/bench, with an owned fixture root.
set -euo pipefail
kind="${1:?kind}"; seats="${2:?seats}"; fixture="${3:?fixture}"
case "$kind" in herald|desk) ;; *) exit 2;; esac
[ -f "$fixture/.wheelhouse-selftest-fixture" ] || exit 2
bin="$fixture/memory-$kind-bin"
mkdir -p "$bin"
cat > "$bin/bd" <<'SH'
#!/bin/sh
printf '%s\n' "$*" >> "$WHEELHOUSE_MEMORY_BD_CALLS"
case "$1" in
  --memory-fixture-probe) printf 'memory-fixture-bd\n';;
  ready) printf 'mem-ready\n';;
  list) case "$*" in *--status*|*--label*) printf '[]\n';; *) printf '[{"id":"mem-ready","title":"Memory fixture work","status":"open","priority":"P2","created_at":"2026-01-01T00:00:00Z"}]\n';; esac;;
  *) printf 'refusing unexpected fixture bd verb\n' >&2; exit 97;;
esac
SH
chmod 755 "$bin/bd"
export WHEELHOUSE_MEMORY_BD_STUB="$bin/bd" WHEELHOUSE_MEMORY_BD_CALLS="$bin/calls"
export PATH="$bin:$PATH" GIT_CEILING_DIRECTORIES="$fixture" BEADS_DIR="$fixture/refuse-real-beads"
unset WHEELHOUSE_HERALD_ROOT WHEELHOUSE_DESK_ROOT WHEELHOUSE_NEEDS_ROOT WHEELHOUSE_DIGEST_ROOT
export WHEELHOUSE_HERALD_MAX_SEEN=5000 WHEELHOUSE_HERALD_INTERVAL_MS=1000 WHEELHOUSE_HERALD_READ_CHUNK_BYTES=65536
export WHEELHOUSE_ALERT_INTERVAL_MS=1000000000000000 WHEELHOUSE_STAFFING_INTERVAL_MS=1000000000000000
export WHEELHOUSE_DESK_DIGEST_CACHE_MAX=16 WHEELHOUSE_DESK_DIGEST_REFRESH_MS=60000
exec bun "$seats/fixtures/daemon-memory.ts" "$kind" "$seats" "$fixture"
