#!/usr/bin/env bash
set -u
SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"
HERE="$(cd "$(dirname "$0")" && pwd -P)"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-supervisor.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
. "$HERE/fixtures/readiness.sh"
. "$HERE/selftest-herald.sh"
selftest_bind_herald_owner "$FIX" || exit 2
PASS=0; FAIL=0
pass(){ PASS=$((PASS+1)); echo "ok $PASS - $*"; }
fail(){ FAIL=$((FAIL+1)); echo "not ok $((PASS+FAIL)) - $*" >&2; }
cleanup(){ [ -n "$FIX" ] && pkill -f "$FIX" 2>/dev/null || true; selftest_remove_fixture_dir "$FIX"; }
selftest_install_cleanup_traps cleanup
PROJ="$FIX/project"; mkdir -p "$PROJ/seats/logs" "$PROJ/seats/run" "$PROJ/wheelhouse"
selftest_copy_seat_runtime "$PROJ" "$HERE"; chmod +x "$PROJ/seats/supervisor.sh" "$PROJ/seats/daemons.sh"
# Never launch a real full sweep from the legacy daemon/clock fixtures.
printf 'process.exit(0);\n' > "$PROJ/seats/nightly-sweep.ts"
bun "$HERE/fixtures/supervisor-observation.ts" "$PROJ/seats/supervisor.sh" || exit 2
for d in herald desk courier; do cat > "$PROJ/seats/$d.ts" <<'TS'
import * as fs from "node:fs";
import { fixtureOwner, fixtureOwnerAlive } from "./herald-owner";
const owner = import.meta.path.endsWith("/herald.ts") ? fixtureOwner(`${import.meta.dir}/..`) : null;
if (process.env.WHEELHOUSE_DAEMON_EXIT_IMMEDIATELY === "1") { console.error("synthetic crash"); process.exit(42); }
const role = import.meta.path.split("/").pop()!.replace(/\.ts$/, "");
if (role === "herald" || role === "courier") fs.writeFileSync(`${import.meta.dir}/run/${role}.pid`, `${process.pid}\n`);
if (role === "desk") { const portFile = `${import.meta.dir}/run/desk.port`, tmp = `${portFile}.${process.pid}.tmp`; fs.writeFileSync(tmp, "http://127.0.0.1:0/needs\n"); fs.renameSync(tmp, portFile); }
setInterval(() => { if (!fixtureOwnerAlive(owner)) process.exit(0); }, 100);
TS
done
cat > "$PROJ/seats/needs.ts" <<'TS'
import * as fs from "node:fs"; import * as path from "node:path";
const root=path.resolve(import.meta.dir,".."); fs.mkdirSync(path.join(root,"seats","run"),{recursive:true});
fs.appendFileSync(path.join(root,"seats","run","needs-open.log"), JSON.stringify(process.argv.slice(2))+"\n");
TS
run_once(){ (cd "$PROJ" && WHEELHOUSE_SUPERVISOR_ROOT="$PROJ" "$PROJ/seats/supervisor.sh" --once) > "$FIX/once.out" 2>&1; }
call_count(){ [ -f "$2" ] || { echo "STOP: missing call ledger $2" >&2; return 2; }; awk -v wanted="$1" '$0==wanted{n++} END{print n+0}' "$2"; }
status(){ (cd "$PROJ" && WHEELHOUSE_SUPERVISOR_ROOT="$PROJ" "$PROJ/seats/supervisor.sh" --status) > "$FIX/status.out" 2>&1; }
# courier absent until declared
run_once
if [ ! -f "$PROJ/seats/run/courier.pid" ]; then pass "courier not declared -> never started"; else fail "courier started without principal channel"; fi
# restart dead herald
H1="$(cat "$PROJ/seats/run/herald.pid" 2>/dev/null || true)"; [ -n "$H1" ] && kill "$H1" 2>/dev/null || true; fixture_wait_exit "$H1" || exit 1; run_once; H2="$(cat "$PROJ/seats/run/herald.pid" 2>/dev/null || true)"
if [ -n "$H2" ] && [ "$H2" != "$H1" ] && kill -0 "$H2" 2>/dev/null && grep -q 'herald restarted: pid' "$PROJ/seats/logs/supervisor.out.log"; then pass "dead herald restarts within one tick"; else fail "herald restart failed old=$H1 new=$H2 log=$(cat "$PROJ/seats/logs/supervisor.out.log" 2>/dev/null)"; fi
# crash loop: mark desk, exactly one inbox + need, no fourth restart
OLD_DESK="$(cat "$PROJ/seats/run/desk.pid" 2>/dev/null || true)"; kill "$OLD_DESK" 2>/dev/null || true; fixture_wait_exit "$OLD_DESK" || exit 1; rm -f "$PROJ/seats/run/desk.pid"; export WHEELHOUSE_DAEMON_EXIT_IMMEDIATELY=1
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
before_label_count="$(grep -c 'com\.wheelhouse\.launchfixture\.supervisor' "$FIX/launchctl.before" 2>/dev/null || true)"
after_label_count="$(grep -c 'com\.wheelhouse\.launchfixture\.supervisor' "$FIX/launchctl.after" 2>/dev/null || true)"
if [ $RC -eq 0 ] && [ -f "$PLIST" ] && grep -q "launchctl bootstrap gui/$UID $PLIST" "$FIX/install-launchd.out" && grep -q "launchctl bootout gui/$UID $PLIST" "$FIX/install-launchd.out" && [ "$before_label_count" = 0 ] && [ "$after_label_count" = 0 ]; then pass "install-launchd writes fixture plist and does not load its launchd label"; else fail "install-launchd output/launchctl proof wrong rc=$RC out=$OUT before_label_count=$before_label_count after_label_count=$after_label_count"; fi
if command -v plutil >/dev/null 2>&1; then
  if plutil -lint "$PLIST" >/dev/null 2>"$FIX/plutil.err"; then pass "launchd plist passes plutil -lint"; else fail "plutil -lint failed: $(cat "$FIX/plutil.err")"; fi
