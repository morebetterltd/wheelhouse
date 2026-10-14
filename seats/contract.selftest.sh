#!/usr/bin/env bash
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/selftest-lib.sh"
CONTRACT="${1:-$HERE/contract.ts}"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-contract.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
cleanup(){ selftest_cleanup_fixture_processes "$FIX"; selftest_remove_fixture_dir "$FIX"; }
trap cleanup EXIT
FAILED=0
pass(){ echo "PASS $*"; }
fail(){ echo "FAIL $*"; FAILED=$((FAILED+1)); }
leg(){
  local name="$1" expected="$2" error="$3" out rc=0
  out="$(bun "$CONTRACT" check --file "$HERE/fixtures/contracts/$name.md" 2>&1)" || rc=$?
  if [ "$rc" = "$expected" ] && { [ -z "$error" ] || grep -Fq "$error" <<<"$out"; }; then pass "$name (exit $rc)"; else fail "$name expected exit $expected + '$error', got $rc: $out"; fi
}
# Intent-only linter never reads the graph. All fixtures are owned by this run.
mkdir -p "$FIX/intents"
intent_leg(){
  local name="$1" text="$2" expected="$3" error="$4" rc=0
  printf '%s' "$text" > "$FIX/intents/$name.md"
  bun "$CONTRACT" lint-intent --file "$FIX/intents/$name.md" > "$FIX/intents/$name.out" 2> "$FIX/intents/$name.err" || rc=$?
  if [ "$rc" = "$expected" ] && { [ -z "$error" ] || grep -Fq "$error" "$FIX/intents/$name.err"; } && [ ! -s "$FIX/intents/$name.out" ] && { { [ "$expected" = 0 ] && [ ! -s "$FIX/intents/$name.err" ]; } || { [ "$expected" != 0 ] && [ "$(wc -l < "$FIX/intents/$name.err" | tr -d ' ')" = 1 ]; }; }; then
    pass "lint-intent $name (exit $rc)"
  else fail "lint-intent $name expected exit $expected + '$error', got $rc: $(<"$FIX/intents/$name.err")"; fi
}
intent_leg paragraph $'Intent:\nMake the shared list easier to trust, so people avoid repeated shopping.\n' 0 ''
intent_leg three-paragraphs $'Intent:\nMake the shared list easier to trust.\n\nPeople need a clear record of what is bought.\n\nThis avoids repeated shopping.\n' 0 ''
intent_leg crlf $'Intent:\r\nMake the list clear so people can coordinate.\r\n' 0 ''
intent_leg no-header $'Make the list clear.\n' 2 'line 1: expected the literal Intent: header'
intent_leg leading-blank $'\nIntent:\nMake the list clear.\n' 2 'line 1: expected the literal Intent: header'
intent_leg empty $'Intent:\n\n \t\n' 2 'line 2: Intent: needs at least one non-blank paragraph'
intent_leg numbered-dot $'Intent:\nMake the list clear.\n1. edit the file\n' 2 'line 3: numbered build step: 1. edit the file'
intent_leg numbered-paren $'Intent:\nMake the list clear.\n  2) rebuild it\n' 2 'line 3: numbered build step:'
intent_leg outcome $'Intent:\nMake the list clear.\n  - O2 It is clear\n' 2 'line 3: outcome row:'
intent_leg consumer $'Intent:\nMake the list clear.\n  consumer: person-reading\n' 2 'line 3: outcome field:'
intent_leg surface $'Intent:\nMake the list clear.\n  surface: the list\n' 2 'line 3: outcome field:'
intent_leg check $'Intent:\nMake the list clear.\n\tcheck: read\n' 2 'line 3: outcome field:'
intent_leg outcomes $'Intent:\nMake the list clear.\nOutcomes:\n' 2 'line 3: Outcomes: header is not part of an intent:'
intent_leg first-offense $'Intent:\nMake the list clear.\n1. edit the file\n\nconsumer: someone\n' 2 'line 3: numbered build step: 1. edit the file'
intent_leg quoted-header $'> Intent:\nMake the list clear.\n' 2 'line 1: expected the literal Intent: header'
intent_leg prose-number $'Intent:\nMake the list clear for 2 households, so people can coordinate.\n' 0 ''
RC=0
bun "$CONTRACT" lint-intent --file "$FIX/intents/missing.md" > "$FIX/intents/missing.out" 2> "$FIX/intents/missing.err" || RC=$?
[ "$RC" = 2 ] && grep -Fq 'lint-intent: cannot read file:' "$FIX/intents/missing.err" && pass 'lint-intent unreadable (exit 2)' || fail "lint-intent unreadable rc=$RC"
if [ "${WHEELHOUSE_INTENT_LINT_ONLY:-0}" = 1 ]; then
  [ "$FAILED" = 0 ] && { echo 'intent lint selftest: PASS'; exit 0; }
  echo "intent lint selftest: FAIL ($FAILED failures)"; exit 1
fi

leg valid 0 ''
leg no-intent 2 'contract: Intent: missing'
leg empty-intent 2 'contract: Intent: must contain'
leg no-outcomes 2 'contract: Outcomes: missing'
leg outcome-no-surface 2 'O1: surface: missing'
leg outcome-no-consumer 2 'O1: consumer: missing'
leg group-check-mismatch 2 'O1: check: person-on-surface requires walk'
leg duplicate-ids 2 'O1: id: duplicate'
leg bad-group-token 2 'O1: consumer: unknown group "robot"'

