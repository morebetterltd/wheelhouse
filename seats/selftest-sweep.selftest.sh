#!/usr/bin/env bash
# selftest-sweep.selftest.sh — fixture proof for the host-wide sweep lock.

SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"

set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
SWEEP="${1:-$HERE/selftest-sweep.sh}"
[ -x "$SWEEP" ] || { echo "selftest: not executable: $SWEEP" >&2; exit 2; }
export WHEELHOUSE_SELFTEST_SWEEP_LOCK_HELPER="${WHEELHOUSE_SELFTEST_SWEEP_LOCK_HELPER:-$HERE/selftest-sweep-lock.ts}"
make_lock(){
  bun -e '
import fs from "node:fs"; import os from "node:os"; import p from "node:path";
const [dir,pidText]=process.argv.slice(1),pid=Number(pidText),started=new Date().toISOString().replace(/\.\d{3}Z$/,"Z");
fs.mkdirSync(dir); fs.writeFileSync(p.join(dir,"pid"),pid+"\n"); fs.writeFileSync(p.join(dir,"started"),started+"\n");
fs.writeFileSync(p.join(dir,"wheelhouse-selftest-sweep"),JSON.stringify({kind:"wheelhouse-selftest-sweep",version:1,pid,hostname:os.hostname(),started,token:crypto.randomUUID().replace(/-/g,"")})+"\n");
' "$1" "$2"
}

FAILED=0
FIX=""
pass(){ printf 'ok - %s\n' "$*"; }
fail(){ printf 'not ok - %s\n' "$*"; FAILED=$((FAILED + 1)); }
cleanup(){
  [ -n "$FIX" ] && selftest_cleanup_fixture_processes "$FIX" >/dev/null 2>&1 || true
  [ -n "$FIX" ] && selftest_remove_fixture_dir "$FIX"
  return 0
}
trap cleanup EXIT INT TERM

FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-selftest-sweep-selftest.$$.XXXXXX")" || exit 2
FIX="$(cd "$FIX" && pwd -P)"
SUITES="$FIX/suites"
LOCK="$FIX/host.lock"
EVENTS="$FIX/events.log"
mkdir -p "$SUITES"
cat > "$SUITES/fixture.selftest.sh" <<'EOF'
#!/usr/bin/env bash
set -eu
: "${SWEEP_ID:?}"
: "${SWEEP_EVENTS:?}"
printf '%s start\n' "$SWEEP_ID" >> "$SWEEP_EVENTS"
if [ -n "${SWEEP_RELEASE:-}" ]; then
  while [ ! -f "$SWEEP_RELEASE" ]; do sleep 0.05; done
fi
printf '%s end\n' "$SWEEP_ID" >> "$SWEEP_EVENTS"
EOF
chmod +x "$SUITES/fixture.selftest.sh"

