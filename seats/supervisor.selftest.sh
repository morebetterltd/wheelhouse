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
cp "$HERE/supervisor.sh" "$HERE/daemons.sh" "$PROJ/seats/"; chmod +x "$PROJ/seats/supervisor.sh" "$PROJ/seats/daemons.sh"
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
