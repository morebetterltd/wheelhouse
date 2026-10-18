#!/usr/bin/env bash
set -u
SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"
command -v bun >/dev/null 2>&1 || { echo "selftest: bun required" >&2; exit 2; }
command -v git >/dev/null 2>&1 || { echo "selftest: git required" >&2; exit 2; }
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-digest-selftest.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
PASS=0; FAIL=0
cleanup(){ selftest_remove_fixture_dir "$FIX"; }
trap cleanup EXIT INT TERM
pass(){ PASS=$((PASS+1)); echo "ok $PASS - $*"; }
fail(){ FAIL=$((FAIL+1)); echo "not ok $((PASS+FAIL)) - $*" >&2; }
run_digest(){ HOME="$FAKE_HOME" WHEELHOUSE_DIGEST_ROOT="$PROJ" PATH="$PROJ/bin:$PATH" bun "$PROJ/seats/digest.ts" "$@"; }
assert_contains(){ printf '%s' "$1" | grep >/dev/null -- "$2"; }

PROJ="$FIX/project"; FAKE_HOME="$FIX/fake-home"; mkdir -p "$PROJ/bin" "$PROJ/seats/logs" "$PROJ/seats/verdicts" "$PROJ/wheelhouse" "$FAKE_HOME"
selftest_copy_seat_runtime "$PROJ" "$ROOT/seats"
cat > "$PROJ/wheelhouse/.template-source" <<EOF
namespace=demo
source=https://github.com/example/template.git
product-repo=product
EOF
cat > "$PROJ/seats/seats.json" <<'EOF'
{"seats":{"worker-1":{"role":"worker","provider":"codex","model":"gpt-fixture"},"reviewer":{"role":"reviewer","provider":"claude-code","model":"sonnet-fixture","account":{"dir":"SECRET-SHOULD-NOT-PRINT","label":"claude-code-oauth-demo-own"}}}}
EOF
cat > "$PROJ/seats/pool.json" <<'EOF'
{"version":1,"entries":{"pool-a":{"account":{"label":"pool-oauth-demo-own"}}},"roles":{}}
EOF
PRODUCT="$PROJ/product"; mkdir -p "$PRODUCT"; git -C "$PRODUCT" init -q; git -C "$PRODUCT" config user.email selftest@example.invalid; git -C "$PRODUCT" config user.name selftest
printf base > "$PRODUCT/file.txt"; git -C "$PRODUCT" add file.txt; GIT_AUTHOR_DATE=2026-01-01T10:00:00Z GIT_COMMITTER_DATE=2026-01-01T10:00:00Z git -C "$PRODUCT" commit -q -m base; git -C "$PRODUCT" checkout -q -b feat; printf feat >> "$PRODUCT/file.txt"; GIT_AUTHOR_DATE=2026-01-01T11:00:00Z GIT_COMMITTER_DATE=2026-01-01T11:00:00Z git -C "$PRODUCT" commit -am 'demo-ship feature' -q; SECOND="$(git -C "$PRODUCT" rev-parse HEAD)"; git -C "$PRODUCT" checkout -q main; printf main >> "$PRODUCT/main.txt"; git -C "$PRODUCT" add main.txt; GIT_AUTHOR_DATE=2026-01-01T11:30:00Z GIT_COMMITTER_DATE=2026-01-01T11:30:00Z git -C "$PRODUCT" commit -q -m main; GIT_AUTHOR_DATE=2026-01-01T12:30:00Z GIT_COMMITTER_DATE=2026-01-01T12:30:00Z git -C "$PRODUCT" merge --no-ff -q feat -m 'Merge demo-ship Build the package'; MERGE="$(git -C "$PRODUCT" rev-parse HEAD)"; git -C "$PRODUCT" remote add origin https://github.com/example/product.git
SINCE=2026-01-01T00:00:00Z; UNTIL=2026-01-02T00:00:00Z
cat > "$PROJ/bin/bd" <<'EOF'
#!/usr/bin/env bash
set -u
args="$*"
if printf '%s' "$args" | grep >/dev/null -- '--status closed'; then cat "$WHEELHOUSE_FIXTURE_CLOSED"; exit 0; fi
if printf '%s' "$args" | grep >/dev/null -- '--label needs-review'; then cat "$WHEELHOUSE_FIXTURE_REVIEW"; exit 0; fi
printf '[]\n'
EOF
chmod +x "$PROJ/bin/bd"
export WHEELHOUSE_FIXTURE_CLOSED="$PROJ/closed.json" WHEELHOUSE_FIXTURE_REVIEW="$PROJ/review.json"
cat > "$PROJ/closed.json" <<EOF
[{"id":"demo-ship","title":"Build the package","status":"closed","created_at":"2026-01-01T11:00:00Z","closed_at":"2026-01-01T12:30:00Z","close_reason":"merged $MERGE to main","description":"done"},
 {"id":"demo-goal","title":"Goal branch task","status":"closed","created_at":"2026-01-01T13:00:00Z","closed_at":"2026-01-01T13:30:00Z","close_reason":"closed demo-goal on fleet/goal at abc1234","description":"done"},
 {"id":"demo-goal2","title":"Goal branch without id","status":"closed","created_at":"2026-01-01T13:00:00Z","closed_at":"2026-01-01T13:40:00Z","close_reason":"Integrated on goal branch fleet/dynamic-staffing at abc5678","description":"done"},
 {"id":"demo-bulk1","title":"closed holder","created_at":"2026-01-01T14:00:00Z","closed_at":"2026-01-01T14:00:02Z","description":""},
 {"id":"demo-bulk2","title":"closed holder","created_at":"2026-01-01T14:00:10Z","closed_at":"2026-01-01T14:00:12Z","description":""},
 {"id":"demo-bulk3","title":"closed holder","created_at":"2026-01-01T14:00:20Z","closed_at":"2026-01-01T14:00:22Z","description":""},
 {"id":"demo-small1","title":"two only","created_at":"2026-01-01T15:00:00Z","closed_at":"2026-01-01T15:00:02Z","description":""},
 {"id":"demo-small2","title":"two only","created_at":"2026-01-01T15:00:10Z","closed_at":"2026-01-01T15:00:12Z","description":""},
 {"id":"demo-unnamed","title":"Unrelated close","created_at":"2026-01-01T17:00:00Z","closed_at":"2026-01-01T17:30:00Z","close_reason":"closed after discussion","description":"done"}]