# Exercise the default (override unset), but relocate only its constant /tmp
# prefix into this fixture. Otherwise a full sweep would wait on its own lock.
default_tmpdir_leg(){
  local runner="$FIX/default-runner.sh" host="$FIX/default-host"
  local tmp_a="$FIX/tmp-A" tmp_b="$FIX/tmp-B" events="$FIX/default-events.log"
  local release="$FIX/default-release" pid_a pid_b rc_a rc_b order
  mkdir -p "$host" "$tmp_a" "$tmp_b"
  sed "/^LOCK=/s|/tmp|$host|g" "$SWEEP" > "$runner"
  env -u WHEELHOUSE_SELFTEST_SWEEP_LOCK TMPDIR="$tmp_a" SWEEP_RELEASE="$release" SWEEP_ID=TA SWEEP_EVENTS="$events" WHEELHOUSE_SELFTEST_SWEEP_PATTERN="$SUITES/*.selftest.sh" WHEELHOUSE_SELFTEST_SWEEP_WAIT_SECONDS=0.05 bash "$runner" > "$FIX/TA.out" 2> "$FIX/TA.err" &
  pid_a=$!
  for _ in $(seq 1 100); do grep -q '^TA start$' "$events" 2>/dev/null && break; sleep 0.05; done
  if ! grep -q '^TA start$' "$events" 2>/dev/null; then
    : > "$release"; wait "$pid_a" || true
    fail "default TMPDIR fixture first sweep never started"; return
  fi
  env -u WHEELHOUSE_SELFTEST_SWEEP_LOCK TMPDIR="$tmp_b" SWEEP_RELEASE="$release" SWEEP_ID=TB SWEEP_EVENTS="$events" WHEELHOUSE_SELFTEST_SWEEP_PATTERN="$SUITES/*.selftest.sh" WHEELHOUSE_SELFTEST_SWEEP_WAIT_SECONDS=0.05 bash "$runner" > "$FIX/TB.out" 2> "$FIX/TB.err" &
  pid_b=$!
  for _ in $(seq 1 100); do
    grep -q 'waiting for host-wide lock' "$FIX/TB.err" && break
    grep -q '^TB start$' "$events" 2>/dev/null && break
    sleep 0.05
  done
  if grep -qF "waiting for host-wide lock $host/wheelhouse-selftest-sweep.lock" "$FIX/TB.err" && ! grep -q '^TB start$' "$events" 2>/dev/null; then
    pass "different TMPDIRs share the default lock: second sweep waits on first"
  else
    fail "different TMPDIRs did not wait on default lock (err=$(cat "$FIX/TB.err") events=$(cat "$events"))"
  fi
  : > "$release"
  wait "$pid_a"; rc_a=$?
  wait "$pid_b"; rc_b=$?
  order="$(tr '\n' '|' < "$events")"
  if [ "$rc_a" -eq 0 ] && [ "$rc_b" -eq 0 ] && [ "$order" = 'TA start|TA end|TB start|TB end|' ]; then
    pass "different TMPDIR default sweeps complete serially after release"
  else
    fail "different TMPDIR default sweep order wrong (rcA=$rc_a rcB=$rc_b order=$order)"
  fi
}
default_tmpdir_leg
if [ "${WHEELHOUSE_SELFTEST_SWEEP_TMPDIR_ONLY:-0}" = 1 ]; then
  [ "$FAILED" -eq 0 ] || { echo "selftest-sweep.selftest: FAIL ($FAILED failure(s))"; exit 1; }
  echo 'selftest-sweep.selftest: PASS (2 TMPDIR checks)'
  exit 0
fi

# Every invalid-lock case must leave the whole record (including inode) intact.
lock_snapshot(){
  bun -e '
import fs from "node:fs"; import p from "node:path"; import {createHash} from "node:crypto";
const rows:any[]=[];
function visit(file:string){const s=fs.lstatSync(file,{bigint:true}),row:any[]=[file,String(s.dev),String(s.ino),String(s.mode)];
if(s.isSymbolicLink())row.push(fs.readlinkSync(file));else if(s.isFile())row.push(createHash("sha256").update(fs.readFileSync(file)).digest("hex"));
rows.push(row);if(s.isDirectory())for(const child of fs.readdirSync(file).sort())visit(p.join(file,child));}
visit(process.argv[1]);console.log(JSON.stringify(rows));
' "$1"
}
ownership_tests(){
  local EVENTS="$FIX/ownership-events.log"
  local case path before after rc
  for case in plain extra nested bad-marker mismatch bad-time other-host link legacy-bad legacy-duplicate; do
    path="$FIX/invalid-$case.lock"
    case "$case" in
      plain) mkdir "$path"; printf 'KEEP\n' > "$path/KEEP" ;;
      legacy-bad) printf 'pid=not-a-pid\n' > "$path" ;;
      legacy-duplicate) printf 'pid=999999999\npid=999999998\n' > "$path" ;;
      *) make_lock "$path" 999999999 ;;
    esac
    case "$case" in
      extra) printf 'KEEP\n' > "$path/KEEP" ;;
      nested) mkdir "$path/extra"; printf 'KEEP\n' > "$path/extra/KEEP" ;;
      bad-marker) printf '{broken\n' > "$path/wheelhouse-selftest-sweep" ;;
      mismatch) printf '999999998\n' > "$path/pid" ;;
      bad-time) printf 'not-a-time\n' > "$path/started" ;;
      other-host) bun -e 'import fs from "node:fs";const p=process.argv[1],m=JSON.parse(fs.readFileSync(p,"utf8"));m.hostname="not-this-host";fs.writeFileSync(p,JSON.stringify(m)+"\n")' "$path/wheelhouse-selftest-sweep"
        ;;
      link) mv -f "$path" "$path.target"; ln -s "$path.target" "$path" ;;
    esac
    before="$(lock_snapshot "$path")"
    SWEEP_ID="invalid-$case" SWEEP_EVENTS="$EVENTS" WHEELHOUSE_SELFTEST_SWEEP_PATTERN="$SUITES/*.selftest.sh" WHEELHOUSE_SELFTEST_SWEEP_LOCK="$path" WHEELHOUSE_SELFTEST_SWEEP_WAIT_SECONDS=0.05 bash "$SWEEP" > "$FIX/invalid-$case.out" 2> "$FIX/invalid-$case.err"
    rc=$?
    after="$(lock_snapshot "$path" 2>/dev/null || true)"
    if [ "$rc" = 2 ] && [ "$before" = "$after" ] && grep -q 'STOP: .* is not a selftest-sweep lock (' "$FIX/invalid-$case.err" && ! grep -q 'selftest-sweep: START ' "$FIX/invalid-$case.out"; then
      pass "invalid $case lock STOPs2 without moving/removing any record"
    else
      fail "invalid $case lock mutated/ran (rc=$rc intact=$([ "$before" = "$after" ] && echo yes || echo NO))"
    fi
  done
  # Shape from the real 6cb9dc9 atomic-file capture; normalize pid/root/pattern.
  path="$FIX/legacy-valid.lock"
  printf 'pid=999999999\nstarted=2026-10-14T21:32:07Z\nroot=/fixture\npattern=/fixture/*.selftest.sh\n' > "$path"
  SWEEP_ID=legacy SWEEP_EVENTS="$EVENTS" WHEELHOUSE_SELFTEST_SWEEP_PATTERN="$SUITES/*.selftest.sh" WHEELHOUSE_SELFTEST_SWEEP_LOCK="$path" bash "$SWEEP" > "$FIX/legacy.out" 2> "$FIX/legacy.err"
  rc=$?
  [ "$rc" = 0 ] && [ ! -e "$path" ] && grep -q '^legacy start$' "$EVENTS" && pass 'valid dead-pid legacy file is compatible and released' || fail "legacy compatibility failed rc=$rc"

  # A suite replaces the lock with a new file bearing the SAME runner pid.
  # PID equality alone must not authorize release of that replacement.
  local replacement_suite="$FIX/replacement.selftest.sh"
  cat > "$replacement_suite" <<'EOF'
