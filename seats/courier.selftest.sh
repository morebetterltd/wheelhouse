#!/usr/bin/env bash
set -u
SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"
HERE="$(cd "$(dirname "$0")" && pwd -P)"
COURIER="$HERE/courier.ts"
WATCHDOG="$HERE/courier-watchdog.sh"
NEEDS="$HERE/needs.ts"
TELEGRAM="$HERE/transports/telegram.ts"
TRANSPORT="$HERE/transports/transport.ts"
command -v bun >/dev/null 2>&1 || { echo "selftest: bun required" >&2; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "selftest: python3 required" >&2; exit 2; }
FIX="$(mktemp -d "${TMPDIR:-/tmp}/wheelhouse-courier-selftest.XXXXXX")"; FIX="$(cd "$FIX" && pwd -P)"
PASS=0; FAIL=0; SERVER_PID=""; COURIER_PID=""; WATCHDOG_PID=""
sweep_fixture_couriers(){
  [ -n "${FIX:-}" ] || return 0
  for pid in $(pgrep -f 'seats/courier\.ts|courier-watchdog\.sh' 2>/dev/null || true); do
    [ -n "$pid" ] || continue
    if lsof -p "$pid" 2>/dev/null | grep -qF "$FIX"; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  return 0
}
stop_courier(){
  [ -n "${COURIER_PID:-}" ] || return 0
  kill "$COURIER_PID" 2>/dev/null || true
  wait "$COURIER_PID" 2>/dev/null || true
  COURIER_PID=""
}
cleanup(){ stop_courier; [ -n "$WATCHDOG_PID" ] && kill "$WATCHDOG_PID" 2>/dev/null || true; [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true; sweep_fixture_couriers; selftest_cleanup_fixture_processes "${FIX:-}" ""; rm -rf "$FIX"; }
trap cleanup EXIT INT TERM
pass(){ PASS=$((PASS+1)); echo "ok $PASS - $*"; }
fail(){ FAIL=$((FAIL+1)); echo "not ok $((PASS+FAIL)) - $*" >&2; }
port(){ python3 - <<'PY'
import socket
s=socket.socket(); s.bind(('127.0.0.1',0)); print(s.getsockname()[1]); s.close()
PY
}
make_proj(){
  local p="$1"; mkdir -p "$p/seats/transports" "$p/seats/run" "$p/seats/logs" "$p/wheelhouse"
  cp "$COURIER" "$p/seats/courier.ts"; [ -f "$WATCHDOG" ] && cp "$WATCHDOG" "$p/seats/courier-watchdog.sh" && chmod +x "$p/seats/courier-watchdog.sh"; cp "$NEEDS" "$p/seats/needs.ts"; cp "$TELEGRAM" "$p/seats/transports/telegram.ts"; cp "$TRANSPORT" "$p/seats/transports/transport.ts"
  printf 'namespace=demo\n' > "$p/wheelhouse/.template-source"
  printf 'TESTTOKEN\n' > "$p/seats/run/telegram.token"; chmod 600 "$p/seats/run/telegram.token"
  printf '111\n' > "$p/seats/run/telegram.allow"
}
write_server(){
  cat > "$FIX/server.ts" <<'EOF'
import * as fs from "node:fs";
const dir = process.env.STUB_DIR!;
let msg = 0;
function json(path:string, fallback:any){ try { return JSON.parse(fs.readFileSync(`${dir}/${path}`,"utf8")); } catch { return fallback; } }
function append(path:string, row:any){ fs.appendFileSync(`${dir}/${path}`, JSON.stringify(row)+"\n"); }
Bun.serve({ hostname:"127.0.0.1", port:Number(process.env.STUB_PORT), async fetch(req){
  const u=new URL(req.url); const body=req.method==="POST" ? await req.json().catch(()=>({})) : {};
  if(u.pathname.endsWith('/sendMessage')) {
    msg++; append('requests.jsonl', {method:'sendMessage', body});
    const failFile=`${dir}/fail-send-once`;
    if (fs.existsSync(failFile)) { fs.unlinkSync(failFile); return Response.json({ok:false,description:'Bad Request: chat not found'}, {status:400}); }
    return Response.json({ok:true,result:{message_id:msg,chat:{id:body.chat_id}}});
  }
  if(u.pathname.endsWith('/getUpdates')) {
    append('requests.jsonl', {method:'getUpdates', body});
    const failFile=`${dir}/fail-poll-once`;
    if (fs.existsSync(failFile)) { fs.unlinkSync(failFile); return Response.json({ok:false,description:'Bad Request: poll failed'}, {status:400}); }
    const updates=json('updates.json', []); fs.writeFileSync(`${dir}/updates.json`, '[]\n'); return Response.json({ok:true,result:updates});
  }
  return Response.json({ok:false,description:'no route'}, {status:404});
}});
EOF
}
start_courier_daemon(){
  local root="$1" interval="$2" err="$3"
  (cd "$root" && exec env WHEELHOUSE_TELEGRAM_API_BASE="http://127.0.0.1:$P" WHEELHOUSE_TELEGRAM_POLL_TIMEOUT=0 WHEELHOUSE_COURIER_INTERVAL_MS="$interval" bun seats/courier.ts >/dev/null 2> "$err") &
  COURIER_PID=$!
}
requests(){ python3 - <<'PY' "$FIX/requests.jsonl"
import json,sys,os
p=sys.argv[1]
if not os.path.exists(p): sys.exit(0)
for l in open(p):
 print(l.strip())
PY
}
count_ledger(){ PAT="$1" python3 - <<'PY' "$PROJ/seats/needs.jsonl"
import json, os, sys
pat=os.environ['PAT']; n=0
for l in open(sys.argv[1]):
 if pat in l: n+=1
print(n)
PY
}
PROJ="$FIX/proj"; make_proj "$PROJ"; write_server
P="$(port)"; STUB_DIR="$FIX" STUB_PORT="$P" bun "$FIX/server.ts" > "$FIX/server.out" 2> "$FIX/server.err" & SERVER_PID=$!
for _ in $(seq 1 50); do curl -fsS "http://127.0.0.1:$P/" >/dev/null 2>&1 || true; kill -0 "$SERVER_PID" 2>/dev/null && break; sleep 0.1; done
cat > "$PROJ/seats/needs.jsonl" <<'EOF'
{"type":"opened","id":"need-one","at":"2026-09-21T00:00:00.000Z","kind":"question","title":"Approve tag","body":"Ship it?","options":[{"label":"A","text":"Yes"},{"label":"B","text":"No"}],"machine":{}}
EOF
(cd "$PROJ" && WHEELHOUSE_TELEGRAM_API_BASE="http://127.0.0.1:$P" WHEELHOUSE_TELEGRAM_POLL_TIMEOUT=0 bun seats/courier.ts --once) > "$FIX/once1.out" 2> "$FIX/once1.err"
if [ $? -eq 0 ] && grep -q '"method":"sendMessage"' "$FIX/requests.jsonl" && grep -q 'Approve tag' "$FIX/requests.jsonl" && grep -q '"type":"sent"' "$PROJ/seats/needs.jsonl"; then pass "planted opened need sends one Telegram message and records sent"; else fail "opened send failed out=$(cat "$FIX/once1.out" "$FIX/once1.err" 2>/dev/null) req=$(requests) ledger=$(cat "$PROJ/seats/needs.jsonl")"; fi
cat > "$FIX/updates.json" <<'EOF'
[{"update_id":10,"message":{"message_id":50,"date":1790000000,"chat":{"id":111},"from":{"id":111},"text":"A","reply_to_message":{"message_id":1}}}]
EOF
(cd "$PROJ" && WHEELHOUSE_TELEGRAM_API_BASE="http://127.0.0.1:$P" WHEELHOUSE_TELEGRAM_POLL_TIMEOUT=0 bun seats/courier.ts --once) > "$FIX/once2.out" 2> "$FIX/once2.err"
if grep -q '"type":"answered"' "$PROJ/seats/needs.jsonl" && grep -q '"via":"telegram"' "$PROJ/seats/needs.jsonl" && grep -q '"choice":"A"' "$PROJ/seats/needs.jsonl"; then pass "allowed Telegram reply records an answered event with via telegram and choice"; else fail "reply did not answer ledger=$(cat "$PROJ/seats/needs.jsonl") out=$(cat "$FIX/once2.out" "$FIX/once2.err" 2>/dev/null)"; fi
cat > "$FIX/updates.json" <<'EOF'
[{"update_id":12,"message":{"message_id":52,"date":1790000001,"chat":{"id":111},"from":{"id":111},"text":"follow-up","reply_to_message":{"message_id":1}}}]
EOF
(cd "$PROJ" && WHEELHOUSE_TELEGRAM_API_BASE="http://127.0.0.1:$P" WHEELHOUSE_TELEGRAM_POLL_TIMEOUT=0 bun seats/courier.ts --once) >/dev/null 2>&1
if grep -q '"type":"message"' "$PROJ/seats/needs.jsonl" && grep -q '"from":"human"' "$PROJ/seats/needs.jsonl" && grep -q 'follow-up' "$PROJ/seats/needs.jsonl"; then pass "Telegram reply to answered-but-open need records a threaded human message"; else fail "answered follow-up did not become message ledger=$(cat "$PROJ/seats/needs.jsonl")"; fi
printf '%s
' '{"type":"closed","id":"need-one","at":"2026-09-21T00:02:00.000Z","reason":"complete"}' >> "$PROJ/seats/needs.jsonl"
(cd "$PROJ" && WHEELHOUSE_TELEGRAM_API_BASE="http://127.0.0.1:$P" WHEELHOUSE_TELEGRAM_POLL_TIMEOUT=0 bun seats/courier.ts --once) >/dev/null 2>&1
if tail -20 "$FIX/requests.jsonl" | grep -q 'Resolved: complete'; then pass "closed notice is sent as the thread-ending Telegram message"; else fail "closed notice missing req=$(tail -20 "$FIX/requests.jsonl")"; fi
before_ans="$(count_ledger '"type":"answered"')"
cat > "$FIX/updates.json" <<'EOF'
[{"update_id":11,"message":{"message_id":51,"date":1790000001,"chat":{"id":999},"from":{"id":999},"text":"B","reply_to_message":{"message_id":1}}}]
EOF
(cd "$PROJ" && WHEELHOUSE_TELEGRAM_API_BASE="http://127.0.0.1:$P" WHEELHOUSE_TELEGRAM_POLL_TIMEOUT=0 bun seats/courier.ts --once) >/dev/null 2>&1
after_ans="$(count_ledger '"type":"answered"')"
if [ "$before_ans" = "$after_ans" ] && grep -q 'ignored telegram sender 999' "$PROJ/seats/logs/courier.out.log"; then pass "unallowlisted sender is ignored and logged"; else fail "unallowlisted sender changed ledger/log ledger=$(cat "$PROJ/seats/needs.jsonl") log=$(cat "$PROJ/seats/logs/courier.out.log" 2>/dev/null)"; fi
printf '%s
' '{"type":"message","id":"need-one","at":"2026-09-21T00:03:00.000Z","from":"commander","via":"cli","text":"Extra context"}' >> "$PROJ/seats/needs.jsonl"
(cd "$PROJ" && WHEELHOUSE_TELEGRAM_API_BASE="http://127.0.0.1:$P" WHEELHOUSE_TELEGRAM_POLL_TIMEOUT=0 bun seats/courier.ts --once) >/dev/null 2>&1
if tail -20 "$FIX/requests.jsonl" | grep -q 'Extra context' && tail -20 "$FIX/requests.jsonl" | grep -q '"reply_to_message_id":1'; then pass "commander say pushes a threaded Telegram sendMessage"; else fail "commander say was not threaded req=$(tail -20 "$FIX/requests.jsonl")"; fi
RETRY="$FIX/retry"; make_proj "$RETRY"
cat > "$RETRY/seats/needs.jsonl" <<'EOF'
{"type":"opened","id":"need-retry","at":"2026-09-21T00:00:00.000Z","kind":"question","title":"Retry me","body":"First send fails","options":[],"machine":{}}
EOF
: > "$FIX/requests.jsonl"; : > "$RETRY/seats/logs/courier.out.log"; touch "$FIX/fail-send-once"
start_courier_daemon "$RETRY" 200 "$FIX/retry.err"
sleep 0.8
if kill -0 "$COURIER_PID" 2>/dev/null && grep -q 'send failed need=need-retry: Bad Request: chat not found' "$RETRY/seats/logs/courier.out.log"; then pass "transport send failure is logged with need id and courier keeps running"; else fail "courier did not survive/log first send failure pid=$COURIER_PID log=$(cat "$RETRY/seats/logs/courier.out.log" 2>/dev/null) err=$(cat "$FIX/retry.err" 2>/dev/null)"; fi
for _ in $(seq 1 30); do grep -q '"type":"sent"' "$RETRY/seats/needs.jsonl" && break; sleep 0.2; done
sent_count="$(grep -c '"type":"sent"' "$RETRY/seats/needs.jsonl" || true)"
if [ "$sent_count" -eq 1 ]; then pass "failed outbound event is retried and records exactly one sent event after success"; else fail "retry sent count=$sent_count ledger=$(cat "$RETRY/seats/needs.jsonl") requests=$(cat "$FIX/requests.jsonl" 2>/dev/null)"; fi
stop_courier
POLLFAIL="$FIX/pollfail"; make_proj "$POLLFAIL"
cat > "$POLLFAIL/seats/needs.jsonl" <<'EOF'
{"type":"opened","id":"need-poll","at":"2026-09-21T00:00:00.000Z","kind":"question","title":"Poll failure","body":"Keep daemon alive","options":[],"machine":{}}
EOF
: > "$FIX/requests.jsonl"; : > "$POLLFAIL/seats/logs/courier.out.log"; touch "$FIX/fail-poll-once"
start_courier_daemon "$POLLFAIL" 200 "$FIX/pollfail.err"
sleep 0.45
if kill -0 "$COURIER_PID" 2>/dev/null && grep -q 'poll failed: Bad Request: poll failed' "$POLLFAIL/seats/logs/courier.out.log"; then pass "poll transport failure is logged and courier daemon keeps running"; else fail "poll failure killed courier or missed log pid=$COURIER_PID log=$(cat "$POLLFAIL/seats/logs/courier.out.log" 2>/dev/null) err=$(cat "$FIX/pollfail.err" 2>/dev/null)"; fi
polls="$(grep -c '"method":"getUpdates"' "$FIX/requests.jsonl" || true)"
if [ "$polls" -ge 2 ] && grep -q 'courier scanned' "$POLLFAIL/seats/logs/courier.out.log"; then pass "poll transport failure recovers on a later cycle"; else fail "poll failure did not retry/recover polls=$polls log=$(cat "$POLLFAIL/seats/logs/courier.out.log" 2>/dev/null) req=$(cat "$FIX/requests.jsonl" 2>/dev/null)"; fi
stop_courier
PAIR="$FIX/pair"; make_proj "$PAIR"; printf '@keenan\n' > "$PAIR/seats/run/telegram.allow"
cat > "$PAIR/seats/needs.jsonl" <<'EOF'
{"type":"opened","id":"need-pair","at":"2026-09-21T00:00:00.000Z","kind":"question","title":"Pair me","body":"Wait for chat","options":[],"machine":{}}
EOF
cat > "$FIX/updates.json" <<'EOF'
[{"update_id":30,"message":{"message_id":70,"date":1790000003,"chat":{"id":222},"from":{"id":222,"username":"keenan"},"text":"hello"}}]
EOF
: > "$FIX/requests.jsonl"
(cd "$PAIR" && WHEELHOUSE_TELEGRAM_API_BASE="http://127.0.0.1:$P" WHEELHOUSE_TELEGRAM_POLL_TIMEOUT=0 bun seats/courier.ts --once) >/dev/null 2>&1
if grep -q '@keenan 222' "$PAIR/seats/run/telegram.allow" && grep -q 'paired @keenan -> 222' "$PAIR/seats/logs/courier.out.log" && grep -q 'waiting for @keenan to message the bot' "$PAIR/seats/logs/courier.out.log"; then pass "@username allow entry waits, pairs on first inbound message, and records numeric id"; else fail "pairing failed allow=$(cat "$PAIR/seats/run/telegram.allow") log=$(cat "$PAIR/seats/logs/courier.out.log" 2>/dev/null)"; fi
(cd "$PAIR" && WHEELHOUSE_TELEGRAM_API_BASE="http://127.0.0.1:$P" WHEELHOUSE_TELEGRAM_POLL_TIMEOUT=0 bun seats/courier.ts --once) >/dev/null 2>&1
if grep -q '"type":"sent"' "$PAIR/seats/needs.jsonl"; then pass "queued outbound need sends after username pairing"; else fail "paired outbound did not send ledger=$(cat "$PAIR/seats/needs.jsonl") req=$(cat "$FIX/requests.jsonl" 2>/dev/null)"; fi
WATCH="$FIX/watch"; make_proj "$WATCH"
cat > "$WATCH/seats/needs.jsonl" <<'EOF'
{"type":"opened","id":"need-watch","at":"2026-09-21T00:00:00.000Z","kind":"question","title":"Watch","body":"Restart","options":[],"machine":{}}
EOF
start_courier_daemon "$WATCH" 100 "$FIX/watch.err"
printf '%s\n' "$COURIER_PID" > "$WATCH/seats/run/courier.pid"
WHEELHOUSE_COURIER_ROOT="$WATCH" WHEELHOUSE_COURIER_WATCHDOG_SECONDS=1 "$WATCH/seats/courier-watchdog.sh" >/dev/null 2>&1 & WATCHDOG_PID=$!
sleep 0.3; kill "$COURIER_PID" 2>/dev/null || true
NEW_PID=""
for _ in $(seq 1 30); do NEW_PID="$(cat "$WATCH/seats/run/courier.pid" 2>/dev/null || true)"; [ -n "$NEW_PID" ] && [ "$NEW_PID" != "$COURIER_PID" ] && kill -0 "$NEW_PID" 2>/dev/null && break; sleep 0.2; done
if [ -n "$NEW_PID" ] && [ "$NEW_PID" != "$COURIER_PID" ] && kill -0 "$NEW_PID" 2>/dev/null; then pass "courier watchdog restarts a killed courier"; else fail "courier watchdog did not restart old=$COURIER_PID new=$NEW_PID log=$(cat "$WATCH/seats/logs/courier.out.log" 2>/dev/null)"; fi
kill "$WATCHDOG_PID" "$NEW_PID" 2>/dev/null || true; wait "$WATCHDOG_PID" 2>/dev/null || true; WATCHDOG_PID=""; COURIER_PID=""
sweep_fixture_couriers
BAD="$FIX/badmode"; make_proj "$BAD"; chmod 0644 "$BAD/seats/run/telegram.token"; cp "$PROJ/seats/needs.jsonl" "$BAD/seats/needs.jsonl"
(cd "$BAD" && WHEELHOUSE_TELEGRAM_API_BASE="http://127.0.0.1:$P" WHEELHOUSE_TELEGRAM_POLL_TIMEOUT=0 bun seats/courier.ts --once) > "$FIX/bad.out" 2>&1; BAD_RC=$?
if [ $BAD_RC -ne 0 ] && grep -q 'mode 0600' "$FIX/bad.out"; then pass "telegram token file mode 0644 is refused"; else fail "token mode refusal failed rc=$BAD_RC out=$(cat "$FIX/bad.out")"; fi
CAN="$FIX/canary"; make_proj "$CAN"
python3 - <<'PY' "$CAN/seats/courier.ts"
from pathlib import Path
import sys
p=Path(sys.argv[1]); s=p.read_text(); old='answerNeed(n.id, reply.text, tx.name, choiceFor(n.id, reply.text));'
if old not in s: raise SystemExit(1)
p.write_text(s.replace(old, 'addMessage(n.id, reply.text, "human", tx.name);', 1))
PY
if cmp -s "$PROJ/seats/courier.ts" "$CAN/seats/courier.ts"; then
  fail "canary: could not replace answer path; test proves nothing"
else
  cat > "$CAN/seats/needs.jsonl" <<'EOF'
{"type":"opened","id":"need-canary","at":"2026-09-21T00:00:00.000Z","kind":"question","title":"Canary","body":"Answer","options":[],"machine":{}}
EOF
  : > "$FIX/requests.jsonl"; echo '[]' > "$FIX/updates.json"
  (cd "$CAN" && WHEELHOUSE_TELEGRAM_API_BASE="http://127.0.0.1:$P" WHEELHOUSE_TELEGRAM_POLL_TIMEOUT=0 bun seats/courier.ts --once) >/dev/null 2>&1
  cat > "$FIX/updates.json" <<'EOF'
[{"update_id":20,"message":{"message_id":60,"date":1790000002,"chat":{"id":111},"from":{"id":111},"text":"yes","reply_to_message":{"message_id":1}}}]
EOF
  (cd "$CAN" && WHEELHOUSE_TELEGRAM_API_BASE="http://127.0.0.1:$P" WHEELHOUSE_TELEGRAM_POLL_TIMEOUT=0 bun seats/courier.ts --once) >/dev/null 2>&1
  if ! grep -q '"type":"answered"' "$CAN/seats/needs.jsonl" && grep -q '"type":"message"' "$CAN/seats/needs.jsonl"; then pass "canary: replacing answer with message is caught"; else fail "canary did not expose broken answer path ledger=$(cat "$CAN/seats/needs.jsonl")"; fi
fi
[ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true; SERVER_PID=""
if [ "$FAIL" -eq 0 ]; then echo "courier.selftest: PASS ($PASS checks)"; exit 0; fi
echo "courier.selftest: FAIL ($FAIL failed, $PASS passed)" >&2; exit 1