EOF
cat > "$PROJ/review.json" <<'EOF'
[{"id":"demo-review","title":"Review the package","created_at":"2026-01-01T12:00:00Z"},{"id":"demo-back","title":"Fix the retry"},{"id":"demo-back2","title":"Fix the docs"},{"id":"demo-back3","title":"Explain the refusal"}]
EOF
cat > "$PROJ/seats/verdicts/demo-ship.md" <<'EOF'
- verdict: APPROVE — NOT BENCHED: fixture qualifier survives
- push: NOT CONSIDERED — recheck demo-ship before publishing
EOF
cat > "$PROJ/seats/inbox.jsonl" <<'EOF'
{"at":"2026-01-01T12:00:00Z","seat":"verifier-gate","class":"settle","state":"terminal","title":"verifier gate verdict — demo-ship","detail":"VERDICT: APPROVE — first round"}
{"at":"2026-01-01T12:20:00Z","seat":"verifier-gate","class":"settle","state":"terminal","title":"verifier gate verdict — demo-ship","detail":"VERDICT: APPROVE — second round"}
{"at":"2026-01-01T12:10:00Z","seat":"worker-1","class":"settle","state":"terminal","title":"seat turn settled — demo-review","detail":"done"}
{"at":"2026-01-01T12:12:00Z","seat":"verifier-gate","class":"settle","state":"terminal","title":"verifier gate verdict — demo-back","detail":"VERDICT: BOUNCE — tests failed"}
{"at":"2026-01-01T12:30:00Z","seat":"worker-1","class":"settle","state":"terminal","title":"seat turn settled — demo-back","detail":"rework done"}
{"at":"2026-01-01T12:40:00Z","seat":"verifier-gate","class":"settle","state":"terminal","title":"verifier gate verdict — demo-back2","detail":"VERDICT: BOUNCE — docs missing"}
{"at":"2025-12-31T23:30:00Z","seat":"verifier-gate","class":"settle","state":"terminal","title":"verifier gate verdict — demo-before","detail":"VERDICT: BOUNCE — old reason"}
{"at":"2026-01-01T12:45:00Z","seat":"verifier-gate","class":"settle","state":"terminal","title":"verifier gate verdict — demo-back3","detail":"VERDICT: BOUNCE"}
{"at":"2026-01-01T13:00:00Z","seat":"verifier-gate","class":"distress","state":"failed","title":"verifier gate STOP — demo-stop-ok","detail":"STOP: timed out after 600000ms with account label claude-code-oauth-demo-own at [[PROJ]]/scratch and [[HOME]]/cache; this detail is deliberately long long long long long long long long long long long long long long long long long long long long long long long long END-SHOULD-BE-TRUNCATED\nelapsed 1200000ms"}
{"at":"2026-01-01T13:10:00Z","seat":"verifier-gate","class":"settle","state":"terminal","title":"verifier gate verdict — demo-stop-ok","detail":"VERDICT: APPROVE — recovered"}
{"at":"2026-01-01T13:20:00Z","seat":"verifier-gate","class":"distress","state":"failed","title":"verifier gate STOP — demo-stop-bad","detail":"STOP: no verdict\nelapsed 60000ms"}
{"at":"2026-01-01T13:30:00Z","seat":"worker-1","class":"settle","state":"stalled","title":"seat turn stalled","detail":"stalled"}
{"at":"2026-01-01T13:45:00Z","seat":"worker-1","class":"settle","state":"terminal","title":"seat turn settled — demo-other","detail":"resumed"}
{"at":"2026-01-01T13:35:00Z","seat":"worker-2","class":"settle","state":"stalled","title":"seat turn stalled","detail":"stalled"}
{"at":"2026-01-01T13:50:00Z","seat":"worker-2","class":"settle","state":"terminal","title":"seat turn settled — demo-other2","detail":"resumed"}
{"at":"2026-01-01T16:00:00Z","class":"alert","state":"fired","title":"disk low","detail":"alert fired"}
{"at":"2025-12-31T23:59:59Z","class":"alert","state":"fired","title":"outside old","detail":"out"}
{"at":"2026-01-02T00:00:01Z","class":"alert","state":"fired","title":"outside new","detail":"out"}
EOF
perl -0pi -e "s|\[\[PROJ\]\]|$PROJ|g; s|\[\[HOME\]\]|$FAKE_HOME|g" "$PROJ/seats/inbox.jsonl"
cat > "$PROJ/seats/needs.jsonl" <<'EOF'
{"type":"opened","id":"need-open","at":"2026-01-01T10:00:00Z","kind":"question","title":"Choose release train","body":"Which train?","options":[],"machine":{}}
{"type":"opened","id":"need-clear","at":"2026-01-01T09:00:00Z","kind":"approval","title":"Approve fixture","body":"Approve?","options":[],"machine":{"bead":"demo-need"}}
{"type":"answered","id":"need-clear","at":"2026-01-01T11:00:00Z","from":"human","via":"selftest","text":"yes"}
EOF
OUT="$(run_digest --since "$SINCE" --until "$UNTIL")"
# 1 order + empties on empty records
EMPTY="$FIX/empty"; mkdir -p "$EMPTY/seats" "$EMPTY/wheelhouse" "$EMPTY/bin"; selftest_copy_seat_runtime "$EMPTY" "$ROOT/seats"; printf 'namespace=empty\nproduct-repo=.\n' > "$EMPTY/wheelhouse/.template-source"; (cd "$EMPTY" && git init -q && git config user.email a@b && git config user.name a && touch x && git add x && git commit -q -m x); cp "$PROJ/bin/bd" "$EMPTY/bin/bd"; printf '[]\n' > "$EMPTY/closed.json"; printf '[]\n' > "$EMPTY/review.json"; EO="$(WHEELHOUSE_DIGEST_ROOT="$EMPTY" WHEELHOUSE_FIXTURE_CLOSED="$EMPTY/closed.json" WHEELHOUSE_FIXTURE_REVIEW="$EMPTY/review.json" PATH="$EMPTY/bin:$PATH" bun "$EMPTY/seats/digest.ts" --since "$SINCE" --until "$UNTIL")"
if printf '%s' "$EO" | awk '/## Shipped/{a=1}/## Blocked/{b=a}/## In review/{c=b}/## Sent back/{d=c}/## Failed and why/{e=d}/## Alerts/{f=e}END{exit f?0:1}' && assert_contains "$EO" '\[Nothing merged\.\]' && assert_contains "$EO" '\[Nothing open\.\]' && assert_contains "$EO" '\[Nothing waiting\.\]' && assert_contains "$EO" '\[Nothing sent back\.\]' && assert_contains "$EO" '\[Nothing failed\.\]' && assert_contains "$EO" '\[None\.\]'; then pass "empty digest prints sections in order with bracketed text"; else fail "empty output wrong: $EO"; fi
# 2 shipped
if assert_contains "$OUT" 'Build the package' && assert_contains "$OUT" 'On goal branch fleet/goal: Goal branch task' && assert_contains "$OUT" 'On goal branch fleet/dynamic-staffing: Goal branch without id' && ! assert_contains "$OUT" 'Unrelated close' && assert_contains "$OUT" "$(echo "$MERGE"|cut -c1-7)" && assert_contains "$OUT" "$(echo "$SECOND"|cut -c1-7)" && assert_contains "$OUT" 'APPROVE — NOT BENCHED' && assert_contains "$OUT" 'push: NOT CONSIDERED' && assert_contains "$OUT" 'rounds=2' && assert_contains "$OUT" 'seats/verdicts/demo-ship.md'; then pass "shipped rows carry main merge details and goal-branch closes, including branch-only reasons"; else fail "shipped line missing: $OUT"; fi
# 3 needs
if assert_contains "$OUT" 'Choose release train — question' && assert_contains "$OUT" 'Cleared:' && assert_contains "$OUT" 'Approve fixture — approval'; then pass "open and cleared needs print, including need without machine bead"; else fail "needs missing: $OUT"; fi
# 4 bounces
if assert_contains "$OUT" 'Fix the retry' && assert_contains "$OUT" 'tests failed; rework delivered' && assert_contains "$OUT" 'Fix the docs' && assert_contains "$OUT" 'docs missing; rework not started' && assert_contains "$OUT" 'Explain the refusal' && assert_contains "$OUT" 'no reason given; rework not started' && ! assert_contains "$OUT" 'Old bounce' && ! printf '%s' "$OUT" | grep >/dev/null 'verifier gate verdict — demo-back'; then pass "bounce rows use bd titles, reasons, rework state, and window filtering"; else fail "bounce missing: $OUT"; fi
# 5 distress
if assert_contains "$OUT" 'STOP: timed out' && assert_contains "$OUT" '20 min' && ! assert_contains "$OUT" '10 min' && assert_contains "$OUT" '→ APPROVE' && assert_contains "$OUT" '5 events, 1 still failing'; then pass "distress rows print details elapsed recovery and still-failing summary"; else fail "distress missing: $OUT"; fi
# 6 stalled
if [ "$(printf '%s' "$OUT" | grep -c 'resumed')" -ge 2 ]; then pass "stalled rows print resumed time"; else fail "stalled rows missing: $OUT"; fi
# 7 bulk close
if assert_contains "$OUT" '3 tasks titled "closed holder"' && ! assert_contains "$OUT" 'tasks titled "two only"'; then pass "bulk-close anomaly groups three but not two"; else fail "bulk close wrong: $OUT"; fi
# 8 human
HRC=0; HUMAN="$(run_digest --human --since "$SINCE" --until "$UNTIL" 2>"$FIX/human.err")" || HRC=$?; HC=0; while IFS= read -r line; do [ -n "$line" ] || continue; WHEELHOUSE_NEEDS_ROOT="$FIX/human-guard" bun "$PROJ/seats/needs.ts" open --title "$line" --body x --kind notify >/dev/null 2>&1 || HC=$((HC+1)); done <<EOF
$HUMAN
EOF
if [ $HRC -eq 0 ] && ! printf '%s' "$HUMAN" | grep -Ei >/dev/null 'demo-[a-z0-9]+|bead' && [ $HC -eq 0 ]; then pass "human output has no ids/bead and passes needs humanTextGuard"; else fail "human guard failed rc=$HRC count=$HC err=$(cat "$FIX/human.err") output=$HUMAN"; fi
# 9 json
JSON="$(run_digest --json --since "$SINCE" --until "$UNTIL")"; if printf '%s' "$JSON" | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const j=JSON.parse(s); for(const k of ["window","namespace","seats","shipped","blocked","cleared","inReview","sentBack","failed","alerts"]) if(!(k in j)) process.exit(1);})'; then pass "json output has required top-level keys"; else fail "json missing keys: $JSON"; fi

