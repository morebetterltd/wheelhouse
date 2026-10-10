#!/usr/bin/env bash
# fleet-gate.selftest.sh — hermetic checks for the prompt-path snapshot reader.
# Fixtures write synthetic seats/run/fleet-snapshot.json files only; no live
# herald, cockpit, commander pane, bd, gh, or adapter process is touched.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
GATE="${1:-$HERE/fleet-gate.sh}"
[ -f "$GATE" ] || { echo "selftest: not found: $GATE" >&2; exit 2; }

FAILED=0
pass(){ printf '  ok    %s\n' "$*"; }
fail(){ printf '  FAIL  %s\n' "$*"; FAILED=$((FAILED + 1)); }

FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-fleet-gate-selftest.XXXXXX")" || exit 2
cleanup(){ selftest_cleanup_fixture_processes "${FIX:-}"; selftest_remove_fixture_dir "$FIX"; }
trap cleanup EXIT INT TERM

PROJ="$FIX/proj"
mkdir -p "$PROJ/seats/run" "$PROJ/bin"
cp "$GATE" "$PROJ/seats/fleet-gate.sh"
chmod +x "$PROJ/seats/fleet-gate.sh"

write_snapshot(){
  local file="$PROJ/seats/run/fleet-snapshot.json"
  node - "$file" "$1" "$2" "$3" "$4" "$5" "$6" "${7:-}" <<'NODE'
const fs = require('fs');
const [file, ageSec, intervalMs, live, rostered, ready, review, alertsCsv=''] = process.argv.slice(2);
const alerts = {};
for (const name of alertsCsv.split(',').map(s => s.trim()).filter(Boolean)) alerts[name] = { active: true, since: '2026-01-01T00:00:00.000Z', lastFiredAt: '2026-01-01T00:00:00.000Z' };
for (const name of ['idle-fleet-ready-work','cold-seats-ready-work','inbox-lag','capacity-events','low-disk','commander-pane-invalid','untriaged-github-issues','template-drift']) if (!alerts[name]) alerts[name] = { active: false, since: null, lastFiredAt: null };
const n = Number(live);
const workers = Array.from({ length: n }, (_, i) => ({ name: `worker-${i+1}` }));
const backlog = Array.from({ length: Number(review) }, (_, i) => ({ id: `review-${i+1}` }));
const j = {
  at: new Date(Date.now() - Number(ageSec) * 1000).toISOString(),
  intervalMs: Number(intervalMs),
  snapshot: { readyCount: Number(ready), reviewBacklog: backlog, workers: { live: workers, rostered: Number(rostered), idle: n, busy: 0 } },
  herald: {}, inbox: {}, needs: {}, capacity: {}, disk: {}, github: {}, drift: {}, alerts,
};
fs.mkdirSync(require('path').dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n');
NODE
}
run_gate(){ OUT="$(cd "$PROJ" && env PATH="$PROJ/bin:$PATH" bash seats/fleet-gate.sh 2>&1)"; RC=$?; }
has(){ case "$OUT" in *"$1"*) return 0;; *) return 1;; esac; }

rm -f "$PROJ/seats/run/fleet-snapshot.json"
run_gate
if [ $RC -eq 0 ] && [ "$OUT" = '🚢 FLEET: no snapshot yet — run seats/cockpit.sh' ]; then
  pass 'missing snapshot prints the cockpit hint and exits 0'
else
  fail "missing snapshot output wrong rc=$RC out=$OUT"
fi

write_snapshot 2 60000 2 4 3 1 ""
run_gate
if [ $RC -eq 0 ] && [ "$OUT" = '🚢 FLEET: 2/4 seats live · 3 ready · 1 in review · alerts: none' ]; then
  pass 'fresh snapshot prints live/rostered, ready, review backlog, and no alerts'
else
  fail "fresh snapshot output wrong rc=$RC out=$OUT"
fi

write_snapshot 3 60000 1 3 5 2 "capacity-events,low-disk"
run_gate
if [ $RC -eq 0 ] && [ "$OUT" = '🚢 FLEET: 1/3 seats live · 5 ready · 2 in review · alerts: capacity-events, low-disk' ]; then
  pass 'active alerts are listed by name in the one-line reader output'
else
  fail "active alert output wrong rc=$RC out=$OUT"
fi

write_snapshot 190 60000 0 4 7 0 "cold-seats-ready-work"
run_gate
if [ $RC -eq 0 ] && has '🚢 FLEET: 0/4 seats live · 7 ready · 0 in review · alerts: cold-seats-ready-work · snapshot ' && has 's old — is the herald running?'; then
  pass 'stale snapshot appends age and herald-running hint'
else
  fail "stale snapshot output wrong rc=$RC out=$OUT"
fi

cat > "$PROJ/bin/bd" <<'SH'
#!/usr/bin/env bash
sleep 2
echo 'old fleet-gate should not call bd' >&2
exit 9
SH
cat > "$PROJ/bin/bun" <<'SH'
#!/usr/bin/env bash
sleep 2
echo 'old fleet-gate should not call bun adapter/status' >&2
exit 9
SH
cat > "$PROJ/bin/gh" <<'SH'
#!/usr/bin/env bash
sleep 2
echo 'old fleet-gate should not call gh' >&2
exit 9
SH
chmod +x "$PROJ/bin/bd" "$PROJ/bin/bun" "$PROJ/bin/gh"
write_snapshot 1 60000 1 2 0 0 ""
TIME_OUT="$(cd "$PROJ" && perl -MTime::HiRes=time -e '$t=time; system(qw(bash seats/fleet-gate.sh)); printf "ELAPSED=%.3f\n", time-$t' 2>&1)"; TIME_RC=$?
ELAPSED="$(printf '%s\n' "$TIME_OUT" | sed -n 's/^ELAPSED=//p' | tail -1)"
if [ $TIME_RC -eq 0 ] && printf '%s\n' "$TIME_OUT" | grep -q '🚢 FLEET: 1/2 seats live' && ELAPSED="$ELAPSED" perl -e 'exit(($ENV{ELAPSED}//9) < 1 ? 0 : 1)'; then
  pass 'reader finishes under 1s and does not call bd, gh, or adapter/bun stubs'
else
  fail "subsecond/no-slow-tools leg failed rc=$TIME_RC elapsed=${ELAPSED:-?} out=$TIME_OUT"
fi

printf '\n'
if [ $FAILED -eq 0 ]; then
  echo 'fleet-gate.sh works on this machine.'
  exit 0
fi
echo "$FAILED check(s) failed."
exit 1
