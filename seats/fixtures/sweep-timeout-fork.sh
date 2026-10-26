# Sourced by selftest-sweep-timeout.selftest.sh inside its owned allocation.
# Coordinate an idle parent at the final census: without quiescence it forks a
# separate job-control PGID AFTER ps completed, BEFORE the captured groups die.
run_fork_window_case(){
  local name="$1" control="$2" suppress_kill="${3:-0}" dir="$FIX/$1" project="$FIX/$1/project" rc reuse_rc gone=0 rescue_rc stopped=0 i
  selftest_require_fixture_owner "$FIX" || return 2
  mkdir -p "$dir"
  : > "$dir/identities"
  selftest_copy_seat_runtime "$project" "$HERE" || return 2
  cat > "$dir/probe" <<'SH'
  if [ "$signal" = KILL ]; then
    local observed_state
    observed_state="$(ps -p "$root" -o stat=)" || return 2
    printf '%s\n' "$observed_state" > "$CASE_DIR/at-kill"
    case "$observed_state" in *T*|*t*) ;; *)
      printf 'fork\n' > "$CASE_DIR/fork-control"
      local attempt
      for ((attempt=0;attempt<100;attempt++)); do
        [ ! -e "$CASE_DIR/child-ready" ] || break
        sleep 0.02
      done
      [ -e "$CASE_DIR/child-ready" ] || return 2
    ;; esac
  fi
SH
  # Instrument only a pinned private runner, after its native process census.
  # The control removes only the quiescence call, retaining all identity checks.
  awk -v hook="$dir/probe" -v control="$control" -v suppress_kill="$suppress_kill" '
    $0 == "      kill -\"$signal\" -- \"-$g\" 2>/dev/null || true" && suppress_kill == 1 {
      print "      if [ \"$signal\" != KILL ]; then"
      print
      print "      fi"
      omitted++; next
    }
    $0 == "  if ! quiesce_suite_tree \"$root\" \"$dir\"; then" && control == 1 {
      print "  if ! :; then"; removed++; next
    }
    { print }
    /^  LC_ALL=C ps -ww -axo .* > "\$dir\/processes" \|\| return 2$/ {
      while ((getline line < hook) > 0) print line
      close(hook); injected++
    }
    END { if (injected != 1 || removed != control || omitted != suppress_kill) exit 2 }
  ' "$SWEEP" > "$project/seats/selftest-sweep.sh" || return 2
  observe_fixture_watchdog "$project/seats/selftest-sweep.sh" "$project/seats/selftest-sweep.sh" || return 2
  git -C "$project" init -q -b main || return 2
  [ "$(git -C "$project" rev-parse --show-toplevel)" = "$project" ] || return 2
  git -C "$project" add seats || return 2
  mkfifo -m 600 "$dir/fork-control"
  cat > "$dir/00-fork.selftest.sh" <<'SH'
