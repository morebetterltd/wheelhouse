#!/usr/bin/env bash
set -uo pipefail
SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"
HERE="$(cd "$(dirname "$0")" && pwd -P)"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-alerts.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
. "$HERE/selftest-herald.sh"
selftest_bind_herald_owner "$FIX" || exit 2
cleanup(){ selftest_cleanup_fixture_processes "${FIX:-}" "${TMUX_SOCK:-}"; selftest_remove_fixture_dir "$FIX"; }
selftest_install_cleanup_traps cleanup
FAILED=0
pass(){ printf '  ok    %s\n' "$*"; }
fail(){ printf '  FAIL  %s\n' "$*"; FAILED=$((FAILED+1)); }
phase(){ printf '\n%s\n' "$*"; }
ROOT="$FIX/project"; BIN="$FIX/bin"; HOME_FIX="$FIX/home"; mkdir -p "$ROOT/seats/run" "$ROOT/seats/logs" "$ROOT/wheelhouse" "$BIN" "$HOME_FIX"
selftest_copy_seat_runtime "$ROOT" "$HERE"
[ "$#" = 0 ] || cp -f "$1" "$ROOT/seats/alerts.ts"
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
case "${DRIFT_CASE:-}" in
  garbage) printf 'not-json\n'; exit 0 ;;
  empty) exit 0 ;;
  schema) printf '{}\n'; exit 0 ;;
  crash) printf 'fixture crash\n' >&2; exit 7 ;;
  signal) kill -TERM "$$" ;;
  compare-error) printf '{"error":"fixture cannot compare"}\n'; exit 3 ;;
  real) printf '{"modified":["seats/example.ts"],"localOnly":["runbooks/local.md"],"missing":["runbooks/missing.md"],"aheadBy":1,"comparedAgainst":"fixture"}\n'; exit 1 ;;