mv -f "$REPLACEMENT_LOCK" "$REPLACEMENT_LOCK.saved"
printf 'pid=%s\n' "$PPID" > "$REPLACEMENT_LOCK"
EOF
  path="$FIX/replacement.lock"
  REPLACEMENT_LOCK="$path" WHEELHOUSE_SELFTEST_SWEEP_PATTERN="$replacement_suite" WHEELHOUSE_SELFTEST_SWEEP_LOCK="$path" bash "$SWEEP" > "$FIX/replacement.out" 2> "$FIX/replacement.err"
  rc=$?
  [ "$rc" = 0 ] && [ -f "$path" ] && [ -e "$path.saved" ] && pass 'release preserves replacement with same pid but different identity' || fail "release removed same-pid replacement (rc=$rc present=$([ -f "$path" ] && echo yes || echo GONE))"

  # Termination before acquisition must not delete a file we did not publish.
  path="$FIX/not-acquired.lock"
  local pid_wait rc_wait
  env TEST_LOCK="$path" TEST_SWEEP="$SWEEP" WHEELHOUSE_SELFTEST_SWEEP_LOCK="$path" WHEELHOUSE_SELFTEST_SWEEP_PATTERN="$SUITES/*.selftest.sh" WHEELHOUSE_SELFTEST_SWEEP_WAIT_SECONDS=0.05 bash -c 'printf "pid=%s\n" "$$" > "$TEST_LOCK"; exec bash "$TEST_SWEEP"' > "$FIX/not-acquired.out" 2> "$FIX/not-acquired.err" &
  pid_wait=$!
  for _ in $(seq 1 100); do grep -q 'waiting for host-wide lock' "$FIX/not-acquired.err" && break; sleep 0.05; done
  before="$(lock_snapshot "$path")"
  kill -TERM "$pid_wait" 2>/dev/null || true
  wait "$pid_wait"; rc_wait=$?
  after="$(lock_snapshot "$path" 2>/dev/null || true)"
  [ "$rc_wait" = 143 ] && [ "$before" = "$after" ] && pass 'TERM before acquisition preserves unowned same-pid legacy file' || fail "TERM removed never-acquired file (rc=$rc_wait intact=$([ "$before" = "$after" ] && echo yes || echo NO))"
}
ownership_tests
if [ "${WHEELHOUSE_SELFTEST_SWEEP_OWNERSHIP_ONLY:-0}" = 1 ]; then
  [ "$FAILED" = 0 ] && { echo 'selftest-sweep.selftest: PASS (13 ownership checks)'; exit 0; }
  echo "selftest-sweep.selftest: FAIL ($FAILED failure(s))"; exit 1