# Real bd output, not a guessed JSON envelope: isolated scratch graph.
eval "$(selftest_scratch_graph "$FIX/graph")" || exit 2
VALID_JSON="$(bd create 'Valid contract fixture' --body-file "$HERE/fixtures/contracts/valid.md" --json)" || exit 2
INVALID_JSON="$(bd create 'Invalid contract fixture' --body-file "$HERE/fixtures/contracts/outcome-no-surface.md" --json)" || exit 2
VALID_ID="$(printf '%s' "$VALID_JSON" | bun -e 'import fs from "node:fs";process.stdout.write(JSON.parse(fs.readFileSync(0,"utf8")).id)')"
INVALID_ID="$(printf '%s' "$INVALID_JSON" | bun -e 'import fs from "node:fs";process.stdout.write(JSON.parse(fs.readFileSync(0,"utf8")).id)')"
[ -n "$VALID_ID" ] && [ -n "$INVALID_ID" ] || exit 2
bd update "$INVALID_ID" --status in_progress >/dev/null || exit 2
RC=0; OUT="$(env -u WHEELHOUSE_SKIP_BD -u WHEELHOUSE_CONTRACT_FIXTURE WHEELHOUSE_CONTRACT_ROOT="$FIX/graph" bun "$CONTRACT" audit 2>&1)" || RC=$?
if [ "$RC" = 1 ] && grep -Fq "$INVALID_ID: O1: surface: missing" <<<"$OUT" && ! grep -Fq "$VALID_ID" <<<"$OUT" && [ "$(wc -l <<<"$OUT" | tr -d ' ')" = 1 ]; then pass "audit (exit 1; invalid id printed once, valid id absent)"; else fail "audit rc=$RC: $OUT"; fi
RC=0; OUT="$(env -u WHEELHOUSE_SKIP_BD -u WHEELHOUSE_CONTRACT_FIXTURE WHEELHOUSE_CONTRACT_ROOT="$FIX/graph" bun "$CONTRACT" check "$VALID_ID" 2>&1)" || RC=$?
[ "$RC" = 0 ] && pass 'read real bd show JSON from overridden root' || fail "bd JSON check rc=$RC: $OUT"

mkdir -p "$FIX/bin"
printf '#!/bin/sh\necho fixture-bd-unavailable >&2\nexit 7\n' > "$FIX/bin/bd"; chmod +x "$FIX/bin/bd"
RC=0; OUT="$(env -u WHEELHOUSE_CONTRACT_FIXTURE WHEELHOUSE_SKIP_BD=1 bun "$CONTRACT" check unreadable-bead 2>&1)" || RC=$?
[ "$RC" = 3 ] && grep -Fq 'unreadable-bead: contract: unreadable:' <<<"$OUT" && pass 'skip-bd without fixture refuses unreadable (exit 3)' || fail "missing fixture rc=$RC: $OUT"
RC=0; OUT="$(env -u WHEELHOUSE_SKIP_BD -u WHEELHOUSE_CONTRACT_FIXTURE PATH="$FIX/bin:$PATH" bun "$CONTRACT" check unreadable-bead 2>&1)" || RC=$?
[ "$RC" = 3 ] && grep -Fq 'fixture-bd-unavailable' <<<"$OUT" && pass 'failed bd read refuses unreadable (exit 3)' || fail "bd failure rc=$RC: $OUT"
RC=0; OUT="$(env -u WHEELHOUSE_SKIP_BD WHEELHOUSE_CONTRACT_FIXTURE="$HERE/fixtures/contracts/valid.md" PATH="$FIX/bin:$PATH" bun "$CONTRACT" check fallback-bead 2>&1)" || RC=$?
[ "$RC" = 0 ] && pass 'failed bd read uses explicit fixture (exit 0)' || fail "fallback fixture rc=$RC: $OUT"
RC=0; OUT="$(env -u WHEELHOUSE_SKIP_BD PATH="$FIX/bin:$PATH" bun "$CONTRACT" audit 2>&1)" || RC=$?
[ "$RC" = 3 ] && grep -Fq 'audit: bd list open unreadable:' <<<"$OUT" && pass 'unreadable audit is exit 3, never a clean empty graph' || fail "audit failure rc=$RC: $OUT"

# API flags are opt-in; the default K1 gates do not enforce sibling features.
RC=0; OUT="$(CONTRACT="$CONTRACT" VALID="$HERE/fixtures/contracts/valid.md" bun -e '
import fs from "node:fs";
const m=await import(process.env.CONTRACT);
const p=m.parseContract(fs.readFileSync(process.env.VALID,"utf8"));
if(p.trace!=="contract parser fixture"||p.integration!=="fleet/fixture-goal"||p.signal!=="isa-gap: K1"||p.skills!=="intent@1.0.0 outcomes@1.0.0"||p.outcomes.length!==3)throw Error("parsed fields lost");
p.signal="";p.skills="";
if(m.validateContract(p).length)throw Error("default flags enforced siblings");
if(!m.validateContract(p,{requireSkills:true}).some(e=>e.includes("Skills:")))throw Error("requireSkills ignored");
if(!m.validateContract(p,{requireSignal:true}).some(e=>e.includes("Signal:")))throw Error("requireSignal ignored");
console.log("parsed fields + opt-in flags");' 2>&1)" || RC=$?
[ "$RC" = 0 ] && pass 'parse fields and optional Skills/Signal flags' || fail "API rc=$RC: $OUT"

if [ "$FAILED" = 0 ]; then echo 'contract.selftest: PASS'; exit 0; fi
echo "contract.selftest: FAIL ($FAILED failures)"; exit 1