else
  pass "launchd plist lint skipped: plutil absent"
fi
if bun - "$PLIST" "$PROJ" <<'JS'
const fs=(await import('node:fs')).default,assert=(await import('node:assert/strict')).default,[plist,root]=process.argv.slice(2);
// Full emitted XML shape captured from install-launchd --print before porting.
// Assert all eight original typed fields without adding a plist package or a
// mandatory platform utility. Only inter-tag formatting whitespace is ignored.
const fields={Label:'com.wheelhouse.launchfixture.supervisor',ProgramArguments:['/bin/bash',root+'/seats/supervisor.sh'],
 WorkingDirectory:root,RunAtLoad:true,KeepAlive:true,ProcessType:'Interactive',
 StandardOutPath:root+'/seats/logs/supervisor.launchd.out.log',StandardErrorPath:root+'/seats/logs/supervisor.launchd.err.log'};
const escape=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const value=v=>v===true?'<true/>':Array.isArray(v)?'<array>'+v.map(x=>'<string>'+escape(x)+'</string>').join('')+'</array>':'<string>'+escape(v)+'</string>';
const expected='<?xml version="1.0" encoding="UTF-8"?>'+
 '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'+
 '<plist version="1.0"><dict>'+Object.entries(fields).map(([k,v])=>'<key>'+k+'</key>'+value(v)).join('')+'</dict></plist>';
