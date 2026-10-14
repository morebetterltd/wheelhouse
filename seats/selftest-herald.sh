#!/usr/bin/env bash
# Herald-specific lifetime binding; deliberately separate from selftest-lib.
# Call in the owning selftest shell after allocating its marked fixture.
selftest_bind_herald_owner() {
  local root="${1:-}" started
  [ -n "$root" ] && [ -f "$root/.wheelhouse-selftest-fixture" ] || { echo 'STOP: herald owner needs a marked fixture' >&2; return 2; }
  root="$(cd "$root" && pwd -P)" || return 2
  started="$(ps -p "$$" -o lstart= | awk '{$1=$1;print}')"
  [ -n "$started" ] || return 2
  printf '%s\n%s\n%s\n%s\n' "$$" "$started" "$(id -u)" "$root" > "$root/.wheelhouse-herald-owner"
}

# Only the direct child recorded at our own exec launch is waited/stopped here.
selftest_stop_herald_child() {
  local pid="${1:-}"
  [ -n "$pid" ] || return 0
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}
