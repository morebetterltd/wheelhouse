#!/usr/bin/env bash
# Deadline fixtures are idle sleep/wait trees, never CPU spinners. The outer
# invocation must use the real host lock; nested runners use fixture-only locks.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-sweep-timeout.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
SWEEP="${1:-$HERE/selftest-sweep.sh}"
[ -r "$SWEEP" ] || exit 2
FAILED=0
RESCUE_PID=""
pass(){ printf 'PASS %s\n' "$*"; }
fail(){ printf 'FAIL %s\n' "$*"; FAILED=$((FAILED+1)); }
cleanup(){
  trap '' INT TERM HUP
  if [ -n "$RESCUE_PID" ]; then printf 'done\n' >&7; wait "$RESCUE_PID" 2>/dev/null || true; fi
  selftest_cleanup_fixture_processes "$FIX" >/dev/null 2>&1 || true
  selftest_remove_fixture_dir "$FIX"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
PROJECT="$FIX/project"
selftest_copy_seat_runtime "$PROJECT" "$HERE"
cp -f "$SWEEP" "$PROJECT/seats/selftest-sweep.sh"
git -C "$PROJECT" init -q -b main || exit 2
git -C "$PROJECT" add seats || exit 2
export WHEELHOUSE_SELFTEST_SWEEP_LOCK_HELPER="$HERE/selftest-sweep-lock.ts"

# Independent bounded containment for deliberately broken runner controls.
# It is not the feature under test: if it fires, the regression leg FAILs.
rescue_tree(){ (
  trap - EXIT
  trap '' INT TERM HUP
  local dir="$1" message p g born fresh fp fg fb seen=" "
  if read -r -t 15 -u 7 message; then exit 0; fi
  printf 'independent fixture rescue\n' > "$dir/rescued"
  while read -r p g born; do
    [[ "$p" =~ ^[1-9][0-9]*$ ]] && [[ "$g" =~ ^[1-9][0-9]*$ ]] || continue
    fresh="$(ps -p "$p" -o pid=,pgid=,lstart=)" || continue
    read -r fp fg fb <<< "$fresh"
    [ "$fp" = "$p" ] && [ "$fg" = "$g" ] && [ "$fb" = "$born" ] || continue
    [ "$g" -gt 1 ] && [ "$g" != "$TEST_PGID" ] || continue
    case "$seen" in *" $g "*) continue ;; esac
    seen="$seen$g "
    printf 'RESCUE KILL owned pgid=%s anchor=%s birth=%s\n' "$g" "$p" "$born" >&2
    kill -KILL -- "-$g" 2>/dev/null || true
  done < "$dir/identities"
); }
TEST_PGID="$(ps -p "$$" -o pgid=)"; TEST_PGID="${TEST_PGID//[[:space:]]/}"

check_gone(){
  local dir="$1" p g born fresh fp fg fb rc=0 count=0
  [ -s "$dir/identities" ] || return 1
  while read -r p g born; do
    [[ "$p" =~ ^[1-9][0-9]*$ ]] && [[ "$g" =~ ^[1-9][0-9]*$ ]] || { rc=1; continue; }
    count=$((count+1))
    if fresh="$(ps -p "$p" -o pid=,pgid=,lstart= 2>/dev/null)"; then
      read -r fp fg fb <<< "$fresh"
      if [ "$fp" = "$p" ] && [ "$fg" = "$g" ] && [ "$fb" = "$born" ]; then
        printf 'SURVIVOR pid=%s pgid=%s birth=%s\n' "$p" "$g" "$born" >&2; rc=1
      fi
    fi
  done < "$dir/identities"
  [ "$count" -ge 3 ] && [ "$rc" = 0 ]
}