#!/usr/bin/env bash
set -u
trap '' TERM
set -m
exec 5<> "$CASE_DIR/fork-control"
ps -p "$$" -o pid=,pgid=,lstart= >> "$CASE_DIR/identities"
read -r message <&5 || exit 2
sleep 60 & child=$!
ps -p "$child" -o pid=,pgid=,lstart= >> "$CASE_DIR/identities"
: > "$CASE_DIR/child-ready"
wait "$child"
SH
  printf '#!/usr/bin/env bash\nprintf after > "$CASE_DIR/after"\n' > "$dir/01-after.selftest.sh"
  mkfifo -m 600 "$dir/rescue-control"; exec 7<> "$dir/rescue-control"; rm -f "$dir/rescue-control"
  rescue_tree "$dir" & RESCUE_PID=$!
  CASE_DIR="$dir" WHEELHOUSE_SELFTEST_SWEEP_LOCK="$dir/lock" WHEELHOUSE_SELFTEST_SUITE_TIMEOUT_S=1 WHEELHOUSE_SELFTEST_SUITE_TERM_GRACE_S=1 WHEELHOUSE_SELFTEST_SWEEP_PATTERN="$dir/*.selftest.sh" bash "$project/seats/selftest-sweep.sh" > "$dir/out" 2> "$dir/err"; rc=$?
  printf 'done\n' >&7; wait "$RESCUE_PID"; rescue_rc=$?; RESCUE_PID=""; exec 7>&-
  CASE_DIR="$dir" WHEELHOUSE_SELFTEST_SWEEP_LOCK="$dir/lock" WHEELHOUSE_SELFTEST_SUITE_TIMEOUT_S=5 WHEELHOUSE_SELFTEST_SUITE_TERM_GRACE_S=1 WHEELHOUSE_SELFTEST_SWEEP_PATTERN="$dir/01-after.selftest.sh" bash "$project/seats/selftest-sweep.sh" > "$dir/reuse.out" 2> "$dir/reuse.err"; reuse_rc=$?
  check_gone "$dir" 1 > "$dir/detected.out" 2> "$dir/detected.err" || gone=$?
  while IFS= read -r line; do printf '%s\n' "$line" >&2; done < "$dir/detected.err"
  if [ -s "$dir/at-kill" ]; then
    case "$(<"$dir/at-kill")" in *T*|*t*) stopped=1 ;; esac
  fi
  printf 'FORK_WINDOW name=%s control=%s stopped_at_kill=%s late_child=%s survivor_check=%s runner=%s reuse=%s rescue=%s\n' "$name" "$control" "$stopped" "$([ -e "$dir/child-ready" ] && echo yes || echo no)" "$gone" "$rc" "$reuse_rc" "$([ -e "$dir/rescued" ] && echo yes || echo no)"
  if [ "$rc" != 1 ] || [ "$reuse_rc" != 0 ] || [ "$rescue_rc" != 0 ] || [ ! -s "$dir/containment-finished" ] || [ -e "$dir/rescued" ] || [ ! -e "$dir/after" ] || [ -e "$dir/lock" ] || [ -e "$dir/lock.queue" ]; then
    fail "$name: timeout/reuse/independent containment outcome (rc=$rc reuse=$reuse_rc)"
  elif [ "$control" = 0 ] && [ "$stopped" = 1 ] && [ ! -e "$dir/child-ready" ] && [ "$gone" = 0 ]; then
    pass 'fork window: parent is stopped at final KILL census; no late group can be born; lock reusable'
  elif [ "$control" = 1 ] && [ "$stopped" = 0 ] && [ -e "$dir/child-ready" ] && [ "$gone" = 1 ] && grep -E '^SURVIVOR pid=[0-9]+ ppid=[0-9]+ pgid=[0-9]+ state=[^ ]+ birth=.* command=.*sleep' "$dir/detected.err" >/dev/null; then
    pass 'fix-removed control: post-census child escapes group KILL; detection records command/parent/group/state/birth'
  else
    fail "$name: wrong fork-window observation (control=$control stopped=$stopped gone=$gone)"
  fi
  # A failing control is not permission to leave its known survivor running.
  # Signal only freshly matching recorded PID/PGID/birth groups, then observe
  # absence, not merely successful kill delivery. Never touch another run.
  kill_recorded_tree "$dir" CONTROL_CLEANUP
  for ((i=0;i<50;i++)); do
    check_gone "$dir" 1 > "$dir/cleanup.out" 2> "$dir/cleanup.err" && break
    sleep 0.05
  done
  if [ "$i" = 50 ]; then
    while IFS= read -r line; do printf '%s\n' "$line" >&2; done < "$dir/cleanup.err"
    fail "$name: recorded fixture process remains after identity-checked cleanup"
  else pass "$name: recorded fixture processes absent after cleanup"; fi
}
run_fork_window_case fork-frozen 0 || fail 'fixed fork-window setup failed'
run_fork_window_case fork-unfrozen 1 || fail 'control fork-window setup failed'

# Quiescence alone is not containment. Keep it, but omit group KILL in a
# pinned private runner; the frozen parent must outlive its deadline and the
# completed watchdog pass, then cause a real rejection and owned rescue.
run_frozen_kill_control(){
  local before="$FAILED" rejected=0 dir="$FIX/fork-kill-omitted"
  run_fork_window_case fork-kill-omitted 0 1 > "$FIX/frozen-kill-control.out" 2> "$FIX/frozen-kill-control.err"
  if [ "$FAILED" = "$((before+1))" ] && [ -s "$dir/containment-finished" ] && [ -s "$dir/rescue-checked" ] && [ -s "$dir/rescued" ] && grep -E 'state=[Tt]' "$dir/rescue-targets" >/dev/null && grep -F 'FORK_WINDOW name=fork-kill-omitted control=0 stopped_at_kill=1' "$FIX/frozen-kill-control.out" >/dev/null && grep -F 'FAIL fork-kill-omitted: timeout/reuse/independent containment outcome' "$FIX/frozen-kill-control.out" >/dev/null && check_gone "$dir" 1; then rejected=1; fi
  FAILED="$before"
  if [ "$rejected" = 1 ]; then
    printf 'EXPECTED_REJECTION FAIL fork-kill-omitted: frozen cohort survived deadline and completed watchdog pass\n'
    while IFS= read -r line; do printf 'FROZEN_RESCUE %s\n' "$line"; done < "$dir/rescue-targets"
    pass 'frozen-kill control: omitted KILL rejected; unchanged 15s post-containment observer rescued matching frozen target'
  else
    while IFS= read -r line; do printf '%s\n' "$line"; done < "$FIX/frozen-kill-control.out"
    while IFS= read -r line; do printf '%s\n' "$line" >&2; done < "$FIX/frozen-kill-control.err"
    fail 'frozen-kill control: missing rejection or frozen-target rescue proof'
  fi
}
run_frozen_kill_control || fail 'frozen-kill control setup failed'
