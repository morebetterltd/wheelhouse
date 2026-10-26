#!/usr/bin/env bash
# Herald-specific lifetime binding; deliberately separate from selftest-lib.
# TERM escalation grace only; the final wait joins the original child.
SELFTEST_HERALD_TERM_GRACE_TICKS=30
SELFTEST_HERALD_OBSERVE_INTERVAL_S=0.1
# Call in the owning selftest shell after allocating its marked fixture.
selftest_bind_herald_owner() {
  local root="${1:-}" started
  [ -n "$root" ] && [ -f "$root/.wheelhouse-selftest-fixture" ] || { echo 'STOP: herald owner needs a marked fixture' >&2; return 2; }
  root="$(cd "$root" && pwd -P)" || return 2
  started="$(ps -p "$$" -o lstart= | awk '{$1=$1;print}')"
  [ -n "$started" ] || return 2
  printf '%s\n%s\n%s\n%s\n' "$$" "$started" "$(id -u)" "$root" > "$root/.wheelhouse-herald-owner"
}

# A waited/reaped PID can be reused. Check the direct child relationship AND
# herald command afresh before each signal, never a pidfile/prefix adoption.
selftest_herald_child_is_ours() {
  local identity
  identity="$(ps -ww -p "$1" -o ppid=,command= 2>/dev/null)"
  [ "$(printf '%s\n' "$identity" | awk '{print $1}')" = "$$" ] || return 1
  case "$identity" in *bun*herald.ts*) return 0;; *) return 1;; esac
}
selftest_stop_herald_child() {
  local pid="${1:-}"
  [ -n "$pid" ] || return 0
  selftest_herald_child_is_ours "$pid" || return 0
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 "$SELFTEST_HERALD_TERM_GRACE_TICKS"); do selftest_herald_child_is_ours "$pid" || break; sleep "$SELFTEST_HERALD_OBSERVE_INTERVAL_S"; done
  selftest_herald_child_is_ours "$pid" && kill -KILL "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}