esac
if [ -n "${DRIFT_JSON:-}" ]; then printf '%s\n' "$DRIFT_JSON"; elif [ "${DRIFT_ON:-0}" = 1 ]; then printf '{"error":null,"modified":["README.md"],"localOnly":[],"missing":[],"aheadBy":0,"comparedAgainst":"fixture"}\n'; elif [ "${DRIFT_AHEAD:-0}" = 1 ]; then printf '{"error":null,"modified":[],"localOnly":[],"missing":[],"aheadBy":2,"comparedAgainst":"fixture"}\n'; else printf '{"error":null,"modified":[],"localOnly":[],"missing":[],"aheadBy":0,"comparedAgainst":"fixture"}\n'; fi
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
run_alert(){ OUT="$(cd "$ROOT" && env HOME="$HOME_FIX" PATH="$BIN:$PATH" WHEELHOUSE_ALERTS_ROOT="$ROOT" "$@" 2>&1)"; RC=$?;
  if [ "$RC" = 0 ] && [ -f "$ROOT/seats/inbox.jsonl" ]; then
    node --input-type=module - "$ROOT" <<'JS' || fail 'every herald alert row must name its condition and retain concrete detail'
import fs from 'node:fs';import assert from 'node:assert/strict';const root=process.argv[2],rows=fs.readFileSync(root+'/seats/inbox.jsonl','utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l)).filter(r=>r.class==='alert'),snapshot=JSON.parse(fs.readFileSync(root+'/seats/run/fleet-snapshot.json','utf8'));
for(const row of rows){assert(row.detail.startsWith('Alert '+row.source.name+': '));assert(row.detail.includes('Cost:'));assert(row.detail.includes('Next:'));}
// A fixture may deliberately delete its snapshot while retaining old inbox rows;
// retention across a real clear is checked separately below.
JS
  fi
}
inbox_count(){ [ -f "$ROOT/seats/inbox.jsonl" ] && wc -l < "$ROOT/seats/inbox.jsonl" | tr -d ' ' || echo 0; }
need_open_count(){ [ -f "$ROOT/seats/needs.jsonl" ] && grep -c '"type":"opened"' "$ROOT/seats/needs.jsonl" || echo 0; }
need_closed_count(){ [ -f "$ROOT/seats/needs.jsonl" ] && grep -c '"type":"closed"' "$ROOT/seats/needs.jsonl" || echo 0; }
active(){ node -e 'const j=require(process.argv[1]); if(!j.alerts[process.argv[2]]?.active) process.exit(1)' "$ROOT/seats/run/fleet-snapshot.json" "$1"; }
set_low_disk(){ bun - "$ROOT/wheelhouse/.template-source" "$1" <<'JS'
const fs=(await import('node:fs')).default,[p,v]=process.argv.slice(2),s=fs.readFileSync(p,'utf8');
fs.writeFileSync(p,s.replace(/^alert-low-disk-gb=.*$/gm,()=> 'alert-low-disk-gb='+v));
JS
}
old_iso(){ bun -e 'console.log(new Date(Date.now()-20*60*1000).toISOString())'; }
clear_runtime(){ rm -f "$ROOT/seats/run/fleet-snapshot.json" "$ROOT/seats/inbox.jsonl" "$ROOT/seats/needs.jsonl" "$ROOT/seats/logs/alerts.log" "$ROOT/seats/inbox.cursor" "$ROOT/seats/run/herald.target.json" "$ROOT/seats/run/alerts.lock"; printf '{"seats":{}}\n' > "$ROOT/seats/state.json"; set_low_disk 0; }
quiet3(){ local before name; name="$1"; before="$(inbox_count)"; run_alert "$@"; run_alert bun seats/alerts.ts check --json; run_alert bun seats/alerts.ts check --json; [ "$(inbox_count)" = "$before" ]; }
age_alert(){ node -e 'const fs=require("fs"); const f=process.argv[1], n=process.argv[2]; const j=JSON.parse(fs.readFileSync(f,"utf8")); j.alerts[n].since="2000-01-01T00:00:00.000Z"; fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n");' "$ROOT/seats/run/fleet-snapshot.json" "$1"; }

# Drift's consumer is the inbox: set membership, not categories/order/counts,
# controls a fresh hold and a single raise. Test time is aged in owned state.
drift_set_cases(){
  local a b moved first current recent
  a='{"error":null,"modified":["b.ts","a.ts"],"localOnly":[],"missing":[],"aheadBy":0}'
  b='{"error":null,"modified":["c.ts"],"localOnly":[],"missing":[],"aheadBy":0}'
  moved='{"error":null,"modified":[],"localOnly":["b.ts","b.ts"],"missing":["a.ts"],"aheadBy":7}'
  clear_runtime
  WHEELHOUSE_TEMPLATE_DRIFT_ALERT_HOLD_MS=600000 DRIFT_JSON="$a" run_alert bun seats/alerts.ts check --json
  [ "$RC" = 0 ] && ! active template-drift && [ "$(inbox_count)" = 0 ] || fail "set fixture did not start pending: $OUT"
  age_alert template-drift
  WHEELHOUSE_TEMPLATE_DRIFT_ALERT_HOLD_MS=600000 DRIFT_JSON="$a" run_alert bun seats/alerts.ts check --json
  [ "$RC" = 0 ] && active template-drift && [ "$(inbox_count)" = 1 ] || fail "set fixture first raise missing: $OUT"
  first="$(node -e 'console.log(JSON.stringify(require(process.argv[1]).alerts["template-drift"]))' "$ROOT/seats/run/fleet-snapshot.json")"
  if [ "${WHEELHOUSE_TEMPLATE_DRIFT_CASE:-all}" != changed ]; then
    for variant in "$a" '{"modified":["a.ts","b.ts","a.ts"],"localOnly":[],"missing":[],"aheadBy":2}' "$moved"; do
      WHEELHOUSE_TEMPLATE_DRIFT_ALERT_HOLD_MS=600000 DRIFT_JSON="$variant" run_alert bun seats/alerts.ts check --json
      current="$(node -e 'console.log(JSON.stringify(require(process.argv[1]).alerts["template-drift"]))' "$ROOT/seats/run/fleet-snapshot.json")"
      [ "$RC" = 0 ] && active template-drift && [ "$(inbox_count)" = 1 ] && [ "$current" = "$first" ] || fail "same-set re-raised or changed its clock/signature: rc=$RC rows=$(inbox_count) first=$first current=$current"
    done
    # Existing deployments persisted the old object-shaped signature. Preserve
    # an already fired same set across this upgrade instead of re-holding it.
    node -e 'const fs=require("fs"),f=process.argv[1],j=JSON.parse(fs.readFileSync(f,"utf8"));j.alerts["template-drift"].signature=JSON.stringify({e:null,m:["b.ts"],l:["a.ts"],mi:[],a:99});fs.writeFileSync(f,JSON.stringify(j));' "$ROOT/seats/run/fleet-snapshot.json"
    WHEELHOUSE_TEMPLATE_DRIFT_ALERT_HOLD_MS=600000 DRIFT_JSON="$a" run_alert bun seats/alerts.ts check --json
    current="$(node -e 'console.log(JSON.stringify(require(process.argv[1]).alerts["template-drift"]))' "$ROOT/seats/run/fleet-snapshot.json")"
    [ "$RC" = 0 ] && active template-drift && [ "$(inbox_count)" = 1 ] && [ "$current" = "$first" ] || fail "legacy same-set signature restarted or re-raised: $current"
    recent="$(node -e 'const fs=require("fs"),f=process.argv[1],j=JSON.parse(fs.readFileSync(f,"utf8"));const a=j.alerts["template-drift"];a.since=new Date().toISOString();a.signature=JSON.stringify({e:null,m:["b.ts"],l:["a.ts"],mi:[],a:99});fs.writeFileSync(f,JSON.stringify(j));console.log(JSON.stringify({...a,signature:JSON.stringify(["a.ts","b.ts"])}));' "$ROOT/seats/run/fleet-snapshot.json")"
    WHEELHOUSE_TEMPLATE_DRIFT_ALERT_HOLD_MS=600000 DRIFT_JSON="$a" run_alert bun seats/alerts.ts check --json
    current="$(node -e 'console.log(JSON.stringify(require(process.argv[1]).alerts["template-drift"]))' "$ROOT/seats/run/fleet-snapshot.json")"
    [ "$RC" = 0 ] && active template-drift && [ "$(inbox_count)" = 1 ] && [ "$current" = "$recent" ] || fail "recent already-active same set became pending: $current"
    [ "$FAILED" = 0 ] && pass 'same drift set never re-raises or resets state: reorder, duplicates, category moves, aheadBy changes, persisted legacy signature (aged and recent)'
  fi
  if [ "${WHEELHOUSE_TEMPLATE_DRIFT_CASE:-all}" != same ]; then
    WHEELHOUSE_TEMPLATE_DRIFT_ALERT_HOLD_MS=600000 DRIFT_JSON="$b" run_alert bun seats/alerts.ts check --json
    [ "$RC" = 0 ] && ! active template-drift && [ "$(inbox_count)" = 1 ] || fail "changed set reused old hold: rc=$RC rows=$(inbox_count) out=$OUT"
    age_alert template-drift
    WHEELHOUSE_TEMPLATE_DRIFT_ALERT_HOLD_MS=600000 DRIFT_JSON="$b" run_alert bun seats/alerts.ts check --json
    [ "$RC" = 0 ] && active template-drift && [ "$(inbox_count)" = 2 ] || fail "changed set did not re-raise after own hold: rc=$RC rows=$(inbox_count) out=$OUT"
    WHEELHOUSE_TEMPLATE_DRIFT_ALERT_HOLD_MS=600000 DRIFT_JSON="$a" run_alert bun seats/alerts.ts check --json
    [ "$RC" = 0 ] && ! active template-drift && [ "$(inbox_count)" = 2 ] || fail "returning set did not start its own hold"
    age_alert template-drift
    WHEELHOUSE_TEMPLATE_DRIFT_ALERT_HOLD_MS=600000 DRIFT_JSON="$a" run_alert bun seats/alerts.ts check --json
    [ "$RC" = 0 ] && active template-drift && [ "$(inbox_count)" = 3 ] || fail "returning changed set did not re-raise after own hold"
    [ "$FAILED" = 0 ] && pass 'changed drift set starts a fresh hold and re-raises exactly once; returning old set gets a new hold'
  fi
}
phase 'drift file-set design'
case "${WHEELHOUSE_TEMPLATE_DRIFT_CASE:-all}" in all|same|changed) ;; *) echo 'invalid drift test case' >&2; exit 2;; esac
drift_set_cases
if [ "${WHEELHOUSE_TEMPLATE_DRIFT_CASE:-all}" != all ]; then
  [ "$FAILED" = 0 ] && { echo 'drift-set selftest: PASS'; exit 0; }
  echo "drift-set selftest: FAIL ($FAILED failure(s))" >&2; exit 1
