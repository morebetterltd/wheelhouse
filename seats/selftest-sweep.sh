#!/usr/bin/env bash
# selftest-sweep.sh — run seats/*.selftest.sh serially under a host-wide lock.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
PATTERN="${WHEELHOUSE_SELFTEST_SWEEP_PATTERN:-$ROOT/seats/*.selftest.sh}"
LOCK="${WHEELHOUSE_SELFTEST_SWEEP_LOCK:-${TMPDIR:-/tmp}/wheelhouse-selftest-sweep.lock}"
SLEEP_SECS="${WHEELHOUSE_SELFTEST_SWEEP_WAIT_SECONDS:-1}"

say(){ printf '%s\n' "$*"; }
info(){ say "$*" >&2; }

holder_pid(){ [ -f "$LOCK/pid" ] && sed -n '1p' "$LOCK/pid" 2>/dev/null || true; }
holder_desc(){
  local pid started root
  pid="$(holder_pid)"
  started="$(sed -n '1p' "$LOCK/started" 2>/dev/null || true)"
  root="$(sed -n '1p' "$LOCK/root" 2>/dev/null || true)"
  printf 'pid=%s%s%s' "${pid:-unknown}" "${started:+ started=$started}" "${root:+ root=$root}"
}
pid_alive(){ local pid="$1"; [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; }

acquire_lock(){
  local printed=0 pid
  while :; do
    if mkdir "$LOCK" 2>/dev/null; then
      printf '%s\n' "$$" > "$LOCK/pid"
      date -u +%Y-%m-%dT%H:%M:%SZ > "$LOCK/started"
      printf '%s\n' "$ROOT" > "$LOCK/root"
      printf '%s\n' "$PATTERN" > "$LOCK/pattern"
      return 0
    fi
    pid="$(holder_pid)"
    if [ -n "$pid" ] && ! pid_alive "$pid"; then
      info "selftest-sweep: removing stale lock $LOCK held by dead pid $pid"
      rm -rf "$LOCK"
      continue
    fi
    if [ "$printed" = 0 ]; then
      info "selftest-sweep: waiting for host-wide lock $LOCK held by $(holder_desc)"
      printed=1
    fi
    sleep "$SLEEP_SECS"
  done
}

release_lock(){
  if [ -f "$LOCK/pid" ] && [ "$(holder_pid)" = "$$" ]; then rm -rf "$LOCK"; fi
}
trap release_lock EXIT INT TERM

acquire_lock

shopt -s nullglob
suites=( $PATTERN )
shopt -u nullglob
if [ "${#suites[@]}" -eq 0 ]; then
  info "selftest-sweep: no suites matched: $PATTERN"
  exit 1
fi

failures=0
for suite in "${suites[@]}"; do
  [ -f "$suite" ] || continue
  say "selftest-sweep: START $suite"
  if bash "$suite"; then
    say "selftest-sweep: PASS $suite"
  else
    rc=$?
    say "selftest-sweep: FAIL $suite rc=$rc"
    failures=$((failures + 1))
  fi
done

if [ "$failures" -eq 0 ]; then
  say "selftest-sweep: PASS (${#suites[@]} suite(s))"
  exit 0
fi
say "selftest-sweep: FAIL ($failures failure(s) of ${#suites[@]} suite(s))"
exit 1