run_timeout_case(){
  local name="$1" ignore="$2" limit="$3" dir="$FIX/$1" lock="$FIX/$1.lock" rc rescue_rc
  mkdir -p "$dir"
  : > "$dir/identities"
  cat > "$dir/00-hang.selftest.sh" <<'SH'
#!/usr/bin/env bash
set -u
# New groups deliberately exercise descendants outside the leader's PGID.
set -m
if [ "$IGNORE_TERM" = 1 ]; then trap 'printf "TERM observed\n" >> "$CASE_DIR/term"' TERM; fi
ps -p "$$" -o pid=,pgid=,lstart= >> "$CASE_DIR/identities"
depth="${1:-0}"
if [ "$depth" -lt 2 ]; then bash "$0" "$((depth+1))" & fi
while :; do
  sleep 60 & sleeper=$!
  ps -p "$sleeper" -o pid=,pgid=,lstart= >> "$CASE_DIR/identities"
  wait "$sleeper" || true
done
SH
  cat > "$dir/01-after.selftest.sh" <<'SH'
#!/usr/bin/env bash
printf 'after timeout\n' > "$CASE_DIR/after"
SH
  mkfifo -m 600 "$dir/rescue-control"; exec 7<> "$dir/rescue-control"; rm -f "$dir/rescue-control"
  rescue_tree "$dir" & RESCUE_PID=$!
  CASE_DIR="$dir" IGNORE_TERM="$ignore" WHEELHOUSE_SELFTEST_SWEEP_LOCK="$lock" WHEELHOUSE_SELFTEST_SUITE_TIMEOUT_S="$limit" WHEELHOUSE_SELFTEST_SUITE_TERM_GRACE_S=1 WHEELHOUSE_SELFTEST_SWEEP_PATTERN="$dir/*.selftest.sh" bash "$PROJECT/seats/selftest-sweep.sh" > "$dir/out" 2> "$dir/err"; rc=$?
  printf 'done\n' >&7
  wait "$RESCUE_PID"; rescue_rc=$?; RESCUE_PID=""; exec 7>&-
  if [ "$rc" = 1 ] && [ "$rescue_rc" = 0 ] && [ ! -e "$dir/rescued" ] && grep -F "selftest-sweep: FAIL $dir/00-hang.selftest.sh timed out after ${limit}s" "$dir/out" >/dev/null && grep -F "selftest-sweep: timeout summary: $dir/00-hang.selftest.sh timed out after ${limit}s" "$dir/out" >/dev/null; then
    pass "$name: deadline reports FAIL and timed out after ${limit}s (without independent rescue)"
  else fail "$name: deadline outcome rc=$rc rescue=$([ -e "$dir/rescued" ] && echo yes || echo no)"; fi
  if [ -f "$dir/after" ] && grep -Fx "selftest-sweep: PASS $dir/01-after.selftest.sh" "$dir/out" >/dev/null && [ ! -e "$lock" ] && [ ! -e "$lock.queue" ]; then
    pass "$name: following suite runs and lock/queue are released normally"
  else fail "$name: following suite or lock release missing"; fi
  if [ "$ignore" = 1 ]; then
    if [ -s "$dir/term" ] && grep -F 'KILL owned suite tree pgid=' "$dir/err" >/dev/null; then pass "$name: TERM trap observed; grace then KILL escalated"
    else fail "$name: TERM/grace/KILL proof missing"; fi
  fi
  # A fresh foreground runner reuses the same private lock, and gives init an
  # observable completed child lifecycle before checking orphan PID absence.
  CASE_DIR="$dir" WHEELHOUSE_SELFTEST_SWEEP_LOCK="$lock" WHEELHOUSE_SELFTEST_SUITE_TIMEOUT_S=5 WHEELHOUSE_SELFTEST_SUITE_TERM_GRACE_S=1 WHEELHOUSE_SELFTEST_SWEEP_PATTERN="$dir/01-after.selftest.sh" bash "$PROJECT/seats/selftest-sweep.sh" > "$dir/reuse.out" 2> "$dir/reuse.err"; rc=$?
  if [ "$rc" = 0 ] && [ ! -e "$lock" ] && [ ! -e "$lock.queue" ] && check_gone "$dir"; then pass "$name: no recorded parent/child/grandchild/sleep survives; released lock reusable"
  else fail "$name: surviving process or lock reuse failed"; fi
  printf '%s\n' "--- $name nested stdout ---"; while IFS= read -r line; do printf '%s\n' "$line"; done < "$dir/out"
  printf '%s\n' "--- $name nested stderr ---" >&2; while IFS= read -r line; do printf '%s\n' "$line" >&2; done < "$dir/err"
}
run_timeout_case ordinary 0 2
run_timeout_case term-ignored 1 3

# Defaults are observed on a completed fast suite, never by waiting an hour.
DEFAULT_DIR="$FIX/default"; mkdir -p "$DEFAULT_DIR"
printf '#!/usr/bin/env bash\nexit 0\n' > "$DEFAULT_DIR/pass.selftest.sh"
env -u WHEELHOUSE_SELFTEST_SUITE_TIMEOUT_S -u WHEELHOUSE_SELFTEST_SUITE_TERM_GRACE_S WHEELHOUSE_SELFTEST_SWEEP_LOCK="$FIX/default.lock" WHEELHOUSE_SELFTEST_SWEEP_PATTERN="$DEFAULT_DIR/pass.selftest.sh" bash "$PROJECT/seats/selftest-sweep.sh" > "$DEFAULT_DIR/out" 2> "$DEFAULT_DIR/err"; rc=$?
if [ "$rc" = 0 ] && grep -F 'suite timeout=3600s TERM grace=5s' "$DEFAULT_DIR/err" >/dev/null; then pass 'measured generous default is 3600 seconds with five-second TERM grace'
else fail "default limit missing rc=$rc"; fi
for invalid in 0 -1 garbage; do
  WHEELHOUSE_SELFTEST_SUITE_TIMEOUT_S="$invalid" WHEELHOUSE_SELFTEST_SWEEP_LOCK="$FIX/invalid.lock" WHEELHOUSE_SELFTEST_SWEEP_PATTERN="$DEFAULT_DIR/pass.selftest.sh" bash "$PROJECT/seats/selftest-sweep.sh" > "$FIX/invalid.out" 2> "$FIX/invalid.err"; rc=$?
  if [ "$rc" = 2 ] && [ ! -e "$FIX/invalid.lock" ] && [ ! -e "$FIX/invalid.lock.queue" ] && grep -F 'must be positive whole seconds' "$FIX/invalid.err" >/dev/null; then pass "invalid limit $invalid refused before admission"
  else fail "invalid limit $invalid not refused (rc=$rc)"; fi
done
[ "$FAILED" = 0 ] || { printf 'selftest-sweep-timeout: FAIL (%s)\n' "$FAILED"; exit 1; }
printf 'selftest-sweep-timeout: PASS\n'