assert.equal(fs.readFileSync(plist,'utf8').replace(/>\s+</g,'><').trim(),expected);
JS
then pass "launchd plist names fixture root, ProgramArguments, and Interactive process type"; else fail "launchd plist fields wrong: $(cat "$PLIST" 2>/dev/null)"; fi
RC=0; OUT="$(cd "$PROJ" && WHEELHOUSE_SUPERVISOR_ROOT="$PROJ" "$PROJ/seats/supervisor.sh" print-systemd 2>&1)" || RC=$?
if [ $RC -eq 0 ] && printf '%s\n' "$OUT" | grep >/dev/null '^ExecStart=/bin/bash ' && printf '%s\n' "$OUT" | grep >/dev/null 'seats/supervisor.sh' && printf '%s\n' "$OUT" | grep >/dev/null '^Restart=always'; then pass "print-systemd prints equivalent user unit"; else fail "print-systemd wrong rc=$RC out=$OUT"; fi
before_restarts="$(grep -c 'restarted:' "$PROJ/seats/logs/supervisor.out.log" 2>/dev/null || echo 0)"
rm -f "$PROJ/seats/run/supervisor.pid"
(cd "$PROJ" && exec env WHEELHOUSE_SUPERVISOR_ROOT="$PROJ" WHEELHOUSE_SUPERVISOR_STARTED_BY_COCKPIT=1 WHEELHOUSE_SUPERVISOR_SECONDS=0.1 "$PROJ/seats/supervisor.sh") > "$FIX/supervisor-holder.out" 2>&1 &
holder_pid=$!
holder_published(){ [ "$(cat "$PROJ/seats/run/supervisor.pid" 2>/dev/null || true)" = "$holder_pid" ]; }
fixture_wait "original holder PID publication" "$holder_pid" holder_published || exit 1
(cd "$PROJ" && exec env WHEELHOUSE_SUPERVISOR_ROOT="$PROJ" WHEELHOUSE_SUPERVISOR_SECONDS=0.1 "$PROJ/seats/supervisor.sh") > "$FIX/supervisor-contender.out" 2>&1 &
contender_pid=$!
contender_decided(){ grep -qx "$contender_pid" "$PROJ/seats/run/fixture-holder-waits" 2>/dev/null || [ "$(cat "$PROJ/seats/run/supervisor.pid" 2>/dev/null || true)" = "$contender_pid" ]; }
fixture_wait "native contender wait or ownership decision" "$contender_pid" contender_decided || exit 1
after_restarts="$(grep -c 'restarted:' "$PROJ/seats/logs/supervisor.out.log" 2>/dev/null || echo 0)"
if kill -0 "$holder_pid" 2>/dev/null && kill -0 "$contender_pid" 2>/dev/null && [ "$(cat "$PROJ/seats/run/supervisor.pid" 2>/dev/null || true)" = "$holder_pid" ] && [ "$before_restarts" = "$after_restarts" ]; then pass "launchd-style supervisor waits on live cockpit holder instead of exiting and churning"; else fail "contender did not wait holder=$holder_pid contender=$contender_pid pidfile=$(cat "$PROJ/seats/run/supervisor.pid" 2>/dev/null) holder_alive=$(kill -0 "$holder_pid" 2>/dev/null; echo $?) contender_alive=$(kill -0 "$contender_pid" 2>/dev/null; echo $?) before=$before_restarts after=$after_restarts out=$(cat "$FIX/supervisor-contender.out" 2>/dev/null)"; fi
kill "$holder_pid" 2>/dev/null || true
wait "$holder_pid" 2>/dev/null || true
contender_published(){ [ "$(cat "$PROJ/seats/run/supervisor.pid" 2>/dev/null || true)" = "$contender_pid" ]; }
fixture_wait "contender ownership after original holder exit" "$contender_pid" contender_published || exit 1
if grep -qx "$contender_pid $holder_pid 0" "$PROJ/seats/run/fixture-holder-claims"; then pass "contender claims ownership only after observing the original holder gone"; else fail "contender claimed while original holder was alive"; fi
kill "$contender_pid" 2>/dev/null || true
wait "$contender_pid" 2>/dev/null || true

