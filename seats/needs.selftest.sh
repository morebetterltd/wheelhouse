#!/usr/bin/env bash
SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"
set -uo pipefail
# Ordinary round trips exercise the commander; actor-specific legs opt in.
unset BEADS_ACTOR
HERE="$(cd "$(dirname "$0")" && pwd -P)"
SCRIPT="${1:-$HERE/needs.ts}"
SCRUB="$HERE/evidence-scrub.sh"
[ -x "$SCRIPT" ] || { echo "selftest: not executable: $SCRIPT" >&2; exit 2; }
[ -x "$SCRUB" ] || { echo "selftest: not executable: $SCRUB" >&2; exit 2; }
command -v bun >/dev/null 2>&1 || { echo "selftest: bun is required" >&2; exit 2; }
exec > >("$SCRUB") 2> >("$SCRUB" >&2)
FAILED=0; FIX=""
pass(){ printf '  ok    %s\n' "$*"; }
fail(){ printf '  FAIL  %s\n' "$*"; FAILED=$((FAILED+1)); }
phase(){ printf '\n%s\n' "$*"; }
cleanup(){ selftest_cleanup_fixture_processes "${FIX:-}"; [ -n "$FIX" ] && selftest_remove_fixture_dir "$FIX"; return 0; }
trap cleanup EXIT INT TERM
mkdir -p "${TMPDIR:-/tmp}"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-needs-selftest.$$.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
FIX="$(cd "$FIX" && pwd -P)" || exit 2
ROOT="$FIX/proj"; mkdir -p "$ROOT/seats" "$ROOT/wheelhouse"
printf 'namespace=wheelhouse-project\n' > "$ROOT/wheelhouse/.template-source"
cat > "$ROOT/seats/seats.json" <<'JSON'
{ "seats": { "worker-1": { "role": "worker" }, "reviewer": { "role": "verifier" }, "commander": { "role": "commander" } } }
JSON
RUN_SCRIPT="$SCRIPT"
run(){ RC=0; OUT="$(WHEELHOUSE_NEEDS_ROOT="$ROOT" bun "$RUN_SCRIPT" "$@" 2>&1)" || RC=$?; }
says(){ case "$OUT" in *"$1"*) return 0;; *) return 1;; esac; }
json(){ WHEELHOUSE_NEEDS_ROOT="$ROOT" bun "$RUN_SCRIPT" "$@"; }
phase "1. open/list/answer/show/close round trip"
run open --title "Pick the release window" --body "Can we deploy after lunch?" --option "yes: Deploy after lunch" --option "no: Hold until tomorrow" --default "yes; applies if no objection by noon" --consequence "Default deploys" --kind approval --bead wheelhouse-project-abcd --seat worker-1 --source release-window
if [ $RC -eq 0 ] && [[ "$OUT" =~ ^need-[a-z0-9]{4}$ ]]; then NEED="$OUT"; pass "open prints a need id"; else NEED=""; fail "open failed or printed wrong id (rc=$RC): $OUT"; fi
if grep -q '"type":"opened"' "$ROOT/seats/needs.jsonl" && grep -q '"source":"release-window"' "$ROOT/seats/needs.jsonl"; then pass "ledger records an opened JSONL event with machine source"; else fail "opened event missing from ledger: $(cat "$ROOT/seats/needs.jsonl" 2>/dev/null)"; fi
run list; if [ $RC -eq 0 ] && says "$NEED open approval" && says "Pick the release window"; then pass "list shows the open need"; else fail "list did not show open need (rc=$RC): $OUT"; fi
run say "$NEED" "Thanks, a short answer is enough."; if [ $RC -eq 0 ] && grep -q '"from":"commander"' "$ROOT/seats/needs.jsonl"; then pass "say appends a commander message"; else fail "say failed (rc=$RC): $OUT"; fi
run answer "$NEED" yes --via desk; if [ $RC -eq 0 ]; then pass "answer exits 0"; else fail "answer failed (rc=$RC): $OUT"; fi
run list --unread; if [ $RC -eq 0 ] && says "$NEED answered approval"; then pass "list --unread shows an unread human answer"; else fail "list --unread missed unread answer (rc=$RC): $OUT"; fi
SHOW="$(json show "$NEED")"; if printf '%s\n' "$SHOW" | grep >/dev/null '"state": "answered"' && printf '%s\n' "$SHOW" | grep >/dev/null '"choice": "yes"' && printf '%s\n' "$SHOW" | grep >/dev/null '"type": "read"'; then pass "show folds answered state and records a read marker"; else fail "show did not fold answered state/read marker: $SHOW"; fi
run list --unread; if [ $RC -eq 0 ] && ! says "$NEED"; then pass "show clears list --unread for the answer"; else fail "show did not clear unread answer (rc=$RC): $OUT"; fi
run say "$NEED" "A commander follow-up does not make it unread."; run list --unread; if [ $RC -eq 0 ] && ! says "$NEED"; then pass "commander messages do not create unread human-answer state"; else fail "commander message made need unread (rc=$RC): $OUT"; fi
run read "$NEED"; run list --unread; if [ $RC -eq 0 ] && ! says "$NEED"; then pass "explicit read command is idempotent and leaves no unread answer"; else fail "explicit read command left unread output (rc=$RC): $OUT"; fi
run close "$NEED" --reason handled; [ $RC -eq 0 ] && pass "close exits 0" || fail "close failed (rc=$RC): $OUT"
SHOW="$(json show "$NEED")"; if printf '%s\n' "$SHOW" | grep >/dev/null '"state": "closed"' && printf '%s\n' "$SHOW" | grep >/dev/null '"reason": "handled"'; then pass "show folds close into closed state"; else fail "show did not fold closed state: $SHOW"; fi
run list; if [ $RC -eq 0 ] && ! says "$NEED"; then pass "list hides closed needs by default"; else fail "closed need appeared without --all: $OUT"; fi
run list --all; if [ $RC -eq 0 ] && says "$NEED closed"; then pass "list --all includes closed needs"; else fail "list --all missed closed need: $OUT"; fi
phase "2. --from-stdin and --source dedupe"
RC=0; OUT="$(printf '@principal: Need the invoice total\nPlease answer with the final total.\n' | WHEELHOUSE_NEEDS_ROOT="$ROOT" bun "$RUN_SCRIPT" open --from-stdin --source invoice-total 2>&1)" || RC=$?
if [ $RC -eq 0 ] && [[ "$OUT" =~ ^need-[a-z0-9]{4}$ ]]; then NEED2="$OUT"; pass "--from-stdin opens a need from an @principal block"; else NEED2=""; fail "--from-stdin failed (rc=$RC): $OUT"; fi
RC=0; OUT2="$(printf '@principal: Need the invoice total again\nDifferent body should dedupe.\n' | WHEELHOUSE_NEEDS_ROOT="$ROOT" bun "$RUN_SCRIPT" open --from-stdin --source invoice-total 2>&1)" || RC=$?
if [ $RC -eq 0 ] && [ "$OUT2" = "$NEED2" ]; then pass "--source repeat is a no-op that prints the existing id"; else fail "--source did not dedupe (rc=$RC first=$NEED2 second=$OUT2)"; fi
COUNT="$(grep -c '"source":"invoice-total"' "$ROOT/seats/needs.jsonl" || true)"; [ "$COUNT" -eq 1 ] && pass "source dedupe appended only one opened event" || fail "source dedupe wrote $COUNT opened events"
phase "3. human-facing text refusals and warnings"
run open --title x --body "see wheelhouse-project-abcd"; if [ $RC -eq 2 ] && says "wheelhouse-project-abcd"; then pass "id-pattern refusal exits 2 and names the token"; else fail "id-pattern refusal failed (rc=$RC): $OUT"; fi
run open --title x --body "this bead is blocked"; if [ $RC -eq 2 ] && says "bead"; then pass "bead-word refusal exits 2 and names the token"; else fail "bead-word refusal failed (rc=$RC): $OUT"; fi
run open --title "Ask worker-1" --body "Please decide" --source seat-warning; if [ $RC -eq 0 ] && says "WARN: human-facing text mentions roster seat worker-1"; then pass "rostered seat names warn but do not block"; else fail "seat-name warning missing or blocked open (rc=$RC): $OUT"; fi
phase "4. WHEELHOUSE_NEEDS_ROOT override and JSON listing"
[ -s "$ROOT/seats/needs.jsonl" ] && pass "ledger was written under WHEELHOUSE_NEEDS_ROOT" || fail "ledger was not written under WHEELHOUSE_NEEDS_ROOT"
LIST_JSON="$(json list --json --all)"; if printf '%s\n' "$LIST_JSON" | grep >/dev/null '"id": "need-' && printf '%s\n' "$LIST_JSON" | grep >/dev/null '"state": "closed"'; then pass "list --json --all prints folded JSON state"; else fail "list --json --all output wrong: $LIST_JSON"; fi
phase "5. unread human messages are durable until show"
MSG_NEED="need-msg1"
cat >> "$ROOT/seats/needs.jsonl" <<JSONL
{"type":"opened","id":"$MSG_NEED","at":"2026-09-21T00:00:00.000Z","kind":"question","title":"Message need","body":"Need a human note","options":[],"machine":{}}
{"type":"message","id":"$MSG_NEED","at":"2026-09-21T00:01:00.000Z","from":"human","via":"desk","text":"Here is the note"}
JSONL
run list --unread; if [ $RC -eq 0 ] && says "$MSG_NEED open question"; then pass "list --unread shows an unread human message"; else fail "list --unread missed human message (rc=$RC): $OUT"; fi
SHOW="$(json show "$MSG_NEED")"; run list --unread; if [ $RC -eq 0 ] && ! says "$MSG_NEED" && printf '%s\n' "$SHOW" | grep >/dev/null '"type": "read"'; then pass "show clears unread human message"; else fail "show did not clear human message (rc=$RC out=$OUT show=$SHOW)"; fi
phase "6. only the commander opens, says, and closes; sentinel relay is once"
STOP_NEEDS='STOP: seats do not open needs; write a line beginning @commander: in your own output and the commander opens the need'
ledger_sha(){ [ -s "$ROOT/seats/needs.jsonl" ] || return 2; shasum -a 256 "$ROOT/seats/needs.jsonl" | awk '{print $1}'; }
BEFORE="$(ledger_sha)"
BEADS_ACTOR=worker-1 run open --title t --body b
[ "$RC" -eq 2 ] && [ "$OUT" = "$STOP_NEEDS" ] && [ "$(ledger_sha)" = "$BEFORE" ] && pass 'actor refusal: worker open exits 2 with exact STOP and byte-identical ledger' || fail "worker open refusal rc=$RC: $OUT"
BEADS_ACTOR=reviewer run say "$NEED2" 'Please decide'
[ "$RC" -eq 2 ] && [ "$OUT" = "$STOP_NEEDS" ] && [ "$(ledger_sha)" = "$BEFORE" ] && pass 'say refusal: reviewer exits 2 with exact STOP and byte-identical ledger' || fail "reviewer say refusal rc=$RC: $OUT"
BEADS_ACTOR=worker-1 run close "$NEED2"
[ "$RC" -eq 2 ] && [ "$OUT" = "$STOP_NEEDS" ] && [ "$(ledger_sha)" = "$BEFORE" ] && pass 'close refusal: worker exits 2 without a ledger write' || fail "worker close refusal rc=$RC: $OUT"
WHEELHOUSE_BEADS_ACTOR_WORKER_1=fixture-worker-alias BEADS_ACTOR=fixture-worker-alias run open --title t --body b
[ "$RC" -eq 2 ] && [ "$OUT" = "$STOP_NEEDS" ] && [ "$(ledger_sha)" = "$BEFORE" ] && pass 'actor override maps back to the roster worker and refuses without a write' || fail "worker override refusal rc=$RC: $OUT"
BEADS_ACTOR=someone-not-rostered run open --title t --body b --source unknown-actor
[ "$RC" -eq 0 ] && [[ "$OUT" =~ ^need-[a-z0-9]{4}$ ]] && pass 'actor not on the roster may open a need' || fail "unrostered actor open rc=$RC: $OUT"
BEADS_ACTOR=commander run open --title t --body b --source commander-actor
COMMANDER_RC="$RC"; COMMANDER_ID="$OUT"
WHEELHOUSE_BEADS_ACTOR_COMMANDER=fixture-commander-alias BEADS_ACTOR=fixture-commander-alias run open --title t --body b --source commander-alias
[ "$COMMANDER_RC" -eq 0 ] && [[ "$COMMANDER_ID" =~ ^need-[a-z0-9]{4}$ ]] && [ "$RC" -eq 0 ] && [[ "$OUT" =~ ^need-[a-z0-9]{4}$ ]] && pass 'roster commander and its actor override may open needs' || fail "commander role/override open rc=$COMMANDER_RC/$RC: $COMMANDER_ID / $OUT"
run open --title 'Sentinel question' --body 'Please decide' --source sentinel:abc123
SENTINEL_ID="$OUT"; SENTINEL_RC="$RC"; AFTER_FIRST="$(ledger_sha)"
run open --title 'Sentinel question replay' --body 'Please decide again' --source sentinel:abc123
SECOND_RC="$RC"; SECOND_ID="$OUT"; AFTER_SECOND="$(ledger_sha)"
run close "$SENTINEL_ID"; CLOSE_RC="$RC"; AFTER_CLOSE="$(ledger_sha)"
run open --title 'Old sentinel re-read' --body 'Must not reopen' --source sentinel:abc123
COUNT="$(grep -c '"source":"sentinel:abc123"' "$ROOT/seats/needs.jsonl" || true)"
[ "$SENTINEL_RC" -eq 0 ] && [ "$SECOND_RC" -eq 0 ] && [ "$CLOSE_RC" -eq 0 ] && [ "$RC" -eq 0 ] && [ "$SENTINEL_ID" = "$SECOND_ID" ] && [ "$SENTINEL_ID" = "$OUT" ] && [ "$AFTER_FIRST" = "$AFTER_SECOND" ] && [ "$AFTER_CLOSE" = "$(ledger_sha)" ] && [ "$COUNT" -eq 1 ] && pass 'sentinel source dedupe: two opens and a third after close write one opened event' || fail "sentinel source dedupe failed rc=$SENTINEL_RC/$SECOND_RC/$CLOSE_RC/$RC ids=$SENTINEL_ID/$SECOND_ID/$OUT count=$COUNT"
run open --title 'Recurring question' --body 'Please decide' --source recurring-question
OLD_ID="$OUT"; run close "$OLD_ID"; run open --title 'New occurrence' --body 'Please decide' --source recurring-question
COUNT="$(grep -c '"source":"recurring-question"' "$ROOT/seats/needs.jsonl" || true)"
[ "$RC" -eq 0 ] && [ "$OLD_ID" != "$OUT" ] && [ "$COUNT" -eq 2 ] && pass 'non-sentinel source still reopens after close' || fail "ordinary source behavior changed rc=$RC old=$OLD_ID new=$OUT count=$COUNT"
phase "7. canary — refusal removal is caught"
SAB="$FIX/needs-no-refusal.ts"
perl -0pe 's/export function humanTextGuard\(text:string, where:string, root=ROOT\)\{.*?\nfunction seatNames/export function humanTextGuard(text:string, where:string, root=ROOT){ }\nfunction seatNames/s' "$SCRIPT" > "$SAB"
chmod +x "$SAB"
if cmp -s "$SCRIPT" "$SAB"; then fail "canary: could not remove refusal function; pattern no longer matches"; else BEFORE=$FAILED; RUN_SCRIPT="$SAB"; run open --title x --body "see wheelhouse-project-abcd"; RUN_SCRIPT="$SCRIPT"; if [ $RC -eq 2 ]; then FAILED=$((BEFORE+1)); fail "canary: sabotaged script still refused the forbidden id, so this test proves nothing"; else FAILED=$BEFORE; pass "canary: removing the human-text refusal is caught"; fi; fi
printf '\n'; if [ $FAILED -eq 0 ]; then echo "needs.ts works on this machine."; exit 0; fi; echo "$FAILED check(s) failed."; exit 1
