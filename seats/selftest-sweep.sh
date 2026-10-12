#!/usr/bin/env bash
# selftest-sweep.sh — run seats/*.selftest.sh serially under a host-wide lock.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
PATTERN="${WHEELHOUSE_SELFTEST_SWEEP_PATTERN:-$ROOT/seats/*.selftest.sh}"
LOCK="${WHEELHOUSE_SELFTEST_SWEEP_LOCK:-${TMPDIR:-/tmp}/wheelhouse-selftest-sweep.lock}"
SLEEP_SECS="${WHEELHOUSE_SELFTEST_SWEEP_WAIT_SECONDS:-1}"
CURRENT_SUITE_PID=""

say(){ printf '%s\n' "$*"; }
info(){ say "$*" >&2; }

lock_read_field(){
  local key="$1"
  if [ -d "$LOCK" ]; then
    case "$key" in
      pid) [ -f "$LOCK/pid" ] && sed -n '1p' "$LOCK/pid" 2>/dev/null || true ;;
      started) [ -f "$LOCK/started" ] && sed -n '1p' "$LOCK/started" 2>/dev/null || true ;;
      root) [ -f "$LOCK/root" ] && sed -n '1p' "$LOCK/root" 2>/dev/null || true ;;
      pattern) [ -f "$LOCK/pattern" ] && sed -n '1p' "$LOCK/pattern" 2>/dev/null || true ;;
    esac
    return 0
  fi
  [ -f "$LOCK" ] || return 0
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$LOCK" 2>/dev/null || true
}
holder_pid(){ lock_read_field pid; }
holder_desc(){
  local pid started root
  pid="$(holder_pid)"
  started="$(lock_read_field started)"
  root="$(lock_read_field root)"
  printf 'pid=%s%s%s' "${pid:-unknown}" "${started:+ started=$started}" "${root:+ root=$root}"
}
pid_alive(){
  local pid="$1" err
  [ -n "$pid" ] || return 1
  if kill -0 "$pid" 2>/dev/null; then return 0; fi
  err="$(kill -0 "$pid" 2>&1 >/dev/null || true)"
  case "$err" in
    *"Operation not permitted"*|*"operation not permitted"*|*"not permitted"*) return 0 ;;
  esac
  return 1
}

write_lock_candidate(){
  local path="$1"
  {
    printf 'pid=%s\n' "$$"
    printf 'started=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'root=%s\n' "$ROOT"
    printf 'pattern=%s\n' "$PATTERN"
  } > "$path"
}

try_atomic_acquire(){
  local parent base candidate
  parent="$(dirname "$LOCK")"
  base="$(basename "$LOCK")"
  candidate="$parent/.${base}.$$.$RANDOM.new"
  write_lock_candidate "$candidate" || { rm -f "$candidate"; return 1; }
  if [ -e "$LOCK" ]; then
    rm -f "$candidate"
    return 1
  fi
  if ln "$candidate" "$LOCK" 2>/dev/null; then
    rm -f "$candidate"
    return 0
  fi
  rm -f "$candidate"
  return 1
}

try_remove_stale_lock(){
  local pid stale moved_pid desc
  pid="$(holder_pid)"
  if [ -n "$pid" ] && pid_alive "$pid"; then return 1; fi
  stale="$LOCK.stale.$$.$RANDOM"
  if ! mv "$LOCK" "$stale" 2>/dev/null; then return 1; fi
  if [ -d "$stale" ]; then
    moved_pid="$(sed -n '1p' "$stale/pid" 2>/dev/null || true)"
  else
    moved_pid="$(awk -F= '$1 == "pid" { sub(/^[^=]*=/, ""); print; exit }' "$stale" 2>/dev/null || true)"
  fi
  if [ -n "$moved_pid" ] && pid_alive "$moved_pid"; then
    mv "$stale" "$LOCK" 2>/dev/null || true
    return 1
  fi
  if [ -n "$moved_pid" ]; then desc="dead pid $moved_pid"; else desc="missing pid"; fi
  info "selftest-sweep: removing stale lock $LOCK held by $desc"
  rm -rf "$stale"
  return 0
}

acquire_lock(){
  local printed=0
  while :; do
    if try_atomic_acquire; then return 0; fi
    if [ -e "$LOCK" ] && try_remove_stale_lock; then
      printed=0
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
  if [ -f "$LOCK" ] && [ "$(holder_pid)" = "$$" ]; then rm -f "$LOCK"; fi
}
interrupt_sweep(){
  local rc="$1"
  trap - INT TERM
  if [ -n "$CURRENT_SUITE_PID" ] && kill -0 "$CURRENT_SUITE_PID" 2>/dev/null; then
    kill -TERM -- "-$CURRENT_SUITE_PID" 2>/dev/null || kill -TERM "$CURRENT_SUITE_PID" 2>/dev/null || true
    wait "$CURRENT_SUITE_PID" 2>/dev/null || true
  fi
  release_lock
  exit "$rc"
}
trap release_lock EXIT
trap 'interrupt_sweep 130' INT
trap 'interrupt_sweep 143' TERM

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