# 13 account labels stay out of every rendering
if ! printf '%s\n%s\n%s' "$OUT" "$HUMAN" "$JSON" | grep >/dev/null 'claude-code-oauth-demo-own\|pool-oauth-demo-own\|SECRET-SHOULD-NOT-PRINT'; then pass "seats and pool account labels and account fields do not reach digest output"; else fail "account data leaked into output"; fi
# 14 failed detail lines are truncated before long tails
if printf '%s' "$OUT" | grep >/dev/null 'STOP: timed out.*…' && ! printf '%s' "$OUT" | grep >/dev/null 'END-SHOULD-BE-TRUNCATED'; then pass "failed detail lines are truncated"; else fail "failed detail was not truncated: $OUT"; fi
# 15 human output scrubs absolute fixture root and fake HOME paths
if ! printf '%s' "$HUMAN" | grep >/dev/null "$PROJ" && ! printf '%s' "$HUMAN" | grep >/dev/null "$FAKE_HOME" && printf '%s' "$HUMAN" | grep >/dev/null '\[local-path\]'; then pass "human output scrubs install root and fake HOME paths"; else fail "human output leaked local paths: $HUMAN"; fi
# 16 no-dash bounce falls back to no reason given rather than echoing VERDICT: BOUNCE
if printf '%s' "$OUT" | grep >/dev/null 'Explain the refusal.*no reason given' && ! printf '%s' "$OUT" | grep >/dev/null 'Explain the refusal.*VERDICT: BOUNCE'; then pass "bounce without dash uses no reason given"; else fail "no-dash bounce reason wrong: $OUT"; fi
# 17 human push keeps the full push value with ids scrubbed
if printf '%s' "$HUMAN" | grep >/dev/null 'push: NOT CONSIDERED' && ! printf '%s' "$HUMAN" | grep >/dev/null 'push: NOT;' && ! printf '%s' "$HUMAN" | grep >/dev/null 'demo-ship'; then pass "human push keeps full value and scrubs ids"; else fail "human push value wrong: $HUMAN"; fi
# 10 canaries
cp "$PROJ/seats/inbox.jsonl" "$PROJ/seats/inbox.with-distress"; grep -v 'demo-stop-ok\|demo-stop-bad' "$PROJ/seats/inbox.with-distress" > "$PROJ/seats/inbox.jsonl"; NOFAIL="$(run_digest --since "$SINCE" --until "$UNTIL")"; mv "$PROJ/seats/inbox.with-distress" "$PROJ/seats/inbox.jsonl"; sed -i.bak '/^product-repo=/d' "$PROJ/wheelhouse/.template-source"; FALLBACK="$(run_digest --since "$SINCE" --until "$UNTIL")"; printf 'product-repo=product\n' >> "$PROJ/wheelhouse/.template-source"; rm -f "$PROJ/wheelhouse/.template-source.bak"
if ! assert_contains "$NOFAIL" 'STOP: timed out' && assert_contains "$FALLBACK" 'Shipped'; then pass "canary removes distress line and product-repo fallback still renders"; else fail "canary failed nofail=$NOFAIL fallback=$FALLBACK"; fi
# 11 bd absent
NOBD="$(WHEELHOUSE_DIGEST_ROOT="$PROJ" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin" bun "$PROJ/seats/digest.ts" --since "$SINCE" --until "$UNTIL")"; NRC=$?; if [ $NRC -eq 0 ] && assert_contains "$NOBD" '\[bd unavailable\]'; then pass "bd absent exits 0 and marks bd sections unavailable"; else fail "bd absent rc=$NRC out=$NOBD"; fi
# 12 window edge
if ! assert_contains "$OUT" 'outside old' && ! assert_contains "$OUT" 'outside new' && assert_contains "$OUT" 'disk low'; then pass "since/until exclude rows outside the window edges"; else fail "window filtering failed: $OUT"; fi

