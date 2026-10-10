#!/usr/bin/env bash
set -uo pipefail
SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"
HERE="$(cd "$(dirname "$0")" && pwd -P)"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-alerts.XXXXXX")" || exit 2
cleanup(){ selftest_cleanup_fixture_processes "${FIX:-}" "${TMUX_SOCK:-}"; selftest_remove_fixture_dir "$FIX"; }
trap cleanup EXIT INT TERM
FAILED=0
pass(){ printf '  ok    %s\n' "$*"; }
fail(){ printf '  FAIL  %s\n' "$*"; FAILED=$((FAILED+1)); }
phase(){ printf '\n%s\n' "$*"; }
ROOT="$FIX/project"; BIN="$FIX/bin"; HOME_FIX="$FIX/home"; mkdir -p "$ROOT/seats/run" "$ROOT/seats/logs" "$ROOT/wheelhouse" "$BIN" "$HOME_FIX"
selftest_copy_seat_runtime "$ROOT" "$HERE"
chmod +x "$ROOT/seats/template-drift.sh"
cat > "$ROOT/seats/seats.json" <<'JSON'
{"seats":{"worker-a":{"role":"worker","runtime":"pi","account":{"dir":"~/.pi-seats-alerts/worker-a"}},"commander":{"role":"commander","external":true}}}
JSON
cat > "$ROOT/wheelhouse/.template-source" <<'EOF'
namespace=fixture
alert-inbox-lag-minutes=10
alert-human-after-minutes=15
alert-low-disk-gb=0
github-issue-repos=fixture/repo
EOF
cat > "$ROOT/seats/template-drift.sh" <<'SH'
#!/usr/bin/env bash
if [ "${DRIFT_ON:-0}" = 1 ]; then printf '{"error":null,"modified":["README.md"],"localOnly":[],"missing":[],"aheadBy":0,"comparedAgainst":"fixture"}\n'; else printf '{"error":null,"modified":[],"localOnly":[],"missing":[],"aheadBy":0,"comparedAgainst":"fixture"}\n'; fi
SH
chmod +x "$ROOT/seats/template-drift.sh"
printf '{"seats":{}}\n' > "$ROOT/seats/state.json"
cat > "$BIN/bd" <<'SH'
#!/usr/bin/env bash
case "$1 $2" in
  "ready --json") [ "${BD_READY:-0}" = 1 ] && printf '[{"id":"ready-1","title":"Synthetic ready"}]\n' || printf '[]\n' ;;
  "list --json") printf '[]\n' ;;
  "list --status") printf '[]\n' ;;
  *) printf '[]\n' ;;
esac
SH
chmod +x "$BIN/bd"
cat > "$BIN/gh" <<'SH'
#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo 'gh fixture'; exit 0; fi
case "${GH_UNTRIAGED:-0}" in
  1) printf '[{"url":"https://github.com/fixture/repo/issues/7","labels":[],"author":{"login":"alice"}}]\n' ;;
  2) printf '[{"url":"https://github.com/fixture/repo/issues/8","labels":[],"author":{"login":"alice"}}]\n' ;;
  *) printf '[]\n' ;;
