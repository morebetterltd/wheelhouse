#!/usr/bin/env bash
set -u
SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"
HERE="$(cd "$(dirname "$0")" && pwd -P)"
DESK="$HERE/desk.ts"
NEEDS="$HERE/needs.ts"
WATCHDOG="$HERE/desk-watchdog.sh"
[ -f "$DESK" ] || { echo "selftest: missing $DESK" >&2; exit 2; }
command -v bun >/dev/null 2>&1 || { echo "selftest: bun required" >&2; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "selftest: python3 required" >&2; exit 2; }
FIX="$(mktemp -d "${TMPDIR:-/tmp}/wheelhouse-desk-selftest.XXXXXX")"; FIX="$(cd "$FIX" && pwd -P)"
PASS=0; FAIL=0; PID=""; WATCHDOG_PID=""
cleanup(){ [ -n "$PID" ] && kill "$PID" 2>/dev/null || true; [ -n "$WATCHDOG_PID" ] && kill "$WATCHDOG_PID" 2>/dev/null || true; selftest_cleanup_fixture_processes "${FIX:-}" "${SOCK:-}"; rm -rf "$FIX"; }
trap cleanup EXIT INT TERM
pass(){ PASS=$((PASS+1)); echo "ok $PASS - $*"; }
fail(){ FAIL=$((FAIL+1)); echo "not ok $((PASS+FAIL)) - $*" >&2; }
port(){ python3 - <<'PY'
import socket
s=socket.socket(); s.bind(('127.0.0.1',0)); print(s.getsockname()[1]); s.close()
PY
}
PROJ="$FIX/proj"; mkdir -p "$PROJ/seats" "$PROJ/wheelhouse"
cp "$DESK" "$PROJ/seats/desk.ts"; cp "$NEEDS" "$PROJ/seats/needs.ts"; [ -f "$WATCHDOG" ] && cp "$WATCHDOG" "$PROJ/seats/desk-watchdog.sh" && chmod +x "$PROJ/seats/desk-watchdog.sh"
cat > "$PROJ/wheelhouse/.template-source" <<'EOF'
namespace=demo
EOF
cat > "$PROJ/seats/needs.jsonl" <<'EOF'
{"type":"opened","id":"need-open","at":"2026-09-21T00:00:00.000Z","kind":"question","title":"Choose lunch","body":"Pick a meal","options":[{"label":"A","text":"Soup"},{"label":"B","text":"Salad"}],"default":"A; applies after noon","consequence":"We order the default.","machine":{"bead":"demo-ab12","seat":"worker-1"}}
{"type":"message","id":"need-open","at":"2026-09-21T00:01:00.000Z","from":"commander","via":"cli","text":"Please choose."}
{"type":"opened","id":"need-old","at":"2026-09-20T00:00:00.000Z","kind":"question","title":"Old question","body":"Already answered","options":[],"machine":{}}
{"type":"answered","id":"need-old","at":"2026-09-20T00:02:00.000Z","from":"human","via":"cli","text":"done"}
{"type":"opened","id":"need-board","at":"2026-09-21T00:03:00.000Z","kind":"question","title":"Approve deploy","body":"Need a human decision","options":[],"machine":{"bead":"demo-human"}}
EOF
mkdir -p "$PROJ/seats/verdicts" "$PROJ/bin"
cat > "$PROJ/seats/state.json" <<'EOF'
{"seats":{"builder":{"role":"worker","lastBead":"demo-progress"},"reviewer-a":{"role":"reviewer","lastBead":"demo-review"},"reviewer-finished":{"role":"reviewer","lastBead":"demo-finished"},"verifier-a":{"role":"verifier","lastBead":"demo-other"}}}
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
P="$(port)"
(cd "$PROJ" && PATH="$PROJ/bin:$PATH" WHEELHOUSE_DESK_ROOT="$PROJ" WHEELHOUSE_DESK_PORT="$P" bun seats/desk.ts > "$FIX/desk.out" 2> "$FIX/desk.err") & PID=$!
for _ in $(seq 1 50); do [ -s "$PROJ/seats/run/desk.port" ] && curl -fsS "http://127.0.0.1:$P/needs" > "$FIX/needs.html" 2>/dev/null && break; sleep 0.1; done
if kill -0 "$PID" 2>/dev/null && grep -q "http://127.0.0.1:$P/needs" "$PROJ/seats/run/desk.port"; then pass "desk starts and writes seats/run/desk.port"; else fail "desk did not start: $(cat "$FIX/desk.err" 2>/dev/null)"; fi
if grep -q 'Choose lunch' "$FIX/needs.html" && grep -q 'Old question' "$FIX/needs.html" && [ "$(grep -n 'Choose lunch\|Old question' "$FIX/needs.html" | head -1 | grep -c 'Choose lunch')" = 1 ]; then pass "GET /needs renders open needs first and answered needs as history"; else fail "GET /needs did not render open/history correctly"; fi
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
if python3 - "$FIX/board.json" <<'PY'
import json, sys
data=json.load(open(sys.argv[1])); cols={c['title']:c['cards'] for c in data['columns']}
def has(col,title,seat=None):
  for c in cols.get(col,[]):
    if c.get('title')==title and (seat is None or c.get('seat')==seat): return True
  return False