fi

RELEASE_A="$FIX/release-A"
SWEEP_RELEASE="$RELEASE_A" SWEEP_ID=A SWEEP_EVENTS="$EVENTS" WHEELHOUSE_SELFTEST_SWEEP_PATTERN="$SUITES/*.selftest.sh" WHEELHOUSE_SELFTEST_SWEEP_LOCK="$LOCK" WHEELHOUSE_SELFTEST_SWEEP_WAIT_SECONDS=0.05 bash "$SWEEP" > "$FIX/A.out" 2> "$FIX/A.err" &
PID_A=$!
for _ in $(seq 1 100); do grep -q '^A start$' "$EVENTS" 2>/dev/null && break; sleep 0.05; done
if bun -e '
import fs from "node:fs";import p from "node:path";import os from "node:os";import assert from "node:assert/strict";
const [dir,pid]=process.argv.slice(1);assert(fs.lstatSync(dir).isDirectory());
assert.deepEqual(fs.readdirSync(dir).sort(),["pid","started","wheelhouse-selftest-sweep"]);
const m=JSON.parse(fs.readFileSync(p.join(dir,"wheelhouse-selftest-sweep"),"utf8"));assert.equal(m.pid,Number(pid));assert.equal(m.hostname,os.hostname());
assert.equal(fs.readFileSync(p.join(dir,"pid"),"utf8"),m.pid+"\n");assert.equal(fs.readFileSync(p.join(dir,"started"),"utf8"),m.started+"\n");
' "$LOCK" "$PID_A"
then
  pass "atomic acquire publishes a complete marked pid-bearing directory before waiters can see it"
else
  fail "active lock was not a complete marked directory"
fi
SWEEP_RELEASE="$RELEASE_A" SWEEP_ID=B SWEEP_EVENTS="$EVENTS" WHEELHOUSE_SELFTEST_SWEEP_PATTERN="$SUITES/*.selftest.sh" WHEELHOUSE_SELFTEST_SWEEP_LOCK="$LOCK" WHEELHOUSE_SELFTEST_SWEEP_WAIT_SECONDS=0.05 bash "$SWEEP" > "$FIX/B.out" 2> "$FIX/B.err" &
PID_B=$!
sleep 0.2
if grep -q 'waiting for host-wide lock' "$FIX/B.err" && ! grep -q '^B start$' "$EVENTS" 2>/dev/null; then
  pass "second fixture sweep reports the holder and waits before starting"
else
  fail "second fixture sweep did not wait (B.err=$(cat "$FIX/B.err" 2>/dev/null) events=$(cat "$EVENTS" 2>/dev/null))"
fi
: > "$RELEASE_A"
wait "$PID_A"; RC_A=$?
wait "$PID_B"; RC_B=$?
ORDER="$(tr '\n' '|' < "$EVENTS")"
if [ "$RC_A" -eq 0 ] && [ "$RC_B" -eq 0 ] && [ "$ORDER" = 'A start|A end|B start|B end|' ]; then
  pass "host-wide lock serializes concurrent fixture sweeps in order"
else
  fail "fixture sweeps did not serialize (rcA=$RC_A rcB=$RC_B order=$ORDER A=$(cat "$FIX/A.out" 2>/dev/null) B=$(cat "$FIX/B.out" 2>/dev/null))"
fi

STALE="$FIX/stale.lock"
make_lock "$STALE" 999999999
SWEEP_ID=C SWEEP_EVENTS="$EVENTS" WHEELHOUSE_SELFTEST_SWEEP_PATTERN="$SUITES/*.selftest.sh" WHEELHOUSE_SELFTEST_SWEEP_LOCK="$STALE" WHEELHOUSE_SELFTEST_SWEEP_WAIT_SECONDS=0.05 bash "$SWEEP" > "$FIX/stale.out" 2> "$FIX/stale.err"
RC_STALE=$?
if [ "$RC_STALE" -eq 0 ] && grep -q 'removing stale lock' "$FIX/stale.err"; then
  pass "dead-pid stale lock is recovered before running"
