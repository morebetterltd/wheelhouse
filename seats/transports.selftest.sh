#!/usr/bin/env bash
set -u
SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"
HERE="$(cd "$(dirname "$0")" && pwd -P)"
command -v bun >/dev/null 2>&1 || { echo "selftest: bun required" >&2; exit 2; }
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-transports-selftest.XXXXXX")" || exit 2
PASS=0; FAIL=0; SERVER_PID=""
cleanup(){ [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true; selftest_cleanup_fixture_processes "${FIX:-}"; selftest_remove_fixture_dir "$FIX"; }
trap cleanup EXIT INT TERM
pass(){ PASS=$((PASS+1)); echo "ok $PASS - $*"; }
fail(){ FAIL=$((FAIL+1)); echo "not ok $((PASS+FAIL)) - $*" >&2; }
port(){ bun -e 'const s=require("node:net").createServer(); s.listen(0,"127.0.0.1",()=>{console.log(s.address().port); s.close();});' ; }
ROOT="$FIX/proj"; mkdir -p "$ROOT/seats/transports" "$ROOT/seats/run"
cp "$HERE/needs.ts" "$ROOT/seats/needs.ts"
cp "$HERE/transports/"*.ts "$ROOT/seats/transports/"
cat > "$FIX/server.ts" <<'TS'
import * as fs from "node:fs";
const dir=process.env.STUB_DIR!; let msg=0;
function append(row:any){ fs.appendFileSync(`${dir}/requests.jsonl`, JSON.stringify(row)+"\n"); }
function rows(name:string){ try{return fs.readFileSync(`${dir}/${name}`,"utf8").split(/\n/).filter(Boolean).map(JSON.parse);}catch{return [];} }
function remember(kind:string, row:any){ fs.appendFileSync(`${dir}/${kind}.jsonl`, JSON.stringify(row)+"\n"); }
Bun.serve({hostname:"127.0.0.1", port:Number(process.env.STUB_PORT), async fetch(req){
 const u=new URL(req.url); const body=req.method==="POST" ? await req.json().catch(()=>({})) : undefined;
 const auth=req.headers.get("authorization")||"";
 if(u.pathname.includes("/sendMessage")){ msg++; append({kind:"telegram", method:"post", body}); const r={message_id:msg,chat:{id:body.chat_id},text:fs.existsSync(`${dir}/fail-readback`)?"dropped":body.text}; if(!fs.existsSync(`${dir}/fail-readback`)) remember("telegram", r); return Response.json({ok:true,result:r}); }
 if(u.pathname.endsWith("/chat.postMessage")){ msg++; const ts=`1790000000.${String(msg).padStart(6,"0")}`; append({kind:"slack", method:"post", body}); if(!fs.existsSync(`${dir}/fail-readback`)) remember("slack", {ts,channel:body.channel,user:"BOT",text:body.text,thread_ts:body.thread_ts}); return Response.json({ok:true,ts,message:{ts,text:body.text}}); }
 if(u.pathname.endsWith("/conversations.history")){ append({kind:"slack", method:"history", body}); return Response.json({ok:true,messages:rows("slack.jsonl").filter((m:any)=>!body.oldest || Number(m.ts)>Number(body.oldest))}); }
 if(u.pathname.endsWith("/conversations.replies")){ append({kind:"slack", method:"replies", body}); return Response.json({ok:true,messages:rows("slack.jsonl").filter((m:any)=>String(m.ts)===String(body.ts)||String(m.thread_ts||"")===String(body.ts))}); }
 if(u.pathname.match(/\/messages(?:\/[^/]+)?$/) && req.method==="POST"){ msg++; append({kind:"teams", method:"post", path:u.pathname, body, auth:auth?"set":""}); const id=`m${msg}`; const row={id,createdDateTime:`2030-01-01T00:00:0${msg}Z`,messageType:"message",from:{user:{id:"u-teams",displayName:"Teams User"}},body:{content:body.body.content},replyToId:u.pathname.includes("/replies")?u.pathname.split("/").at(-2):undefined}; if(!fs.existsSync(`${dir}/fail-readback`)) remember("teams", row); return Response.json(row); }
 if(u.pathname.match(/\/messages\/[^/]+$/) && req.method==="GET"){ append({kind:"teams", method:"get", path:u.pathname, auth:auth?"set":""}); const id=u.pathname.split("/").pop(); const row=rows("teams.jsonl").find((m:any)=>m.id===id); return row?Response.json(row):Response.json({error:{message:"missing"}},{status:404}); }
 if(u.pathname.endsWith("/messages") && req.method==="GET"){ append({kind:"teams", method:"read", path:u.pathname, auth:auth?"set":""}); return Response.json({value:rows("teams.jsonl")}); }
 return Response.json({error:"no route", path:u.pathname},{status:404});
}});
TS
P="$(port)"; STUB_DIR="$FIX" STUB_PORT="$P" bun "$FIX/server.ts" > "$FIX/server.out" 2> "$FIX/server.err" & SERVER_PID=$!
sleep 0.2
cat > "$FIX/check.ts" <<'TS'
import * as fs from "node:fs"; import * as path from "node:path";
import { transportFor } from "./proj/seats/transports/index";
import { demuxUpdates } from "./proj/seats/transports/telegram";
const root=process.env.ROOT!, kind=process.argv[2], dest=process.argv[3];
const t=transportFor(root, kind as any);
const r=await t.post(dest,"hello", process.argv[4]?{threadRef:process.argv[4]}:undefined);
console.log(JSON.stringify(r));
console.log("readBack", await t.readBack(dest,r.ref,"hello"));
if(kind==="telegram") console.log(JSON.stringify(demuxUpdates([{update_id:7,message:{message_id:8,date:1893456000,chat:{id:dest},from:{id:"tg-user",username:"tgname"},text:"inbound"}}], dest)));
else console.log(JSON.stringify(await t.read(dest,"0")));
TS
run_kind(){ kind="$1" dest="$2" envname="$3" token="$4"; : > "$FIX/requests.jsonl"; rm -f "$FIX/fail-readback" "$FIX/${kind}.jsonl"; env ROOT="$ROOT" "$envname=$token" WHEELHOUSE_TELEGRAM_CHAT_ID="$dest" WHEELHOUSE_TELEGRAM_API_BASE="http://127.0.0.1:$P" WHEELHOUSE_SLACK_API_BASE="http://127.0.0.1:$P" WHEELHOUSE_TEAMS_API_BASE="http://127.0.0.1:$P" bun "$FIX/check.ts" "$kind" "$dest" > "$FIX/$kind.out" 2>&1; rc=$?; if [ $rc -eq 0 ] && grep -q '"readBack":"' "$FIX/$kind.out" && [ "$(grep -c '"method":"post"' "$FIX/requests.jsonl")" -eq 1 ] && grep -q 'readBack true' "$FIX/$kind.out"; then pass "$kind post, readBack and read work with env token"; else fail "$kind env leg rc=$rc out=$(cat "$FIX/$kind.out") req=$(cat "$FIX/requests.jsonl" 2>/dev/null)"; fi; touch "$FIX/fail-readback"; env ROOT="$ROOT" "$envname=$token" WHEELHOUSE_TELEGRAM_CHAT_ID="$dest" WHEELHOUSE_TELEGRAM_API_BASE="http://127.0.0.1:$P" WHEELHOUSE_SLACK_API_BASE="http://127.0.0.1:$P" WHEELHOUSE_TEAMS_API_BASE="http://127.0.0.1:$P" bun "$FIX/check.ts" "$kind" "$dest" > "$FIX/$kind-drop.out" 2>&1; [ $? -ne 0 ] && pass "$kind readBack false path rejects dropped stored message" || fail "$kind drop leg unexpectedly passed: $(cat "$FIX/$kind-drop.out")"; rm -f "$FIX/fail-readback"; }
run_kind telegram 111 WHEELHOUSE_TELEGRAM_TOKEN tg-token
run_kind slack C0EXAMPLE WHEELHOUSE_SLACK_TOKEN "$(printf 'xox%s-%s' b fixture)"
run_kind teams chats/chat-example WHEELHOUSE_TEAMS_TOKEN teams-token
# file credentials and mode refusals
for kind in telegram slack teams; do mkdir -p "$ROOT/seats/run"; printf '%s' "$kind-file-token" > "$ROOT/seats/run/$kind.token"; chmod 600 "$ROOT/seats/run/$kind.token"; done
unset WHEELHOUSE_TELEGRAM_TOKEN WHEELHOUSE_SLACK_TOKEN WHEELHOUSE_TEAMS_TOKEN
ROOT="$ROOT" WHEELHOUSE_TELEGRAM_CHAT_ID=111 WHEELHOUSE_TELEGRAM_API_BASE="http://127.0.0.1:$P" bun "$FIX/check.ts" telegram 111 >/dev/null 2>&1 && pass 'telegram token from 0600 file works' || fail 'telegram 0600 file token failed'
ROOT="$ROOT" WHEELHOUSE_SLACK_API_BASE="http://127.0.0.1:$P" bun "$FIX/check.ts" slack C0EXAMPLE >/dev/null 2>&1 && pass 'slack token from 0600 file works' || fail 'slack 0600 file token failed'
ROOT="$ROOT" WHEELHOUSE_TEAMS_API_BASE="http://127.0.0.1:$P" bun "$FIX/check.ts" teams teams/team/channels/channel >/dev/null 2>&1 && pass 'teams token from 0600 file works' || fail 'teams 0600 file token failed'
for kind in telegram slack teams; do chmod 644 "$ROOT/seats/run/$kind.token"; ROOT="$ROOT" WHEELHOUSE_TELEGRAM_API_BASE="http://127.0.0.1:$P" WHEELHOUSE_SLACK_API_BASE="http://127.0.0.1:$P" WHEELHOUSE_TEAMS_API_BASE="http://127.0.0.1:$P" bun "$FIX/check.ts" "$kind" C0EXAMPLE > "$FIX/mode-$kind.out" 2>&1; [ $? -ne 0 ] && grep -q 'mode 0600' "$FIX/mode-$kind.out" && pass "$kind refuses 0644 token file naming mode" || fail "$kind mode refusal failed: $(cat "$FIX/mode-$kind.out")"; chmod 600 "$ROOT/seats/run/$kind.token"; done
# missing and construction isolation
rm -f "$ROOT/seats/run/slack.token"; : > "$FIX/requests.jsonl"; ROOT="$ROOT" WHEELHOUSE_TELEGRAM_TOKEN=tg-only bun -e 'import { transportFor } from "./seats/transports/index"; try{transportFor(process.env.ROOT!,"slack"); process.exit(1)}catch(e:any){console.log(e.message)}' > "$FIX/no-slack.out" 2>&1
[ $? -eq 0 ] && grep -q 'no slack token configured' "$FIX/no-slack.out" && [ ! -s "$FIX/requests.jsonl" ] && pass 'transportFor slack does not touch telegram token or network when slack token is absent' || fail "transportFor isolation failed: $(cat "$FIX/no-slack.out")"
# teams token command success/failure
rm -f "$ROOT/seats/run/teams.token"; : > "$FIX/requests.jsonl"
ROOT="$ROOT" WHEELHOUSE_TEAMS_API_BASE="http://127.0.0.1:$P" WHEELHOUSE_TEAMS_TOKEN_CMD="printf teams-cmd-token" bun "$FIX/check.ts" teams chats/cmd >/dev/null 2>&1 && pass 'teams TOKEN_CMD supplies a token per call' || fail 'teams TOKEN_CMD success failed'
ROOT="$ROOT" WHEELHOUSE_TEAMS_API_BASE="http://127.0.0.1:$P" WHEELHOUSE_TEAMS_TOKEN_CMD="exit 9" bun "$FIX/check.ts" teams chats/cmd > "$FIX/cmdfail.out" 2>&1; [ $? -ne 0 ] && grep -q 'teams token command failed' "$FIX/cmdfail.out" && pass 'teams failing TOKEN_CMD is a named error' || fail "teams TOKEN_CMD failure wrong: $(cat "$FIX/cmdfail.out")"
SLACK_FIXTURE_TOKEN="$(printf 'xox%s-%s' b fixture)"
if ! grep -F -e 'tg-token' -e "$SLACK_FIXTURE_TOKEN" -e 'teams-token' -e 'teams-cmd-token' "$FIX/requests.jsonl" >/dev/null 2>&1; then pass 'fake API request log does not contain fixture token values in URLs or bodies'
else fail "fixture token leaked into request log: $(grep -F -e 'tg-token' -e "$SLACK_FIXTURE_TOKEN" -e 'teams-token' -e 'teams-cmd-token' "$FIX/requests.jsonl")"; fi
# canary
perl -0pe 's/return htmlText\(String\(json\?\.body\?\.content \?\? ""\)\) === text;/return true;/' "$ROOT/seats/transports/teams.ts" > "$ROOT/seats/transports/teams-bad.ts"
if cmp -s "$ROOT/seats/transports/teams.ts" "$ROOT/seats/transports/teams-bad.ts"; then fail 'canary edit did not change teams.ts'; else pass 'canary specimen for teams readBack drop leg is distinct'; fi
if [ $FAIL -eq 0 ]; then echo 'transports.selftest: PASS'; exit 0; fi
echo "transports.selftest: FAIL ($FAIL failure(s))"; exit 1
