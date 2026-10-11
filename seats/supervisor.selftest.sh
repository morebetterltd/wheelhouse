#!/usr/bin/env bash
set -u
SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"
HERE="$(cd "$(dirname "$0")" && pwd -P)"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-supervisor.XXXXXX")" || exit 2
PASS=0; FAIL=0
pass(){ PASS=$((PASS+1)); echo "ok $PASS - $*"; }
fail(){ FAIL=$((FAIL+1)); echo "not ok $((PASS+FAIL)) - $*" >&2; }
cleanup(){ [ -n "$FIX" ] && pkill -f "$FIX" 2>/dev/null || true; selftest_remove_fixture_dir "$FIX"; }
trap cleanup EXIT INT TERM
PROJ="$FIX/project"; mkdir -p "$PROJ/seats/logs" "$PROJ/seats/run" "$PROJ/wheelhouse"
selftest_copy_seat_runtime "$PROJ" "$HERE"; chmod +x "$PROJ/seats/supervisor.sh" "$PROJ/seats/daemons.sh"
for d in herald desk courier; do cat > "$PROJ/seats/$d.ts" <<'TS'
if (process.env.WHEELHOUSE_DAEMON_EXIT_IMMEDIATELY === "1") { console.error("synthetic crash"); process.exit(42); }
setInterval(() => {}, 1000);
TS
done
cat > "$PROJ/seats/needs.ts" <<'TS'
import * as fs from "node:fs"; import * as path from "node:path";
const root=path.resolve(import.meta.dir,".."); fs.mkdirSync(path.join(root,"seats","run"),{recursive:true});
fs.appendFileSync(path.join(root,"seats","run","needs-open.log"), JSON.stringify(process.argv.slice(2))+"\n");
TS
run_once(){ (cd "$PROJ" && WHEELHOUSE_SUPERVISOR_ROOT="$PROJ" WHEELHOUSE_SUPERVISOR_SECONDS=0.2 "$PROJ/seats/supervisor.sh" --once) > "$FIX/once.out" 2>&1; }
status(){ (cd "$PROJ" && WHEELHOUSE_SUPERVISOR_ROOT="$PROJ" "$PROJ/seats/supervisor.sh" --status) > "$FIX/status.out" 2>&1; }
# courier absent until declared
run_once
if [ ! -f "$PROJ/seats/run/courier.pid" ]; then pass "courier not declared -> never started"; else fail "courier started without principal channel"; fi
# restart dead herald
H1="$(cat "$PROJ/seats/run/herald.pid" 2>/dev/null || true)"; [ -n "$H1" ] && kill "$H1" 2>/dev/null || true; sleep 0.2; run_once; H2="$(cat "$PROJ/seats/run/herald.pid" 2>/dev/null || true)"
if [ -n "$H2" ] && [ "$H2" != "$H1" ] && kill -0 "$H2" 2>/dev/null && grep -q 'herald restarted: pid' "$PROJ/seats/logs/supervisor.out.log"; then pass "dead herald restarts within one tick"; else fail "herald restart failed old=$H1 new=$H2 log=$(cat "$PROJ/seats/logs/supervisor.out.log" 2>/dev/null)"; fi
# crash loop: mark desk, exactly one inbox + need, no fourth restart
kill "$(cat "$PROJ/seats/run/desk.pid" 2>/dev/null || true)" 2>/dev/null || true; rm -f "$PROJ/seats/run/desk.pid"; export WHEELHOUSE_DAEMON_EXIT_IMMEDIATELY=1
run_once; run_once; run_once; before="$(grep -c '"class":"daemon-down"' "$PROJ/seats/inbox.jsonl" 2>/dev/null || echo 0)"; restarts="$(grep -c 'desk restarted:' "$PROJ/seats/logs/supervisor.out.log" 2>/dev/null || echo 0)"; run_once; after="$(grep -c '"class":"daemon-down"' "$PROJ/seats/inbox.jsonl" 2>/dev/null || echo 0)"; needs="$(grep -c 'supervisor:desk' "$PROJ/seats/run/needs-open.log" 2>/dev/null || echo 0)"
if [ "$before" = 1 ] && [ "$after" = 1 ] && [ "$needs" = 1 ] && [ "$restarts" = 3 ]; then pass "crash loop alerts once and stops restarting"; else fail "crash-loop guard failed before=$before after=$after needs=$needs restarts=$restarts log=$(cat "$PROJ/seats/logs/supervisor.out.log" 2>/dev/null)"; fi
unset WHEELHOUSE_DAEMON_EXIT_IMMEDIATELY
(cd "$PROJ" && WHEELHOUSE_SUPERVISOR_ROOT="$PROJ" "$PROJ/seats/supervisor.sh" reset desk) > "$FIX/reset.out" 2>&1
if grep -q 'desk started: pid' "$FIX/reset.out" && grep -q '"crashLoop": false' "$PROJ/seats/run/supervisor.state.json"; then pass "reset clears crash-loop and restarts"; else fail "reset failed out=$(cat "$FIX/reset.out") state=$(cat "$PROJ/seats/run/supervisor.state.json")"; fi
status
if grep -Eq '^herald RUNNING pid [0-9]+' "$FIX/status.out" && grep -Eq '^desk RUNNING pid [0-9]+' "$FIX/status.out" && grep -q '^courier SKIPPED' "$FIX/status.out"; then pass "--status prints daemon lines"; else fail "status shape wrong: $(cat "$FIX/status.out")"; fi

