#!/usr/bin/env bash
set -u
SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"
HERE="$(cd "$(dirname "$0")" && pwd -P)"
command -v bun >/dev/null 2>&1 || { echo "selftest: bun required" >&2; exit 2; }
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-comms-selftest.XXXXXX")" || exit 2
PASS=0; FAIL=0; SERVER_PID=""
cleanup(){ [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true; selftest_cleanup_fixture_processes "${FIX:-}"; selftest_remove_fixture_dir "$FIX"; }
trap cleanup EXIT INT TERM
pass(){ PASS=$((PASS+1)); echo "ok $PASS - $*"; }
fail(){ FAIL=$((FAIL+1)); echo "not ok $((PASS+FAIL)) - $*" >&2; }
port(){ bun -e 'const s=require("node:net").createServer(); s.listen(0,"127.0.0.1",()=>{console.log(s.address().port); s.close();});' ; }
ROOT="$FIX/proj"; mkdir -p "$ROOT/seats/transports" "$ROOT/seats/run"
cp "$HERE/comms.ts" "$HERE/channels.ts" "$HERE/needs.ts" "$HERE/herald.ts" "$ROOT/seats/"
cp "$HERE/transports/"*.ts "$ROOT/seats/transports/"
cat > "$ROOT/seats/seats.json" <<'JSON'
{"commander":{"role":"commander","external":true},"seats":{"worker-1":{"role":"worker"},"reviewer":{"role":"reviewer"}}}
JSON
cat > "$ROOT/seats/channels.json" <<'JSON'
{
  "version": 1,
  "channels": {
    "principal": { "kind": "telegram", "destination": "111", "audience": "principal", "members": [], "read": false },
    "partners": { "kind": "slack", "destination": "C08EXAMPLE", "audience": "stakeholders", "members": [{ "id": "U1", "name": "Fixture One" }], "read": true },
    "dev": { "kind": "teams", "destination": "chats/dev", "audience": "stakeholders", "members": [], "read": true }
  }
}
JSON
cat > "$FIX/server.ts" <<'TS'
import * as fs from "node:fs";
const dir=process.env.STUB_DIR!; let msg=0;
function append(row:any){ fs.appendFileSync(`${dir}/requests.jsonl`, JSON.stringify(row)+"\n"); }
function rows(name:string){ try{return fs.readFileSync(`${dir}/${name}`,"utf8").split(/\n/).filter(Boolean).map(JSON.parse);}catch{return [];} }
function remember(kind:string, row:any){ fs.appendFileSync(`${dir}/${kind}.jsonl`, JSON.stringify(row)+"\n"); }
function hidden(){ return fs.existsSync(`${dir}/fail-readback`); }
Bun.serve({hostname:"127.0.0.1", port:Number(process.env.STUB_PORT), async fetch(req){
 const u=new URL(req.url); const body=req.method==="POST" ? await req.json().catch(()=>({})) : undefined;
 append({method:req.method, url:u.pathname+u.search, body});
 if(u.pathname.includes("/sendMessage")){ msg++; const r={message_id:msg,chat:{id:body.chat_id},text:body.text}; remember("telegram", r); return Response.json({ok:true,result:r}); }
 if(u.pathname.endsWith("/chat.postMessage")){ msg++; const ts=`1790000000.${String(msg).padStart(6,"0")}`; remember("slack", {ts,channel:body.channel,user:"BOT",text:body.text}); return Response.json({ok:true,ts,message:{ts,text:body.text}}); }
 if(u.pathname.endsWith("/conversations.history")){ let messages=rows("slack.jsonl"); if(hidden()) messages=messages.map((m:any)=>({...m,text:"dropped"})); return Response.json({ok:true,messages}); }
 if(u.pathname.match(/\/messages$/) && req.method==="POST"){ msg++; const row={id:`m${msg}`,createdDateTime:`2030-01-01T00:00:${String(msg).padStart(2,"0")}Z`,messageType:"message",from:{user:{id:"u-teams",displayName:"Teams User"}},body:{content:body.body.content}}; remember("teams", row); return Response.json(row); }
 if(u.pathname.match(/\/messages\/[^/]+$/) && req.method==="GET"){ const id=u.pathname.split("/").pop(); const row=rows("teams.jsonl").find((m:any)=>m.id===id); return row?Response.json(hidden()?{...row,body:{content:"dropped"}}:row):Response.json({error:{message:"missing"}},{status:404}); }
 return Response.json({error:"no route", path:u.pathname},{status:404});
}});
TS
P="$(port)"; STUB_DIR="$FIX" STUB_PORT="$P" bun "$FIX/server.ts" > "$FIX/server.out" 2> "$FIX/server.err" & SERVER_PID=$!
sleep 0.2
base_env(){ env -u BEADS_ACTOR WHEELHOUSE_COMMS_ROOT="$ROOT" WHEELHOUSE_TELEGRAM_TOKEN=tg-token WHEELHOUSE_TELEGRAM_CHAT_ID=111 WHEELHOUSE_TELEGRAM_API_BASE="http://127.0.0.1:$P" WHEELHOUSE_SLACK_TOKEN="$(printf 'xox%s-%s' b fixture)" WHEELHOUSE_SLACK_API_BASE="http://127.0.0.1:$P" WHEELHOUSE_TEAMS_TOKEN=teams-token WHEELHOUSE_TEAMS_API_BASE="http://127.0.0.1:$P" "$@"; }
count_req(){ [ -f "$FIX/requests.jsonl" ] && wc -l < "$FIX/requests.jsonl" | tr -d ' ' || printf '0'; }
count_rows(){ if [ -f "$ROOT/seats/comms.jsonl" ]; then awk -v t="\"type\":\"$1\"" 'index($0,t){n++} END{print n+0}' "$ROOT/seats/comms.jsonl"; else printf '0'; fi; }
reset_logs(){ rm -f "$FIX/requests.jsonl" "$FIX/slack.jsonl" "$FIX/telegram.jsonl" "$FIX/teams.jsonl" "$FIX/fail-readback" "$ROOT/seats/comms.jsonl" "$ROOT/seats/inbox.jsonl" "$ROOT/seats/herald.state.json"; }

reset_logs
base_env bun "$ROOT/seats/comms.ts" send nowhere hi > "$FIX/undeclared.out" 2>&1; rc=$?
if [ $rc -eq 2 ] && grep -q 'STOP: channel nowhere is not declared in seats/channels.json' "$FIX/undeclared.out" && [ ! -e "$FIX/requests.jsonl" ] && [ ! -e "$ROOT/seats/comms.jsonl" ]; then pass 'undeclared channel refuses before any network call or ledger row'; else fail "undeclared channel leg rc=$rc out=$(cat "$FIX/undeclared.out") req=$(count_req)"; fi

reset_logs
base_env bun "$ROOT/seats/comms.ts" send C08EXAMPLE hi > "$FIX/rawid.out" 2>&1; rc=$?
if [ $rc -eq 2 ] && grep -q 'STOP: channel C08EXAMPLE is not declared in seats/channels.json' "$FIX/rawid.out" && [ ! -e "$FIX/requests.jsonl" ] && [ ! -e "$ROOT/seats/comms.jsonl" ]; then pass 'raw platform id is refused like any undeclared name before network'; else fail "raw id leg rc=$rc out=$(cat "$FIX/rawid.out") req=$(count_req)"; fi

reset_logs
base_env BEADS_ACTOR=worker-1 bun "$ROOT/seats/comms.ts" request partners "need a word with Tyler" > "$FIX/request.out" 2>&1; rc=$?; RELAY_ID="$(cat "$FIX/request.out" | tr -d '\r\n')"
if [ $rc -eq 0 ] && echo "$RELAY_ID" | grep -Eq '^relay-[0-9a-z]{4}$' && [ "$(count_rows request)" -eq 1 ] && [ "$(count_req)" -eq 0 ]; then pass 'seat relay request records one request row and makes zero network calls'; else fail "request leg rc=$rc id=$RELAY_ID ledger=$(cat "$ROOT/seats/comms.jsonl" 2>/dev/null) req=$(count_req) out=$(cat "$FIX/request.out")"; fi
base_env bun "$ROOT/seats/herald.ts" --once > "$FIX/herald-request1.out" 2>&1; rc=$?
base_env bun "$ROOT/seats/herald.ts" --once > "$FIX/herald-request2.out" 2>&1; rc2=$?
HERALD_MATCHES="$(node -e 'const fs=require("fs"); const rows=fs.existsSync(process.argv[1])?fs.readFileSync(process.argv[1],"utf8").trim().split(/\n/).filter(Boolean).map(JSON.parse):[]; console.log(rows.filter(r=>r.class==="relay-request"&&r.seat==="worker-1"&&r.state==="input-required"&&r.detail.includes("relay "+process.argv[2])).length)' "$ROOT/seats/inbox.jsonl" "$RELAY_ID")"
if [ $rc -eq 0 ] && [ $rc2 -eq 0 ] && grep -q 'appended 1 wake event' "$FIX/herald-request1.out" && grep -q 'appended 0 wake event' "$FIX/herald-request2.out" && [ "$HERALD_MATCHES" -eq 1 ]; then pass 'herald turns one relay request into one input-required inbox row and does not duplicate'; else fail "herald relay request leg rc=$rc/$rc2 out1=$(cat "$FIX/herald-request1.out") out2=$(cat "$FIX/herald-request2.out") inbox=$(cat "$ROOT/seats/inbox.jsonl" 2>/dev/null)"; fi
base_env bun "$ROOT/seats/comms.ts" relay "$RELAY_ID" > "$FIX/relay.out" 2>&1; rc=$?
if [ $rc -eq 0 ] && grep -q "^relayed $RELAY_ID C08EXAMPLE:" "$FIX/relay.out" && [ "$(grep -c 'chat.postMessage' "$FIX/requests.jsonl")" -eq 1 ] && [ "$(grep -c 'conversations.history' "$FIX/requests.jsonl")" -eq 1 ] && [ "$(count_rows sent)" -eq 1 ] && [ "$(count_rows relayed)" -eq 1 ]; then pass 'commander relay sends through shared gate, records sent and relayed rows'; else fail "relay leg rc=$rc out=$(cat "$FIX/relay.out") req=$(cat "$FIX/requests.jsonl" 2>/dev/null) ledger=$(cat "$ROOT/seats/comms.jsonl" 2>/dev/null)"; fi
BEFORE_LEDGER="$(wc -c < "$ROOT/seats/comms.jsonl" | tr -d ' ')"; BEFORE_CALLS="$(count_req)"
base_env bun "$ROOT/seats/comms.ts" relay "$RELAY_ID" > "$FIX/relay-again.out" 2>&1; rc=$?; AFTER_LEDGER="$(wc -c < "$ROOT/seats/comms.jsonl" | tr -d ' ')"; AFTER_CALLS="$(count_req)"
if [ $rc -eq 2 ] && grep -q 'STOP: already relayed' "$FIX/relay-again.out" && [ "$BEFORE_LEDGER" = "$AFTER_LEDGER" ] && [ "$BEFORE_CALLS" = "$AFTER_CALLS" ]; then pass 'relaying the same request again exits already relayed with no calls or ledger change'; else fail "relay-again leg rc=$rc out=$(cat "$FIX/relay-again.out") before=$BEFORE_LEDGER/$BEFORE_CALLS after=$AFTER_LEDGER/$AFTER_CALLS"; fi
base_env BEADS_ACTOR=worker-1 bun "$ROOT/seats/comms.ts" request partners "please decline this" > "$FIX/request-decline.out" 2>&1; DECLINE_ID="$(cat "$FIX/request-decline.out" | tr -d '\r\n')"; : > "$FIX/requests.jsonl"
base_env bun "$ROOT/seats/comms.ts" relay "$DECLINE_ID" --decline "not ours to say" > "$FIX/decline.out" 2>&1; rc=$?
if [ $rc -eq 0 ] && grep -q "^declined $DECLINE_ID" "$FIX/decline.out" && [ "$(count_rows declined)" -eq 1 ] && [ "$(count_req)" -eq 0 ]; then pass 'relay decline records declined row and makes zero network calls'; else fail "decline leg rc=$rc out=$(cat "$FIX/decline.out") req=$(count_req) ledger=$(cat "$ROOT/seats/comms.jsonl" 2>/dev/null)"; fi
base_env BEADS_ACTOR=worker-1 bun "$ROOT/seats/comms.ts" send partners hi > "$FIX/seat-send.out" 2>&1; rc=$?
if [ $rc -eq 2 ] && grep -q 'STOP: seats cannot send to stakeholders; file a relay request: bun seats/comms.ts request partners' "$FIX/seat-send.out" && [ "$(count_req)" -eq 0 ] && [ "$(count_rows sent)" -eq 1 ]; then pass 'seat identity send is refused before transport construction or new ledger row'; else fail "seat-send leg rc=$rc out=$(cat "$FIX/seat-send.out") req=$(count_req) ledger=$(cat "$ROOT/seats/comms.jsonl" 2>/dev/null)"; fi
base_env BEADS_ACTOR=reviewer bun "$ROOT/seats/comms.ts" request partners "reviewer wants relay" > "$FIX/request-reviewer.out" 2>&1; REVIEW_ID="$(cat "$FIX/request-reviewer.out" | tr -d '\r\n')"; : > "$FIX/requests.jsonl"
base_env BEADS_ACTOR=reviewer bun "$ROOT/seats/comms.ts" relay "$REVIEW_ID" > "$FIX/reviewer-relay.out" 2>&1; rc=$?
if [ $rc -eq 2 ] && grep -q 'STOP: seats cannot send to stakeholders; file a relay request: bun seats/comms.ts request partners' "$FIX/reviewer-relay.out" && [ "$(count_req)" -eq 0 ]; then pass 'reviewer identity relay is refused by the same send gate before network'; else fail "reviewer relay leg rc=$rc out=$(cat "$FIX/reviewer-relay.out") req=$(count_req)"; fi
base_env BEADS_ACTOR=worker-1 bun "$ROOT/seats/comms.ts" request partners "same source" --source fixture-source > "$FIX/source1.out" 2>&1; base_env BEADS_ACTOR=worker-1 bun "$ROOT/seats/comms.ts" request partners "same source changed" --source fixture-source > "$FIX/source2.out" 2>&1
SRC1="$(cat "$FIX/source1.out" | tr -d '\r\n')"; SRC2="$(cat "$FIX/source2.out" | tr -d '\r\n')"
SOURCE_COUNT="$(awk 'index($0,"\"source\":\"fixture-source\""){n++} END{print n+0}' "$ROOT/seats/comms.jsonl")"
if [ "$SRC1" = "$SRC2" ] && [ "$SOURCE_COUNT" -eq 1 ]; then pass 'request --source deduplicates pending relay requests and prints the existing id'; else fail "source dedupe failed src1=$SRC1 src2=$SRC2 count=$SOURCE_COUNT ledger=$(cat "$ROOT/seats/comms.jsonl")"; fi
perl -0pe 's/enforceSendIdentity\(channel\.name\);/\/\/ identity gate removed by canary/;' "$ROOT/seats/comms.ts" > "$ROOT/seats/comms-bad-identity.ts"
: > "$FIX/requests.jsonl"
base_env BEADS_ACTOR=worker-1 bun "$ROOT/seats/comms-bad-identity.ts" send partners hi > "$FIX/canary-identity.out" 2>&1; rc=$?
if [ $rc -eq 0 ] && [ "$(count_req)" -gt 0 ]; then pass 'canary: removing identity gate lets a seat send and is caught'; else fail "identity canary failed rc=$rc out=$(cat "$FIX/canary-identity.out") req=$(count_req)"; fi