fi

phase 'drift continuity across unknown observations'
if bun "$HERE/fixtures/drift-continuity.ts" "$HERE" "$FIX/drift-continuity" "$ROOT/seats/alerts.ts"; then
  pass 'unchanged active/pending drift survives failures; real changes and clears re-arm; removals rejected'
else
  fail 'drift continuity consumer sequences failed'
fi

phase 'empty drift set'
clear_runtime
WHEELHOUSE_TEMPLATE_DRIFT_ALERT_HOLD_MS=600000 DRIFT_AHEAD=1 run_alert bun seats/alerts.ts check --json
[ "$RC" = 0 ] && ! active template-drift && [ "$(inbox_count)" = 0 ] || fail 'ahead-only empty set did not start pending'
age_alert template-drift
WHEELHOUSE_TEMPLATE_DRIFT_ALERT_HOLD_MS=600000 DRIFT_JSON='{"error":null,"modified":[],"localOnly":[],"missing":[],"aheadBy":3}' run_alert bun seats/alerts.ts check --json
[ "$RC" = 0 ] && active template-drift && [ "$(inbox_count)" = 1 ] || fail 'empty set restarted its hold when ahead count changed'
empty_first="$(node -e 'console.log(JSON.stringify(require(process.argv[1]).alerts["template-drift"]))' "$ROOT/seats/run/fleet-snapshot.json")"
WHEELHOUSE_TEMPLATE_DRIFT_ALERT_HOLD_MS=600000 DRIFT_JSON='{"error":null,"modified":[],"localOnly":[],"missing":[],"aheadBy":9}' run_alert bun seats/alerts.ts check --json
empty_current="$(node -e 'console.log(JSON.stringify(require(process.argv[1]).alerts["template-drift"]))' "$ROOT/seats/run/fleet-snapshot.json")"
[ "$RC" = 0 ] && [ "$(inbox_count)" = 1 ] && [ "$empty_first" = "$empty_current" ] && pass 'ahead-only drift holds once and never re-raises for count changes' || fail "empty set re-raised or reset state: $empty_current"

