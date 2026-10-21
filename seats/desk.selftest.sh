#!/usr/bin/env bash
set -u
SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"
HERE="$(cd "$(dirname "$0")" && pwd -P)"
DESK="$HERE/desk.ts"
NEEDS="$HERE/needs.ts"
[ -f "$DESK" ] || { echo "selftest: missing $DESK" >&2; exit 2; }
command -v bun >/dev/null 2>&1 || { echo "selftest: bun required" >&2; exit 2; }
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-desk-selftest.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
export WHEELHOUSE_DESK_BD_TIMEOUT_MS="${WHEELHOUSE_DESK_BD_TIMEOUT_MS:-30000}"
PASS=0; FAIL=0; PID=""; WATCHDOG_PID=""
cleanup(){ [ -n "$PID" ] && kill "$PID" 2>/dev/null || true; [ -n "$WATCHDOG_PID" ] && kill "$WATCHDOG_PID" 2>/dev/null || true; selftest_cleanup_fixture_processes "${FIX:-}" "${SOCK:-}"; selftest_remove_fixture_dir "$FIX"; }
selftest_install_cleanup_traps cleanup
pass(){ PASS=$((PASS+1)); echo "ok $PASS - $*"; }
fail(){ FAIL=$((FAIL+1)); echo "not ok $((PASS+FAIL)) - $*" >&2; }
desk_fixture_processes(){ ps axww -o pid=,command= | awk -v root="$FIX" '$2 ~ /(^|\/)bun$/ && index($0, root) && index($0, "seats/desk.ts") {print}'; }
stop_fixture_desks(){
  local pids=""
  pids="$(desk_fixture_processes | awk '{print $1}' | tr '\n' ' ')"
  [ -n "$pids" ] && kill $pids >/dev/null 2>&1 || true
  sleep 0.3
  pids="$(desk_fixture_processes | awk '{print $1}' | tr '\n' ' ')"
  [ -n "$pids" ] && kill -9 $pids >/dev/null 2>&1 || true
}
assert_no_fixture_desks(){
  local leaks=""
  for _ in $(seq 1 30); do
    leaks="$(desk_fixture_processes)"
    [ -z "$leaks" ] && break
    sleep 0.1
  done
  [ -z "$leaks" ] && pass "desk selftest leaves zero fixture seats/desk.ts processes" || fail "fixture seats/desk.ts process survived: $leaks"
}
port(){ bun -e 'const s=(await import("node:net")).default.createServer(); s.listen(0,"127.0.0.1",()=>{console.log(s.address().port); s.close();});'; }
PROJ="$FIX/proj"; mkdir -p "$PROJ/seats" "$PROJ/wheelhouse"
selftest_copy_seat_runtime "$PROJ" "$HERE"
cat > "$PROJ/wheelhouse/.template-source" <<'EOF'
namespace=demo
product-repo=product
EOF
cat > "$PROJ/seats/needs.jsonl" <<'EOF'
{"type":"opened","id":"need-open","at":"2026-09-21T00:00:00.000Z","kind":"question","title":"Choose lunch","body":"Pick a meal","options":[{"label":"A","text":"Soup"},{"label":"B","text":"Salad"}],"default":"A; applies after noon","consequence":"We order the default.","machine":{"bead":"demo-ab12","seat":"worker-1"}}
{"type":"message","id":"need-open","at":"2026-09-21T00:01:00.000Z","from":"commander","via":"cli","text":"Please choose."}
{"type":"opened","id":"need-old","at":"2026-09-20T00:00:00.000Z","kind":"question","title":"Old question","body":"Already answered","options":[{"label":"Run","text":"Run the login line"}],"machine":{}}
{"type":"answered","id":"need-old","at":"2026-09-20T00:02:00.000Z","from":"human","via":"cli","text":"done"}
{"type":"message","id":"need-old","at":"2026-09-20T00:03:00.000Z","from":"commander","via":"cli","text":"Please do the second step."}
{"type":"opened","id":"need-closed","at":"2026-09-19T00:00:00.000Z","kind":"question","title":"Closed question","body":"Already complete","options":[{"label":"Done","text":"Done"}],"machine":{}}
{"type":"answered","id":"need-closed","at":"2026-09-19T00:02:00.000Z","from":"human","via":"cli","text":"done"}
{"type":"closed","id":"need-closed","at":"2026-09-19T00:03:00.000Z","reason":"complete"}
{"type":"opened","id":"need-board","at":"2026-09-21T00:03:00.000Z","kind":"question","title":"Approve deploy","body":"Need a human decision","options":[],"machine":{"bead":"demo-human"}}
EOF
mkdir -p "$PROJ/seats/verdicts" "$PROJ/bin"
cat > "$PROJ/seats/state.json" <<'EOF'
{"seats":{"verifier-a":{"role":"verifier","lastBead":"demo-review"},"builder":{"role":"worker","lastBead":"demo-progress"},"reviewer-a":{"role":"reviewer","lastBead":"demo-review"},"reviewer-finished":{"role":"reviewer","lastBead":"demo-finished"}}}
EOF
cat > "$PROJ/seats/verdicts/demo-bounce.md" <<'EOF'
VERDICT: BOUNCE
EOF
cat > "$PROJ/bin/bd" <<'EOF'
#!/usr/bin/env bash
set -eu
[ -n "${WHEELHOUSE_STUB_BD_SLEEP:-}" ] && sleep "$WHEELHOUSE_STUB_BD_SLEEP"
if [ "${1:-}" = "ready" ]; then printf 'demo-ready\ndemo-dep\n'; exit 0; fi
if [ "${1:-}" != "list" ]; then exit 1; fi
status=""; label=""
while [ $# -gt 0 ]; do
  case "$1" in
    --status) status="$2"; shift 2;;
    --label) label="$2"; shift 2;;
    *) shift;;
  esac
