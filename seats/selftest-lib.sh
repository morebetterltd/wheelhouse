#!/usr/bin/env bash
# Shared teardown helpers for wheelhouse selftests.
# Source this file, then call selftest_cleanup_fixture_processes "$FIX" [tmux-socket...]
# from the selftest's EXIT trap before deleting the fixture root.

with_timeout() {
  seconds="${1:-}"
  shift || true
  [ -n "$seconds" ] || { echo "with_timeout: missing seconds" >&2; return 2; }
  [ "$#" -gt 0 ] || { echo "with_timeout: missing command" >&2; return 2; }
  perl -e '$seconds = shift @ARGV; alarm $seconds; exec @ARGV or die "exec @ARGV: $!\n"' "$seconds" "$@"
}

selftest_fixture_processes() {
  root="${1:-}"
  [ -n "$root" ] || return 0
  ps axww -o pid=,command= | grep -F "$root" | grep -v 'grep -F' | grep -v 'awk -v root' || true
}

selftest_stop_fixture_adapters() {
  root="${1:-}"
  [ -n "$root" ] || return 0
  command -v bun >/dev/null 2>&1 || return 0
  [ -d "$root" ] || return 0
  while IFS= read -r state; do
    seats_dir="$(dirname "$state")"
    adapter="$seats_dir/adapter.ts"
    [ -f "$adapter" ] || continue
    (cd "$(dirname "$seats_dir")" && bun seats/adapter.ts stop-all >/dev/null 2>&1) || true
  done <<EOF
$(find "$root" -path '*/seats/state.json' -type f 2>/dev/null)
EOF
}

selftest_cleanup_fixture_processes() {
  root="${1:-}"
  shift || true
  [ -n "$root" ] || return 0

  selftest_stop_fixture_adapters "$root"

  for sock in "$@"; do
    [ -n "${sock:-}" ] || continue
    tmux -L "$sock" kill-server >/dev/null 2>&1 || true
  done

  pids="$(selftest_fixture_processes "$root" | awk '{print $1}' | tr '\n' ' ')"
  [ -n "$pids" ] && kill $pids >/dev/null 2>&1 || true
  sleep 0.2
  pids="$(selftest_fixture_processes "$root" | awk '{print $1}' | tr '\n' ' ')"
  [ -n "$pids" ] && kill -9 $pids >/dev/null 2>&1 || true
  sleep 0.1

  leaks="$(selftest_fixture_processes "$root" || true)"
  if [ -n "$leaks" ]; then
    echo "selftest cleanup leak under $root:" >&2
    printf '%s\n' "$leaks" >&2
    return 1
  fi
  return 0
}
