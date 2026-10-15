#!/usr/bin/env bash
# selftest-sweep.sh — run seats/*.selftest.sh serially under a host-wide lock.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
PATTERN="${WHEELHOUSE_SELFTEST_SWEEP_PATTERN:-$ROOT/seats/*.selftest.sh}"
# TMPDIR is per-run scratch; it must not split the host-wide lock domain.
LOCK="${WHEELHOUSE_SELFTEST_SWEEP_LOCK:-/tmp/wheelhouse-selftest-sweep.lock}"
SLEEP_SECS="${WHEELHOUSE_SELFTEST_SWEEP_WAIT_SECONDS:-1}"
CURRENT_SUITE_PID=""
CURRENT_SUITE_TMP=""
CURRENT_SUITE_NAME=""
OWNED_LOCK=""
LOCK_HELPER="${WHEELHOUSE_SELFTEST_SWEEP_LOCK_HELPER:-$ROOT/seats/selftest-sweep-lock.ts}"
PROCESS_HELPER="${WHEELHOUSE_SELFTEST_SWEEP_PROCESS_HELPER:-$ROOT/seats/selftest-sweep-processes.ts}"
if [ ! -f "$LOCK_HELPER" ] || [ ! -r "$LOCK_HELPER" ]; then
  printf 'STOP: selftest-sweep lock helper missing or unreadable: %s\n' "$LOCK_HELPER" >&2
  exit 2
fi
# Canonicalize the parent, not the leaf: a symlink at LOCK must be refused.
LOCK="$(bun -e 'import fs from "node:fs"; import p from "node:path"; const s=process.argv[1]; console.log(p.join(fs.realpathSync(p.dirname(p.resolve(s))),p.basename(s)))' "$LOCK")" || exit 2
LOCK_TOKEN="$(bun -e 'console.log(crypto.randomUUID().replace(/-/g,""))')" || exit 2

say(){ printf '%s\n' "$*"; }
info(){ say "$*" >&2; }

acquire_lock(){
  local printed=0 result rc
  while :; do
    result="$(bun "$LOCK_HELPER" acquire "$LOCK" "$$" "$LOCK_TOKEN" "")"; rc=$?
    case "$rc" in
      0) OWNED_LOCK="$result"; return 0 ;;
      75) ;; # Reserved helper result: a validated live lock, not a Bun error.
      *) info "STOP: selftest-sweep lock helper failed (exit $rc)"; exit 2 ;;
    esac
    if [ "$printed" = 0 ]; then
      info "selftest-sweep: waiting for host-wide lock $LOCK held by $result"
      printed=1
    fi
    sleep "$SLEEP_SECS"
  done
}

release_lock(){
  local rc=0
  if [ -n "$OWNED_LOCK" ]; then
    bun "$LOCK_HELPER" release "$LOCK" "$$" "$LOCK_TOKEN" "$OWNED_LOCK" || rc=$?
    OWNED_LOCK=""
  fi
  return "$rc"
}
finish_sweep(){
  local rc=$?
  trap - EXIT
  release_lock || rc=2
  exit "$rc"
}
interrupt_sweep(){
  local rc="$1"
  trap - INT TERM
  if [ -n "$CURRENT_SUITE_PID" ] && kill -0 "$CURRENT_SUITE_PID" 2>/dev/null; then
    kill -TERM -- "-$CURRENT_SUITE_PID" 2>/dev/null || kill -TERM "$CURRENT_SUITE_PID" 2>/dev/null || true
    wait "$CURRENT_SUITE_PID" 2>/dev/null || true
  fi
  if [ -n "$CURRENT_SUITE_PID" ] && [ -n "$CURRENT_SUITE_TMP" ]; then
    bun "$PROCESS_HELPER" check "$CURRENT_SUITE_NAME" "$CURRENT_SUITE_PID" "$CURRENT_SUITE_TMP" || true
  fi
  release_lock || rc=2
  exit "$rc"
}
trap finish_sweep EXIT
trap 'interrupt_sweep 130' INT
trap 'interrupt_sweep 143' TERM

acquire_lock
[ -f "$PROCESS_HELPER" ] && [ -r "$PROCESS_HELPER" ] || { info "STOP: selftest-sweep survivor helper missing: $PROCESS_HELPER"; exit 2; }

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
  CURRENT_SUITE_NAME="$suite"
  CURRENT_SUITE_TMP="$(bun "$PROCESS_HELPER" make "$suite" "$$")" || exit 2
  say "selftest-sweep: START $suite"
  TMPDIR="$CURRENT_SUITE_TMP" perl -MPOSIX=setsid -e 'setsid or die "setsid: $!\n"; exec @ARGV or die "exec @ARGV: $!\n"' bash "$suite" &
  CURRENT_SUITE_PID=$!
  wait "$CURRENT_SUITE_PID"
  rc=$?
  bun "$PROCESS_HELPER" check "$suite" "$CURRENT_SUITE_PID" "$CURRENT_SUITE_TMP"
  survivor_rc=$?
  CURRENT_SUITE_PID=""
  CURRENT_SUITE_TMP=""
  if [ "$survivor_rc" -ne 0 ]; then rc="$survivor_rc"; fi
  if [ "$rc" -eq 0 ]; then
    say "selftest-sweep: PASS $suite"
  else
    say "selftest-sweep: FAIL $suite rc=$rc"
    failures=$((failures + 1))
  fi
  # An unavailable/failed instrument is not evidence of no surviving children.
  [ "$survivor_rc" -ne 2 ] || exit 2
done

if [ "$failures" -eq 0 ]; then
  say "selftest-sweep: PASS (${#suites[@]} suite(s))"
  exit 0
fi
say "selftest-sweep: FAIL ($failures failure(s) of ${#suites[@]} suite(s))"
exit 1