echo $$ > "$PROJ/seats/run/supervisor.pid"
(cd "$PROJ" && exec env WHEELHOUSE_SUPERVISOR_ROOT="$PROJ" WHEELHOUSE_SUPERVISOR_SECONDS=0.1 "$PROJ/seats/supervisor.sh") > "$FIX/supervisor-reused-pid.out" 2>&1 &
takeover_pid=$!
takeover_published(){ [ "$(cat "$PROJ/seats/run/supervisor.pid" 2>/dev/null || true)" = "$takeover_pid" ]; }
fixture_wait "original takeover child's PID publication" "$takeover_pid" takeover_published || exit 1
takeover_live_pid="$(cat "$PROJ/seats/run/supervisor.pid" 2>/dev/null || true)"
if [ -n "$takeover_live_pid" ] && [ "$takeover_live_pid" != "$$" ] && kill -0 "$takeover_live_pid" 2>/dev/null && grep -q 'non-supervisor process' "$FIX/supervisor-reused-pid.out"; then pass "reused supervisor pid fixture is treated as stale and taken over"; else fail "reused pid did not take over takeover=$takeover_pid live=${takeover_live_pid:-none} alive=$(kill -0 "${takeover_live_pid:-$takeover_pid}" 2>/dev/null; echo $?) pidfile=$(cat "$PROJ/seats/run/supervisor.pid" 2>/dev/null) out=$(cat "$FIX/supervisor-reused-pid.out" 2>/dev/null)"; fi
if [ "${takeover_live_pid:-$takeover_pid}" != "$$" ]; then
  kill "$takeover_pid" 2>/dev/null || true
  wait "$takeover_pid" 2>/dev/null || true
fi
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
# Earlier real-time ticks populated this field. Start the injected-clock leg
# with an explicit initial state, not a January clock behind an October tick.
node - "$PROJ/seats/run/supervisor.state.json" <<'JS'
const fs=require('node:fs'),file=process.argv[2],state=JSON.parse(fs.readFileSync(file,'utf8'));
console.log('RECOVERY_CLOCK_INPUT '+JSON.stringify({previousLastRecoveryMs:state.lastRecoveryMs,initialInjectedClock:'2026-01-01T00:00:00.000Z',reset:'fixture-only lastRecoveryMs'}));
delete state.lastRecoveryMs; fs.writeFileSync(file,JSON.stringify(state,null,2)+'\n');
JS
for instant in 2026-01-01T00:00:00.000Z 2026-01-01T00:00:00.199Z 2026-01-01T00:00:00.200Z; do
  (cd "$PROJ" && WHEELHOUSE_SUPERVISOR_ROOT="$PROJ" WHEELHOUSE_SUPERVISOR_NOW="$instant" WHEELHOUSE_SEAT_RECOVERY_SECONDS=0.2 "$PROJ/seats/supervisor.sh" --once) >/dev/null 2>&1