phase 'interval parsing'
clear_runtime; unset WHEELHOUSE_ALERT_INTERVAL_MS; run_alert bun seats/alerts.ts check --json; unset_interval="$(node -e 'console.log(require(process.argv[1]).intervalMs)' "$ROOT/seats/run/fleet-snapshot.json")"
[ $RC -eq 0 ] && [ "$unset_interval" = 60000 ] && pass 'unset WHEELHOUSE_ALERT_INTERVAL_MS records default interval' || fail "unset interval rc=$RC interval=$unset_interval out=$OUT"
clear_runtime; WHEELHOUSE_ALERT_INTERVAL_MS= run_alert bun seats/alerts.ts check --json; empty_interval="$(node -e 'console.log(require(process.argv[1]).intervalMs)' "$ROOT/seats/run/fleet-snapshot.json")"
[ $RC -eq 0 ] && [ "$empty_interval" = 60000 ] && pass 'empty WHEELHOUSE_ALERT_INTERVAL_MS records default interval' || fail "empty interval rc=$RC interval=$empty_interval out=$OUT"
clear_runtime; WHEELHOUSE_ALERT_INTERVAL_MS=0 run_alert bun seats/alerts.ts check --json; zero_interval="$(node -e 'console.log(require(process.argv[1]).intervalMs)' "$ROOT/seats/run/fleet-snapshot.json")"
[ $RC -eq 0 ] && [ "$zero_interval" = 0 ] && pass 'explicit zero WHEELHOUSE_ALERT_INTERVAL_MS is honoured in snapshot' || fail "zero interval rc=$RC interval=$zero_interval out=$OUT"