reset_logs
base_env BEADS_ACTOR=commander bun "$ROOT/seats/comms.ts" send partners "shipping tonight" > "$FIX/partners.out" 2>&1; rc=$?
if [ $rc -eq 0 ] && grep -q '^sent partners C08EXAMPLE:' "$FIX/partners.out" && [ "$(grep -c 'chat.postMessage' "$FIX/requests.jsonl")" -eq 1 ] && [ "$(grep -c 'conversations.history' "$FIX/requests.jsonl")" -eq 1 ] && [ "$(count_rows sent)" -eq 1 ] && grep -q '"readBack":"fetched"' "$ROOT/seats/comms.jsonl" && ! grep -q 'shipping tonight' "$ROOT/seats/comms.jsonl"; then pass 'slack send posts once, reads back once, and records hashed sent row'; else fail "slack send leg rc=$rc out=$(cat "$FIX/partners.out") req=$(cat "$FIX/requests.jsonl" 2>/dev/null) ledger=$(cat "$ROOT/seats/comms.jsonl" 2>/dev/null)"; fi

reset_logs; touch "$FIX/fail-readback"
base_env bun "$ROOT/seats/comms.ts" send partners "shipping tonight" > "$FIX/failread.out" 2>&1; rc=$?
if [ $rc -eq 1 ] && grep -q 'STOP: send unverified: slack read-back did not return' "$FIX/failread.out" && [ "$(count_rows failed)" -eq 1 ] && [ "$(count_rows sent)" -eq 0 ]; then pass 'failed read-back records failed row and no sent row'; else fail "fail readback leg rc=$rc out=$(cat "$FIX/failread.out") ledger=$(cat "$ROOT/seats/comms.jsonl" 2>/dev/null)"; fi

