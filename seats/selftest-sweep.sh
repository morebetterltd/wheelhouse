#!/usr/bin/env bash
# selftest-sweep.sh — run seats/*.selftest.sh serially under a host-wide lock.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
PATTERN="${WHEELHOUSE_SELFTEST_SWEEP_PATTERN:-$ROOT/seats/*.selftest.sh}"
# TMPDIR is per-run scratch; it must not split the host-wide lock domain.
LOCK="${WHEELHOUSE_SELFTEST_SWEEP_LOCK:-/tmp/wheelhouse-selftest-sweep.lock}"
SLEEP_SECS="${WHEELHOUSE_SELFTEST_SWEEP_WAIT_SECONDS:-1}"
CURRENT_SUITE_PID=""
OWNED_LOCK=""
ENROLLED=0
LOCK_HELPER="${WHEELHOUSE_SELFTEST_SWEEP_LOCK_HELPER:-$ROOT/seats/selftest-sweep-lock.ts}"
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
  local previous="" result rc
  while :; do
    result="$(bun "$LOCK_HELPER" acquire "$LOCK" "$$" "$LOCK_TOKEN" "")"; rc=$?
    case "$rc" in
      0) ENROLLED=1; OWNED_LOCK="$result"; return 0 ;;
      75) ENROLLED=1 ;; # Validated, durably registered waiter, not a Bun error.
      *) info "STOP: selftest-sweep lock helper failed (exit $rc)"; exit 2 ;;
    esac
    if [ "$previous" != "$result" ]; then
      info "selftest-sweep: waiting for host-wide lock $LOCK $result"
      previous="$result"
    fi
    sleep "$SLEEP_SECS"
  done
}

release_lock(){
  local rc=0
  if [ "$ENROLLED" = 1 ]; then
    bun "$LOCK_HELPER" release "$LOCK" "$$" "$LOCK_TOKEN" "$OWNED_LOCK" || rc=$?
    OWNED_LOCK=""
    ENROLLED=0
  fi
  return "$rc"
}
finish_sweep(){
  local rc=$?
  trap - EXIT
  trap '' INT TERM
  if [ -n "$CURRENT_SUITE_PID" ]; then
    kill -TERM -- "-$CURRENT_SUITE_PID" 2>/dev/null || kill -TERM "$CURRENT_SUITE_PID" 2>/dev/null || true
    wait "$CURRENT_SUITE_PID" 2>/dev/null || true
    CURRENT_SUITE_PID=""
  fi
  # Release once, from EXIT, after the interrupted suite has cleaned up.
  # A release error must not replace the requested signal exit status.
  release_lock || { [ "$rc" -ge 128 ] || rc=2; }
  exit "$rc"
}
trap finish_sweep EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Source policy is unconditional, including filtered sweeps. Check actual
# files, not embedded heredocs/inline calls (tracked separately in 9yms).
check_source_files(){
  [ -d "$ROOT/seats" ] || { info "selftest-sweep: missing seats directory: $ROOT/seats"; return 1; }
  find -L "$ROOT/seats" \( -type f -o -type l \) -print0 | (
    rejected=0
    while IFS= read -r -d '' file; do
      case "$file" in
        *.[pP][yY]) info "selftest-sweep: forbidden Python file: $file"; rejected=1; continue ;;
      esac
      [ -r "$file" ] || { info "selftest-sweep: unreadable source file: $file"; rejected=1; continue; }
      # Only shebang files need a full first-line read; binary/large fixtures
      # are probed for two bytes, never loaded wholesale.
      prefix=""; IFS= read -r -n 2 prefix < "$file" || true
      [ "$prefix" = '#!' ] || continue
      first=""; IFS= read -r first < "$file" || true
      # env -S also accepts a quoted split string, e.g. "python3 -u".
      first="${first//\"/}"; first="${first//\'/}"
      if printf '%s\n' "$first" | LC_ALL=C grep -E '^#![[:space:]]*([^[:space:]]*/)?python([0-9]+([.][0-9]+)*)?([[:space:]]|$)|^#![[:space:]]*([^[:space:]]*/)?env[[:space:]]+([^[:space:]]+[[:space:]]+)*([^[:space:]]*/)?python([0-9]+([.][0-9]+)*)?([[:space:]]|$)|^#![[:space:]]*([^[:space:]]*/)?env[[:space:]]+([^[:space:]]+[[:space:]]+)*(-S|--split-string=)([^[:space:]]*/)?python([0-9]+([.][0-9]+)*)?([[:space:]]|$)' >/dev/null; then
        info "selftest-sweep: forbidden Python shebang: $file"
        rejected=1
      fi
    done
    exit "$rejected"
  )
}
check_source_files || exit 1
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
  perl -MPOSIX=setsid -e 'setsid or die "setsid: $!\n"; exec @ARGV or die "exec @ARGV: $!\n"' bash "$suite" &
  CURRENT_SUITE_PID=$!
  wait "$CURRENT_SUITE_PID"
  rc=$?
  CURRENT_SUITE_PID=""
  if [ "$rc" -eq 0 ]; then
    say "selftest-sweep: PASS $suite"
  else
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