printf 'namespace=launchfixture\ncleanup=on\n' > "$PROJ/wheelhouse/.template-source"
LAUNCH_HOME="$FIX/home"; mkdir -p "$LAUNCH_HOME"
if command -v launchctl >/dev/null 2>&1; then launchctl list > "$FIX/launchctl.before" 2>&1 || true; else printf 'launchctl absent\n' > "$FIX/launchctl.before"; fi
RC=0; OUT="$(cd "$PROJ" && HOME="$LAUNCH_HOME" WHEELHOUSE_SUPERVISOR_ROOT="$PROJ" "$PROJ/seats/supervisor.sh" install-launchd --home "$LAUNCH_HOME" --print 2>&1)" || RC=$?
printf '%s\n' "$OUT" > "$FIX/install-launchd.out"
PLIST="$LAUNCH_HOME/Library/LaunchAgents/com.wheelhouse.launchfixture.supervisor.plist"
if command -v launchctl >/dev/null 2>&1; then launchctl list > "$FIX/launchctl.after" 2>&1 || true; else printf 'launchctl absent\n' > "$FIX/launchctl.after"; fi
if [ $RC -eq 0 ] && [ -f "$PLIST" ] && grep -q "launchctl bootstrap gui/$UID $PLIST" "$FIX/install-launchd.out" && grep -q "launchctl bootout gui/$UID $PLIST" "$FIX/install-launchd.out" && cmp -s "$FIX/launchctl.before" "$FIX/launchctl.after"; then pass "install-launchd writes fixture plist and only prints launchctl commands"; else fail "install-launchd output/launchctl proof wrong rc=$RC out=$OUT before=$(cat "$FIX/launchctl.before") after=$(cat "$FIX/launchctl.after")"; fi
if command -v plutil >/dev/null 2>&1; then
  if plutil -lint "$PLIST" >/dev/null 2>"$FIX/plutil.err"; then pass "launchd plist passes plutil -lint"; else fail "plutil -lint failed: $(cat "$FIX/plutil.err")"; fi
else
  pass "launchd plist lint skipped: plutil absent"