else
  fail "stale lock was not recovered (rc=$RC_STALE err=$(cat "$FIX/stale.err" 2>/dev/null))"
fi

RACE="$FIX/race.lock"
make_lock "$RACE" 999999999
RELEASE_RACE="$FIX/release-race"
SWEEP_RELEASE="$RELEASE_RACE" SWEEP_ID=D SWEEP_EVENTS="$EVENTS" WHEELHOUSE_SELFTEST_SWEEP_PATTERN="$SUITES/*.selftest.sh" WHEELHOUSE_SELFTEST_SWEEP_LOCK="$RACE" WHEELHOUSE_SELFTEST_SWEEP_WAIT_SECONDS=0.05 bash "$SWEEP" > "$FIX/race-D.out" 2> "$FIX/race-D.err" &
PID_D=$!
SWEEP_RELEASE="$RELEASE_RACE" SWEEP_ID=E SWEEP_EVENTS="$EVENTS" WHEELHOUSE_SELFTEST_SWEEP_PATTERN="$SUITES/*.selftest.sh" WHEELHOUSE_SELFTEST_SWEEP_LOCK="$RACE" WHEELHOUSE_SELFTEST_SWEEP_WAIT_SECONDS=0.05 bash "$SWEEP" > "$FIX/race-E.out" 2> "$FIX/race-E.err" &
PID_E=$!
for _ in $(seq 1 100); do grep -Eq '^[DE] start$' "$EVENTS" 2>/dev/null && break; sleep 0.05; done
sleep 0.2
REMOVE_COUNT="$(grep -h -c 'removing stale lock' "$FIX/race-D.err" "$FIX/race-E.err" 2>/dev/null | awk '{s += $1} END {print s + 0}')"
: > "$RELEASE_RACE"
wait "$PID_D"; RC_D=$?
wait "$PID_E"; RC_E=$?
if [ "$RC_D" -eq 0 ] && [ "$RC_E" -eq 0 ] && [ "$REMOVE_COUNT" -eq 1 ]; then
  pass "exactly one waiter wins stale-lock takeover"
else
  fail "stale-lock takeover was not single-winner (rcD=$RC_D rcE=$RC_E remove_count=$REMOVE_COUNT D.err=$(cat "$FIX/race-D.err" 2>/dev/null) E.err=$(cat "$FIX/race-E.err" 2>/dev/null))"
fi

ORPHANED_TAKEOVER="$FIX/orphaned-takeover.lock"
make_lock "$ORPHANED_TAKEOVER" 999999999
mkdir -p "$ORPHANED_TAKEOVER.takeover"
SWEEP_ID=F SWEEP_EVENTS="$EVENTS" WHEELHOUSE_SELFTEST_SWEEP_PATTERN="$SUITES/*.selftest.sh" WHEELHOUSE_SELFTEST_SWEEP_LOCK="$ORPHANED_TAKEOVER" WHEELHOUSE_SELFTEST_SWEEP_WAIT_SECONDS=0.05 bash "$SWEEP" > "$FIX/orphaned-takeover.out" 2> "$FIX/orphaned-takeover.err"
RC_ORPHANED=$?
if [ "$RC_ORPHANED" -eq 0 ] && grep -q 'removing stale lock' "$FIX/orphaned-takeover.err"; then
  pass "orphaned takeover guard cannot wedge stale-lock recovery"
else
  fail "orphaned takeover guard wedged recovery (rc=$RC_ORPHANED err=$(cat "$FIX/orphaned-takeover.err" 2>/dev/null))"
fi
rm -rf "$ORPHANED_TAKEOVER.takeover"

NO_PID="$FIX/no-pid.lock"
mkdir -p "$NO_PID"
printf 'KEEP\n' > "$NO_PID/KEEP"
SWEEP_ID=G SWEEP_EVENTS="$EVENTS" WHEELHOUSE_SELFTEST_SWEEP_PATTERN="$SUITES/*.selftest.sh" WHEELHOUSE_SELFTEST_SWEEP_LOCK="$NO_PID" WHEELHOUSE_SELFTEST_SWEEP_WAIT_SECONDS=0.05 bash "$SWEEP" > "$FIX/no-pid.out" 2> "$FIX/no-pid.err"
RC_NO_PID=$?
# Deliberate H7 contract change: an unmarked directory is NOT a stale lock.
if [ "$RC_NO_PID" -eq 2 ] && [ -f "$NO_PID/KEEP" ] && grep -q 'STOP: .* is not a selftest-sweep lock' "$FIX/no-pid.err" && ! grep -q '^G start$' "$EVENTS"; then
  pass "unmarked pid-less directory STOPs with exit 2 and KEEP survives"