esac
SH
chmod +x "$BIN/gh"
run_alert(){ OUT="$(cd "$ROOT" && env HOME="$HOME_FIX" PATH="$BIN:$PATH" WHEELHOUSE_ALERTS_ROOT="$ROOT" "$@" 2>&1)"; RC=$?; }
inbox_count(){ [ -f "$ROOT/seats/inbox.jsonl" ] && wc -l < "$ROOT/seats/inbox.jsonl" | tr -d ' ' || echo 0; }
need_open_count(){ [ -f "$ROOT/seats/needs.jsonl" ] && grep -c '"type":"opened"' "$ROOT/seats/needs.jsonl" || echo 0; }
need_closed_count(){ [ -f "$ROOT/seats/needs.jsonl" ] && grep -c '"type":"closed"' "$ROOT/seats/needs.jsonl" || echo 0; }
active(){ node -e 'const j=require(process.argv[1]); if(!j.alerts[process.argv[2]]?.active) process.exit(1)' "$ROOT/seats/run/fleet-snapshot.json" "$1"; }
set_low_disk(){ python3 - "$ROOT/wheelhouse/.template-source" "$1" <<'PY'
from pathlib import Path
import sys,re
p=Path(sys.argv[1]); v=sys.argv[2]; s=p.read_text(); s=re.sub(r'(?m)^alert-low-disk-gb=.*$', f'alert-low-disk-gb={v}', s); p.write_text(s)
PY
}
old_iso(){ python3 - <<'PY'
from datetime import datetime, timedelta, timezone
print((datetime.now(timezone.utc)-timedelta(minutes=20)).isoformat())
PY
}
clear_runtime(){ rm -f "$ROOT/seats/run/fleet-snapshot.json" "$ROOT/seats/inbox.jsonl" "$ROOT/seats/needs.jsonl" "$ROOT/seats/logs/alerts.log" "$ROOT/seats/inbox.cursor" "$ROOT/seats/run/herald.target.json" "$ROOT/seats/run/alerts.lock"; printf '{"seats":{}}\n' > "$ROOT/seats/state.json"; set_low_disk 0; }
quiet3(){ local before name; name="$1"; before="$(inbox_count)"; run_alert "$@"; run_alert bun seats/alerts.ts check --json; run_alert bun seats/alerts.ts check --json; [ "$(inbox_count)" = "$before" ]; }
age_alert(){ node -e 'const fs=require("fs"); const f=process.argv[1], n=process.argv[2]; const j=JSON.parse(fs.readFileSync(f,"utf8")); j.alerts[n].since="2000-01-01T00:00:00.000Z"; fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n");' "$ROOT/seats/run/fleet-snapshot.json" "$1"; }

phase 'transition table, thresholds, clears'
clear_runtime; BD_READY=1 run_alert bun seats/alerts.ts check --json
[ $RC -eq 0 ] && active idle-fleet-ready-work && active cold-seats-ready-work && [ "$(inbox_count)" = 2 ] && pass 'ready work fires idle-fleet and cold-seats once' || fail "ready/cold failed rc=$RC out=$OUT inbox=$(inbox_count)"
for i in 1 2 3; do BD_READY=1 run_alert bun seats/alerts.ts check --json; done
[ "$(inbox_count)" = 2 ] && pass 'idle-fleet/cold-seats stay quiet over 3 active runs' || fail "ready/cold not quiet inbox=$(inbox_count)"
BD_READY=0 run_alert bun seats/alerts.ts check --json
[ $RC -eq 0 ] && grep -q 'alert cleared idle-fleet-ready-work' "$ROOT/seats/logs/alerts.log" && grep -q 'alert cleared cold-seats-ready-work' "$ROOT/seats/logs/alerts.log" && pass 'idle-fleet/cold-seats clear logs' || fail "ready/cold clear failed out=$OUT log=$(cat "$ROOT/seats/logs/alerts.log" 2>/dev/null)"

clear_runtime; old="$(old_iso)"; printf '{"at":"%s","seat":"worker-a"}\n' "$old" > "$ROOT/seats/inbox.jsonl"; : > "$ROOT/seats/inbox.cursor"; printf 'poke deferred reason=not-idle\n' > "$ROOT/seats/logs/herald.out.log"; run_alert bun seats/alerts.ts check --json
[ $RC -eq 0 ] && active inbox-lag && [ "$(need_open_count)" = 0 ] && pass 'inbox-lag active younger than alert-human-after-minutes opens no need' || fail "young inbox-lag opened need rc=$RC out=$OUT needs=$(cat "$ROOT/seats/needs.jsonl" 2>/dev/null)"
before_lag="$(inbox_count)"; for i in 1 2 3; do run_alert bun seats/alerts.ts check --json; done
[ "$(inbox_count)" = "$before_lag" ] && pass 'inbox-lag stays quiet over 3 active runs' || fail "inbox-lag not quiet before=$before_lag inbox=$(inbox_count)"
age_alert inbox-lag; run_alert bun seats/alerts.ts check --json
[ "$(need_open_count)" = 1 ] && pass 'inbox-lag opens one human need after threshold' || fail "inbox-lag threshold need failed: $(cat "$ROOT/seats/needs.jsonl" 2>/dev/null)"
printf '' > "$ROOT/seats/inbox.jsonl"; run_alert bun seats/alerts.ts check --json
[ $RC -eq 0 ] && grep -q 'alert cleared inbox-lag' "$ROOT/seats/logs/alerts.log" && [ "$(need_closed_count)" = 1 ] && pass 'inbox-lag clear closes its need' || fail "inbox-lag close failed: $(cat "$ROOT/seats/needs.jsonl" 2>/dev/null)"

