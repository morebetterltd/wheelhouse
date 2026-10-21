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
  if declare -F kill_recorded_tree >/dev/null; then
    kill_recorded_tree "$FIX/ordinary" CLEANUP
    kill_recorded_tree "$FIX/term-ignored" CLEANUP
    kill_recorded_tree "$FIX/live-target-control" CLEANUP
    kill_recorded_tree "$FIX/fork-frozen" CLEANUP
    kill_recorded_tree "$FIX/fork-unfrozen" CLEANUP
    kill_recorded_tree "$FIX/fork-kill-omitted" CLEANUP
  fi
  selftest_remove_fixture_dir "$FIX"
}
selftest_install_cleanup_traps cleanup
# Observe completion of the copied watchdog's containment pass. Fixture setup
# and native censuses are not part of the independent 15s rescue observation.
# Preserve the watchdog status; this hook cannot turn a refusal into success.
observe_fixture_watchdog(){
  local source="$1" target="$2" pending="$2.observer-new"
  awk '
    /^suite_watchdog\(\)\{ \($/ { watchdog=1 }
    watchdog && /^\); \}$/ {
      print "  local fixture_status=$?"
      print "  if [ -n \"${CASE_DIR:-}\" ]; then"
      print "    printf '\''%s\\n'\'' \"$fixture_status\" > \"$CASE_DIR/.containment-finished.$$\" || exit 2"
      print "    mv -f \"$CASE_DIR/.containment-finished.$$\" \"$CASE_DIR/containment-finished\" || exit 2"
      print "  fi"
      print "  exit \"$fixture_status\""
      observed++; watchdog=0
    }
    { print }
    END { if (observed != 1) exit 2 }
  ' "$source" > "$pending" || return 2
  mv -f "$pending" "$target"
}
PROJECT="$FIX/project"
selftest_copy_seat_runtime "$PROJECT" "$HERE"
observe_fixture_watchdog "$SWEEP" "$PROJECT/seats/selftest-sweep.sh" || exit 2
git -C "$PROJECT" init -q -b main || exit 2
git -C "$PROJECT" add seats || exit 2
export WHEELHOUSE_SELFTEST_SWEEP_LOCK_HELPER="$HERE/selftest-sweep-lock.ts"

# Independent bounded containment for deliberately broken runner controls.
# It is not the feature under test: if it fires, the regression leg FAILs.
kill_recorded_tree(){
  local dir="$1" reason="$2" p g born fresh fp fg state fb seen=" "
  [ -f "$dir/identities" ] || return 0
  while read -r p g born; do
    [[ "$p" =~ ^[1-9][0-9]*$ ]] && [[ "$g" =~ ^[1-9][0-9]*$ ]] || continue
    fresh="$(ps -p "$p" -o pid=,pgid=,stat=,lstart=)" || continue
    read -r fp fg state fb <<< "$fresh"
    [ "$fp" = "$p" ] && [ "$fg" = "$g" ] && [ "$fb" = "$born" ] || continue
    [ "$g" -gt 1 ] && [ "$g" != "$TEST_PGID" ] || continue
    # An expired observer is not proof it rescued anything: the runner may
    # already have reaped the cohort and still be doing survivor inventories.
    case "$state" in Z*) continue ;; esac
    case "$seen" in *" $g "*) continue ;; esac
    seen="$seen$g "
    if [ "$reason" = RESCUE ]; then
      printf 'independent fixture rescue\n' > "$dir/rescued"
      printf 'pid=%s pgid=%s state=%s birth=%s\n' "$p" "$g" "$state" "$born" >> "$dir/rescue-targets"
    fi
    printf '%s KILL owned pgid=%s anchor=%s birth=%s\n' "$reason" "$g" "$p" "$born" >&2
    kill -KILL -- "-$g" 2>/dev/null || true
  done < "$dir/identities"
}
rescue_tree(){ (
  trap - EXIT
  trap '' INT TERM HUP
  local dir="$1" message status
  # Do not race a healthy runner still preparing or observing its owned tree.
  # A broken KILL still completes this pass and arms the same bounded rescue.
  while [ ! -f "$dir/containment-finished" ]; do
    if read -r -t 1 -u 7 message; then
      [ "$message" = done ] || exit 2
      exit 0
    fi
  done
  read -r status < "$dir/containment-finished" || exit 2
  [[ "$status" =~ ^[0-9]+$ ]] || exit 2
  if read -r -t 15 -u 7 message; then [ "$message" = done ]; exit "$?"; fi
  printf 'independent 15s post-containment observation\n' > "$dir/rescue-checked"
  kill_recorded_tree "$dir" RESCUE
); }
TEST_PGID="$(ps -p "$$" -o pgid=)"; TEST_PGID="${TEST_PGID//[[:space:]]/}"

check_gone(){
  local dir="$1" minimum="${2:-3}" p g born fresh fp parent fg state weekday month day clock year cmd
  local bd bm bn bt by rc=0 count=0
  [ -s "$dir/identities" ] || return 1
  while read -r p g born; do
    [[ "$p" =~ ^[1-9][0-9]*$ ]] && [[ "$g" =~ ^[1-9][0-9]*$ ]] || { rc=1; continue; }
    count=$((count+1))
    # One wide native snapshot supplies identity AND diagnostics at detection,
    # before teardown can kill/reparent it. Keep state so zombies are nameable.
    if fresh="$(ps -ww -p "$p" -o pid=,ppid=,pgid=,stat=,lstart=,command= 2>/dev/null)"; then
      read -r fp parent fg state weekday month day clock year cmd <<< "$fresh"
      read -r bd bm bn bt by <<< "$born"
      if [ "$fp" = "$p" ] && [ "$fg" = "$g" ] && [ "$weekday $month $day $clock $year" = "$bd $bm $bn $bt $by" ]; then
        printf 'SURVIVOR pid=%s ppid=%s pgid=%s state=%s birth=%s command=%q\n' "$p" "$parent" "$g" "$state" "$born" "$cmd" >&2; rc=1
      fi
    fi
  done < "$dir/identities"
  [ "$count" -ge "$minimum" ] && [ "$rc" = 0 ]
}

