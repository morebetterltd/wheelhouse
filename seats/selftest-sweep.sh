#!/usr/bin/env bash
# selftest-sweep.sh — run seats/*.selftest.sh serially under a host-wide lock.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
PATTERN="${WHEELHOUSE_SELFTEST_SWEEP_PATTERN:-$ROOT/seats/*.selftest.sh}"
# TMPDIR is per-run scratch; it must not split the host-wide lock domain.
LOCK="${WHEELHOUSE_SELFTEST_SWEEP_LOCK:-/tmp/wheelhouse-selftest-sweep.lock}"
SLEEP_SECS="${WHEELHOUSE_SELFTEST_SWEEP_WAIT_SECONDS:-1}"
CURRENT_SUITE_PID=""
WATCHDOG_PID=""
SUITE_STATE=""
STARTING_SUITE=0
PENDING_INTERRUPT=""
# Optional reviewer-owned registry. Only our fixed launcher publishes pgids;
# suite payloads do not inherit this capability.
REVIEW_GROUPS="${WHEELHOUSE_SELFTEST_REVIEW_GROUPS:-}"
SUITE_TIMED_OUT=0
SUITE_RC=0
# Measured: concurrency 62s; passing adapter capture <=335s; a whole
# successful 53-suite review sweep took 843.256s (2026-10-17, wxuh 49e2970).
# One hour is >4x that conservative bound, not a guessed short test budget.
SUITE_TIMEOUT_S="${WHEELHOUSE_SELFTEST_SUITE_TIMEOUT_S:-3600}"
SUITE_GRACE_S="${WHEELHOUSE_SELFTEST_SUITE_TERM_GRACE_S:-5}"
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

for setting in SUITE_TIMEOUT_S SUITE_GRACE_S; do
  value="${!setting}"
  if [[ ! "$value" =~ ^[1-9][0-9]{0,8}$ ]]; then
    info "STOP: $setting must be positive whole seconds (got '$value')"
    exit 2
  fi
done
RUNNER_PGID="$(ps -p "$$" -o pgid=)" || exit 2
RUNNER_PGID="${RUNNER_PGID//[[:space:]]/}"

