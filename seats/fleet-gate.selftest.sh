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
cleanup(){ selftest_cleanup_fixture_processes "${FIX:-}"; selftest_remove_fixture_dir "$FIX"; }
trap cleanup EXIT INT TERM

PROJ="$FIX/proj"; BIN="$FIX/bin"; HOME_FIX="$FIX/home"
mkdir -p "$PROJ/seats/run" "$PROJ/seats/logs" "$PROJ/wheelhouse" "$PROJ/contracts" "$BIN" "$HOME_FIX"
cp "$GATE" "$PROJ/seats/fleet-gate.sh"
chmod +x "$PROJ/seats/fleet-gate.sh"
for f in alerts.ts fleet-snapshot.ts roster.ts pool.ts seat-activity.ts seat-worktree.ts credential-shapes.ts harness.ts needs.ts template-drift.sh lock.ts; do cp "$HERE/$f" "$PROJ/seats/$f"; done
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
(sleep 1000) & P1=$!; (sleep 1000) & P2=$!
cat > "$PROJ/seats/state.json" <<JSON
{"seats":{"worker-a":{"pid":$P1,"log":"$PROJ/seats/logs/worker-a.jsonl"},"worker-b":{"pid":$P2,"log":"$PROJ/seats/logs/worker-b.jsonl"}}}
JSON
printf '%s\n' '{"type":"agent_end","timestamp":"2026-01-01T00:00:00Z"}' > "$PROJ/seats/logs/worker-a.jsonl"
printf '%s\n' '{"type":"agent_end","timestamp":"2026-01-01T00:00:00Z"}' > "$PROJ/seats/logs/worker-b.jsonl"

run_alert(){ OUT="$(cd "$PROJ" && env HOME="$HOME_FIX" PATH="$BIN:$PATH" WHEELHOUSE_ALERTS_ROOT="$PROJ" WHEELHOUSE_ALERT_INTERVAL_MS=60000 bun seats/alerts.ts check --json 2>&1)"; RC=$?; }
run_gate(){ OUT="$(cd "$PROJ" && env PATH="$BIN:$PATH" bash seats/fleet-gate.sh 2>&1)"; RC=$?; }
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

cat > "$BIN/bd" <<'SH'
#!/usr/bin/env bash
sleep 2
echo 'old fleet-gate should not call bd' >&2
exit 9
SH
cat > "$BIN/bun" <<'SH'
#!/usr/bin/env bash
sleep 2
echo 'old fleet-gate should not call bun adapter/status' >&2
exit 9
SH
cat > "$BIN/gh" <<'SH'
#!/usr/bin/env bash
sleep 2
echo 'old fleet-gate should not call gh' >&2
exit 9
SH
chmod +x "$BIN/bd" "$BIN/bun" "$BIN/gh"
cp "$FIX/real-fleet-snapshot.json" "$PROJ/seats/run/fleet-snapshot.json"; mutate_snapshot fresh
TIME_OUT="$(cd "$PROJ" && perl -MTime::HiRes=time -e '$t=time; system(qw(bash seats/fleet-gate.sh)); printf "ELAPSED=%.3f\n", time-$t' 2>&1)"; TIME_RC=$?
ELAPSED="$(printf '%s\n' "$TIME_OUT" | sed -n 's/^ELAPSED=//p' | tail -1)"
if [ $TIME_RC -eq 0 ] && printf '%s\n' "$TIME_OUT" | grep -q '🚢 FLEET: 2 seats live' && ! printf '%s\n' "$TIME_OUT" | grep -q '2/2 seats live' && ELAPSED="$ELAPSED" perl -e 'exit(($ENV{ELAPSED}//9) < 1 ? 0 : 1)'; then
  pass 'reader finishes under 1s, uses no slow tools, and does not ask for absent rostered count'
else
  fail "subsecond/no-slow-tools/no-rostered leg failed rc=$TIME_RC elapsed=${ELAPSED:-?} out=$TIME_OUT"
fi

printf '\n'
if [ $FAILED -eq 0 ]; then
  echo 'fleet-gate.sh works on this machine.'
  exit 0
fi
echo "$FAILED check(s) failed."
exit 1