clear_runtime; printf '{"status":"wrong-root"}\n' > "$ROOT/seats/run/herald.target.json"; run_alert bun seats/alerts.ts check --json
[ $RC -eq 0 ] && active commander-pane-invalid && [ "$(need_open_count)" = 1 ] && pass 'commander-pane-invalid fires and escalates on first run' || fail "pane invalid failed rc=$RC out=$OUT"
for i in 1 2 3; do run_alert bun seats/alerts.ts check --json; done
[ "$(inbox_count)" = 1 ] && [ "$(need_open_count)" = 1 ] && pass 'commander-pane-invalid stays quiet over 3 active runs' || fail "pane invalid not quiet"
printf '{"status":"ok"}\n' > "$ROOT/seats/run/herald.target.json"; run_alert bun seats/alerts.ts check --json
[ $RC -eq 0 ] && grep -q 'alert cleared commander-pane-invalid' "$ROOT/seats/logs/alerts.log" && [ "$(need_closed_count)" = 1 ] && pass 'commander-pane-invalid clear closes its need' || fail "pane close failed: $(cat "$ROOT/seats/needs.jsonl" 2>/dev/null)"

clear_runtime; printf '{"seats":{"worker-a":{"pid":%s,"log":"%s","lastCapacityEvent":{"at":"2026-01-01T00:00:00Z","detail":"synthetic"}}}}\n' $$ "$ROOT/seats/logs/worker-a.jsonl" > "$ROOT/seats/state.json"; run_alert bun seats/alerts.ts check --json
[ $RC -eq 0 ] && active capacity-events && pass 'capacity-events fires when state carries lastCapacityEvent' || fail "capacity failed rc=$RC out=$OUT"
for i in 1 2 3; do run_alert bun seats/alerts.ts check --json; done; [ "$(inbox_count)" = 1 ] && pass 'capacity-events stays quiet over 3 active runs' || fail "capacity not quiet"
node -e 'const fs=require("fs"), f=process.argv[1]; const j=JSON.parse(fs.readFileSync(f,"utf8")); j.seats["worker-b"]={pid:process.pid,log:"x",lastCapacityEvent:{at:"2026-01-01T00:00:00Z",detail:"synthetic"}}; fs.writeFileSync(f,JSON.stringify(j));' "$ROOT/seats/state.json"; run_alert bun seats/alerts.ts check --json
[ "$(inbox_count)" = 2 ] && pass 'capacity-events fires again when the set changes' || fail "capacity set change did not fire"
printf '{"seats":{}}\n' > "$ROOT/seats/state.json"; run_alert bun seats/alerts.ts check --json
[ $RC -eq 0 ] && grep -q 'alert cleared capacity-events' "$ROOT/seats/logs/alerts.log" && pass 'capacity-events clears' || fail "capacity clear failed"

clear_runtime; GH_UNTRIAGED=1 run_alert bun seats/alerts.ts check --json
[ $RC -eq 0 ] && active untriaged-github-issues && pass 'untriaged GitHub issues fire' || fail "github failed rc=$RC out=$OUT"
for i in 1 2 3; do GH_UNTRIAGED=1 run_alert bun seats/alerts.ts check --json; done; [ "$(inbox_count)" = 1 ] && pass 'untriaged GitHub issues stay quiet over 3 active runs' || fail "github not quiet"
GH_UNTRIAGED=2 run_alert bun seats/alerts.ts check --json; [ "$(inbox_count)" = 2 ] && pass 'untriaged GitHub issues fire again when the set changes' || fail "github set change did not fire"
run_alert bun seats/alerts.ts check --json
[ $RC -eq 0 ] && grep -q 'alert cleared untriaged-github-issues' "$ROOT/seats/logs/alerts.log" && pass 'untriaged GitHub issues clear' || fail "github clear failed"

