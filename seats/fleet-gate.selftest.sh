#!/usr/bin/env bash
# fleet-gate.selftest.sh — hermetic checks for the prompt-path snapshot reader.
# A real seats/run/fleet-snapshot.json is first produced by this branch's
# alerts.ts in a fixture; later legs mutate only fields present in that schema.
# No live herald, cockpit, commander pane, bd, gh, or adapter process is touched.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
GATE="${1:-$HERE/fleet-gate.sh}"
[ -f "$GATE" ] || { echo "selftest: not found: $GATE" >&2; exit 2; }
command -v bun >/dev/null 2>&1 || { echo "selftest: bun is required" >&2; exit 2; }

FAILED=0
pass(){ printf '  ok    %s\n' "$*"; }
fail(){ printf '  FAIL  %s\n' "$*"; FAILED=$((FAILED + 1)); }

FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-fleet-gate-selftest.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
cleanup(){ selftest_cleanup_fixture_processes "${FIX:-}"; selftest_remove_fixture_dir "$FIX"; }
selftest_install_cleanup_traps cleanup

PROJ="$FIX/proj"; BIN="$FIX/bin"; HOME_FIX="$FIX/home"
mkdir -p "$PROJ/seats/run" "$PROJ/seats/logs" "$PROJ/wheelhouse" "$PROJ/contracts" "$BIN" "$HOME_FIX"
cp "$GATE" "$PROJ/seats/fleet-gate.sh"
chmod +x "$PROJ/seats/fleet-gate.sh"
for f in nightly-state.ts quarantine.ts alerts.ts selftest-sweep-lock.ts seat-settled.ts fleet-snapshot.ts native-command.ts completed-command.ts roster.ts pool.ts seat-activity.ts seat-stream-health.ts seat-worktree.ts credential-shapes.ts harness.ts needs.ts template-drift.sh lock.ts; do cp "$HERE/$f" "$PROJ/seats/$f"; done
chmod +x "$PROJ/seats/template-drift.sh"
cat > "$PROJ/seats/template-drift.sh" <<'SH'
#!/usr/bin/env bash
printf '{"error":null,"modified":[],"localOnly":[],"missing":[],"aheadBy":0,"comparedAgainst":"fixture"}\n'
SH
chmod +x "$PROJ/seats/template-drift.sh"
cat > "$PROJ/wheelhouse/.template-source" <<'EOF'
namespace=fleetgate
alert-low-disk-gb=0
github-issue-watch=off
EOF
cat > "$PROJ/seats/seats.json" <<'JSON'
{"seats":{"worker-a":{"role":"worker","runtime":"pi","account":{"dir":"~/.pi-seats-fleetgate/worker-a"}},"worker-b":{"role":"worker","runtime":"pi","account":{"dir":"~/.pi-seats-fleetgate/worker-b"}},"commander":{"role":"commander","external":true}}}
JSON
cat > "$BIN/bd" <<'SH'
#!/usr/bin/env bash
case "$1 $2" in
  "ready --json") printf '[{"id":"ready-1","title":"Ready 1"},{"id":"ready-2","title":"Ready 2"},{"id":"ready-3","title":"Ready 3"}]\n' ;;
  "list --json") printf '[{"id":"review-1","title":"Review","labels":["needs-review"],"status":"open","issue_type":"task","created_at":"2026-01-01T00:00:00Z","dependencies":[]}]\n' ;;
  "list --status") printf '[]\n' ;;
  *) printf '[]\n' ;;