phase 'quarantine count transitions'
clear_runtime
for name in quarantine-a quarantine-b quarantine-c; do printf 'exit 0\n' > "$ROOT/seats/$name.selftest.sh"; done
printf 'quarantine-a.selftest.sh owner-a 2099-12-31\nquarantine-b.selftest.sh owner-b 2099-12-31\n' > "$ROOT/seats/selftest-quarantine.list"
run_alert bun seats/alerts.ts check --json
if [ "$RC" = 0 ] && node - "$ROOT" <<'JS'
const fs=require('fs'),a=require('assert/strict'),r=process.argv[2],s=JSON.parse(fs.readFileSync(r+'/seats/run/fleet-snapshot.json','utf8')),rows=fs.readFileSync(r+'/seats/inbox.jsonl','utf8').trim().split('\n').map(JSON.parse);a.deepEqual(s.quarantined,{count:2,names:['quarantine-a.selftest.sh','quarantine-b.selftest.sh']});a.equal(rows.length,1);a.equal(rows[0].source.name,'quarantine');a(rows[0].detail.includes('count=2'));
JS
then pass 'real snapshot names/count and one herald row at first nonzero quarantine'; else fail "quarantine snapshot transition: $OUT"; fi
run_alert bun seats/alerts.ts check --json
[ "$RC" = 0 ] && [ "$(inbox_count)" = 1 ] && pass 'unchanged quarantine poll is quiet' || fail 'duplicate quarantine row'
printf 'quarantine-a.selftest.sh owner-a 2099-12-31\n' > "$ROOT/seats/selftest-quarantine.list"
run_alert bun seats/alerts.ts check --json
[ "$RC" = 0 ] && [ "$(inbox_count)" = 2 ] && pass 'quarantine shrink emits one row' || fail 'quarantine shrink row missing'
printf '# cleared\n' > "$ROOT/seats/selftest-quarantine.list"
run_alert bun seats/alerts.ts check --json
[ "$RC" = 0 ] && [ "$(inbox_count)" = 3 ] && pass 'quarantine clear emits one row' || fail 'quarantine clear row missing'
cp -f "$ROOT/seats/alerts.ts" "$FIX/quarantine-alerts-source.ts"
bun - "$ROOT/seats/alerts.ts" <<'JS'
import fs from 'node:fs';const f=process.argv[2],s=fs.readFileSync(f,'utf8'),a='if(quarantined.count!==(prior?.quarantined?.count??0))';if(s.split(a).length!==2)throw Error('quarantine count guard changed');fs.writeFileSync(f,s.replace(a,'if(false)'));
JS
[ "$?" = 0 ] || exit 2
clear_runtime
printf 'quarantine-a.selftest.sh owner-a 2099-12-31\n' > "$ROOT/seats/selftest-quarantine.list"
run_alert bun seats/alerts.ts check --json
[ "$RC" = 0 ] && [ "$(inbox_count)" = 0 ] && pass 'canary: removing count notification loses the required inbox row' || fail 'quarantine count canary insensitive'
cp -f "$FIX/quarantine-alerts-source.ts" "$ROOT/seats/alerts.ts"
rm -f "$ROOT/seats/selftest-quarantine.list" "$ROOT"/seats/quarantine-*.selftest.sh
clear_runtime
phase 'claimed commander refusal surface'
if bun "$HERE/fixtures/commander-alert.ts" "$HERE" "$FIX/commander-alert"; then
  pass 'not-commander %12 alert/need/remedy, ok clear, and source controls'
else
  fail 'claimed commander refusal alert failed'
fi

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