assert has('Ready','Write the guide','ready')
assert not has('Ready','Hidden dependency work')
assert has('In progress','Build the package','builder')
assert has('In review','Check the branch','reviewer-a')
assert has('In review','Fix the rejected change','sent back')
assert has('In review','Finished but still in progress','reviewer-finished')
assert not has('In progress','Finished but still in progress')
assert sum(1 for cards in cols.values() for c in cards if c.get('title') == 'Finished but still in progress') == 1
assert has('Blocked on you','Answer the product question','waiting on you')
assert cols['Blocked on you'][0].get('needHref') == '/needs'
assert has('Merged recently','Ship the button','integrator')
assert not has('Merged recently','Ancient merge')
PY
then pass "GET /api/board.json places cards in the right columns with the right seats"; else fail "board JSON did not match expected columns: $(cat "$FIX/board.json" 2>/dev/null)"; fi
PREC_CAN="$FIX/precedence-canary.ts"; cp "$PROJ/seats/desk.ts" "$PREC_CAN"
python3 - "$PREC_CAN" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]); s=p.read_text(); old='if(placed.has(id)) return;'
if old not in s: raise SystemExit(1)
s=s.replace(old, '', 1)
p.write_text(s)
PY
if cmp -s "$PROJ/seats/desk.ts" "$PREC_CAN"; then
  fail "canary: could not disable board de-duplication; test proves nothing"
else
  mkdir -p "$FIX/preccan/seats" "$FIX/preccan/wheelhouse" "$FIX/preccan/bin"
  cp "$PREC_CAN" "$FIX/preccan/seats/desk.ts"; cp "$NEEDS" "$FIX/preccan/seats/needs.ts"; cp "$PROJ/seats/needs.jsonl" "$FIX/preccan/seats/needs.jsonl"; cp "$PROJ/seats/state.json" "$FIX/preccan/seats/state.json"; cp -R "$PROJ/seats/verdicts" "$FIX/preccan/seats/"; cp "$PROJ/bin/bd" "$FIX/preccan/bin/bd"; cp "$PROJ/wheelhouse/.template-source" "$FIX/preccan/wheelhouse/.template-source"
  PPREC="$(port)"; (cd "$FIX/preccan" && PATH="$FIX/preccan/bin:$PATH" WHEELHOUSE_DESK_ROOT="$FIX/preccan" WHEELHOUSE_DESK_PORT="$PPREC" bun seats/desk.ts >/dev/null 2>&1) & PID=$!
  for _ in $(seq 1 80); do curl -fsS "http://127.0.0.1:$PPREC/api/board.json" > "$FIX/precedence-canary.json" 2>/dev/null || true; grep -q 'Finished but still in progress' "$FIX/precedence-canary.json" 2>/dev/null && break; sleep 0.1; done
  if python3 - "$FIX/precedence-canary.json" <<'PY'