run_timeout_case(){
  local name="$1" ignore="$2" limit="$3" dir="$FIX/$1" lock="$FIX/$1.lock" rc rescue_rc
  mkdir -p "$dir"
  : > "$dir/identities"
  cat > "$dir/00-hang.selftest.sh" <<'SH'
#!/usr/bin/env bash
set -u
cd "$CASE_DIR" || exit 2
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
  if [ "$rc" = 1 ] && [ "$rescue_rc" = 0 ] && [ -s "$dir/containment-finished" ] && [ ! -e "$dir/rescued" ] && grep -F "selftest-sweep: FAIL $dir/00-hang.selftest.sh timed out after ${limit}s" "$dir/out" >/dev/null && grep -F "selftest-sweep: timeout summary: $dir/00-hang.selftest.sh timed out after ${limit}s" "$dir/out" >/dev/null; then
    pass "$name: deadline reports FAIL and timed out after ${limit}s (without independent rescue)"
  else fail "$name: deadline outcome rc=$rc rescue=$([ -e "$dir/rescued" ] && echo yes || echo no)"; fi
  if [ -f "$dir/after" ] && grep -F "selftest-sweep: PASS $dir/01-after.selftest.sh elapsed=" "$dir/out" >/dev/null && [ ! -e "$lock" ] && [ ! -e "$lock.queue" ]; then
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

# Deterministically expire the unchanged observer after a real cohort is gone.
# This is the false-positive regression; it must not claim a rescue happened.
run_absent_target_control(){
  local dir="$FIX/absent-target" rc=0
  mkdir -p "$dir"
  cp -f "$FIX/ordinary/identities" "$dir/identities" || return 2
  check_gone "$dir" || return 2
  printf '0\n' > "$dir/containment-finished"
  mkfifo -m 600 "$dir/rescue-control"; exec 7<> "$dir/rescue-control"; rm -f "$dir/rescue-control"
  rescue_tree "$dir" & RESCUE_PID=$!
  wait "$RESCUE_PID" || rc=$?; RESCUE_PID=""; exec 7>&-
  if [ "$rc" = 0 ] && [ -s "$dir/rescue-checked" ] && [ ! -e "$dir/rescued" ] && check_gone "$dir"; then
    pass 'absent-target control: 15s observer expired after recorded cohort exited; no rescue claimed'
  else fail 'absent-target control: expired observation falsely claimed rescue'; fi
}
run_absent_target_control || fail 'absent-target control setup failed'

# Remove containment ONLY from a pinned private runner's watchdog. The real
# hung cohort must outlive its own 2s deadline and require independent rescue;
# run_timeout_case must still reject it, not accept its eventual timeout footer.
run_live_target_control(){
  local original_project="$PROJECT" project="$FIX/live-target-project" before="$FAILED" rejected=0
  selftest_copy_seat_runtime "$project" "$HERE" || return 2
  awk '
    /^suite_watchdog\(\)\{ \($/ { watchdog=1 }
    watchdog && $0 == "  contain_suite_tree \"$root\" \"$dir\"" {
      print "  : # control: watchdog observes expiry but leaves the cohort alive"; removed++; next
    }
    { print }
    watchdog && /^\); \}$/ { watchdog=0 }
    END { if (removed != 1) exit 2 }
  ' "$SWEEP" > "$project/seats/selftest-sweep.sh" || return 2
  observe_fixture_watchdog "$project/seats/selftest-sweep.sh" "$project/seats/selftest-sweep.sh" || return 2
  git -C "$project" init -q -b main || return 2
  git -C "$project" add seats || return 2
  PROJECT="$project"
  run_timeout_case live-target-control 0 2 > "$FIX/live-target-check.out" 2> "$FIX/live-target-check.err"
  PROJECT="$original_project"
  if [ "$FAILED" = "$((before+1))" ] && [ -s "$FIX/live-target-control/rescue-checked" ] && [ -s "$FIX/live-target-control/rescued" ] && [ -s "$FIX/live-target-control/rescue-targets" ] && grep -F 'FAIL live-target-control: deadline outcome rc=1 rescue=yes' "$FIX/live-target-check.out" >/dev/null && grep -F 'RESCUE KILL owned pgid=' "$FIX/live-target-check.err" >/dev/null && check_gone "$FIX/live-target-control"; then rejected=1; fi
  # Expected rejection is a control result, not a failure of the fixed runner.
  FAILED="$before"
  if [ "$rejected" = 1 ]; then
    printf 'EXPECTED_REJECTION FAIL live-target-control: deadline outcome rc=1 rescue=yes\n'
    while IFS= read -r line; do printf 'LIVE_RESCUE %s\n' "$line"; done < "$FIX/live-target-control/rescue-targets"
    pass 'live-target control: runner leaving cohort alive past 2s deadline rejected; 15s rescue killed freshly matching targets'
  else
    while IFS= read -r line; do printf '%s\n' "$line"; done < "$FIX/live-target-check.out"
    while IFS= read -r line; do printf '%s\n' "$line" >&2; done < "$FIX/live-target-check.err"
    fail 'live-target control: live overdue cohort was not rejected and contained'
  fi
}
run_live_target_control || fail 'live-target control setup failed'
. "$HERE/fixtures/sweep-timeout-fork.sh"

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