clear_runtime; set_low_disk 999999999; run_alert bun seats/alerts.ts check --json
[ $RC -eq 0 ] && active low-disk && pass 'low-disk fires from statfs threshold' || fail "low disk failed rc=$RC out=$OUT"
for i in 1 2 3; do run_alert bun seats/alerts.ts check --json; done; [ "$(inbox_count)" = 1 ] && pass 'low-disk stays quiet over 3 active runs' || fail "low disk not quiet"
set_low_disk 0; run_alert bun seats/alerts.ts check --json
[ $RC -eq 0 ] && grep -q 'alert cleared low-disk' "$ROOT/seats/logs/alerts.log" && pass 'low-disk clears' || fail "low disk clear failed"

clear_runtime; DRIFT_ON=1 run_alert bun seats/alerts.ts check --json
[ $RC -eq 0 ] && active template-drift && pass 'template-drift --json is wired into the snapshot and alert' || fail "drift failed rc=$RC out=$OUT"
for i in 1 2 3; do DRIFT_ON=1 run_alert bun seats/alerts.ts check --json; done; [ "$(inbox_count)" = 1 ] && pass 'template-drift stays quiet over 3 active runs' || fail "drift not quiet"
run_alert bun seats/alerts.ts check --json
[ $RC -eq 0 ] && grep -q 'alert cleared template-drift' "$ROOT/seats/logs/alerts.log" && pass 'template-drift clears' || fail "drift clear failed"

phase 'failure and stale lock handling'
old_at="$(node -e 'console.log(require(process.argv[1]).at)' "$ROOT/seats/run/fleet-snapshot.json")"
cat > "$BIN/bd" <<'SH'
#!/usr/bin/env bash
echo bd fixture failure >&2
exit 7
SH
chmod +x "$BIN/bd"; run_alert bun seats/alerts.ts check --json; new_at="$(node -e 'console.log(require(process.argv[1]).at)' "$ROOT/seats/run/fleet-snapshot.json")"
[ $RC -ne 0 ] && [ "$old_at" = "$new_at" ] && grep -q 'STOP alerts check failed' "$ROOT/seats/logs/alerts.log" && pass 'bd non-zero leaves previous snapshot intact and logs STOP' || fail "bd failure handling failed rc=$RC old=$old_at new=$new_at out=$OUT"
cat > "$BIN/bd" <<'SH'
#!/usr/bin/env bash
case "$1 $2" in
  "ready --json") [ "${BD_READY:-0}" = 1 ] && printf '[{"id":"ready-1","title":"Synthetic ready"}]\n' || printf '[]\n' ;;
  *) printf '[]\n' ;;
esac
SH
chmod +x "$BIN/bd"
printf '99999999\n' > "$ROOT/seats/run/alerts.lock"; run_alert bun seats/alerts.ts check --json
[ $RC -eq 0 ] && [ ! -f "$ROOT/seats/run/alerts.lock" ] && pass 'stale alerts lock left by a dead pid is reclaimed' || fail "stale lock was not reclaimed rc=$RC out=$OUT lock=$(cat "$ROOT/seats/run/alerts.lock" 2>/dev/null)"
printf '%s\n' $$ > "$ROOT/seats/run/alerts.lock"; run_alert bun seats/alerts.ts check --json
[ $RC -eq 0 ] && grep -q 'locked' <<<"$OUT" && pass 'live-pid alerts lock is respected' || fail "live lock not respected rc=$RC out=$OUT"
rm -f "$ROOT/seats/run/alerts.lock"

