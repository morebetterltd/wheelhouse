#!/usr/bin/env bash

SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"
# bootstrap-dynamic-staffing.selftest.sh — documentation and fixture checks for
# BOOTSTRAP question 11's optional dynamic-staffing records. This is synthetic:
# it never provisions real seats, starts herald/cockpit, or touches live panes.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd -P)"
ROOT="$(cd "$HERE/.." && pwd -P)"
BOOTSTRAP="$ROOT/BOOTSTRAP.md"
FAILED=0
pass() { printf '  ok    %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; FAILED=$((FAILED + 1)); }
phase() { printf '\n%s\n' "$*"; }

FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-bootstrap-dynamic-staffing.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
cleanup(){ selftest_cleanup_fixture_processes "$FIX"; selftest_remove_fixture_dir "$FIX"; }
selftest_install_cleanup_traps cleanup

copy_pool_runtime() {
  local dst="$1"
  mkdir -p "$dst/seats" "$dst/wheelhouse" "$dst/home/.pi-seats-scratch/pool/claude-a" "$dst/home/.pi-seats-scratch/pool/claude-b"
  selftest_copy_seat_runtime "$dst" "$HERE"
  printf 'namespace=scratch\n' > "$dst/wheelhouse/.template-source"
}

phase "1. BOOTSTRAP asks optional dynamic staffing after stakeholder channels"
if node - "$BOOTSTRAP" <<'JS'
const fs = require('fs');
const text = fs.readFileSync(process.argv[2], 'utf8');
const needles = [
  '10. **Stakeholder channels',
  '11. **Dynamic staffing — optional.',
  '12. **Publishing findings to GitHub:',
  'a `roles.reviewers` pool means no non-external `role: "reviewer"` entries remain',
  'Keep commander, producer and researcher outside the pool.',
  'seats/seat-env.sh <namespace> --pool <entry>',
  'Fixed roster',
  'Dynamic staffing',
  'write no `seats/pool.json`',
  'The absence of this file is the fixed-roster switch',
  'Every generated pool must load through `pool.ts`',
  'a `roles.workers` pool means no non-external `role: "worker"` entries remain in `seats.json`',
  'fix: remove <seat> from seats/seats.json or remove <role> from the pool',
  'bun seats/adapter.ts probe --entry <entry>',
  'with a dynamic worker pool, run `bun seats/staffing.ts check` now',
  'Use Q8\'s harness-round labels exactly',
  'PI_CODING_AGENT_DIR="$HOME/.pi-seats-<namespace>/pool/<entry>" pi --list-models',
  'optional public label',
  'a role whose `min` equals its `max` is fine',
  'entry | harness | provider | models | login folder | label | auth route',
  'At wake, read `bun seats/staffing.ts status` beside `bun seats/adapter.ts status` when a pool exists',
];
const missing = needles.filter(n => !text.includes(n));
if (missing.length) {
  console.log('missing: '+JSON.stringify(missing));
  process.exit(1);
}
const interview = text.split('1. **Product repos,')[1].split('### Record what the interview decided')[0];
const numbers = [...interview.matchAll(/^(\d+)\. \*\*/gm)].map(m => Number(m[1]));
if (JSON.stringify(numbers) !== JSON.stringify(Array.from({length:11}, (_,i) => i+2))) {
  console.log('interview numbering after question 1: '+JSON.stringify(numbers));
  process.exit(1);
}
if (text.includes('designer') || text.includes('reviewers` replace `role: "verifier"`')) {
  console.log('retired role in pool interview');
  process.exit(1);
}
JS
then pass "question 11 is ordered after channels and names skip/write/refusal rules"
else fail "BOOTSTRAP dynamic-staffing question text is missing or misordered"; fi

phase "2. fixed-roster skip path writes no pool file and pool.ts reports fixed roster"
SKIP="$FIX/skip"; copy_pool_runtime "$SKIP"
cat > "$SKIP/seats/seats.json" <<'JSON'
{"version":1,"seats":{"worker-1":{"role":"worker","harness":"pi","provider":"openai","model":"gpt-4o","account":{"dir":"~/.pi-seats-scratch/worker-1","authRoute":"oauth"}}}}
JSON
cp "$SKIP/seats/seats.json" "$SKIP/seats/seats.before.json"
rm -f "$SKIP/seats/pool.json"
OUT="$(cd "$SKIP" && HOME="$SKIP/home" bun seats/pool.ts check 2>&1)"; RC=$?
if [ "$RC" -eq 0 ] && [ "$OUT" = 'pool: none (fixed roster)' ] && [ ! -e "$SKIP/seats/pool.json" ] && cmp -s "$SKIP/seats/seats.before.json" "$SKIP/seats/seats.json"; then
  pass "skip path leaves seats/pool.json absent, preserves seats.json, and validator says fixed roster"
else
  fail "skip path rc=$RC out=$OUT pool_exists=$([ -e "$SKIP/seats/pool.json" ] && echo yes || echo no) seats_changed=$(! cmp -s "$SKIP/seats/seats.before.json" "$SKIP/seats/seats.json" && echo yes || echo no)"
fi

phase "3. generated pool loads through pool.ts after same-role fixed rows are removed"
OK="$FIX/ok"; copy_pool_runtime "$OK"
cat > "$OK/seats/seats.json" <<'JSON'
{"version":1,"seats":{"producer":{"role":"producer","external":true}}}
JSON
cat > "$OK/seats/pool.json" <<'JSON'
{"version":1,"entries":{"claude-a":{"harness":"claude-code","provider":"anthropic","models":["sonnet"],"account":{"dir":"~/.pi-seats-scratch/pool/claude-a","authRoute":"oauth"}},"claude-b":{"harness":"claude-code","provider":"anthropic","models":["sonnet"],"account":{"dir":"~/.pi-seats-scratch/pool/claude-b","authRoute":"oauth"}}},"roles":{"workers":{"min":1,"max":2,"entries":["claude-a","claude-b"],"model":"sonnet"}}}
JSON
OUT="$(cd "$OK" && HOME="$OK/home" bun seats/pool.ts check 2>&1)"; RC=$?
if [ "$RC" -eq 0 ] && [ "$OUT" = 'pool: 2 entries, workers 1..2 (2 entries), reviewers 0..0 (0 entries)' ]; then
  pass "accepted dynamic pool validates through pool.ts"
else
  fail "valid generated pool rc=$RC out=$OUT"
fi

phase "4. fixed row for a pooled role is refused with a named fix"
BAD="$FIX/bad"; copy_pool_runtime "$BAD"
cat > "$BAD/seats/seats.json" <<'JSON'
{"version":1,"seats":{"worker-1":{"role":"worker","harness":"pi","provider":"openai","model":"gpt-4o","account":{"dir":"~/.pi-seats-scratch/worker-1","authRoute":"oauth"}}}}
JSON
cp "$OK/seats/pool.json" "$BAD/seats/pool.json"
OUT="$(cd "$BAD" && HOME="$BAD/home" bun seats/pool.ts check 2>&1)"; RC=$?
if [ "$RC" -eq 2 ] && printf '%s\n' "$OUT" | grep -q 'the pool replaces the fixed roster for workers' && printf '%s\n' "$OUT" | grep -q 'fix: remove worker-1 from seats/seats.json or remove workers from the pool'; then
  pass "pool.ts refusal names the fixed-row repair"
else
  fail "fixed-row refusal rc=$RC out=$OUT"
fi

if [ "$FAILED" -eq 0 ]; then
  echo "bootstrap-dynamic-staffing.selftest: PASS"
  exit 0
fi
printf 'bootstrap-dynamic-staffing.selftest: FAIL (%s failure(s))\n' "$FAILED"
exit 1