# 18 notify opens one need, dedupes by source, writes digest.last, and uses digest.last for bare --notify
printf '{"type":"closed","id":"need-open","at":"2026-01-01T10:05:00Z","reason":"selftest"}\n' >> "$PROJ/seats/needs.jsonl"
rm -f "$PROJ/seats/run/digest.last" "$PROJ/seats/run/desk.port"
opened_before="$(grep -c '"type":"opened"' "$PROJ/seats/needs.jsonl" 2>/dev/null || echo 0)"
NID1="$(run_digest --notify --since "$SINCE" --until "$UNTIL" 2>"$FIX/notify.err")"; NRC1=$?
opened_after="$(grep -c '"type":"opened"' "$PROJ/seats/needs.jsonl" 2>/dev/null || echo 0)"
if [ $NRC1 -eq 0 ] && printf '%s' "$NID1" | grep -E >/dev/null '^need-[a-z0-9]+' && [ $((opened_after-opened_before)) -eq 1 ] && node -e 'const fs=require("fs"); const rows=fs.readFileSync(process.argv[1],"utf8").trim().split(/\n/).map(JSON.parse); const ev=rows.at(-1); const until=new Date(process.argv[2]).toISOString(); if(ev.type!=="opened"||ev.kind!=="notify"||ev.machine?.source!=="digest:"+until||!/Build the package/.test(ev.body)||!/\[Nothing open\.\]/.test(ev.body)||/Full page:/.test(ev.body)) process.exit(1);' "$PROJ/seats/needs.jsonl" "$UNTIL"; then pass "--notify opens one notify need through needs.ts with human digest body"; else fail "notify open failed rc=$NRC1 id=$NID1 before=$opened_before after=$opened_after err=$(cat "$FIX/notify.err") ledger=$(tail -3 "$PROJ/seats/needs.jsonl")"; fi
NID2="$(run_digest --notify --since "$SINCE" --until "$UNTIL" 2>"$FIX/notify-rerun.err")"; NRC2=$?
opened_rerun="$(grep -c '"type":"opened"' "$PROJ/seats/needs.jsonl" 2>/dev/null || echo 0)"
if [ $NRC2 -eq 0 ] && [ "$NID2" = "$NID1" ] && [ "$opened_rerun" = "$opened_after" ]; then pass "--notify rerun for same until prints existing id and appends nothing"; else fail "notify rerun dedupe failed rc=$NRC2 id1=$NID1 id2=$NID2 opened_after=$opened_after opened_rerun=$opened_rerun err=$(cat "$FIX/notify-rerun.err")"; fi
last_written="$(cat "$PROJ/seats/run/digest.last" 2>/dev/null || true)"
BARE_ID="$(run_digest --notify 2>"$FIX/notify-bare.err")"; BARE_RC=$?
BARE_JSON="$(WHEELHOUSE_NEEDS_ROOT="$PROJ" bun "$PROJ/seats/needs.ts" show "$BARE_ID" 2>/dev/null || true)"
if [ "$last_written" = "$(node -e 'console.log(new Date(process.argv[1]).toISOString())' "$UNTIL")" ] && [ $BARE_RC -eq 0 ] && printf '%s' "$BARE_JSON" | grep -E >/dev/null 'Jan 01.*07:00 PM EST'; then pass "digest.last records until and bare --notify uses it as the next since"; else fail "digest.last/bare notify failed last=$last_written bare_rc=$BARE_RC body=$BARE_JSON err=$(cat "$FIX/notify-bare.err")"; fi
printf 'http://127.0.0.1:65530/needs\n' > "$PROJ/seats/run/desk.port"
DESK_UNTIL=2026-01-05T00:00:00.000Z
DESK_ID="$(run_digest --notify --since 2026-01-04T00:00:00Z --until "$DESK_UNTIL" 2>"$FIX/notify-desk.err")"; DESK_RC=$?
DESK_JSON="$(WHEELHOUSE_NEEDS_ROOT="$PROJ" bun "$PROJ/seats/needs.ts" show "$DESK_ID" 2>/dev/null || true)"
if [ $DESK_RC -eq 0 ] && printf '%s' "$DESK_JSON" | grep >/dev/null 'Full page: http://127.0.0.1:65530/digest'; then pass "--notify appends Full page digest URL when desk.port exists"; else fail "notify desk URL missing rc=$DESK_RC id=$DESK_ID body=$DESK_JSON err=$(cat "$FIX/notify-desk.err")"; fi
# Canary: if human rendering leaks ids, needs.ts refuses the notify and digest.last is not written.
cp "$PROJ/seats/digest.ts" "$FIX/digest.good.ts"
bun - "$PROJ/seats/digest.ts" <<'TS'
import fs from "node:fs";
import assert from "node:assert/strict";
const file = process.argv[2], source = fs.readFileSync(file, "utf8");
const old = 'function humanText(s:string, ns:string){ return scrubLocalPaths(scrubAccountLabels(String(s||""))).replace(new RegExp(`\\\\b${escapeRegExp(ns)}-[a-z0-9_.-]+\\\\b`,"ig"),"work item").replace(/\\bbead\\b/ig,"task"); }';
assert.equal(source.split(old).length, 2, "humanText canary anchor must occur exactly once");
fs.writeFileSync(file, source.replace(old, 'function humanText(s:string, ns:string){ return String(s||""); }'));
TS
rm -f "$PROJ/seats/run/digest.last"
CAN_RC=0; CAN_OUT="$(run_digest --notify --since "$SINCE" --until 2026-01-06T00:00:00Z 2>"$FIX/notify-canary.err")" || CAN_RC=$?
mv "$FIX/digest.good.ts" "$PROJ/seats/digest.ts"
if [ $CAN_RC -eq 2 ] && grep -q 'contains install-local id token\|contains forbidden human-facing token' "$FIX/notify-canary.err" && [ ! -e "$PROJ/seats/run/digest.last" ]; then pass "canary: id-leaking renderHuman makes --notify exit 2 without writing digest.last"; else fail "notify canary failed rc=$CAN_RC out=$CAN_OUT err=$(cat "$FIX/notify-canary.err") last=$(cat "$PROJ/seats/run/digest.last" 2>/dev/null)"; fi

if [ $FAIL -eq 0 ]; then echo "digest.selftest: PASS ($PASS legs)"; exit 0; fi
echo "digest.selftest: FAIL ($FAIL failure(s), $PASS pass(es))" >&2; exit 1