fi
if python3 - "$PLIST" "$PROJ" <<'PY'
import plistlib, sys
plist, root = sys.argv[1], sys.argv[2]
with open(plist, 'rb') as f: data = plistlib.load(f)
assert data['Label'] == 'com.wheelhouse.launchfixture.supervisor'
assert data['ProgramArguments'] == ['/bin/bash', root + '/seats/supervisor.sh']
assert data['WorkingDirectory'] == root
assert data['RunAtLoad'] is True
assert data['KeepAlive'] is True
assert data['ProcessType'] == 'Interactive'
assert data['StandardOutPath'] == root + '/seats/logs/supervisor.launchd.out.log'
assert data['StandardErrorPath'] == root + '/seats/logs/supervisor.launchd.err.log'
PY
then pass "launchd plist names fixture root, ProgramArguments, and Interactive process type"; else fail "launchd plist fields wrong: $(cat "$PLIST" 2>/dev/null)"; fi
RC=0; OUT="$(cd "$PROJ" && WHEELHOUSE_SUPERVISOR_ROOT="$PROJ" "$PROJ/seats/supervisor.sh" print-systemd 2>&1)" || RC=$?
if [ $RC -eq 0 ] && printf '%s\n' "$OUT" | grep -q '^ExecStart=/bin/bash ' && printf '%s\n' "$OUT" | grep -q 'seats/supervisor.sh' && printf '%s\n' "$OUT" | grep -q '^Restart=always'; then pass "print-systemd prints equivalent user unit"; else fail "print-systemd wrong rc=$RC out=$OUT"; fi
before_restarts="$(grep -c 'restarted:' "$PROJ/seats/logs/supervisor.out.log" 2>/dev/null || echo 0)"
echo $$ > "$PROJ/seats/run/supervisor.pid"
RC=0; OUT="$(cd "$PROJ" && WHEELHOUSE_SUPERVISOR_ROOT="$PROJ" WHEELHOUSE_SUPERVISOR_SECONDS=0 "$PROJ/seats/supervisor.sh" 2>&1)" || RC=$?
after_restarts="$(grep -c 'restarted:' "$PROJ/seats/logs/supervisor.out.log" 2>/dev/null || echo 0)"
if [ $RC -eq 0 ] && printf '%s\n' "$OUT" | grep -q 'supervisor already running' && [ "$before_restarts" = "$after_restarts" ]; then pass "second supervisor exits 0 when pid file names a live process"; else fail "second supervisor did not exit cleanly rc=$RC out=$OUT before=$before_restarts after=$after_restarts"; fi
if ! grep -Eq '^[[:space:]]*launchctl[[:space:]]+(bootstrap|bootout|kickstart)' "$PROJ/seats/supervisor.sh"; then pass "supervisor never executes launchctl bootstrap/bootout/kickstart"; else fail "supervisor contains executable launchctl mutator"; fi

cat > "$PROJ/seats/adapter.ts" <<'TS'
#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";
const root = path.resolve(import.meta.dir, "..");
fs.mkdirSync(path.join(root, "seats", "run"), { recursive: true });
fs.appendFileSync(path.join(root, "seats", "run", "adapter-calls.log"), process.argv.slice(2).join(" ") + "\n");
process.exit(0);
TS
chmod +x "$PROJ/seats/adapter.ts"
printf '{"seats":{"worker-dead":{"pid":999999,"lastBead":"bead-live","cwd":"%s","log":"%s/seats/logs/worker-dead.jsonl"},"worker-stopped":{"pid":null,"stoppedAt":"2026-01-01T00:00:00.000Z","lastBead":"bead-old","cwd":"%s","log":"%s/seats/logs/worker-stopped.jsonl"}}}\n' "$PROJ" "$PROJ" "$PROJ" "$PROJ" > "$PROJ/seats/state.json"
: > "$PROJ/seats/run/adapter-calls.log"
(cd "$PROJ" && WHEELHOUSE_SUPERVISOR_ROOT="$PROJ" WHEELHOUSE_SEAT_RECOVERY_SECONDS=0.2 "$PROJ/seats/supervisor.sh" --once) >/dev/null 2>&1
sleep 0.25
(cd "$PROJ" && WHEELHOUSE_SUPERVISOR_ROOT="$PROJ" WHEELHOUSE_SEAT_RECOVERY_SECONDS=0.2 "$PROJ/seats/supervisor.sh" --once) >/dev/null 2>&1
if grep -q '^resume worker-dead$' "$PROJ/seats/run/adapter-calls.log" && ! grep -q 'worker-stopped' "$PROJ/seats/run/adapter-calls.log" && grep -q 'seat worker-dead resumed after dead pid 999999' "$PROJ/seats/logs/cockpit-recovery.log"; then pass "supervisor recovery resumes dead seats and ignores gracefully stopped seats"; else fail "recovery did not call only resume worker-dead calls=$(cat "$PROJ/seats/run/adapter-calls.log" 2>/dev/null) log=$(cat "$PROJ/seats/logs/cockpit-recovery.log" 2>/dev/null)"; fi