done
if [ "$status" = "in_progress" ]; then cat <<'JSON'; exit 0
[{"id":"demo-progress","title":"Build the package","status":"in_progress","priority":"P1","assignee":"fallback worker","started_at":"2026-09-20T00:00:00Z"},{"id":"demo-finished","title":"Finished but still in progress","status":"in_progress","priority":"P1","assignee":"worker-1","started_at":"2026-09-20T00:30:00Z","labels":["needs-review"]}]
JSON
fi
if [ "$label" = "needs-review" ]; then cat <<'JSON'; exit 0
[{"id":"demo-review","title":"Check the branch","status":"open","priority":"P2","assignee":"","created_at":"2026-09-20T01:00:00Z","labels":["needs-review"]},{"id":"demo-bounce","title":"Fix the rejected change","status":"open","priority":"P0","assignee":"","created_at":"2026-09-20T02:00:00Z","labels":["needs-review"]},{"id":"demo-finished","title":"Finished but still in progress","status":"in_progress","priority":"P1","assignee":"worker-1","started_at":"2026-09-20T00:30:00Z","labels":["needs-review"]}]
JSON
fi
if [ "$status" = "closed" ]; then cat <<'JSON'; exit 0
[{"id":"demo-merged","title":"Ship the button","status":"closed","priority":"P3","assignee":"integrator","closed_at":"2099-01-01T00:00:00Z"},{"id":"demo-old-closed","title":"Ancient merge","status":"closed","priority":"P3","assignee":"integrator","closed_at":"2020-01-01T00:00:00Z"}]
JSON
fi
cat <<'JSON'
[{"id":"demo-ready","title":"Write the guide","status":"open","priority":"P0","created_at":"2026-09-20T03:00:00Z"},{"id":"demo-dep","title":"Hidden dependency work","status":"open","priority":"P1","created_at":"2026-09-20T04:00:00Z","blocked_by_count":1},{"id":"demo-progress","title":"Build the package","status":"in_progress","priority":"P1","assignee":"fallback worker","started_at":"2026-09-20T00:00:00Z"},{"id":"demo-review","title":"Check the branch","status":"open","priority":"P2","created_at":"2026-09-20T01:00:00Z","labels":["needs-review"]},{"id":"demo-bounce","title":"Fix the rejected change","status":"open","priority":"P0","created_at":"2026-09-20T02:00:00Z","labels":["needs-review"]},{"id":"demo-finished","title":"Finished but still in progress","status":"in_progress","priority":"P1","assignee":"worker-1","started_at":"2026-09-20T00:30:00Z","labels":["needs-review"]},{"id":"demo-human","title":"Answer the product question","status":"open","priority":"P1","created_at":"2026-09-20T05:00:00Z"},{"id":"demo-merged","title":"Ship the button","status":"closed","priority":"P3","assignee":"integrator","closed_at":"2099-01-01T00:00:00Z"}]
JSON
EOF
chmod +x "$PROJ/bin/bd"
PRODUCT="$PROJ/product"; mkdir -p "$PRODUCT"; git -C "$PRODUCT" init -q -b main; git -C "$PRODUCT" config user.email selftest@example.invalid; git -C "$PRODUCT" config user.name selftest
printf base > "$PRODUCT/file.txt"; git -C "$PRODUCT" add file.txt; GIT_AUTHOR_DATE=2026-09-20T00:00:00Z GIT_COMMITTER_DATE=2026-09-20T00:00:00Z git -C "$PRODUCT" commit -q -m base; git -C "$PRODUCT" checkout -q -b feat; printf feat >> "$PRODUCT/file.txt"; git -C "$PRODUCT" commit -am 'demo-merged Ship the button' -q; SECOND="$(git -C "$PRODUCT" rev-parse HEAD)"; git -C "$PRODUCT" checkout -q main; printf main > "$PRODUCT/main.txt"; git -C "$PRODUCT" add main.txt; git -C "$PRODUCT" commit -q -m main; GIT_AUTHOR_DATE=2026-09-21T12:00:00Z GIT_COMMITTER_DATE=2026-09-21T12:00:00Z git -C "$PRODUCT" merge --no-ff -q feat -m 'Merge demo-merged Ship the button'; MERGE="$(git -C "$PRODUCT" rev-parse HEAD)"; git -C "$PRODUCT" remote add origin https://github.com/example/product.git
cat > "$PROJ/seats/inbox.jsonl" <<'EOF'
{"at":"2026-09-21T12:10:00Z","seat":"verifier-gate","class":"settle","state":"terminal","title":"verifier gate verdict — demo-bounce","detail":"VERDICT: BOUNCE — tests failed"}
{"at":"2026-09-21T12:20:00Z","seat":"worker-1","class":"settle","state":"terminal","title":"seat turn settled — demo-review","detail":"done"}
EOF
P="$(port)"
(cd "$PROJ" && exec env PATH="$PROJ/bin:$PATH" WHEELHOUSE_DESK_ROOT="$PROJ" WHEELHOUSE_DESK_PORT="$P" bun "$PROJ/seats/desk.ts" > "$FIX/desk.out" 2> "$FIX/desk.err") & PID=$!
for _ in $(seq 1 50); do [ -s "$PROJ/seats/run/desk.port" ] && curl -fsS "http://127.0.0.1:$P/needs" > "$FIX/needs.html" 2>/dev/null && break; sleep 0.1; done
if kill -0 "$PID" 2>/dev/null && grep -q "http://127.0.0.1:$P/needs" "$PROJ/seats/run/desk.port"; then pass "desk starts and writes seats/run/desk.port"; else fail "desk did not start: $(cat "$FIX/desk.err" 2>/dev/null)"; fi
if bun - "$FIX/needs.html" <<'JS'
const assert=(await import('node:assert/strict')).default,html=(await import('node:fs')).default.readFileSync(process.argv[2],'utf8');
for(const text of ['Choose lunch','Old question','History','Closed question','action="/api/needs/need-old/answer"','action="/api/needs/need-old/message"','Run the login line','Please do the second step.']) assert.ok(html.includes(text),text);
const pos=['Choose lunch','Old question','History','Closed question'].map(x=>html.indexOf(x));
assert.ok(pos.every((p,i)=>!i||pos[i-1]<p));
assert.ok(!html.includes('action="/api/needs/need-closed/answer"')&&!html.includes('action="/api/needs/need-closed/message"'));
JS
then pass "GET /needs keeps answered needs open below unanswered ones and closed needs as history"; else fail "GET /needs did not render answered/closed sections correctly"; fi
if grep -q 'A; applies after noon' "$FIX/needs.html" && grep -q 'We order the default' "$FIX/needs.html" && grep -q 'Soup' "$FIX/needs.html" && grep -q 'Please choose' "$FIX/needs.html"; then pass "GET /needs renders options, default, consequence, and thread"; else fail "GET /needs missing need details"; fi
curl -fsS "http://127.0.0.1:$P/api/needs.json" > "$FIX/needs.json" || fail "GET /api/needs.json failed"
if grep -q '"id":"need-open"' "$FIX/needs.json" && grep -q '"state":"open"' "$FIX/needs.json"; then pass "GET /api/needs.json returns folded needs JSON"; else fail "GET /api/needs.json missing folded need"; fi
for _ in $(seq 1 80); do
  curl -fsS "http://127.0.0.1:$P/api/board.json" > "$FIX/board.json" 2>/dev/null || true
  grep -q 'Write the guide' "$FIX/board.json" 2>/dev/null && break
  sleep 0.1