done
if [ "$(call_count 'resume worker-dead' "$PROJ/seats/run/adapter-calls.log")" = 2 ] && ! grep -q 'worker-stopped' "$PROJ/seats/run/adapter-calls.log" && grep -q 'seat worker-dead resumed after dead pid 999999' "$PROJ/seats/logs/cockpit-recovery.log"; then pass "supervisor recovery resumes dead seats and ignores gracefully stopped seats"; else fail "recovery did not call only resume worker-dead calls=$(cat "$PROJ/seats/run/adapter-calls.log" 2>/dev/null) log=$(cat "$PROJ/seats/logs/cockpit-recovery.log" 2>/dev/null)"; fi

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
: > "$PROJ/seats/run/prune-calls.log"; rm -f "$PROJ/seats/run/supervisor.state.json"
(cd "$PROJ" && WHEELHOUSE_SUPERVISOR_ROOT="$PROJ" WHEELHOUSE_SUPERVISOR_NOW=2026-01-01T02:59:00 "$PROJ/seats/supervisor.sh" --once) >/dev/null 2>&1
c1="$(call_count cleanup "$PROJ/seats/run/prune-calls.log")"
(cd "$PROJ" && WHEELHOUSE_SUPERVISOR_ROOT="$PROJ" WHEELHOUSE_SUPERVISOR_NOW=2026-01-01T03:00:00 "$PROJ/seats/supervisor.sh" --once) >/dev/null 2>&1
c2="$(call_count cleanup "$PROJ/seats/run/prune-calls.log")"
(cd "$PROJ" && WHEELHOUSE_SUPERVISOR_ROOT="$PROJ" WHEELHOUSE_SUPERVISOR_NOW=2026-01-01T03:30:00 "$PROJ/seats/supervisor.sh" --once) >/dev/null 2>&1
c3="$(call_count cleanup "$PROJ/seats/run/prune-calls.log")"
(cd "$PROJ" && WHEELHOUSE_SUPERVISOR_ROOT="$PROJ" WHEELHOUSE_SUPERVISOR_NOW=2026-01-02T03:00:00 "$PROJ/seats/supervisor.sh" --once) >/dev/null 2>&1
c4="$(call_count cleanup "$PROJ/seats/run/prune-calls.log")"
if [ "$c1" = 0 ] && [ "$c2" = 1 ] && [ "$c3" = 1 ] && [ "$c4" = 2 ]; then pass "nightly cleanup runs once per local day at configured hour"; else fail "cleanup cadence wrong c1=$c1 c2=$c2 c3=$c3 c4=$c4 state=$(cat "$PROJ/seats/run/supervisor.state.json" 2>/dev/null)"; fi
printf 'cleanup=off\n' > "$PROJ/wheelhouse/.template-source"
(cd "$PROJ" && WHEELHOUSE_SUPERVISOR_ROOT="$PROJ" WHEELHOUSE_SUPERVISOR_NOW=2026-01-03T03:00:00 "$PROJ/seats/supervisor.sh" --once) >/dev/null 2>&1
c5="$(call_count cleanup "$PROJ/seats/run/prune-calls.log")"
if [ "$c5" = 2 ]; then pass "cleanup=off disables nightly cleanup"; else fail "cleanup=off still ran cleanup count=$c5"; fi
CLEAN_CAN="$FIX/cleanup-canary"; mkdir -p "$CLEAN_CAN/seats"; cp "$PROJ/seats/supervisor.sh" "$CLEAN_CAN/seats/supervisor.sh"; perl -0pi -e 's/supervisor_state_set lastCleanupDay "\$day"/true/' "$CLEAN_CAN/seats/supervisor.sh"
printf 'cleanup=on\n' > "$PROJ/wheelhouse/.template-source"; : > "$PROJ/seats/run/prune-calls.log"; rm -f "$PROJ/seats/run/supervisor.state.json"
(cd "$PROJ" && WHEELHOUSE_SUPERVISOR_ROOT="$PROJ" WHEELHOUSE_SUPERVISOR_NOW=2026-01-04T03:00:00 "$CLEAN_CAN/seats/supervisor.sh" --once) >/dev/null 2>&1
(cd "$PROJ" && WHEELHOUSE_SUPERVISOR_ROOT="$PROJ" WHEELHOUSE_SUPERVISOR_NOW=2026-01-04T03:30:00 "$CLEAN_CAN/seats/supervisor.sh" --once) >/dev/null 2>&1
cc="$(call_count cleanup "$PROJ/seats/run/prune-calls.log")"
if [ "$cc" -ge 2 ]; then pass "canary: removing lastCleanupDay makes same-day cleanup run twice"; else fail "cleanup canary did not prove daily guard coverage count=$cc"; fi