reset_logs
base_env bun "$ROOT/seats/comms.ts" send principal hi > "$FIX/principal.out" 2>&1; rc=$?
if [ $rc -eq 0 ] && grep -q '^sent principal 111:' "$FIX/principal.out" && [ "$(grep -c 'sendMessage' "$FIX/requests.jsonl")" -eq 1 ] && [ "$(count_rows sent)" -eq 1 ] && grep -q '"readBack":"echo"' "$ROOT/seats/comms.jsonl"; then pass 'telegram principal send records echo read-back'; else fail "telegram leg rc=$rc out=$(cat "$FIX/principal.out") req=$(cat "$FIX/requests.jsonl" 2>/dev/null) ledger=$(cat "$ROOT/seats/comms.jsonl" 2>/dev/null)"; fi

reset_logs
base_env bun "$ROOT/seats/comms.ts" send dev hi > "$FIX/dev.out" 2>&1; rc=$?
if [ $rc -eq 0 ] && grep -q '^sent dev m' "$FIX/dev.out" && [ "$(grep -c '"method":"POST"' "$FIX/requests.jsonl")" -eq 1 ] && [ "$(grep -c '"method":"GET"' "$FIX/requests.jsonl")" -eq 1 ] && [ "$(count_rows sent)" -eq 1 ]; then pass 'teams send posts once, reads back once, and records sent row'; else fail "teams leg rc=$rc out=$(cat "$FIX/dev.out") req=$(cat "$FIX/requests.jsonl" 2>/dev/null) ledger=$(cat "$ROOT/seats/comms.jsonl" 2>/dev/null)"; fi