done
curl -fsS "http://127.0.0.1:$P/board" > "$FIX/board.html" || fail "GET /board failed"
curl -fsS "http://127.0.0.1:$P/api/board.json" > "$FIX/board.json" || fail "GET /api/board.json failed"
if bun - "$FIX/board.json" <<'JS'
const assert=(await import('node:assert/strict')).default,data=JSON.parse((await import('node:fs')).default.readFileSync(process.argv[2],'utf8'));
const cols=Object.fromEntries(data.columns.map(c=>[c.title,c.cards]));
const has=(col,title,seat)=> (cols[col]??[]).some(c=>c.title===title&&(seat===undefined||c.seat===seat));
assert.ok(has('Ready','Write the guide','ready')); assert.ok(!has('Ready','Hidden dependency work'));
assert.ok(has('In progress','Build the package','builder'));
assert.ok(has('In review','Check the branch','reviewer-a')); assert.ok(has('In review','Fix the rejected change','sent back'));
assert.ok(has('In review','Finished but still in progress','reviewer-finished'));
assert.ok(!has('In progress','Finished but still in progress'));
assert.equal(Object.values(cols).flat().filter(c=>c.title==='Finished but still in progress').length,1);
assert.ok(has('Blocked on you','Answer the product question','waiting on you')); assert.equal(cols['Blocked on you'][0].needHref,'/needs');
assert.ok(has('Merged recently','Ship the button','integrator')); assert.ok(!has('Merged recently','Ancient merge'));
JS
then pass "GET /api/board.json places cards in the right columns with the right seats"; else fail "board JSON did not match expected columns: $(cat "$FIX/board.json" 2>/dev/null)"; fi
PREC_CAN="$FIX/precedence-canary.ts"; cp "$PROJ/seats/desk.ts" "$PREC_CAN"
bun - "$PREC_CAN" <<'JS'
const fs=(await import('node:fs')).default,p=process.argv[2],s=fs.readFileSync(p,'utf8'),old='if(placed.has(id)) return;';
if(!s.includes(old)) throw new Error('board precedence canary source changed');
fs.writeFileSync(p,s.replace(old,''));
JS
if cmp -s "$PROJ/seats/desk.ts" "$PREC_CAN"; then
  fail "canary: could not disable board de-duplication; test proves nothing"