ME_STARTED="$(bun -e 'import {spawnSync} from "node:child_process";const r=spawnSync("ps",["-p",process.argv[1],"-o","lstart="],{encoding:"utf8"});console.error("CAPTURE alerts fixture ps "+JSON.stringify({status:r.status,signal:r.signal,stdout:r.stdout,stderr:r.stderr}));if(r.status!==0||r.error||r.signal)process.exit(2);console.log(new Date(Date.parse(r.stdout.trim())).toISOString());' "$$")" || exit 2
clear_runtime; printf '{"seats":{"worker-a":{"pid":%s,"startedAt":"%s","log":"%s","lastCapacityEvent":{"at":"2026-01-01T00:00:00Z","detail":"synthetic"}}}}\n' $$ "$ME_STARTED" "$ROOT/seats/logs/worker-a.jsonl" > "$ROOT/seats/state.json"; run_alert bun seats/alerts.ts check --json
[ $RC -eq 0 ] && active capacity-events && pass 'capacity-events fires when state carries lastCapacityEvent' || fail "capacity failed rc=$RC out=$OUT"
for i in 1 2 3; do run_alert bun seats/alerts.ts check --json; done; [ "$(inbox_count)" = 1 ] && pass 'capacity-events stays quiet over 3 active runs' || fail "capacity not quiet"
node -e 'const fs=require("fs"), f=process.argv[1]; const j=JSON.parse(fs.readFileSync(f,"utf8")); j.seats["worker-b"]={pid:null,log:"x",lastCapacityEvent:{at:"2026-01-01T00:00:00Z",detail:"synthetic"}}; fs.writeFileSync(f,JSON.stringify(j));' "$ROOT/seats/state.json"; run_alert bun seats/alerts.ts check --json
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
[ $RC -eq 0 ] && ! active template-drift && [ "$(inbox_count)" = 0 ] && pass 'template-drift under default hold threshold writes no inbox row' || fail "short drift fired too early rc=$RC out=$OUT inbox=$(inbox_count)"
run_alert bun seats/alerts.ts check --json
[ $RC -eq 0 ] && ! active template-drift && [ "$(inbox_count)" = 0 ] && pass 'template-drift clearing before threshold stays quiet' || fail "short drift clear produced alert rc=$RC out=$OUT inbox=$(inbox_count)"
WHEELHOUSE_TEMPLATE_DRIFT_ALERT_HOLD_MS=600000 DRIFT_ON=1 run_alert bun seats/alerts.ts check --json
age_alert template-drift
WHEELHOUSE_TEMPLATE_DRIFT_ALERT_HOLD_MS=600000 DRIFT_ON=1 run_alert bun seats/alerts.ts check --json
[ $RC -eq 0 ] && active template-drift && [ "$(inbox_count)" = 1 ] && pass 'template-drift held past threshold fires exactly once' || fail "held drift failed rc=$RC out=$OUT inbox=$(inbox_count)"
for i in 1 2 3; do WHEELHOUSE_TEMPLATE_DRIFT_ALERT_HOLD_MS=600000 DRIFT_ON=1 run_alert bun seats/alerts.ts check --json; done; [ "$(inbox_count)" = 1 ] && pass 'template-drift stays quiet over 3 active runs' || fail "drift not quiet"
run_alert bun seats/alerts.ts check --json
[ $RC -eq 0 ] && grep -q 'alert cleared template-drift' "$ROOT/seats/logs/alerts.log" && pass 'template-drift clears after firing' || fail "drift clear failed"
WHEELHOUSE_TEMPLATE_DRIFT_ALERT_HOLD_MS=600000 DRIFT_ON=1 run_alert bun seats/alerts.ts check --json
[ $RC -eq 0 ] && ! active template-drift && [ "$(inbox_count)" = 1 ] && pass 'template-drift clear resets the hold clock' || fail "drift clock did not reset rc=$RC out=$OUT inbox=$(inbox_count)"
rm -f "$ROOT/seats/run/fleet-snapshot.json" "$ROOT/seats/inbox.jsonl" "$ROOT/seats/logs/alerts.log"
WHEELHOUSE_TEMPLATE_DRIFT_ALERT_HOLD_MS=0 DRIFT_AHEAD=1 run_alert bun seats/alerts.ts check --json
[ $RC -eq 0 ] && active template-drift && pass 'template-drift fires when template main is ahead without file drift after hold threshold' || fail "drift ahead failed rc=$RC out=$OUT"
run_alert bun seats/alerts.ts check --json
[ $RC -eq 0 ] && grep -q 'alert cleared template-drift' "$ROOT/seats/logs/alerts.log" && pass 'template-drift ahead clears' || fail "drift ahead clear failed"

phase 'drift failures are not drift; rows retain the concrete observation'
for mode in garbage empty schema crash signal compare-error; do
  clear_runtime; DRIFT_CASE="$mode" run_alert bun seats/alerts.ts check --json
  if [ "$RC" = 0 ] && node --input-type=module - "$ROOT" "$mode" <<'JS'
import fs from 'node:fs';import assert from 'node:assert/strict';const[root,mode]=process.argv.slice(2),j=JSON.parse(fs.readFileSync(root+'/seats/run/fleet-snapshot.json','utf8')),rows=fs.readFileSync(root+'/seats/inbox.jsonl','utf8').trim().split('\n').map(l=>JSON.parse(l));
assert.equal(j.drift.status,'check-failed');assert(j.drift.reason);assert.equal(j.alerts['template-drift'].active,false);assert.equal(j.alerts['template-drift-check-failed'].active,true);assert.equal(rows.length,1);assert.equal(rows[0].source.name,'template-drift-check-failed');assert(rows[0].detail.includes(j.drift.reason));assert.equal(j.alerts['template-drift-check-failed'].detail,rows[0].detail);
if(mode==='garbage')assert.equal(j.drift.stdout,'not-json\n');if(mode==='crash'){assert.equal(j.drift.exitCode,7);assert.equal(j.drift.stderr,'fixture crash\n');}if(mode==='signal')assert.equal(j.drift.signal,'SIGTERM');
JS
  then pass "drift $mode is check-failed with its reason, never template-drift"
  else fail "drift $mode classification/detail failed rc=$RC out=$OUT"; fi
 done