esac
SH
cat > "$BIN/gh" <<'SH'
#!/usr/bin/env bash
exit 1
SH
chmod +x "$BIN/bd" "$BIN/gh"
( cd "$PROJ" && git init -q -b main && git config user.email selftest@example.invalid && git config user.name selftest && git add seats wheelhouse contracts && git commit -q -m base )
SIGNALS="$HERE/fixtures/adapter-selftest-signals.ts"
(cd "$FIX" && exec bun "$SIGNALS" hold "$FIX/p1.release" "$FIX/p1.ready") & P1=$!
(cd "$FIX" && exec bun "$SIGNALS" hold "$FIX/p2.release" "$FIX/p2.ready") & P2=$!
bun "$SIGNALS" exists "$FIX/p1.ready" '' 0 "$P1" || exit 2
bun "$SIGNALS" exists "$FIX/p2.ready" '' 0 "$P2" || exit 2
export LIFECYCLE_COMMAND_HELPER="$HERE/completed-command.ts"
bun - "$PROJ" "$P1" "$P2" <<'JS'
import fs from 'node:fs';import assert from 'node:assert/strict';
const {completedCommand}=await import(process.env.LIFECYCLE_COMMAND_HELPER);
const [root,...pids]=process.argv.slice(2),seats={};
for(const [i,pid]of pids.entries()){
 const r=completedCommand('ps',['-p',pid,'-o','lstart=']);
 console.error('CAPTURE fleet-gate fixture ps '+JSON.stringify({pid,status:r.status,signal:r.signal,stdout:r.stdout,stderr:r.stderr}));
 assert.equal(r.status,0);assert.equal(r.signal,null);assert.equal(r.error,undefined);
 seats['worker-'+String.fromCharCode(97+i)]={pid:Number(pid),startedAt:new Date(Date.parse(r.stdout.trim())).toISOString(),log:root+'/seats/logs/worker-'+String.fromCharCode(97+i)+'.jsonl'};
}
fs.writeFileSync(root+'/seats/state.json',JSON.stringify({seats}));
JS
printf '%s\n' '{"type":"agent_end","timestamp":"2026-01-01T00:00:00Z"}' > "$PROJ/seats/logs/worker-a.jsonl"
printf '%s\n' '{"type":"agent_end","timestamp":"2026-01-01T00:00:00Z"}' > "$PROJ/seats/logs/worker-b.jsonl"

run_alert(){ OUT="$(cd "$PROJ" && env HOME="$HOME_FIX" PATH="$BIN:$PATH" WHEELHOUSE_ALERTS_ROOT="$PROJ" WHEELHOUSE_ALERT_INTERVAL_MS=60000 bun seats/alerts.ts check --json 2>&1)"; RC=$?; }
run_gate(){ OUT="$(cd "$PROJ" && env PATH="$BIN:$PATH" bash seats/fleet-gate.sh 2>&1)"; RC=$?; }
run_gate_from(){ OUT="$(cd "$1" && shift && env PATH="$BIN:$PATH" CLAUDE_PROJECT_DIR="$PROJ" "$@" 2>&1)"; RC=$?; }
has(){ case "$OUT" in *"$1"*) return 0;; *) return 1;; esac; }
mutate_snapshot(){ node - "$PROJ/seats/run/fleet-snapshot.json" "$@" <<'NODE'
const fs = require('fs');
const [file, mode, alertsCsv=''] = process.argv.slice(2);
const j = JSON.parse(fs.readFileSync(file, 'utf8'));
if (mode === 'fresh') j.at = new Date(Date.now() - 2000).toISOString();
if (mode === 'stale') j.at = new Date(Date.now() - 190000).toISOString();
for (const a of Object.values(j.alerts || {})) a.active = false;
for (const name of alertsCsv.split(',').map(s => s.trim()).filter(Boolean)) {
  if (!j.alerts[name]) throw new Error(`real snapshot lacks alert ${name}`);
  j.alerts[name].active = true;
}
fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n');
NODE
}

rm -f "$PROJ/seats/run/fleet-snapshot.json"
run_gate
if [ $RC -eq 0 ] && [ "$OUT" = '🚢 FLEET: no snapshot yet — run seats/cockpit.sh' ]; then
  pass 'missing snapshot prints the cockpit hint and exits 0'
else
  fail "missing snapshot output wrong rc=$RC out=$OUT"
fi

run_alert
cp "$PROJ/seats/run/fleet-snapshot.json" "$FIX/real-fleet-snapshot.json"
if [ $RC -eq 0 ] && [ -s "$FIX/real-fleet-snapshot.json" ] && node -e 'const j=require(process.argv[1]); if (j.snapshot.workers.rostered !== undefined) process.exit(1); if (!Array.isArray(j.snapshot.workers.live) || j.snapshot.workers.live.length !== 2) process.exit(2); if (j.snapshot.readyCount !== 3) process.exit(3); if (!Array.isArray(j.snapshot.reviewBacklog) || j.snapshot.reviewBacklog.length !== 1) process.exit(4);' "$FIX/real-fleet-snapshot.json"; then
  pass 'fixture captured a real alerts.ts snapshot with the producer schema and no workers.rostered'