else
  mkdir -p "$FIX/preccan/seats" "$FIX/preccan/wheelhouse" "$FIX/preccan/bin"
  cp "$PREC_CAN" "$FIX/preccan/seats/desk.ts"; cp "$NEEDS" "$FIX/preccan/seats/needs.ts"; cp "$PROJ/seats/digest.ts" "$FIX/preccan/seats/digest.ts"; cp "$PROJ/seats/needs.jsonl" "$FIX/preccan/seats/needs.jsonl"; cp "$PROJ/seats/state.json" "$FIX/preccan/seats/state.json"; cp -R "$PROJ/seats/verdicts" "$FIX/preccan/seats/"; cp "$PROJ/bin/bd" "$FIX/preccan/bin/bd"; cp "$PROJ/wheelhouse/.template-source" "$FIX/preccan/wheelhouse/.template-source"
  PPREC="$(port)"; (cd "$FIX/preccan" && exec env PATH="$FIX/preccan/bin:$PATH" WHEELHOUSE_DESK_ROOT="$FIX/preccan" WHEELHOUSE_DESK_PORT="$PPREC" bun "$FIX/preccan/seats/desk.ts" >/dev/null 2>&1) & PID=$!
  for _ in $(seq 1 80); do curl -fsS "http://127.0.0.1:$PPREC/api/board.json" > "$FIX/precedence-canary.json" 2>/dev/null || true; grep -q 'Finished but still in progress' "$FIX/precedence-canary.json" 2>/dev/null && break; sleep 0.1; done
  if bun - "$FIX/precedence-canary.json" <<'JS'
const assert=(await import('node:assert/strict')).default,data=JSON.parse((await import('node:fs')).default.readFileSync(process.argv[2],'utf8'));
const cols=Object.fromEntries(data.columns.map(c=>[c.title,c.cards]));
const count=Object.values(cols).flat().filter(c=>c.title==='Finished but still in progress').length;
assert.ok(count>1||(cols['In progress']??[]).some(c=>c.title==='Finished but still in progress'));
JS
  then pass "canary: disabling board precedence is caught by duplicate/in-progress placement"; else fail "canary did not expose duplicate/in-progress placement: $(cat "$FIX/precedence-canary.json" 2>/dev/null)"; fi
  [ -n "$PID" ] && kill "$PID" 2>/dev/null || true; PID=""