cat > "$FIX/drift-spawn-error.mjs" <<'JS'
import fs from 'node:fs';import * as cp from 'node:child_process';import {mock} from 'bun:test';
const original={...cp};
const spawnSync=(cmd,args,options)=>{
  if(cmd==='bash'&&args?.[0]?.endsWith('/template-drift.sh')){
    if(options?.timeout!==undefined)throw new Error('drift spawn still has a fixed timeout');
    if(typeof options?.stdio?.[2]==='number')fs.writeSync(options.stdio[2],'fixture partial stderr');
    return {status:null,signal:null,error:Object.assign(new Error('fixture spawn error ETIMEDOUT'),{code:'ETIMEDOUT'}),stdout:'',stderr:'fixture partial stderr'};
  }
  return original.spawnSync(cmd,args,options);
};
mock.module('node:child_process',()=>({...original,spawnSync,default:{...original.default,spawnSync}}));
JS
clear_runtime; run_alert bun --preload "$FIX/drift-spawn-error.mjs" seats/alerts.ts check --json
if [ "$RC" = 0 ] && node --input-type=module - "$ROOT" <<'JS'
import fs from 'node:fs';import assert from 'node:assert/strict';const j=JSON.parse(fs.readFileSync(process.argv[2]+'/seats/run/fleet-snapshot.json','utf8'));assert.equal(j.drift.status,'check-failed');assert(j.drift.reason.includes('ETIMEDOUT'));assert.equal(j.drift.stderr,'fixture partial stderr');assert.equal(j.alerts['template-drift'].active,false);
JS
then pass 'spawn error ETIMEDOUT is retained as check-failed without a drift deadline'; else fail "spawn error handling failed rc=$RC out=$OUT"; fi
clear_runtime; DRIFT_CASE=real run_alert bun seats/alerts.ts check --json
[ "$RC" = 0 ] && ! active template-drift && [ "$(inbox_count)" = 0 ] && pass 'real drift exit1 starts pending under the default hold' || fail "real drift fired before its hold rc=$RC out=$OUT"
age_alert template-drift
DRIFT_CASE=real run_alert bun seats/alerts.ts check --json
if [ "$RC" = 0 ] && node --input-type=module - "$ROOT" <<'JS'
import fs from 'node:fs';import assert from 'node:assert/strict';const root=process.argv[2],j=JSON.parse(fs.readFileSync(root+'/seats/run/fleet-snapshot.json','utf8')),rows=fs.readFileSync(root+'/seats/inbox.jsonl','utf8').trim().split('\n').map(l=>JSON.parse(l));assert.equal(j.drift.status,'drift');assert.equal(j.drift.exitCode,1);assert.equal(j.alerts['template-drift-check-failed'].active,false);assert.equal(rows.length,1);assert.equal(rows[0].source.name,'template-drift');for(const value of['template-drift','seats/example.ts','runbooks/local.md','runbooks/missing.md','aheadBy=1'])assert(rows[0].detail.includes(value),value);assert.equal(j.alerts['template-drift'].detail,rows[0].detail);
JS
then pass 'real drift exit1 names modified/local-only/missing files and ahead count in the row and snapshot'
else fail "real drift detail missing rc=$RC out=$OUT"; fi
run_alert bun seats/alerts.ts check --json
if node --input-type=module - "$ROOT" <<'JS'
import fs from 'node:fs';import assert from 'node:assert/strict';const j=JSON.parse(fs.readFileSync(process.argv[2]+'/seats/run/fleet-snapshot.json','utf8'));assert.equal(j.drift.status,'clean');assert.equal(j.alerts['template-drift'].active,false);assert(j.alerts['template-drift'].detail.includes('seats/example.ts'));
JS
then pass 'clear retains the concrete detail that previously fired'; else fail 'clear lost fired detail'; fi
if node --input-type=module - "$ROOT/seats/alerts.ts" <<'JS'
import fs from 'node:fs';import assert from 'node:assert/strict';const source=fs.readFileSync(process.argv[2],'utf8'),body=source.slice(source.indexOf('function driftInfo()'),source.indexOf('function alertRow('));assert(body.length>0);assert(!/\btimeout\s*:/.test(body));
JS
then pass 'drift check has no fixed wall-clock spawn budget'; else fail 'drift check still uses a wall-clock spawn budget'; fi

phase 'shared PID lock recovery and ownership'
mkdir -p "$FIX/lock-regressions"
if bun "$HERE/fixtures/lock-regression.ts" "$ROOT/seats/lock.ts" "$FIX/lock-regressions"; then
  pass 'shared lock regression: incomplete locks recover without stealing live owners'
else
  fail 'shared lock regression failed'
fi
for content in '' 'not a pid'; do
  rm -f "$ROOT/seats/run/fleet-snapshot.json"
  printf '%s' "$content" > "$ROOT/seats/run/alerts.lock"
  bun - "$ROOT/seats/run/alerts.lock" <<'JS'