else
  fail "unmarked directory was not refused (rc=$RC_NO_PID KEEP=$([ -f "$NO_PID/KEEP" ] && echo present || echo GONE) err=$(cat "$FIX/no-pid.err" 2>/dev/null))"
fi

EPERM="$FIX/eperm.lock"
make_lock "$EPERM" 1
SWEEP_ID=H SWEEP_EVENTS="$EVENTS" WHEELHOUSE_SELFTEST_SWEEP_PATTERN="$SUITES/*.selftest.sh" WHEELHOUSE_SELFTEST_SWEEP_LOCK="$EPERM" WHEELHOUSE_SELFTEST_SWEEP_WAIT_SECONDS=0.05 bash "$SWEEP" > "$FIX/eperm.out" 2> "$FIX/eperm.err" &
PID_G=$!
sleep 0.2
if [ -d "$EPERM" ] && grep -q 'waiting for host-wide lock' "$FIX/eperm.err" && ! grep -q 'removing stale lock' "$FIX/eperm.err"; then
  pass "EPERM holder pid is treated as live instead of stale"
else
  fail "EPERM holder pid was not treated as live (err=$(cat "$FIX/eperm.err" 2>/dev/null))"
fi
kill -TERM "$PID_G" 2>/dev/null || true
wait "$PID_G" 2>/dev/null || true
rm -rf "$EPERM"

TERM_SUITES="$FIX/term-suites"
TERM_LOCK="$FIX/term.lock"
TERM_EVENTS="$FIX/term-events.log"
TERM_STARTED="$FIX/term-started"
mkdir -p "$TERM_SUITES"
cat > "$TERM_SUITES/one.selftest.sh" <<'EOF'
#!/usr/bin/env bash
set -eu
printf 'one start\n' >> "$TERM_EVENTS"
: > "$TERM_STARTED"
( trap 'exit 0' TERM; sleep 1; printf 'child survived\n' >> "$TERM_EVENTS" ) &
while :; do sleep 0.05; done
EOF
cat > "$TERM_SUITES/two.selftest.sh" <<'EOF'
#!/usr/bin/env bash
set -eu
printf 'two start\n' >> "$TERM_EVENTS"
EOF
chmod +x "$TERM_SUITES"/*.selftest.sh
TERM_EVENTS="$TERM_EVENTS" TERM_STARTED="$TERM_STARTED" WHEELHOUSE_SELFTEST_SWEEP_PATTERN="$TERM_SUITES/*.selftest.sh" WHEELHOUSE_SELFTEST_SWEEP_LOCK="$TERM_LOCK" WHEELHOUSE_SELFTEST_SWEEP_WAIT_SECONDS=0.05 bash "$SWEEP" > "$FIX/term.out" 2> "$FIX/term.err" &
PID_TERM=$!
for _ in $(seq 1 100); do [ -f "$TERM_STARTED" ] && break; sleep 0.05; done
kill -TERM "$PID_TERM" 2>/dev/null || true
wait "$PID_TERM"; RC_TERM=$?
sleep 1.2
TERM_ORDER="$(tr '\n' '|' < "$TERM_EVENTS" 2>/dev/null || true)"
if [ "$RC_TERM" -eq 143 ] && [ "$TERM_ORDER" = 'one start|' ] && [ ! -e "$TERM_LOCK" ]; then
  pass "TERM stops the running fixture suite process group, skips later suites, and releases the lock"
else
  fail "TERM did not stop cleanly (rc=$RC_TERM order=$TERM_ORDER lock=$(ls -ld "$TERM_LOCK" 2>/dev/null || true) out=$(cat "$FIX/term.out" 2>/dev/null) err=$(cat "$FIX/term.err" 2>/dev/null))"
fi

if [ "$FAILED" -eq 0 ]; then
  echo "selftest-sweep.selftest: PASS (24 checks)"
else
  echo "selftest-sweep.selftest: FAIL ($FAILED failure(s))"
  exit 1
fi