fi
if grep -q 'Write the guide' "$FIX/board.html" && grep -q 'Build the package' "$FIX/board.html" && grep -q 'sent back' "$FIX/board.html" && grep -q 'Open need' "$FIX/board.html"; then pass "GET /board renders board cards and need link"; else fail "GET /board missing expected card text"; fi
if selftest_capture_lacks "$FIX/board.html" -Eq -- '<(form|button|input|textarea)([ >])' && [ "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$P/board")" = 404 ]; then pass "board has no write controls and no POST route"; else fail "board exposed write controls or POST route"; fi
if selftest_capture_lacks "$FIX/board.html" -Eq -- 'demo-[a-z0-9-]+'; then pass "board HTML hides namespace ids"; else fail "board HTML leaked ids: $(grep -Eo 'demo-[a-z0-9-]+' "$FIX/board.html" | sort -u | tr '\n' ' ')"; fi
SINCE="2026-09-21T00:00:00Z"; UNTIL="2026-09-22T00:00:00Z"; DIGEST_Q="since=$SINCE&until=$UNTIL"
for _ in $(seq 1 80); do curl -fsS "http://127.0.0.1:$P/digest?$DIGEST_Q" > "$FIX/digest.html" 2>/dev/null || true; grep -q 'Ship the button' "$FIX/digest.html" 2>/dev/null && break; sleep 0.1; done
curl -fsS "http://127.0.0.1:$P/api/digest.json?$DIGEST_Q" > "$FIX/digest.json" || fail "GET /api/digest.json failed"
if bun - "$FIX/digest.html" <<'JS'
const assert=(await import('node:assert/strict')).default,h=(await import('node:fs')).default.readFileSync(process.argv[2],'utf8');
const pos=['Shipped','Blocked on you','In review','Sent back','Failed and why'].map(x=>h.indexOf('<h2>'+x+'</h2>'));
assert.ok(pos.every(p=>p>=0)); assert.deepEqual(pos,[...pos].sort((a,b)=>a-b));
for(const text of ['Ship the button','commit ','https://github.com/example/product/commit/','<a href="/needs">need</a>']) assert.ok(h.includes(text),text);
JS
then pass "GET /digest renders ordered sections with shipped commit link and need link"; else fail "GET /digest missing expected digest content: $(cat "$FIX/digest.html" 2>/dev/null)"; fi
if bun - "$FIX/digest.json" <(WHEELHOUSE_DIGEST_ROOT="$PROJ" PATH="$PROJ/bin:$PATH" bun "$PROJ/seats/digest.ts" --json --since "$SINCE" --until "$UNTIL") <<'JS'
const fs=(await import('node:fs')).default,[p,q]=process.argv.slice(2),left=JSON.parse(fs.readFileSync(p,'utf8')),right=JSON.parse(fs.readFileSync(q,'utf8'));
delete left.window; delete right.window; (await import('node:assert/strict')).default.deepEqual(left,right);
JS
then pass "GET /api/digest.json matches digest.ts --json for the same window"; else fail "digest JSON differed: api=$(cat "$FIX/digest.json" 2>/dev/null)"; fi
HOURS_AT="$(bun -e 'console.log(new Date().toISOString())')"
printf '{"type":"opened","id":"need-hours","at":"%s","kind":"question","title":"Current hours question","body":"Prove relative windows serve content","options":[],"machine":{"bead":"demo-hours"}}\n' "$HOURS_AT" >> "$PROJ/seats/needs.jsonl"
for _ in $(seq 1 80); do curl -fsS "http://127.0.0.1:$P/digest?hours=1" > "$FIX/digest-hours.html" 2>/dev/null || true; grep -q 'Current hours question' "$FIX/digest-hours.html" 2>/dev/null && break; sleep 0.1; done
if grep -q 'Current hours question' "$FIX/digest-hours.html"; then pass "GET /digest?hours=N serves real digest content from a stable relative-window cache key"; else fail "GET /digest?hours=N did not serve current fixture content: $(cat "$FIX/digest-hours.html" 2>/dev/null)"; fi
if selftest_capture_lacks "$FIX/digest.html" -Eiq -- 'demo-[a-z0-9-]+|bead'; then pass "digest HTML hides namespace ids and the word bead"; else fail "digest HTML leaked ids or bead: $(grep -Eio 'demo-[a-z0-9-]+|bead' "$FIX/digest.html" | sort -u | tr '\n' ' ')"; fi
if selftest_capture_lacks "$FIX/digest.html" -Eq -- '<(form|button|input|textarea)([ >])' && [ "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$P/digest")" = 404 ] && [ "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$P/api/digest.json")" = 404 ]; then pass "digest has no write controls and no POST routes"; else fail "digest exposed write controls or POST routes"; fi
curl -fsS "http://127.0.0.1:$P/digest" > "$FIX/digest-default.html" || fail "GET /digest default failed"
if grep -q 'Digest: last 24 h' "$FIX/digest-default.html" && ! grep -q "$SINCE" "$FIX/digest-default.html"; then pass "query-window digest does not overwrite the default digest snapshot or heading"; else fail "query-window digest overwrote default heading: $(grep -Eo 'Digest: [^<]+' "$FIX/digest-default.html" | sed -n '1p')"; fi
if [ "$(curl -sS -o "$FIX/digest-bad.txt" -w '%{http_code}' "http://127.0.0.1:$P/digest?since=garbage")" = 400 ] && [ "$(curl -sS -o "$FIX/digest-bad-api.txt" -w '%{http_code}' "http://127.0.0.1:$P/api/digest.json?hours=not-a-number")" = 400 ]; then pass "bad digest window input returns 400 instead of stale content"; else fail "bad digest window input did not return 400: page=$(cat "$FIX/digest-bad.txt" 2>/dev/null) api=$(cat "$FIX/digest-bad-api.txt" 2>/dev/null)"; fi
if [ "$(curl -sS -o "$FIX/digest-zero-hours.txt" -w '%{http_code}' "http://127.0.0.1:$P/digest?hours=0")" = 400 ] && [ "$(curl -sS -o "$FIX/digest-negative-hours.txt" -w '%{http_code}' "http://127.0.0.1:$P/api/digest.json?hours=-1")" = 400 ]; then pass "zero and negative digest hours return 400 instead of empty or inverted windows"; else fail "zero or negative digest hours did not return 400: zero=$(cat "$FIX/digest-zero-hours.txt" 2>/dev/null) negative=$(cat "$FIX/digest-negative-hours.txt" 2>/dev/null)"; fi
if grep -q 'Digest: last 24 h' "$FIX/board.html" && grep -q 'Digest: last 24 h' "$FIX/needs.html"; then pass "/board and /needs link to digest"; else fail "board or needs missing digest link"; fi
DIGEST_CAN="$FIX/digest-canary.ts"; cp "$PROJ/seats/desk.ts" "$DIGEST_CAN"
bun - "$DIGEST_CAN" <<'JS'
const fs=(await import('node:fs')).default,p=process.argv[2],s=fs.readFileSync(p,'utf8');
const old='.replace(new RegExp(`\\\\b${namespace().replace(/[.*+?^${}()|[\\]\\\\]/g,"\\\\$&")}-[a-z0-9_.-]+\\\\b`,"ig"),"work item")';
if(!s.includes(old)) throw new Error('digest id canary source changed');
fs.writeFileSync(p,s.replaceAll(old,''));
JS
if cmp -s "$PROJ/seats/desk.ts" "$DIGEST_CAN"; then
  fail "canary: could not disable digest id filter; test proves nothing"
else
  mkdir -p "$FIX/digestcan/seats" "$FIX/digestcan/wheelhouse" "$FIX/digestcan/bin" "$FIX/digestcan/product"
  cp "$DIGEST_CAN" "$FIX/digestcan/seats/desk.ts"; cp "$NEEDS" "$FIX/digestcan/seats/needs.ts"; cp "$PROJ/seats/digest.ts" "$FIX/digestcan/seats/digest.ts"; cp "$PROJ/seats/needs.jsonl" "$FIX/digestcan/seats/needs.jsonl"; cp "$PROJ/seats/inbox.jsonl" "$FIX/digestcan/seats/inbox.jsonl"; cp "$PROJ/seats/seats.json" "$FIX/digestcan/seats/seats.json" 2>/dev/null || true; cp "$PROJ/bin/bd" "$FIX/digestcan/bin/bd"; cp "$PROJ/wheelhouse/.template-source" "$FIX/digestcan/wheelhouse/.template-source"; cp -R "$PROJ/product/." "$FIX/digestcan/product/"
  P4="$(port)"; (cd "$FIX/digestcan" && exec env PATH="$FIX/digestcan/bin:$PATH" WHEELHOUSE_DESK_ROOT="$FIX/digestcan" WHEELHOUSE_DESK_PORT="$P4" bun "$FIX/digestcan/seats/desk.ts" >/dev/null 2>&1) & PID=$!
  for _ in $(seq 1 80); do curl -fsS "http://127.0.0.1:$P4/digest?$DIGEST_Q" > "$FIX/digest-canary.html" 2>/dev/null || true; grep -q 'demo-merged' "$FIX/digest-canary.html" 2>/dev/null && break; sleep 0.1; done
  if grep -q 'demo-merged' "$FIX/digest-canary.html"; then pass "canary: disabling digest id filter leaks demo- in the page"; else fail "canary did not expose digest id leak: $(cat "$FIX/digest-canary.html" 2>/dev/null)"; fi
fi
if selftest_capture_lacks "$FIX/needs.html" -q -- 'demo-ab12' && selftest_capture_lacks "$FIX/needs.html" -qi -- 'worker-1\|seat\|bead'; then pass "HTML hides machine bead id and seat jargon"; else fail "HTML leaked machine fields: $(grep -oi 'demo-ab12\|worker-1\|seat\|bead' "$FIX/needs.html" | sort -u | tr '\n' ' ')"; fi
before="$(grep -c '"type":"answered"' "$PROJ/seats/needs.jsonl")"
curl -fsS -X POST -d 'text=Salad&choice=B' "http://127.0.0.1:$P/api/needs/need-open/answer" >/dev/null || fail "POST answer failed"
after="$(grep -c '"type":"answered"' "$PROJ/seats/needs.jsonl")"
if [ $((after-before)) -eq 1 ] && tail -1 "$PROJ/seats/needs.jsonl" | grep >/dev/null '"via":"desk"' && tail -1 "$PROJ/seats/needs.jsonl" | grep >/dev/null '"choice":"B"'; then pass "POST answer appends exactly one answered event through the ledger"; else fail "POST answer ledger wrong"; fi
curl -fsS -X POST -d 'text=Thanks' "http://127.0.0.1:$P/api/needs/need-open/message" >/dev/null || fail "POST message failed"
if tail -1 "$PROJ/seats/needs.jsonl" | grep >/dev/null '"type":"message"' && tail -1 "$PROJ/seats/needs.jsonl" | grep >/dev/null '"from":"human"'; then pass "POST message appends a human message"; else fail "POST message ledger wrong"; fi
(cd "$PROJ" && WHEELHOUSE_NEEDS_ROOT="$PROJ" bun seats/needs.ts say need-old 'Commander follow-up visible on desk' >/dev/null) || fail "commander say failed"
curl -fsS "http://127.0.0.1:$P/needs" > "$FIX/needs-after-say.html" || fail "GET /needs after commander say failed"
if grep -q 'Commander follow-up visible on desk' "$FIX/needs-after-say.html"; then pass "commander say on answered need shows in the thread"; else fail "commander say missing from answered thread"; fi
curl -fsS -X POST -d 'text=Human follow-up after answer' "http://127.0.0.1:$P/api/needs/need-old/message" >/dev/null || fail "POST answered-need follow-up failed"
if tail -1 "$PROJ/seats/needs.jsonl" | grep >/dev/null '"type":"message"' && tail -1 "$PROJ/seats/needs.jsonl" | grep >/dev/null '"from":"human"' && WHEELHOUSE_NEEDS_ROOT="$PROJ" bun "$PROJ/seats/needs.ts" list --unread | grep >/dev/null 'need-old'; then pass "answered need accepts human follow-up and re-arms unread listing"; else fail "answered follow-up did not record/re-arm unread ledger=$(tail -5 "$PROJ/seats/needs.jsonl")"; fi
if command -v lsof >/dev/null 2>&1; then
  LSOF="$(lsof -nP -iTCP:$P -sTCP:LISTEN 2>/dev/null || true)"
  if printf '%s\n' "$LSOF" | grep >/dev/null "127.0.0.1:$P" && ! printf '%s\n' "$LSOF" | grep >/dev/null "\*:$P\|0.0.0.0:$P"; then pass "desk listens on 127.0.0.1 only"; else fail "desk bind was not localhost-only: $LSOF"; fi
else echo "ok $((PASS+1)) - SKIP lsof not available"; PASS=$((PASS+1)); fi
SLOW="$FIX/slowproj"; mkdir -p "$SLOW"; cp -R "$PROJ/seats" "$SLOW/seats"; mkdir -p "$SLOW/wheelhouse" "$SLOW/bin"; cp "$PROJ/wheelhouse/.template-source" "$SLOW/wheelhouse/.template-source"; cp "$PROJ/bin/bd" "$SLOW/bin/bd"
PSLOW="$(port)"; (cd "$SLOW" && exec env PATH="$SLOW/bin:$PATH" WHEELHOUSE_STUB_BD_SLEEP=2 WHEELHOUSE_DESK_BOARD_REFRESH_MS=100 WHEELHOUSE_DESK_ROOT="$SLOW" WHEELHOUSE_DESK_PORT="$PSLOW" bun "$SLOW/seats/desk.ts" >/dev/null 2> "$FIX/slow-desk.err") & SLOW_PID=$!
for _ in $(seq 1 50); do curl -fsS "http://127.0.0.1:$PSLOW/board" >/dev/null 2>&1 && break; sleep 0.1; done
NEEDS_MS="$(bun - "http://127.0.0.1:$PSLOW/needs" "$FIX/slow-needs.html" <<'JS'
const [url,file]=process.argv.slice(2),start=performance.now(),r=await fetch(url);
if(!r.ok) throw new Error('HTTP '+r.status); (await import('node:fs')).default.writeFileSync(file,Buffer.from(await r.arrayBuffer())); console.log(Math.floor(performance.now()-start));
JS
)"
if [ "$NEEDS_MS" -lt 1000 ] && kill -0 "$SLOW_PID" 2>/dev/null; then pass "slow bd refresh never runs in a request: /needs answers in under 1s and desk survives"; else fail "slow bd blocked /needs or killed desk (ms=$NEEDS_MS err=$(cat "$FIX/slow-desk.err" 2>/dev/null))"; fi
# Let any startup digest build finish so this leg measures the query-window path,
# not a refresh already in progress from process startup.
sleep 5
DIGEST_MS="$(bun - "http://127.0.0.1:$PSLOW/digest?hours=1" "$FIX/slow-digest.html" <<'JS'
const [url,file]=process.argv.slice(2),start=performance.now(),r=await fetch(url);
if(!r.ok) throw new Error('HTTP '+r.status); (await import('node:fs')).default.writeFileSync(file,Buffer.from(await r.arrayBuffer())); console.log(Math.floor(performance.now()-start));
JS
)"
if [ "$DIGEST_MS" -lt 1000 ] && kill -0 "$SLOW_PID" 2>/dev/null; then pass "slow bd digest window is scheduled off the request path and answers in under 1s"; else fail "slow bd digest window blocked request or killed desk (ms=$DIGEST_MS err=$(cat "$FIX/slow-desk.err" 2>/dev/null))"; fi
NEEDS_DURING_DIGEST_MS="$(bun - "http://127.0.0.1:$PSLOW/needs" "$FIX/slow-needs-during-digest.html" <<'JS'
const [url,file]=process.argv.slice(2),start=performance.now(),r=await fetch(url);
if(!r.ok) throw new Error('HTTP '+r.status); (await import('node:fs')).default.writeFileSync(file,Buffer.from(await r.arrayBuffer())); console.log(Math.floor(performance.now()-start));
JS
)"
if [ "$NEEDS_DURING_DIGEST_MS" -lt 1000 ] && kill -0 "$SLOW_PID" 2>/dev/null; then pass "slow bd digest build does not block another desk request"; else fail "slow bd digest build blocked another request or killed desk (ms=$NEEDS_DURING_DIGEST_MS err=$(cat "$FIX/slow-desk.err" 2>/dev/null))"; fi
kill "$SLOW_PID" 2>/dev/null || true; wait "$SLOW_PID" 2>/dev/null || true
# Desk restart supervision moved to seats/supervisor.selftest.sh; this selftest
# covers desk behavior only.
kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; PID=""
ANSWERED_CAN="$FIX/answered-canary.ts"; cp "$PROJ/seats/desk.ts" "$ANSWERED_CAN"
bun - "$ANSWERED_CAN" <<'JS'
const fs=(await import('node:fs')).default,p=process.argv[2],s=fs.readFileSync(p,'utf8'),old='const active = n.state !== "closed";';
if(!s.includes(old)) throw new Error('answered canary source changed');
fs.writeFileSync(p,s.replace(old,'const active = n.state === "open";'));
JS
if cmp -s "$PROJ/seats/desk.ts" "$ANSWERED_CAN"; then
  fail "canary: could not make answered needs inactive; test proves nothing"
