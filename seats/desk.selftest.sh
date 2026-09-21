#!/usr/bin/env bash
set -u
SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"
HERE="$(cd "$(dirname "$0")" && pwd -P)"
DESK="$HERE/desk.ts"
NEEDS="$HERE/needs.ts"
[ -f "$DESK" ] || { echo "selftest: missing $DESK" >&2; exit 2; }
command -v bun >/dev/null 2>&1 || { echo "selftest: bun required" >&2; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "selftest: python3 required" >&2; exit 2; }
FIX="$(mktemp -d "${TMPDIR:-/tmp}/wheelhouse-desk-selftest.XXXXXX")"; FIX="$(cd "$FIX" && pwd -P)"
PASS=0; FAIL=0; PID=""
cleanup(){ [ -n "$PID" ] && kill "$PID" 2>/dev/null || true; selftest_cleanup_fixture_processes "${FIX:-}" "${SOCK:-}"; rm -rf "$FIX"; }
trap cleanup EXIT INT TERM
pass(){ PASS=$((PASS+1)); echo "ok $PASS - $*"; }
fail(){ FAIL=$((FAIL+1)); echo "not ok $((PASS+FAIL)) - $*" >&2; }
port(){ python3 - <<'PY'
import socket
s=socket.socket(); s.bind(('127.0.0.1',0)); print(s.getsockname()[1]); s.close()
PY
}
PROJ="$FIX/proj"; mkdir -p "$PROJ/seats" "$PROJ/wheelhouse"
cp "$DESK" "$PROJ/seats/desk.ts"; cp "$NEEDS" "$PROJ/seats/needs.ts"
cat > "$PROJ/wheelhouse/.template-source" <<'EOF'
namespace=demo
EOF
cat > "$PROJ/seats/needs.jsonl" <<'EOF'
{"type":"opened","id":"need-open","at":"2026-09-21T00:00:00.000Z","kind":"question","title":"Choose lunch","body":"Pick a meal","options":[{"label":"A","text":"Soup"},{"label":"B","text":"Salad"}],"default":"A; applies after noon","consequence":"We order the default.","machine":{"bead":"demo-ab12","seat":"worker-1"}}
{"type":"message","id":"need-open","at":"2026-09-21T00:01:00.000Z","from":"commander","via":"cli","text":"Please choose."}
{"type":"opened","id":"need-old","at":"2026-09-20T00:00:00.000Z","kind":"question","title":"Old question","body":"Already answered","options":[],"machine":{}}
{"type":"answered","id":"need-old","at":"2026-09-20T00:02:00.000Z","from":"human","via":"cli","text":"done"}
EOF
P="$(port)"
(cd "$PROJ" && WHEELHOUSE_DESK_ROOT="$PROJ" WHEELHOUSE_DESK_PORT="$P" bun seats/desk.ts > "$FIX/desk.out" 2> "$FIX/desk.err") & PID=$!
for _ in $(seq 1 50); do [ -s "$PROJ/seats/run/desk.port" ] && curl -fsS "http://127.0.0.1:$P/needs" > "$FIX/needs.html" 2>/dev/null && break; sleep 0.1; done
if kill -0 "$PID" 2>/dev/null && grep -q "http://127.0.0.1:$P/needs" "$PROJ/seats/run/desk.port"; then pass "desk starts and writes seats/run/desk.port"; else fail "desk did not start: $(cat "$FIX/desk.err" 2>/dev/null)"; fi
if grep -q 'Choose lunch' "$FIX/needs.html" && grep -q 'Old question' "$FIX/needs.html" && [ "$(grep -n 'Choose lunch\|Old question' "$FIX/needs.html" | head -1 | grep -c 'Choose lunch')" = 1 ]; then pass "GET /needs renders open needs first and answered needs as history"; else fail "GET /needs did not render open/history correctly"; fi
if grep -q 'A; applies after noon' "$FIX/needs.html" && grep -q 'We order the default' "$FIX/needs.html" && grep -q 'Soup' "$FIX/needs.html" && grep -q 'Please choose' "$FIX/needs.html"; then pass "GET /needs renders options, default, consequence, and thread"; else fail "GET /needs missing need details"; fi
curl -fsS "http://127.0.0.1:$P/api/needs.json" > "$FIX/needs.json" || fail "GET /api/needs.json failed"
if grep -q '"id":"need-open"' "$FIX/needs.json" && grep -q '"state":"open"' "$FIX/needs.json"; then pass "GET /api/needs.json returns folded needs JSON"; else fail "GET /api/needs.json missing folded need"; fi
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
kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; PID=""
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
if [ "$FAIL" -eq 0 ]; then echo "desk.selftest: PASS ($PASS checks)"; exit 0; fi
echo "desk.selftest: FAIL ($FAIL failed, $PASS passed)" >&2; exit 1