phase 'readyWorkNobodyOnIt and herald clock'
DEFS="$(rg -n 'function readyWorkNobodyOnIt' "$HERE" -g '*.ts' | wc -l | tr -d ' ')"; CALLS="$(rg -n 'readyWorkNobodyOnIt\(' "$HERE/staffing.ts" "$HERE/alerts.ts" | wc -l | tr -d ' ')"
[ "$DEFS" = 1 ] && [ "$CALLS" -ge 2 ] && pass 'one readyWorkNobodyOnIt definition and alerts/staffing call sites exist' || fail "ready detector count defs=$DEFS calls=$CALLS"
cat > "$BIN/tmux" <<'SH'
#!/usr/bin/env bash
exit 1
SH
chmod +x "$BIN/tmux"
rm -f "$ROOT/seats/run/fleet-snapshot.json"; HERALD_OUT="$FIX/herald.out"; start=$(date +%s); (cd "$ROOT" && env HOME="$HOME_FIX" PATH="$BIN:$PATH" WHEELHOUSE_ALERTS_ROOT="$ROOT" WHEELHOUSE_ALERT_INTERVAL_MS=200 WHEELHOUSE_HERALD_INTERVAL_MS=100 WHEELHOUSE_HERALD_TMUX_PANE="" timeout 3 bun seats/herald.ts --daemon >"$HERALD_OUT" 2>&1) || true; elapsed=$(( $(date +%s) - start ))
[ -s "$ROOT/seats/run/fleet-snapshot.json" ] && [ "$elapsed" -le 4 ] && pass 'herald launches alerts child and snapshot appears without blocking the scan loop' || fail "herald did not launch alerts child rc? elapsed=$elapsed out=$(cat "$HERALD_OUT" 2>/dev/null)"
SLOW="$FIX/slow-herald"; cp -R "$ROOT" "$SLOW"; cat > "$SLOW/seats/alerts.ts" <<'TS'
await new Promise((resolve) => setTimeout(resolve, 2000));
TS
SLOW_OUT="$FIX/slow-herald.out"; (cd "$SLOW" && HOME="$HOME_FIX" PATH="$BIN:$PATH" WHEELHOUSE_ALERTS_ROOT="$SLOW" timeout 1 bun seats/herald.ts --once >"$SLOW_OUT" 2>&1); SRC=$?
[ "$SRC" = 0 ] && pass 'scan loop does not wait for a slow alerts child' || fail "slow alerts child blocked scan rc=$SRC out=$(cat "$SLOW_OUT" 2>/dev/null)"
BROKEN="$FIX/no-alert-clock"; cp -R "$ROOT" "$BROKEN"; python3 - "$BROKEN/seats/herald.ts" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]); s=p.read_text(); s=s.replace('const clocked = runStaffingClock(state) || runAlertsClock(state);','const clocked = runStaffingClock(state);')
p.write_text(s)
PY
rm -f "$BROKEN/seats/run/fleet-snapshot.json"; (cd "$BROKEN" && HOME="$HOME_FIX" PATH="$BIN:$PATH" WHEELHOUSE_ALERTS_ROOT="$BROKEN" WHEELHOUSE_ALERT_INTERVAL_MS=200 WHEELHOUSE_HERALD_INTERVAL_MS=100 timeout 1 bun seats/herald.ts --daemon >/dev/null 2>&1) || true
[ ! -s "$BROKEN/seats/run/fleet-snapshot.json" ] && pass 'canary: removing runAlertsClock makes the herald snapshot leg fail' || fail 'canary without runAlertsClock still produced a snapshot'

phase 'canary'
CAN="$FIX/canary"; cp -R "$ROOT" "$CAN"; python3 - "$CAN/seats/alerts.ts" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1])
s=p.read_text()
s=s.replace('if(next.active&&(!was?.active||was.signature!==next.signature))','if(next.active)')
p.write_text(s)
PY
rm -f "$CAN/seats/inbox.jsonl" "$CAN/seats/run/fleet-snapshot.json"; (cd "$CAN" && HOME="$HOME_FIX" PATH="$BIN:$PATH" WHEELHOUSE_ALERTS_ROOT="$CAN" BD_READY=1 bun seats/alerts.ts check >/dev/null 2>&1 && HOME="$HOME_FIX" PATH="$BIN:$PATH" WHEELHOUSE_ALERTS_ROOT="$CAN" BD_READY=1 bun seats/alerts.ts check >/dev/null 2>&1); CCOUNT="$( [ -f "$CAN/seats/inbox.jsonl" ] && wc -l < "$CAN/seats/inbox.jsonl" | tr -d ' ' || echo 0 )"
[ "$CCOUNT" -gt 2 ] && pass 'canary: fire-on-every-run variant fails the stays-quiet leg' || fail "canary did not produce repeated alert rows count=$CCOUNT"

if [ "$FAILED" -eq 0 ]; then echo 'alerts.selftest.sh works on this machine.'; exit 0; fi
echo "alerts.selftest.sh FAIL ($FAILED failure(s))" >&2; exit 1