else
  mkdir -p "$FIX/answeredcan/seats" "$FIX/answeredcan/wheelhouse"
  cp "$ANSWERED_CAN" "$FIX/answeredcan/seats/desk.ts"; cp "$NEEDS" "$FIX/answeredcan/seats/needs.ts"; cp "$PROJ/seats/digest.ts" "$FIX/answeredcan/seats/digest.ts"; cp "$PROJ/seats/needs.jsonl" "$FIX/answeredcan/seats/needs.jsonl"
  PANS="$(port)"; (cd "$FIX/answeredcan" && exec env WHEELHOUSE_DESK_ROOT="$FIX/answeredcan" WHEELHOUSE_DESK_PORT="$PANS" bun "$FIX/answeredcan/seats/desk.ts" >/dev/null 2>&1) & PID=$!
  for _ in $(seq 1 50); do curl -fsS "http://127.0.0.1:$PANS/needs" > "$FIX/answered-canary.html" 2>/dev/null && break; sleep 0.1; done
  if selftest_capture_lacks "$FIX/answered-canary.html" -q -- 'action="/api/needs/need-old/message"'; then pass "canary: making answered needs inactive removes controls and is caught"; else fail "canary did not remove answered controls"; fi
  [ -n "$PID" ] && kill "$PID" 2>/dev/null || true; PID=""
