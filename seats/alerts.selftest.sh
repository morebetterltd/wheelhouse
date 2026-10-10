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
for f in alerts.ts fleet-snapshot.ts roster.ts pool.ts seat-activity.ts seat-worktree.ts credential-shapes.ts harness.ts needs.ts template-drift.sh; do cp "$HERE/$f" "$ROOT/seats/$f"; done
chmod +x "$ROOT/seats/template-drift.sh"
cat > "$ROOT/seats/seats.json" <<'JSON'
{"seats":{"worker-a":{"role":"worker","runtime":"pi","account":{"dir":"~/.pi-seats-alerts/worker-a"}},"commander":{"role":"commander","external":true}}}
JSON
cat > "$ROOT/wheelhouse/.template-source" <<'EOF'
namespace=fixture
alert-inbox-lag-minutes=10
alert-human-after-minutes=0
alert-low-disk-gb=0
github-issue-repos=fixture/repo
EOF
cat > "$ROOT/seats/template-drift.sh" <<'SH'
#!/usr/bin/env bash
printf '{"error":null,"modified":[],"localOnly":[],"missing":[],"aheadBy":0,"comparedAgainst":"fixture"}\n'
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
if [ "${GH_UNTRIAGED:-0}" = 1 ]; then printf '[{"url":"https://github.com/fixture/repo/issues/7","labels":[],"author":{"login":"alice"}}]\n'; else printf '[]\n'; fi
SH
chmod +x "$BIN/gh"
run_alert(){ OUT="$(cd "$ROOT" && env HOME="$HOME_FIX" PATH="$BIN:$PATH" WHEELHOUSE_ALERTS_ROOT="$ROOT" "$@" 2>&1)"; RC=$?; }
inbox_count(){ [ -f "$ROOT/seats/inbox.jsonl" ] && wc -l < "$ROOT/seats/inbox.jsonl" | tr -d ' ' || echo 0; }
need_count(){ [ -f "$ROOT/seats/needs.jsonl" ] && grep -c '"type":"opened"' "$ROOT/seats/needs.jsonl" || echo 0; }
active(){ node -e 'const j=require(process.argv[1]); if(!j.alerts[process.argv[2]]?.active) process.exit(1)' "$ROOT/seats/run/fleet-snapshot.json" "$1"; }
set_state_idle_worker(){ cat > "$ROOT/seats/state.json" <<JSON
{"seats":{"worker-a":{"pid":$$,"log":"$ROOT/seats/logs/worker-a.jsonl"}}}
JSON
printf '{"type":"agent_end","timestamp":"2026-01-01T00:00:00Z"}\n' > "$ROOT/seats/logs/worker-a.jsonl"; }
clear_runtime(){ rm -f "$ROOT/seats/run/fleet-snapshot.json" "$ROOT/seats/inbox.jsonl" "$ROOT/seats/needs.jsonl" "$ROOT/seats/logs/alerts.log" "$ROOT/seats/inbox.cursor" "$ROOT/seats/run/herald.target.json"; printf '{"seats":{}}\n' > "$ROOT/seats/state.json"; }

phase 'alerts transitions and snapshot schema'
clear_runtime; BD_READY=1 run_alert bun seats/alerts.ts check --json
[ $RC -eq 0 ] && active idle-fleet-ready-work && active cold-seats-ready-work && [ "$(inbox_count)" = 2 ] && pass 'ready work with no live workers fires idle-fleet and cold-seats once' || fail "ready/cold failed rc=$RC out=$OUT inbox=$(inbox_count)"
BD_READY=1 run_alert bun seats/alerts.ts check --json
[ $RC -eq 0 ] && [ "$(inbox_count)" = 2 ] && pass 'active alerts stay quiet over the next run' || fail "active did not stay quiet inbox=$(inbox_count) out=$OUT"
BD_READY=0 run_alert bun seats/alerts.ts check --json
[ $RC -eq 0 ] && grep -q 'alert cleared idle-fleet-ready-work' "$ROOT/seats/logs/alerts.log" && pass 'active to inactive logs cleared' || fail "clear failed rc=$RC out=$OUT log=$(cat "$ROOT/seats/logs/alerts.log" 2>/dev/null)"