reset_logs
base_env bun "$ROOT/seats/comms.ts" send partners "closing bead x" > "$FIX/guard.out" 2>&1; rc=$?
if [ $rc -eq 2 ] && grep -q 'forbidden human-facing token bead' "$FIX/guard.out" && [ ! -e "$FIX/requests.jsonl" ]; then pass 'human-text guard refuses bead wording before network'; else fail "guard leg rc=$rc out=$(cat "$FIX/guard.out") req=$(count_req)"; fi

reset_logs
printf 'first line\nsecond line\n' | base_env bun "$ROOT/seats/comms.ts" send partners --from-stdin > "$FIX/stdin.out" 2>&1; rc=$?
if [ $rc -eq 0 ] && grep -q 'first line\\nsecond line\\n' "$FIX/requests.jsonl"; then pass '--from-stdin preserves multi-line text in posted body'; else fail "stdin leg rc=$rc out=$(cat "$FIX/stdin.out") req=$(cat "$FIX/requests.jsonl" 2>/dev/null)"; fi

base_env bun "$ROOT/seats/comms.ts" status > "$FIX/status.out" 2>&1; rc=$?
if [ $rc -eq 0 ] && grep -q '^principal telegram principal never$' "$FIX/status.out" && grep -q '^partners slack stakeholders C08EXAMPLE:' "$FIX/status.out" && grep -q '^dev teams stakeholders never$' "$FIX/status.out"; then pass 'status lists declared channels with last refs or never'; else fail "status leg rc=$rc out=$(cat "$FIX/status.out")"; fi

perl -0pe 's/const channel = channelByName\(ROOT, name\);\n  if \(!channel\) stop\(`channel \$\{name\} is not declared in seats\/channels\.json`, 2\);/const channel = channelByName(ROOT, name) || { name, kind: "slack" as const, destination: "C08EXAMPLE", audience: "stakeholders" as const, members: [], read: false };\n  if (false) stop(`channel ${name} is not declared in seats\/channels.json`, 2);/' "$ROOT/seats/comms.ts" > "$ROOT/seats/comms-bad.ts"
reset_logs
base_env bun "$ROOT/seats/comms-bad.ts" send nowhere hi > "$FIX/canary.out" 2>&1; rc=$?
if [ $rc -eq 0 ] && [ -e "$FIX/requests.jsonl" ]; then pass 'canary: removing declared-name check makes undeclared send reach network'; else fail "canary did not prove declared-name check: rc=$rc out=$(cat "$FIX/canary.out") req=$(cat "$FIX/requests.jsonl" 2>/dev/null)"; fi

if [ $FAIL -eq 0 ]; then echo "comms.selftest: PASS ($PASS checks)"; exit 0; fi
echo "comms.selftest: FAIL ($FAIL failure(s))"; exit 1