import json, sys
data=json.load(open(sys.argv[1])); cols={c['title']:c['cards'] for c in data['columns']}
count=sum(1 for cards in cols.values() for c in cards if c.get('title')=='Finished but still in progress')
assert count > 1 or any(c.get('title')=='Finished but still in progress' for c in cols.get('In progress', []))
PY
  then pass "canary: disabling board precedence is caught by duplicate/in-progress placement"; else fail "canary did not expose duplicate/in-progress placement: $(cat "$FIX/precedence-canary.json" 2>/dev/null)"; fi
  [ -n "$PID" ] && kill "$PID" 2>/dev/null || true; PID=""
fi
if grep -q 'Write the guide' "$FIX/board.html" && grep -q 'Build the package' "$FIX/board.html" && grep -q 'sent back' "$FIX/board.html" && grep -q 'Open need' "$FIX/board.html"; then pass "GET /board renders board cards and need link"; else fail "GET /board missing expected card text"; fi
if ! grep -Eq '<(form|button|input|textarea)([ >])' "$FIX/board.html" && [ "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$P/board")" = 404 ]; then pass "board has no write controls and no POST route"; else fail "board exposed write controls or POST route"; fi
if ! grep -Eq 'demo-[a-z0-9-]+' "$FIX/board.html"; then pass "board HTML hides namespace ids"; else fail "board HTML leaked ids: $(grep -Eo 'demo-[a-z0-9-]+' "$FIX/board.html" | sort -u | tr '\n' ' ')"; fi
if ! grep -q 'demo-ab12' "$FIX/needs.html" && ! grep -qi 'worker-1\|seat\|bead' "$FIX/needs.html"; then pass "HTML hides machine bead id and seat jargon"; else fail "HTML leaked machine fields: $(grep -oi 'demo-ab12\|worker-1\|seat\|bead' "$FIX/needs.html" | sort -u | tr '\n' ' ')"; fi
before="$(grep -c '"type":"answered"' "$PROJ/seats/needs.jsonl")"
curl -fsS -X POST -d 'text=Salad&choice=B' "http://127.0.0.1:$P/api/needs/need-open/answer" >/dev/null || fail "POST answer failed"
after="$(grep -c '"type":"answered"' "$PROJ/seats/needs.jsonl")"
if [ $((after-before)) -eq 1 ] && tail -1 "$PROJ/seats/needs.jsonl" | grep -q '"via":"desk"' && tail -1 "$PROJ/seats/needs.jsonl" | grep -q '"choice":"B"'; then pass "POST answer appends exactly one answered event through the ledger"; else fail "POST answer ledger wrong"; fi
curl -fsS -X POST -d 'text=Thanks' "http://127.0.0.1:$P/api/needs/need-open/message" >/dev/null || fail "POST message failed"
if tail -1 "$PROJ/seats/needs.jsonl" | grep -q '"type":"message"' && tail -1 "$PROJ/seats/needs.jsonl" | grep -q '"from":"human"'; then pass "POST message appends a human message"; else fail "POST message ledger wrong"; fi
if command -v lsof >/dev/null 2>&1; then
  LSOF="$(lsof -nP -iTCP:$P -sTCP:LISTEN 2>/dev/null || true)"
  if printf '%s\n' "$LSOF" | grep -q "127.0.0.1:$P" && ! printf '%s\n' "$LSOF" | grep -q "\*:$P\|0.0.0.0:$P"; then pass "desk listens on 127.0.0.1 only"; else fail "desk bind was not localhost-only: $LSOF"; fi