cat > "$PROJ/seats/digest.ts" <<'TS'
#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";
const root = path.resolve(import.meta.dir, "..");
fs.mkdirSync(path.join(root, "seats", "run"), { recursive: true });
fs.appendFileSync(path.join(root, "seats", "run", "digest-calls.log"), process.argv.slice(2).join(" ") + "\n");
TS
chmod +x "$PROJ/seats/digest.ts"
printf 'digest=on\n' > "$PROJ/wheelhouse/.template-source"
: > "$PROJ/seats/run/digest-calls.log"; rm -f "$PROJ/seats/run/supervisor.state.json"
(cd "$PROJ" && WHEELHOUSE_SUPERVISOR_ROOT="$PROJ" WHEELHOUSE_SUPERVISOR_NOW=2026-01-01T05:59:00 WHEELHOUSE_DIGEST_HOUR=6 "$PROJ/seats/supervisor.sh" --once) >/dev/null 2>&1
d1="$(call_count --notify "$PROJ/seats/run/digest-calls.log")"
(cd "$PROJ" && WHEELHOUSE_SUPERVISOR_ROOT="$PROJ" WHEELHOUSE_SUPERVISOR_NOW=2026-01-01T06:00:00 WHEELHOUSE_DIGEST_HOUR=6 "$PROJ/seats/supervisor.sh" --once) >/dev/null 2>&1
d2="$(call_count --notify "$PROJ/seats/run/digest-calls.log")"
(cd "$PROJ" && WHEELHOUSE_SUPERVISOR_ROOT="$PROJ" WHEELHOUSE_SUPERVISOR_NOW=2026-01-01T06:30:00 WHEELHOUSE_DIGEST_HOUR=6 "$PROJ/seats/supervisor.sh" --once) >/dev/null 2>&1
d3="$(call_count --notify "$PROJ/seats/run/digest-calls.log")"
if [ "$d1" = 0 ] && [ "$d2" = 1 ] && [ "$d3" = 1 ] && grep -q 'digest started for 2026-01-01' "$PROJ/seats/logs/supervisor.out.log"; then pass "daily digest starts once per local day at configured hour"; else fail "digest cadence wrong d1=$d1 d2=$d2 d3=$d3 state=$(cat "$PROJ/seats/run/supervisor.state.json" 2>/dev/null) log=$(cat "$PROJ/seats/logs/supervisor.out.log" 2>/dev/null)"; fi
printf 'digest=off\n' > "$PROJ/wheelhouse/.template-source"
(cd "$PROJ" && WHEELHOUSE_SUPERVISOR_ROOT="$PROJ" WHEELHOUSE_SUPERVISOR_NOW=2026-01-02T06:00:00 WHEELHOUSE_DIGEST_HOUR=6 "$PROJ/seats/supervisor.sh" --once) >/dev/null 2>&1
d4="$(call_count --notify "$PROJ/seats/run/digest-calls.log")"
if [ "$d4" = 1 ]; then pass "digest=off disables daily digest"; else fail "digest=off still ran digest count=$d4"; fi
# canary: if crashLoop marker is removed, the no-fourth-restart property fails.
CAN="$FIX/canary"; mkdir -p "$CAN/seats"; cp "$PROJ/seats/supervisor.sh" "$CAN/seats/supervisor.sh"; perl -0pi -e 's/j\.crashLoop=rs\.length>=3;/j.crashLoop=false;/' "$CAN/seats/supervisor.sh"
if cmp -s "$PROJ/seats/supervisor.sh" "$CAN/seats/supervisor.sh"; then fail "canary edit did not change supervisor"; else
  before="$(grep -c 'desk restarted:' "$PROJ/seats/logs/supervisor.out.log" 2>/dev/null || echo 0)"
  OLD_DESK="$(cat "$PROJ/seats/run/desk.pid" 2>/dev/null || true)"; kill "$OLD_DESK" 2>/dev/null || true; fixture_wait_exit "$OLD_DESK" || exit 1; rm -f "$PROJ/seats/run/desk.pid"
  WHEELHOUSE_DAEMON_EXIT_IMMEDIATELY=1 WHEELHOUSE_SUPERVISOR_ROOT="$PROJ" "$CAN/seats/supervisor.sh" --once >/dev/null 2>&1
  WHEELHOUSE_DAEMON_EXIT_IMMEDIATELY=1 WHEELHOUSE_SUPERVISOR_ROOT="$PROJ" "$CAN/seats/supervisor.sh" --once >/dev/null 2>&1
  WHEELHOUSE_DAEMON_EXIT_IMMEDIATELY=1 WHEELHOUSE_SUPERVISOR_ROOT="$PROJ" "$CAN/seats/supervisor.sh" --once >/dev/null 2>&1
  WHEELHOUSE_DAEMON_EXIT_IMMEDIATELY=1 WHEELHOUSE_SUPERVISOR_ROOT="$PROJ" "$CAN/seats/supervisor.sh" --once >/dev/null 2>&1
  after="$(grep -c 'desk restarted:' "$PROJ/seats/logs/supervisor.out.log" 2>/dev/null || echo 0)"
  if [ $((after-before)) -ge 4 ]; then pass "canary: removing crash-loop guard makes the no-fourth-restart leg fail"; else fail "canary did not prove crash-loop guard coverage before=$before after=$after"; fi