# Only the isolated suite group and descendants identified from fresh native
# PID/PPID/PGID/birth records are eligible. Retain identities across TERM so
# an orphaned child is still owned after its parent exits during the grace.
signal_suite_tree(){
  local signal="$1" root="$2" dir="$3" owner group born p parent g birth i j ancestor changed groups_seen=" " oldp oldg oldbirth
  local pids=() parents=() pgids=() states=() births=() owned=() active=()
  local state
  SUITE_TREE_QUIESCENT=1
  local previous_pids=() previous_groups=() previous_births=()
  read -r owner group born < "$dir/owner" || return 2
  [ "$owner" = "$root" ] && [ "$group" = "$root" ] || return 2
  if [ -f "$dir/targets" ]; then
    while read -r oldp oldg oldbirth; do
      i=${#previous_pids[@]}
      previous_pids[i]="$oldp"; previous_groups[i]="$oldg"; previous_births[i]="$oldbirth"
    done < "$dir/targets"
  fi
  ps -axo pid=,ppid=,pgid=,stat=,lstart= > "$dir/processes" || return 2
  i=0
  while read -r p parent g state birth; do
    pids[i]="$p"; parents[i]="$parent"; pgids[i]="$g"; states[i]="$state"; births[i]="$birth"; owned[i]=0
    if [ "$p" = "$root" ] && [ "$g" = "$group" ] && [ "$birth" = "$born" ]; then owned[i]=1; fi
    for ((j=0;j<${#previous_pids[@]};j++)); do
      if [ "$p" = "${previous_pids[j]}" ] && [ "$g" = "${previous_groups[j]}" ] && [ "$birth" = "${previous_births[j]}" ]; then owned[i]=1; break; fi
    done
    if [ "${owned[i]}" = 1 ]; then active[${#active[@]}]="$i"; fi
    i=$((i+1))
  done < "$dir/processes"
  # Expand against only the owned cohort, not every host PID for every row.
  # Likewise load retained identities once, never reopening them per host PID.
  # A small suite tree must not make deadline cleanup quadratic in host size.
  changed=1
  while [ "$changed" = 1 ]; do
    changed=0
    for ((i=0;i<${#pids[@]};i++)); do
      [ "${owned[i]}" = 0 ] || continue
      for ((j=0;j<${#active[@]};j++)); do
        ancestor="${active[j]}"
        if [ "${parents[i]}" = "${pids[ancestor]}" ] || { [ "${pgids[i]}" = "${pgids[ancestor]}" ] && [ "${pgids[i]}" != "$RUNNER_PGID" ]; }; then
          owned[i]=1; active[${#active[@]}]="$i"; changed=1; break
        fi
      done
    done
  done
  : > "$dir/targets.next"
  for ((i=0;i<${#pids[@]};i++)); do
    [ "${owned[i]}" = 1 ] || continue
    case "${states[i]}" in T*|t*|Z*) ;; *) SUITE_TREE_QUIESCENT=0 ;; esac
    printf '%s %s %s\n' "${pids[i]}" "${pgids[i]}" "${births[i]}" >> "$dir/targets.next"
    g="${pgids[i]}"
    if [ "$g" != "$RUNNER_PGID" ] && [ "$g" -gt 1 ]; then
      case "$groups_seen" in *" $g "*) continue ;; esac
      groups_seen="$groups_seen$g "
      info "selftest-sweep: $signal owned suite tree pgid=$g"
      kill -"$signal" -- "-$g" 2>/dev/null || true
    else
      info "selftest-sweep: $signal owned suite descendant pid=${pids[i]}"
      kill -"$signal" "${pids[i]}" 2>/dev/null || true
    fi
  done
  mv -f "$dir/targets.next" "$dir/targets"
}

# A TERM-ignoring job-control shell can fork a new PGID after the KILL
# census. Killing its parent then orphans an unrecorded group. Stop and rescan
# until every attributable process is stopped/zombie before the final census;
# no running owned parent can create another group in that snapshot window.
# This does not contain earlier daemonization or an outside SIGCONT actor.
quiesce_suite_tree(){
  local root="$1" dir="$2" until=$((SECONDS+5))
  while :; do
    signal_suite_tree STOP "$root" "$dir" || return 2
    [ "$SUITE_TREE_QUIESCENT" = 0 ] || return 0
    if [ "$SECONDS" -ge "$until" ]; then
      info 'STOP: suite tree did not quiesce before KILL within 5s'
      return 2
    fi
    sleep 0.05
  done
}

suite_watchdog(){ (
  # This asynchronous child must never run the parent's lock-release traps.
  trap - EXIT
  trap '' INT TERM HUP
  local root="$1" dir="$2" message=""
  if read -r -t "$SUITE_TIMEOUT_S" -u 9 message; then
    [ "$message" = stop ] || exit 0
  else
    printf '%s\n' "$SUITE_TIMEOUT_S" > "$dir/timed-out"
  fi
  signal_suite_tree TERM "$root" "$dir" || { info 'STOP: cannot identify suite tree for TERM'; exit 2; }
  # Separate unwritten FIFO: a parent's normal completion cannot cancel the
  # grace/escalation after TERM has already caused the suite leader to exit.
  read -r -t "$SUITE_GRACE_S" -u 8 message || true
  if ! quiesce_suite_tree "$root" "$dir"; then
    # Do not strand a stopped cohort on an observation failure. Still fail the
    # sweep: a best-effort KILL is not a successful containment observation.
    signal_suite_tree KILL "$root" "$dir" || true
    exit 2
  fi
  signal_suite_tree KILL "$root" "$dir" || { info 'STOP: cannot identify suite tree for KILL'; exit 2; }
); }

retire_review_group(){
  [ -n "$REVIEW_GROUPS" ] || return 0
  perl -MFcntl=:DEFAULT -MErrno=ESRCH -e '
    my ($file, $pid) = @ARGV;
    exit 0 if kill 0, -$pid;
    exit 0 if $! != ESRCH; # EPERM/unknown is not proof the group is gone.
    sysopen(my $in, $file, O_RDONLY|O_NOFOLLOW|O_NONBLOCK) or die "registry read: $!\n";
    my @keep = grep { $_ ne "$pid\n" } <$in>; close $in;
    my $tmp = "$file.$$.new";
    sysopen(my $out, $tmp, O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW, 0600) or die "registry stage: $!\n";
    print $out @keep or die "registry write: $!\n"; close $out or die "registry close: $!\n";
    rename $tmp, $file or die "registry publish: $!\n";
  ' "$REVIEW_GROUPS" "$CURRENT_SUITE_PID"
}

start_suite(){
  # Bash can dispatch a trap between a background fork and its $! assignment.
  # Defer cleanup across the whole allocation/publication transaction: otherwise
  # an unpublished suite can escape, or an unpublished watchdog competes with
  # finish_current_suite's synchronous fallback for the single stop token.
  STARTING_SUITE=1
  SUITE_TIMED_OUT=0
  SUITE_STATE="$(umask 077; mktemp -d "${TMPDIR:-/tmp}/wheelhouse-suite-deadline.XXXXXX")" || exit 2
  mkfifo -m 600 "$SUITE_STATE/control" "$SUITE_STATE/grace" || exit 2
  exec 9<> "$SUITE_STATE/control"
  exec 8<> "$SUITE_STATE/grace"
  rm -f "$SUITE_STATE/control" "$SUITE_STATE/grace"
  # Publish while still in the runner group. KILL before publication therefore
  # kills the launcher too; after publication the reviewer knows its future
  # pgid even if the runner dies before setsid/exec. No reviewer ack is needed.
  perl -MFcntl=:DEFAULT -MPOSIX=setsid -e '
    my $registry = shift @ARGV;
    if (length $registry) {
      sysopen(my $out, $registry, O_WRONLY|O_APPEND|O_NOFOLLOW|O_NONBLOCK) or die "registry open: $!\n";
      print $out "$$\n" or die "registry append: $!\n"; close $out or die "registry close: $!\n";
    }
    setsid or die "setsid: $!\n";
    exec @ARGV or die "exec @ARGV: $!\n";
  ' "$REVIEW_GROUPS" \
    bash -c 'unset WHEELHOUSE_SELFTEST_REVIEW_GROUPS; ps -p "$$" -o pid=,pgid=,lstart= > "$2/owner" || exit 2; exec bash "$1"' \
    suite "$1" "$SUITE_STATE" 8>&- 9>&- &
  CURRENT_SUITE_PID=$!
  suite_watchdog "$CURRENT_SUITE_PID" "$SUITE_STATE" & WATCHDOG_PID=$!
  STARTING_SUITE=0
  if [ -n "$PENDING_INTERRUPT" ]; then interrupt_sweep "$PENDING_INTERRUPT"; fi
}

finish_current_suite(){
  local mode="$1" watch_rc=0
  [ -n "$CURRENT_SUITE_PID" ] || return 0
  if [ "$mode" = stop ]; then printf 'stop\n' >&9; fi
  if [ -n "$WATCHDOG_PID" ]; then
    if [ "$mode" != stop ]; then wait "$CURRENT_SUITE_PID"; SUITE_RC=$?; printf 'done\n' >&9; fi
    wait "$WATCHDOG_PID" || watch_rc=$?
  else
    suite_watchdog "$CURRENT_SUITE_PID" "$SUITE_STATE" || watch_rc=$?
  fi
  if [ "$mode" = stop ]; then wait "$CURRENT_SUITE_PID"; SUITE_RC=$?; fi
  [ ! -f "$SUITE_STATE/timed-out" ] || SUITE_TIMED_OUT=1
  exec 8>&- 9>&-
  rm -rf "$SUITE_STATE"
  retire_review_group || { info 'STOP: cannot retire review suite group'; SUITE_RC=2; }
  CURRENT_SUITE_PID=""; WATCHDOG_PID=""; SUITE_STATE=""
  [ "$watch_rc" = 0 ] || SUITE_RC=2
}

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
  # A startup allocation error must not erase a signal already accepted there.
  [ -z "$PENDING_INTERRUPT" ] || rc="$PENDING_INTERRUPT"
  trap - EXIT
  if [ -n "$CURRENT_SUITE_PID" ]; then finish_current_suite stop; fi
  if [ -n "$SUITE_STATE" ]; then exec 8>&- 9>&-; rm -rf "$SUITE_STATE"; fi
  release_lock || rc=2
  exit "$rc"
}
interrupt_sweep(){
  local rc="$1"
  if [ "$STARTING_SUITE" = 1 ]; then
    [ -n "$PENDING_INTERRUPT" ] || PENDING_INTERRUPT="$rc"
    return
  fi
  trap '' INT TERM HUP
  finish_current_suite stop
  exit "$rc"
}
trap finish_sweep EXIT
trap 'interrupt_sweep 130' INT
trap 'interrupt_sweep 143' TERM
trap 'interrupt_sweep 129' HUP

# File policy remains unconditional, including filtered sweeps. The tracked
# invocation audit below separately distinguishes executable code from data.
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
AUDITOR="$ROOT/seats/python-invocations.ts"
if [ ! -f "$AUDITOR" ] || [ ! -r "$AUDITOR" ]; then
  info "STOP: Python invocation auditor missing or unreadable: $AUDITOR"
  exit 2
fi
# Refuse dependency calls before lock admission, queue registration or START.
# Preserve exit2 for incomplete audits; an unexamined tree is not a test result.
bun "$AUDITOR" "$ROOT" || exit "$?"
acquire_lock

shopt -s nullglob
suites=( $PATTERN )
shopt -u nullglob
if [ "${#suites[@]}" -eq 0 ]; then
  info "selftest-sweep: no suites matched: $PATTERN"
  exit 1
fi

failures=0
timeout_summary=""
info "selftest-sweep: suite timeout=${SUITE_TIMEOUT_S}s TERM grace=${SUITE_GRACE_S}s"
for suite in "${suites[@]}"; do
  [ -f "$suite" ] || continue
  say "selftest-sweep: START $suite"
  start_suite "$suite"
  finish_current_suite done
  rc="$SUITE_RC"
  if [ "$SUITE_TIMED_OUT" = 1 ]; then
    say "selftest-sweep: FAIL $suite timed out after ${SUITE_TIMEOUT_S}s (TERM then KILL after ${SUITE_GRACE_S}s grace; rc=$rc)"
    failures=$((failures + 1))
    timeout_summary="${timeout_summary}selftest-sweep: timeout summary: $suite timed out after ${SUITE_TIMEOUT_S}s
"
  elif [ "$rc" -eq 0 ]; then
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
[ -z "$timeout_summary" ] || printf '%s' "$timeout_summary"
say "selftest-sweep: FAIL ($failures failure(s) of ${#suites[@]} suite(s))"
exit 1