else echo "ok $((PASS+1)) - SKIP lsof not available"; PASS=$((PASS+1)); fi
SLOW="$FIX/slowproj"; mkdir -p "$SLOW"; cp -R "$PROJ/seats" "$SLOW/seats"; mkdir -p "$SLOW/wheelhouse" "$SLOW/bin"; cp "$PROJ/wheelhouse/.template-source" "$SLOW/wheelhouse/.template-source"; cp "$PROJ/bin/bd" "$SLOW/bin/bd"
PSLOW="$(port)"; (cd "$SLOW" && PATH="$SLOW/bin:$PATH" WHEELHOUSE_STUB_BD_SLEEP=2 WHEELHOUSE_DESK_BOARD_REFRESH_MS=100 WHEELHOUSE_DESK_ROOT="$SLOW" WHEELHOUSE_DESK_PORT="$PSLOW" bun seats/desk.ts >/dev/null 2> "$FIX/slow-desk.err") & SLOW_PID=$!
for _ in $(seq 1 50); do curl -fsS "http://127.0.0.1:$PSLOW/board" >/dev/null 2>&1 && break; sleep 0.1; done
NEEDS_MS="$(python3 - "http://127.0.0.1:$PSLOW/needs" "$FIX/slow-needs.html" <<'PY'
import sys, time, urllib.request
start=time.time(); urllib.request.urlretrieve(sys.argv[1], sys.argv[2]); print(int((time.time()-start)*1000))
PY
)"
if [ "$NEEDS_MS" -lt 1000 ] && kill -0 "$SLOW_PID" 2>/dev/null; then pass "slow bd refresh never runs in a request: /needs answers in under 1s and desk survives"; else fail "slow bd blocked /needs or killed desk (ms=$NEEDS_MS err=$(cat "$FIX/slow-desk.err" 2>/dev/null))"; fi
kill "$SLOW_PID" 2>/dev/null || true; wait "$SLOW_PID" 2>/dev/null || true
WHEELHOUSE_DESK_ROOT="$PROJ" WHEELHOUSE_DESK_WATCHDOG_SECONDS=1 "$PROJ/seats/desk-watchdog.sh" > "$FIX/watchdog.out" 2> "$FIX/watchdog.err" & WATCHDOG_PID=$!
sleep 0.5
OLD_PID="$PID"; kill "$OLD_PID" 2>/dev/null || true
NEW_PID=""
for _ in $(seq 1 60); do
  NEW_PID="$(cat "$PROJ/seats/run/desk.pid" 2>/dev/null || true)"
  if [ -n "$NEW_PID" ] && [ "$NEW_PID" != "$OLD_PID" ] && kill -0 "$NEW_PID" 2>/dev/null && curl -fsS "http://127.0.0.1:$P/needs" > "$FIX/restarted-needs.html" 2>/dev/null; then break; fi
  sleep 0.5
