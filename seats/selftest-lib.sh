#!/usr/bin/env bash
# Shared teardown helpers for wheelhouse selftests.
# Source this file, then call selftest_cleanup_fixture_processes "$FIX" [tmux-socket...]
# from the selftest's EXIT trap before deleting the fixture root.

selftest_fixture_processes() {
  root="${1:-}"
  [ -n "$root" ] || return 0
  ps axww -o pid=,command= | grep -F "$root" | grep -v 'grep -F' | grep -v 'awk -v root' || true
}

selftest_cleanup_fixture_processes() {
  root="${1:-}"
  shift || true
  [ -n "$root" ] || return 0

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