else
  fail "real snapshot capture failed rc=$RC out=$OUT snapshot=$(cat "$PROJ/seats/run/fleet-snapshot.json" 2>/dev/null || echo missing)"
fi

cp "$FIX/real-fleet-snapshot.json" "$PROJ/seats/run/fleet-snapshot.json"; mutate_snapshot fresh
run_gate
if [ $RC -eq 0 ] && [ "$OUT" = '🚢 FLEET: 2 seats live · 3 ready · 1 in review · alerts: none' ]; then
  pass 'fresh real-schema snapshot prints live, ready, review backlog, and no alerts'
else
  fail "fresh snapshot output wrong rc=$RC out=$OUT"
fi

node - "$PROJ/seats/run/fleet-snapshot.json" <<'JS'
const fs=require('fs'),f=process.argv[2],j=JSON.parse(fs.readFileSync(f,'utf8'));j.quarantined={count:2,names:['a.selftest.sh','b.selftest.sh']};fs.writeFileSync(f,JSON.stringify(j));
JS
run_gate
[ "$RC" = 0 ] && has 'quarantine: 2' && pass 'snapshot quarantine count prints on Node path' || fail "quarantine count missing: $OUT"
run_bun_gate(){ OUT="$(cd "$PROJ"; command(){ if [ "$*" = '-v node' ]; then return 1; fi; builtin command "$@"; }; export -f command; bash seats/fleet-gate.sh 2>&1)"; RC=$?; }
run_bun_gate
[ "$RC" = 0 ] && has 'quarantine: 2' && pass 'snapshot quarantine count prints on Bun fallback' || fail "Bun quarantine count missing: $OUT"
cp -f "$PROJ/seats/fleet-gate.sh" "$FIX/quarantine-gate-source.sh"
node - "$PROJ/seats/fleet-gate.sh" <<'JS'
const fs=require('fs'),f=process.argv[2],s=fs.readFileSync(f,'utf8'),q=' · quarantine: ${j.quarantined.count}';if(s.split(q).length!==3)throw Error('both gate display sites required');fs.writeFileSync(f,s.split(q).join(''));
JS
[ "$?" = 0 ] || exit 2
run_gate
[ "$RC" = 0 ] && ! has 'quarantine: 2' && pass 'canary: removing display loses Node quarantine count' || fail 'Node quarantine canary insensitive'
run_bun_gate
[ "$RC" = 0 ] && ! has 'quarantine: 2' && pass 'canary: removing display loses Bun quarantine count' || fail 'Bun quarantine canary insensitive'
cp -f "$FIX/quarantine-gate-source.sh" "$PROJ/seats/fleet-gate.sh"
cp -f "$FIX/real-fleet-snapshot.json" "$PROJ/seats/run/fleet-snapshot.json"; mutate_snapshot fresh

PRODUCT="$PROJ/product-checkout"
mkdir -p "$PRODUCT/seats"
cp "$PROJ/seats/fleet-gate.sh" "$PRODUCT/seats/fleet-gate.sh"
chmod +x "$PRODUCT/seats/fleet-gate.sh"
run_gate_from "$PRODUCT" bash seats/fleet-gate.sh
if [ $RC -eq 0 ] && [ "$OUT" = '🚢 FLEET: no snapshot yet — run seats/cockpit.sh' ]; then
  pass 'canary: cwd-relative documented hook from a nested checkout reads the nested missing snapshot'
else
  fail "cwd-relative hook canary output wrong rc=$RC out=$OUT"
fi
run_gate_from "$PRODUCT" bash -c 'bash "$CLAUDE_PROJECT_DIR/seats/fleet-gate.sh"'
if [ $RC -eq 0 ] && [ "$OUT" = '🚢 FLEET: 2 seats live · 3 ready · 1 in review · alerts: none' ]; then
  pass 'project-root-anchored hook command reads the real fleet snapshot from a nested checkout'