const old=Date.now()/1000-60; (await import('node:fs')).default.utimesSync(process.argv[2],old,old);
JS
  run_alert bun seats/alerts.ts check --json
  [ $RC -eq 0 ] && [ -s "$ROOT/seats/run/fleet-snapshot.json" ] && [ ! -e "$ROOT/seats/run/alerts.lock" ] && pass "alerts writes a fresh snapshot after an old incomplete lock (${content:-empty})" || fail "incomplete alerts lock blocked snapshot rc=$RC out=$OUT"
done

phase 'crash-left lock consumer outcomes'
if bun "$HERE/fixtures/alerts-lock.ts" "$HERE" "$FIX/alerts-lock-cases"; then
  pass 'O1 stale-lock snapshot publication and O2 real-owner refusal; meaningful removals rejected'
else
  fail 'alerts lock consumer outcomes failed'
fi

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
# Exercise these legs as on stock macOS, even on hosts with coreutils. Keep
# only the fixture mocks and explicit runtime dependencies on the child PATH;
# neither timeout nor gtimeout can be found, including on GNU/Linux hosts.
CLOCK_BIN="$FIX/without-coreutils-timeout"; mkdir -p "$CLOCK_BIN"
for tool in bash bun node perl git ps df; do
  tool_path="$(command -v "$tool")"
  [ -x "$tool_path" ] || { fail "missing herald clock dependency: $tool"; exit 2; }
  ln -s "$tool_path" "$CLOCK_BIN/$tool"
done
CLOCK_PATH="$BIN:$CLOCK_BIN"
if (export PATH="$CLOCK_PATH"; hash -r; ! command -v timeout >/dev/null && ! command -v gtimeout >/dev/null && command -v perl >/dev/null && command -v bun >/dev/null); then
  pass 'herald clock PATH has no timeout or gtimeout and retains helper dependencies'
else
  fail 'herald clock PATH still exposes timeout/gtimeout or lacks helper dependencies'; exit 2
fi
# Native --once close while the child remains explicitly held is the verdict,
# not elapsed startup time. Controls execute a real child-completion FIFO read
# and remove the actual alerts clock, each failing at its own observed event.
if bun "$HERE/fixtures/alerts-clock.ts" "$FIX" "$ROOT" "$BIN" "$HOME_FIX" "$CLOCK_PATH"; then
  pass 'alerts snapshot and non-blocking scan observed; real blocking/missing-clock removals rejected'
else
  fail 'alerts clock scan protocol failed (see native event evidence above)'
fi

phase 'canary'
CAN="$FIX/canary"; cp -R "$ROOT" "$CAN"; bun - "$CAN/seats/alerts.ts" <<'JS'
const fs=(await import('node:fs')).default,p=process.argv[2],s=fs.readFileSync(p,'utf8'),needle='if(shouldFire)';
if(s.split(needle).length!==2) throw new Error('alert transition canary source changed');
fs.writeFileSync(p,s.replace(needle,'if(next.active)'));
JS
rm -f "$CAN/seats/inbox.jsonl" "$CAN/seats/run/fleet-snapshot.json"
CAN_RC=0
(cd "$CAN" && HOME="$HOME_FIX" PATH="$BIN:$PATH" WHEELHOUSE_ALERTS_ROOT="$CAN" BD_READY=1 bun seats/alerts.ts check >/dev/null 2>&1) || CAN_RC=$?
CCOUNT_FIRST="$( [ -f "$CAN/seats/inbox.jsonl" ] && wc -l < "$CAN/seats/inbox.jsonl" | tr -d ' ' || echo 0 )"
(cd "$CAN" && HOME="$HOME_FIX" PATH="$BIN:$PATH" WHEELHOUSE_ALERTS_ROOT="$CAN" BD_READY=1 bun seats/alerts.ts check >/dev/null 2>&1) || CAN_RC=$?
CCOUNT="$( [ -f "$CAN/seats/inbox.jsonl" ] && wc -l < "$CAN/seats/inbox.jsonl" | tr -d ' ' || echo 0 )"
[ "$CAN_RC" = 0 ] && [ "$CCOUNT_FIRST" -gt 0 ] && [ "$CCOUNT" -gt "$CCOUNT_FIRST" ] && pass 'canary: fire-on-every-run variant fails the stays-quiet leg' || fail "canary did not produce repeated alert rows rc=$CAN_RC first=$CCOUNT_FIRST after=$CCOUNT"

if [ "$FAILED" -eq 0 ]; then echo 'alerts.selftest.sh works on this machine.'; exit 0; fi
echo "alerts.selftest.sh FAIL ($FAILED failure(s))" >&2; exit 1