fi
CAN="$FIX/canary.ts"; cp "$PROJ/seats/desk.ts" "$CAN"
bun - "$CAN" <<'JS'
const fs=(await import('node:fs')).default,p=process.argv[2],s=fs.readFileSync(p,'utf8'),old='${active && n.opened.options.length?`<form';
if(!s.includes(old)) throw new Error('machine-field canary source changed');
fs.writeFileSync(p,s.replace('<p>${esc(n.opened.body)}</p>','<p>${esc(n.opened.body)}</p><p>${esc(n.opened.machine.bead)}</p>'));
JS
if cmp -s "$PROJ/seats/desk.ts" "$CAN"; then fail "canary: could not make needs page print machine.bead; test proves nothing"; fi
mkdir -p "$FIX/canproj/seats" "$FIX/canproj/wheelhouse"; cp "$CAN" "$FIX/canproj/seats/desk.ts"; cp "$NEEDS" "$FIX/canproj/seats/needs.ts"; cp "$PROJ/seats/digest.ts" "$FIX/canproj/seats/digest.ts"; cp "$PROJ/seats/needs.jsonl" "$FIX/canproj/seats/needs.jsonl"
P2="$(port)"; (cd "$FIX/canproj" && exec env WHEELHOUSE_DESK_ROOT="$FIX/canproj" WHEELHOUSE_DESK_PORT="$P2" bun "$FIX/canproj/seats/desk.ts" >/dev/null 2>&1) & PID=$!
for _ in $(seq 1 50); do curl -fsS "http://127.0.0.1:$P2/needs" > "$FIX/canary.html" 2>/dev/null && break; sleep 0.1; done
if grep -q 'demo-ab12' "$FIX/canary.html"; then pass "canary: rendering machine.bead is caught"; else fail "canary did not expose machine.bead leak"; fi
[ -n "$PID" ] && kill "$PID" 2>/dev/null || true; PID=""
BOARD_CAN="$FIX/board-canary.ts"; cp "$PROJ/seats/desk.ts" "$BOARD_CAN"
bun - "$BOARD_CAN" <<'JS'
const fs=(await import('node:fs')).default,p=process.argv[2],s=fs.readFileSync(p,'utf8'),old='title:String(i.title||"Untitled work"),';
if(!s.includes(old)) throw new Error('board id canary source changed');
fs.writeFileSync(p,s.replace(old,'title:String(i.id)+" "+String(i.title||"Untitled work"),'));
JS
if cmp -s "$PROJ/seats/desk.ts" "$BOARD_CAN"; then
  fail "canary: could not make board print ids; test proves nothing"