clear_runtime; old="$(python3 - <<'PY'
from datetime import datetime, timedelta, timezone
print((datetime.now(timezone.utc)-timedelta(minutes=20)).isoformat())
PY
)"; printf '{"at":"%s","seat":"worker-a"}\n' "$old" > "$ROOT/seats/inbox.jsonl"; : > "$ROOT/seats/inbox.cursor"; printf 'poke deferred reason=not-idle\n' > "$ROOT/seats/logs/herald.out.log"; run_alert bun seats/alerts.ts check --json
[ $RC -eq 0 ] && active inbox-lag && [ "$(need_count)" = 1 ] && pass 'inbox-lag opens one human need through needs.ts open after threshold' || fail "inbox lag failed rc=$RC out=$OUT needs=$(cat "$ROOT/seats/needs.jsonl" 2>/dev/null)"
run_alert bun seats/alerts.ts check --json
[ "$(need_count)" = 1 ] && pass 'human need dedupes by --source while open' || fail "need did not dedupe: $(cat "$ROOT/seats/needs.jsonl" 2>/dev/null)"
printf '' > "$ROOT/seats/inbox.jsonl"; run_alert bun seats/alerts.ts check --json
[ $RC -eq 0 ] && grep -q '"type":"closed"' "$ROOT/seats/needs.jsonl" && pass 'clearing an escalated alert closes its need' || fail "need close failed: $(cat "$ROOT/seats/needs.jsonl" 2>/dev/null)"

clear_runtime; printf '{"status":"wrong-root"}\n' > "$ROOT/seats/run/herald.target.json"; run_alert bun seats/alerts.ts check --json
[ $RC -eq 0 ] && active commander-pane-invalid && [ "$(need_count)" = 1 ] && pass 'commander-pane-invalid escalates on the first run' || fail "pane invalid failed rc=$RC out=$OUT"
clear_runtime; printf '{"seats":{"worker-a":{"pid":%s,"log":"%s","lastCapacityEvent":{"at":"2026-01-01T00:00:00Z","detail":"synthetic"}}}}\n' $$ "$ROOT/seats/logs/worker-a.jsonl" > "$ROOT/seats/state.json"; run_alert bun seats/alerts.ts check --json
[ $RC -eq 0 ] && active capacity-events && pass 'capacity-events fires when state carries lastCapacityEvent' || fail "capacity failed rc=$RC out=$OUT"
clear_runtime; GH_UNTRIAGED=1 run_alert bun seats/alerts.ts check --json
[ $RC -eq 0 ] && active untriaged-github-issues && pass 'untriaged GitHub issues from gh are reflected in the snapshot and alert' || fail "github failed rc=$RC out=$OUT"
clear_runtime; python3 - <<PY
from pathlib import Path
p=Path('$ROOT/wheelhouse/.template-source')
s=p.read_text().replace('alert-low-disk-gb=0','alert-low-disk-gb=999999999')
p.write_text(s)
PY
run_alert bun seats/alerts.ts check --json
[ $RC -eq 0 ] && active low-disk && pass 'low-disk fires from statfs threshold' || fail "low disk failed rc=$RC out=$OUT"
python3 - <<PY
from pathlib import Path
p=Path('$ROOT/wheelhouse/.template-source')
s=p.read_text().replace('alert-low-disk-gb=999999999','alert-low-disk-gb=0')
p.write_text(s)
PY
clear_runtime; cp "$ROOT/seats/template-drift.sh" "$ROOT/seats/template-drift.real"; cat > "$ROOT/seats/template-drift.sh" <<'SH'
#!/usr/bin/env bash
printf '{"error":null,"modified":["README.md"],"localOnly":[],"missing":[],"aheadBy":0,"comparedAgainst":"fixture"}\n'
SH
chmod +x "$ROOT/seats/template-drift.sh"; run_alert bun seats/alerts.ts check --json
[ $RC -eq 0 ] && active template-drift && pass 'template-drift --json is wired into the snapshot and alert' || fail "drift failed rc=$RC out=$OUT"; mv "$ROOT/seats/template-drift.real" "$ROOT/seats/template-drift.sh"

