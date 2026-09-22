#!/usr/bin/env bash
# Shared teardown helpers for wheelhouse selftests.
# Source this file, then call selftest_cleanup_fixture_processes "$FIX" [tmux-socket...]
# from the selftest's EXIT trap before deleting the fixture root.

SELFTEST_INVOCATION_PWD="${SELFTEST_INVOCATION_PWD:-$(pwd -P)}"

with_timeout() {
  seconds="${1:-}"
  shift || true
  [ -n "$seconds" ] || { echo "with_timeout: missing seconds" >&2; return 2; }
  [ "$#" -gt 0 ] || { echo "with_timeout: missing command" >&2; return 2; }
  perl -e '$seconds = shift @ARGV; alarm $seconds; exec @ARGV or die "exec @ARGV: $!\n"' "$seconds" "$@"
}

selftest_lib_root() { cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P; }
selftest_path_contains() { case "$2" in "$1"|"$1"/*) return 0;; *) return 1;; esac; }
selftest_fixture_refused() {
  fixture="$1"; reason="$2"
  echo "STOP: unsafe selftest fixture path: ${fixture:-<empty>} ($reason)" >&2
  return 2
}
selftest_make_fixture_dir() {
  template="${1:-}"
  [ -n "$template" ] || { echo "STOP: mktemp fixture template is empty" >&2; return 2; }
  made="$(mktemp -d "$template")" || { echo "STOP: mktemp failed for fixture template: $template" >&2; return 2; }
  [ -n "$made" ] || selftest_fixture_refused "$made" "mktemp returned an empty path" || return 2
  fixture="$(cd "$made" && pwd -P)" || { echo "STOP: could not canonicalize fixture path: $made" >&2; return 2; }
  cwd="$SELFTEST_INVOCATION_PWD"
  repo="$(selftest_lib_root)"
  [ "$fixture" != "/" ] || selftest_fixture_refused "$fixture" "refuses filesystem root" || return 2
  if selftest_path_contains "$fixture" "$cwd"; then selftest_fixture_refused "$fixture" "fixture would contain caller cwd $cwd" || return 2; fi
  if selftest_path_contains "$fixture" "$repo"; then selftest_fixture_refused "$fixture" "fixture would contain repository root $repo" || return 2; fi
  : > "$fixture/.wheelhouse-selftest-fixture"
  printf '%s\n' "$fixture"
}
selftest_remove_fixture_dir() {
  fixture="${1:-}"
  [ -n "$fixture" ] || return 0
  canon="$(cd "$fixture" 2>/dev/null && pwd -P)" || return 0
  [ -f "$canon/.wheelhouse-selftest-fixture" ] || { echo "STOP: refusing to remove fixture path not made by selftest_make_fixture_dir: $canon" >&2; return 2; }
  cwd="$SELFTEST_INVOCATION_PWD"; repo="$(selftest_lib_root)"
  [ "$canon" != "/" ] || selftest_fixture_refused "$canon" "refuses filesystem root" || return 2
  if selftest_path_contains "$canon" "$cwd"; then selftest_fixture_refused "$canon" "fixture would contain caller cwd $cwd" || return 2; fi
  if selftest_path_contains "$canon" "$repo"; then selftest_fixture_refused "$canon" "fixture would contain repository root $repo" || return 2; fi
  rm -rf "$canon"
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