else
  fail "anchored hook output wrong rc=$RC out=$OUT"
fi

cp "$FIX/real-fleet-snapshot.json" "$PROJ/seats/run/fleet-snapshot.json"; mutate_snapshot fresh 'capacity-events,low-disk'
run_gate
if [ $RC -eq 0 ] && [ "$OUT" = '🚢 FLEET: 2 seats live · 3 ready · 1 in review · alerts: capacity-events, low-disk' ]; then
  pass 'active alerts from the real schema are listed by name'
else
  fail "active alert output wrong rc=$RC out=$OUT"
fi

cp "$FIX/real-fleet-snapshot.json" "$PROJ/seats/run/fleet-snapshot.json"; mutate_snapshot stale 'cold-seats-ready-work'
run_gate
if [ $RC -eq 0 ] && has '🚢 FLEET: 2 seats live · 3 ready · 1 in review · alerts: cold-seats-ready-work · snapshot ' && has 's old — is the herald running?'; then
  pass 'stale real-schema snapshot appends age and herald-running hint'
else
  fail "stale snapshot output wrong rc=$RC out=$OUT"
fi

export FLEET_GATE_TOOL_CALLS="$FIX/forbidden-tool-calls"
: > "$FLEET_GATE_TOOL_CALLS"
for tool in bd bun gh; do
  cat > "$BIN/$tool" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "${0##*/} $*" >> "$FLEET_GATE_TOOL_CALLS"
echo 'snapshot reader must not delegate to live tools' >&2
exit 9
SH
 done
chmod +x "$BIN/bd" "$BIN/bun" "$BIN/gh"
cp "$FIX/real-fleet-snapshot.json" "$PROJ/seats/run/fleet-snapshot.json"; mutate_snapshot fresh
TIME_RC=0
bun - "$HERE/completed-command.ts" "$PROJ" "$BIN" "$FIX/reader.stdout" <<'JS' || TIME_RC=$?
import fs from 'node:fs';
const [moduleFile,root,bin,capture]=process.argv.slice(2),{completedCommand}=await import(moduleFile);
const native=completedCommand('bash',['seats/fleet-gate.sh'],{cwd:root,env:{...process.env,PATH:bin+':'+process.env.PATH}});
fs.writeFileSync(capture,native.stdout);fs.writeFileSync(capture+'.stderr',native.stderr);
console.log('CAPTURE snapshot reader '+JSON.stringify(native));
process.exit(native.error||native.signal||native.status===null?1:native.status);
JS
TIME_OUT="$(cat "$FIX/reader.stdout")"
printf 'CAPTURE snapshot reader harness=%s forbidden-tools=%s\n' "$TIME_RC" "$(cat "$FLEET_GATE_TOOL_CALLS")"
if [ $TIME_RC -eq 0 ] && printf '%s\n' "$TIME_OUT" | grep >/dev/null '🚢 FLEET: 2 seats live' && ! printf '%s\n' "$TIME_OUT" | grep >/dev/null '2/2 seats live' && [ ! -s "$FLEET_GATE_TOOL_CALLS" ]; then
  pass 'reader completes without live tool calls or invented rostered count; no throughput verdict'
else
  fail "snapshot/no-live-tools/no-rostered leg failed rc=$TIME_RC calls=$(cat "$FLEET_GATE_TOOL_CALLS") out=$TIME_OUT"
fi

printf 'explicit owner release\n' > "$FIX/p1.release"
printf 'explicit owner release\n' > "$FIX/p2.release"
wait "$P1"; P1_RC=$?; wait "$P2"; P2_RC=$?
printf 'CAPTURE fleet-gate holder exits=%s/%s after owner release\n' "$P1_RC" "$P2_RC"
[ "$P1_RC" = 0 ] && [ "$P2_RC" = 0 ] || fail 'fixture holder died before explicit release'
printf '\n'
if [ $FAILED -eq 0 ]; then
  echo 'fleet-gate.sh works on this machine.'
  exit 0
fi
echo "$FAILED check(s) failed."
exit 1