phase 'failure preserves prior snapshot'
old_at="$(node -e 'console.log(require(process.argv[1]).at)' "$ROOT/seats/run/fleet-snapshot.json")"
cat > "$BIN/bd" <<'SH'
#!/usr/bin/env bash
echo bd fixture failure >&2
exit 7
SH
chmod +x "$BIN/bd"; run_alert bun seats/alerts.ts check --json; new_at="$(node -e 'console.log(require(process.argv[1]).at)' "$ROOT/seats/run/fleet-snapshot.json")"
[ $RC -ne 0 ] && [ "$old_at" = "$new_at" ] && grep -q 'STOP alerts check failed' "$ROOT/seats/logs/alerts.log" && pass 'bd non-zero leaves previous snapshot intact and logs STOP' || fail "bd failure handling failed rc=$RC old=$old_at new=$new_at out=$OUT"
# restore bd
cat > "$BIN/bd" <<'SH'
#!/usr/bin/env bash
case "$1 $2" in
  "ready --json") [ "${BD_READY:-0}" = 1 ] && printf '[{"id":"ready-1","title":"Synthetic ready"}]\n' || printf '[]\n' ;;
  *) printf '[]\n' ;;
esac
SH
chmod +x "$BIN/bd"

phase 'readyWorkNobodyOnIt and herald clock'
DEFS="$(rg -n 'function readyWorkNobodyOnIt' "$HERE" -g '*.ts' | wc -l | tr -d ' ')"; CALLS="$(rg -n 'readyWorkNobodyOnIt\(' "$HERE/staffing.ts" "$HERE/alerts.ts" | wc -l | tr -d ' ')"
[ "$DEFS" = 1 ] && [ "$CALLS" -ge 2 ] && pass 'one readyWorkNobodyOnIt definition and alerts/staffing call sites exist' || fail "ready detector count defs=$DEFS calls=$CALLS"
# Private herald instance only; fake tmux is inert and no live pane is touched.
cat > "$BIN/tmux" <<'SH'
#!/usr/bin/env bash
exit 1
SH
chmod +x "$BIN/tmux"
HERALD_OUT="$FIX/herald.out"; (cd "$ROOT" && env HOME="$HOME_FIX" PATH="$BIN:$PATH" WHEELHOUSE_ALERTS_ROOT="$ROOT" WHEELHOUSE_ALERT_INTERVAL_MS=200 WHEELHOUSE_HERALD_INTERVAL_MS=100 WHEELHOUSE_HERALD_TMUX_PANE="" timeout 3 bun seats/herald.ts --daemon >"$HERALD_OUT" 2>&1) || true
[ -s "$ROOT/seats/run/fleet-snapshot.json" ] && pass 'herald launches alerts child and snapshot appears' || fail "herald did not launch alerts child: $(cat "$HERALD_OUT" 2>/dev/null)"

phase 'canary'
CAN="$FIX/canary"; cp -R "$ROOT" "$CAN"; python3 - "$CAN/seats/alerts.ts" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1])
s=p.read_text()
s=s.replace('if(next.active&&(!was?.active||was.signature!==next.signature)){ appendLog(`alert fired ${name}`); appendInboxAlert(name, bodyFor(name)); }','if(next.active){ appendLog(`alert fired ${name}`); appendInboxAlert(name, bodyFor(name)); }')
p.write_text(s)
PY
rm -f "$CAN/seats/inbox.jsonl" "$CAN/seats/run/fleet-snapshot.json"; (cd "$CAN" && HOME="$HOME_FIX" PATH="$BIN:$PATH" WHEELHOUSE_ALERTS_ROOT="$CAN" BD_READY=1 bun seats/alerts.ts check >/dev/null 2>&1 && HOME="$HOME_FIX" PATH="$BIN:$PATH" WHEELHOUSE_ALERTS_ROOT="$CAN" BD_READY=1 bun seats/alerts.ts check >/dev/null 2>&1); CCOUNT="$( [ -f "$CAN/seats/inbox.jsonl" ] && wc -l < "$CAN/seats/inbox.jsonl" | tr -d ' ' || echo 0 )"
[ "$CCOUNT" -gt 2 ] && pass 'canary: fire-on-every-run variant fails the stays-quiet leg' || fail "canary did not produce repeated alert rows count=$CCOUNT"

if [ "$FAILED" -eq 0 ]; then echo 'alerts.selftest.sh works on this machine.'; exit 0; fi
echo "alerts.selftest.sh FAIL ($FAILED failure(s))" >&2; exit 1