cat > "$PROJ/seats/prune.ts" <<'TS'
#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";
const root = path.resolve(import.meta.dir, "..");
fs.mkdirSync(path.join(root, "seats", "run"), { recursive: true });
fs.appendFileSync(path.join(root, "seats", "run", "prune-calls.log"), process.argv.slice(2).join(" ") + "\n");
TS
chmod +x "$PROJ/seats/prune.ts"
printf 'cleanup=on\n' > "$PROJ/wheelhouse/.template-source"
rm -f "$PROJ/seats/run/prune-calls.log" "$PROJ/seats/run/supervisor.state.json"
(cd "$PROJ" && WHEELHOUSE_SUPERVISOR_ROOT="$PROJ" WHEELHOUSE_SUPERVISOR_NOW=2026-01-01T02:59:00 "$PROJ/seats/supervisor.sh" --once) >/dev/null 2>&1
c1="$(grep -c '^cleanup$' "$PROJ/seats/run/prune-calls.log" 2>/dev/null || echo 0)"
(cd "$PROJ" && WHEELHOUSE_SUPERVISOR_ROOT="$PROJ" WHEELHOUSE_SUPERVISOR_NOW=2026-01-01T03:00:00 "$PROJ/seats/supervisor.sh" --once) >/dev/null 2>&1
for _ in $(seq 1 20); do [ -s "$PROJ/seats/run/prune-calls.log" ] && break; sleep 0.05; done
c2="$(grep -c '^cleanup$' "$PROJ/seats/run/prune-calls.log" 2>/dev/null || echo 0)"
(cd "$PROJ" && WHEELHOUSE_SUPERVISOR_ROOT="$PROJ" WHEELHOUSE_SUPERVISOR_NOW=2026-01-01T03:30:00 "$PROJ/seats/supervisor.sh" --once) >/dev/null 2>&1
sleep 0.1
c3="$(grep -c '^cleanup$' "$PROJ/seats/run/prune-calls.log" 2>/dev/null || echo 0)"
(cd "$PROJ" && WHEELHOUSE_SUPERVISOR_ROOT="$PROJ" WHEELHOUSE_SUPERVISOR_NOW=2026-01-02T03:00:00 "$PROJ/seats/supervisor.sh" --once) >/dev/null 2>&1
for _ in $(seq 1 20); do [ "$(grep -c '^cleanup$' "$PROJ/seats/run/prune-calls.log" 2>/dev/null || echo 0)" -ge 2 ] && break; sleep 0.05; done
c4="$(grep -c '^cleanup$' "$PROJ/seats/run/prune-calls.log" 2>/dev/null || echo 0)"
if [ "$c1" = 0 ] && [ "$c2" = 1 ] && [ "$c3" = 1 ] && [ "$c4" = 2 ]; then pass "nightly cleanup runs once per local day at configured hour"; else fail "cleanup cadence wrong c1=$c1 c2=$c2 c3=$c3 c4=$c4 state=$(cat "$PROJ/seats/run/supervisor.state.json" 2>/dev/null)"; fi
printf 'cleanup=off\n' > "$PROJ/wheelhouse/.template-source"
(cd "$PROJ" && WHEELHOUSE_SUPERVISOR_ROOT="$PROJ" WHEELHOUSE_SUPERVISOR_NOW=2026-01-03T03:00:00 "$PROJ/seats/supervisor.sh" --once) >/dev/null 2>&1
sleep 0.1
c5="$(grep -c '^cleanup$' "$PROJ/seats/run/prune-calls.log" 2>/dev/null || echo 0)"
if [ "$c5" = 2 ]; then pass "cleanup=off disables nightly cleanup"; else fail "cleanup=off still ran cleanup count=$c5"; fi
CLEAN_CAN="$FIX/cleanup-canary"; mkdir -p "$CLEAN_CAN/seats"; cp "$PROJ/seats/supervisor.sh" "$CLEAN_CAN/seats/supervisor.sh"; perl -0pi -e 's/supervisor_state_set lastCleanupDay "\$day"/true/' "$CLEAN_CAN/seats/supervisor.sh"
printf 'cleanup=on\n' > "$PROJ/wheelhouse/.template-source"; rm -f "$PROJ/seats/run/prune-calls.log" "$PROJ/seats/run/supervisor.state.json"
(cd "$PROJ" && WHEELHOUSE_SUPERVISOR_ROOT="$PROJ" WHEELHOUSE_SUPERVISOR_NOW=2026-01-04T03:00:00 "$CLEAN_CAN/seats/supervisor.sh" --once) >/dev/null 2>&1
(cd "$PROJ" && WHEELHOUSE_SUPERVISOR_ROOT="$PROJ" WHEELHOUSE_SUPERVISOR_NOW=2026-01-04T03:30:00 "$CLEAN_CAN/seats/supervisor.sh" --once) >/dev/null 2>&1
for _ in $(seq 1 20); do [ "$(grep -c '^cleanup$' "$PROJ/seats/run/prune-calls.log" 2>/dev/null || echo 0)" -ge 2 ] && break; sleep 0.05; done
cc="$(grep -c '^cleanup$' "$PROJ/seats/run/prune-calls.log" 2>/dev/null || echo 0)"
if [ "$cc" -ge 2 ]; then pass "canary: removing lastCleanupDay makes same-day cleanup run twice"; else fail "cleanup canary did not prove daily guard coverage count=$cc"; fi
# canary: if crashLoop marker is removed, the no-fourth-restart property fails.
CAN="$FIX/canary"; mkdir -p "$CAN/seats"; cp "$PROJ/seats/supervisor.sh" "$CAN/seats/supervisor.sh"; perl -0pi -e 's/j\.crashLoop=rs\.length>=3;/j.crashLoop=false;/' "$CAN/seats/supervisor.sh"
if cmp -s "$PROJ/seats/supervisor.sh" "$CAN/seats/supervisor.sh"; then fail "canary edit did not change supervisor"; else
  before="$(grep -c 'desk restarted:' "$PROJ/seats/logs/supervisor.out.log" 2>/dev/null || echo 0)"
  kill "$(cat "$PROJ/seats/run/desk.pid" 2>/dev/null || true)" 2>/dev/null || true; rm -f "$PROJ/seats/run/desk.pid"
  WHEELHOUSE_DAEMON_EXIT_IMMEDIATELY=1 WHEELHOUSE_SUPERVISOR_ROOT="$PROJ" "$CAN/seats/supervisor.sh" --once >/dev/null 2>&1
  WHEELHOUSE_DAEMON_EXIT_IMMEDIATELY=1 WHEELHOUSE_SUPERVISOR_ROOT="$PROJ" "$CAN/seats/supervisor.sh" --once >/dev/null 2>&1
  WHEELHOUSE_DAEMON_EXIT_IMMEDIATELY=1 WHEELHOUSE_SUPERVISOR_ROOT="$PROJ" "$CAN/seats/supervisor.sh" --once >/dev/null 2>&1
  WHEELHOUSE_DAEMON_EXIT_IMMEDIATELY=1 WHEELHOUSE_SUPERVISOR_ROOT="$PROJ" "$CAN/seats/supervisor.sh" --once >/dev/null 2>&1
  after="$(grep -c 'desk restarted:' "$PROJ/seats/logs/supervisor.out.log" 2>/dev/null || echo 0)"
  if [ $((after-before)) -ge 4 ]; then pass "canary: removing crash-loop guard makes the no-fourth-restart leg fail"; else fail "canary did not prove crash-loop guard coverage before=$before after=$after"; fi
fi
if [ "$FAIL" -eq 0 ]; then echo "supervisor.selftest: PASS ($PASS checks)"; exit 0; fi
echo "supervisor.selftest: FAIL ($FAIL failure(s), $PASS pass(es))"; exit 1