else
  mkdir -p "$FIX/boardcan/seats" "$FIX/boardcan/wheelhouse" "$FIX/boardcan/bin"
  cp "$BOARD_CAN" "$FIX/boardcan/seats/desk.ts"; cp "$NEEDS" "$FIX/boardcan/seats/needs.ts"; cp "$PROJ/seats/digest.ts" "$FIX/boardcan/seats/digest.ts"; cp "$PROJ/seats/needs.jsonl" "$FIX/boardcan/seats/needs.jsonl"; cp "$PROJ/seats/state.json" "$FIX/boardcan/seats/state.json"; cp -R "$PROJ/seats/verdicts" "$FIX/boardcan/seats/"; cp "$PROJ/bin/bd" "$FIX/boardcan/bin/bd"; cp "$PROJ/wheelhouse/.template-source" "$FIX/boardcan/wheelhouse/.template-source"
  P3="$(port)"; (cd "$FIX/boardcan" && exec env PATH="$FIX/boardcan/bin:$PATH" WHEELHOUSE_DESK_ROOT="$FIX/boardcan" WHEELHOUSE_DESK_PORT="$P3" bun "$FIX/boardcan/seats/desk.ts" >/dev/null 2>&1) & PID=$!
  for _ in $(seq 1 80); do curl -fsS "http://127.0.0.1:$P3/board" > "$FIX/board-canary.html" 2>/dev/null || true; grep -q 'demo-ready' "$FIX/board-canary.html" 2>/dev/null && break; sleep 0.1; done
  if grep -q 'demo-ready' "$FIX/board-canary.html"; then pass "canary: a board copy that prints ids is caught"; else fail "canary did not expose board id leak"; fi
  [ -n "$PID" ] && kill "$PID" 2>/dev/null || true; PID=""
fi
stop_fixture_desks
assert_no_fixture_desks
if [ "$FAIL" -eq 0 ]; then echo "desk.selftest: PASS ($PASS checks)"; exit 0; fi
echo "desk.selftest: FAIL ($FAIL failed, $PASS passed)" >&2; exit 1