fi
# ISA sync uses synchronous --once exits and injected clock values. No elapsed
# sleep decides these new checks, and no real daemon or installed service runs.
ISA_PROJ="$FIX/isa-tick"
mkdir -p "$ISA_PROJ/seats/run" "$ISA_PROJ/seats/logs" "$ISA_PROJ/wheelhouse"
cp -f "$HERE/supervisor.sh" "$ISA_PROJ/seats/supervisor.sh"
cat > "$ISA_PROJ/seats/daemons.sh" <<'SH'
daemon_alive(){ return 0; }
daemon_starting(){ return 1; }
principal_channel_declared(){ return 1; }
recover_dead_seats(){ :; }
SH
cat > "$ISA_PROJ/seats/isa-signals.ts" <<'TS'
import * as fs from "node:fs";
import * as path from "node:path";
import assert from "node:assert/strict";
const root = path.resolve(import.meta.dir, "..");
assert.equal(process.env.WHEELHOUSE_ISA_SIGNALS_ROOT, root);
assert.equal(process.env.WHEELHOUSE_INTAKE_ROOT, root);
assert.deepEqual(process.argv.slice(2), ["sync"]);
fs.appendFileSync(path.join(root, "seats/run/isa-calls.log"), "sync\n");
console.log("ISA sync acknowledged");
process.exit(process.env.ISA_TEST_FAIL === "1" ? 42 : 0);
TS
: > "$ISA_PROJ/seats/run/isa-calls.log"
printf '## Claims\n- [ ] C1 fixture direction\n' > "$ISA_PROJ/wheelhouse/ISA.md"
printf 'cleanup=off\ndigest=off\nisa_signals=on\n' > "$ISA_PROJ/wheelhouse/.template-source"
isa_once(){ (cd "$ISA_PROJ" && WHEELHOUSE_SUPERVISOR_ROOT="$ISA_PROJ" WHEELHOUSE_SUPERVISOR_NOW="2026-01-01T00:00:${1}Z" WHEELHOUSE_ISA_SYNC_SECONDS="${2:-30}" bash seats/supervisor.sh --once) > "$FIX/isa-once.out" 2> "$FIX/isa-once.err"; }
isa_count(){ [ -f "$ISA_PROJ/seats/run/isa-calls.log" ] || return 2; awk 'END {print NR+0}' "$ISA_PROJ/seats/run/isa-calls.log"; }
isa_once 00; isa_once 29
if [ "$(isa_count)" = 1 ] && grep -q '^ISA sync acknowledged$' "$ISA_PROJ/seats/logs/isa-signals.out.log"; then pass "ISA sync runs once initially, logs its acknowledgement and waits until due"; else fail "ISA initial sync/interval/log wrong"; fi
isa_once 30; isa_once 30
if [ "$(isa_count)" = 2 ]; then pass "ISA sync runs at the default 30-second boundary, not twice at the same tick"; else fail "ISA default cadence wrong"; fi
isa_once 39 10; isa_once 40 10
if [ "$(isa_count)" = 3 ]; then pass "ISA sync honors WHEELHOUSE_ISA_SYNC_SECONDS"; else fail "ISA custom cadence wrong"; fi
printf 'cleanup=off\ndigest=off\nisa_signals=off\n' > "$ISA_PROJ/wheelhouse/.template-source"
isa_once 50 10
if [ "$(isa_count)" = 3 ]; then pass "isa_signals=off skips the sync"; else fail "ISA opt-out ignored"; fi
printf 'cleanup=off\ndigest=off\n' > "$ISA_PROJ/wheelhouse/.template-source"
mv -f "$ISA_PROJ/wheelhouse/ISA.md" "$ISA_PROJ/wheelhouse/ISA.saved"
isa_once 50 10
mv -f "$ISA_PROJ/wheelhouse/ISA.saved" "$ISA_PROJ/wheelhouse/ISA.md"
isa_once 50 10
if [ "$(isa_count)" = 4 ]; then pass "ISA sync skips an absent ISA, and defaults on when present"; else fail "ISA file-presence/default guard wrong"; fi
mv -f "$ISA_PROJ/seats/isa-signals.ts" "$ISA_PROJ/seats/isa-signals.saved"
cp -f "$ISA_PROJ/seats/logs/isa-signals.out.log" "$FIX/isa-log.before-missing"
isa_once 59 1
if ! cmp -s "$FIX/isa-log.before-missing" "$ISA_PROJ/seats/logs/isa-signals.out.log"; then fail "missing ISA script was invoked"; fi
mv -f "$ISA_PROJ/seats/isa-signals.saved" "$ISA_PROJ/seats/isa-signals.ts"
isa_once 59 1
if [ "$(isa_count)" = 5 ]; then pass "ISA sync skips an absent script and resumes when it exists"; else fail "ISA script-presence guard wrong"; fi
# An unsuccessful child must not mark the interval completed: retry at the same
# injected instant, not after a real wait. Both completion and failure are exits.
ISA_TEST_FAIL=1 isa_once 59.999 0.5
isa_once 59.999 0.5; isa_once 59.999 0.5
if [ "$(isa_count)" = 7 ]; then pass "failed ISA sync retries without advancing the successful interval"; else fail "ISA failure advanced interval or retry failed"; fi
if bun "$HERE/fixtures/supervisor-ordering.ts" "$FIX" "$HERE"; then pass "native holder/recovery ordering and both removal controls"; else fail "supervisor ordering observation/control failed"; fi
printf 'NATIVE_ONCE_RESULTS\n'; cat "$PROJ/seats/run/fixture-once-results.jsonl"
printf 'NATIVE_HOLDER_CLAIMS\n'; cat "$PROJ/seats/run/fixture-holder-claims"
if bun "$HERE/fixtures/supervisor-health.ts" "$FIX" "$HERE"; then
  pass "completed-work health, injected thresholds, real signals and removal controls"
else
  fail "completed-work health consumer/controls failed"
fi
# Nightly-only fixture and sensitive removals, isolated from legacy daemons.
if bun "$HERE/fixtures/nightly-supervisor.ts" "$HERE" "$FIX"; then
  pass "nightly full-tier clock, pause, busy skip and sensitive removal controls"
else fail "nightly full-tier supervisor regression"; fi
if [ "$FAIL" -eq 0 ]; then echo "supervisor.selftest: PASS ($PASS checks)"; exit 0; fi
echo "supervisor.selftest: FAIL ($FAIL failure(s), $PASS pass(es))"; exit 1