done
if [ -n "$NEW_PID" ] && [ "$NEW_PID" != "$OLD_PID" ] && kill -0 "$NEW_PID" 2>/dev/null && grep -q 'desk restarted: pid' "$PROJ/seats/logs/desk.stderr.log"; then pass "desk watchdog restarts a killed desk and records the restart"; else fail "desk watchdog did not restart within 30s (old=$OLD_PID new=$NEW_PID out=$(cat "$FIX/watchdog.out" 2>/dev/null) err=$(cat "$PROJ/seats/logs/desk.stderr.log" 2>/dev/null))"; fi
kill "$WATCHDOG_PID" 2>/dev/null || true; wait "$WATCHDOG_PID" 2>/dev/null || true; WATCHDOG_PID=""
PID="$NEW_PID"; kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; PID=""
CAN="$FIX/canary.ts"; cp "$PROJ/seats/desk.ts" "$CAN"
python3 - "$CAN" <<'PY'
from pathlib import Path
p=Path(__import__('sys').argv[1]); s=p.read_text(); old='${n.opened.options.length?`<form'
if old not in s: raise SystemExit(1)
s=s.replace('<p>${esc(n.opened.body)}</p>', '<p>${esc(n.opened.body)}</p><p>${esc(n.opened.machine.bead)}</p>', 1)
p.write_text(s)
PY
mkdir -p "$FIX/canproj/seats" "$FIX/canproj/wheelhouse"; cp "$CAN" "$FIX/canproj/seats/desk.ts"; cp "$NEEDS" "$FIX/canproj/seats/needs.ts"; cp "$PROJ/seats/needs.jsonl" "$FIX/canproj/seats/needs.jsonl"
P2="$(port)"; (cd "$FIX/canproj" && WHEELHOUSE_DESK_ROOT="$FIX/canproj" WHEELHOUSE_DESK_PORT="$P2" bun seats/desk.ts >/dev/null 2>&1) & PID=$!
for _ in $(seq 1 50); do curl -fsS "http://127.0.0.1:$P2/needs" > "$FIX/canary.html" 2>/dev/null && break; sleep 0.1; done
if grep -q 'demo-ab12' "$FIX/canary.html"; then pass "canary: rendering machine.bead is caught"; else fail "canary did not expose machine.bead leak"; fi
[ -n "$PID" ] && kill "$PID" 2>/dev/null || true; PID=""
BOARD_CAN="$FIX/board-canary.ts"; cp "$PROJ/seats/desk.ts" "$BOARD_CAN"
python3 - "$BOARD_CAN" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]); s=p.read_text(); old='title:String(i.title||"Untitled work"),'
if old not in s: raise SystemExit(1)
s=s.replace(old, 'title:String(i.id)+" "+String(i.title||"Untitled work"),', 1)
p.write_text(s)
PY
if cmp -s "$PROJ/seats/desk.ts" "$BOARD_CAN"; then
  fail "canary: could not make board print ids; test proves nothing"
else
  mkdir -p "$FIX/boardcan/seats" "$FIX/boardcan/wheelhouse" "$FIX/boardcan/bin"
  cp "$BOARD_CAN" "$FIX/boardcan/seats/desk.ts"; cp "$NEEDS" "$FIX/boardcan/seats/needs.ts"; cp "$PROJ/seats/needs.jsonl" "$FIX/boardcan/seats/needs.jsonl"; cp "$PROJ/seats/state.json" "$FIX/boardcan/seats/state.json"; cp -R "$PROJ/seats/verdicts" "$FIX/boardcan/seats/"; cp "$PROJ/bin/bd" "$FIX/boardcan/bin/bd"; cp "$PROJ/wheelhouse/.template-source" "$FIX/boardcan/wheelhouse/.template-source"
  P3="$(port)"; (cd "$FIX/boardcan" && PATH="$FIX/boardcan/bin:$PATH" WHEELHOUSE_DESK_ROOT="$FIX/boardcan" WHEELHOUSE_DESK_PORT="$P3" bun seats/desk.ts >/dev/null 2>&1) & PID=$!
  for _ in $(seq 1 80); do curl -fsS "http://127.0.0.1:$P3/board" > "$FIX/board-canary.html" 2>/dev/null || true; grep -q 'demo-ready' "$FIX/board-canary.html" 2>/dev/null && break; sleep 0.1; done
  if grep -q 'demo-ready' "$FIX/board-canary.html"; then pass "canary: a board copy that prints ids is caught"; else fail "canary did not expose board id leak"; fi
  [ -n "$PID" ] && kill "$PID" 2>/dev/null || true; PID=""
fi
if [ "$FAIL" -eq 0 ]; then echo "desk.selftest: PASS ($PASS checks)"; exit 0; fi
echo "desk.selftest: FAIL ($FAIL failed, $PASS passed)" >&2; exit 1
