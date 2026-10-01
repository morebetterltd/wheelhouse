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
function hidden(){ return fs.existsSync(`${dir}/fail-readback`); }
Bun.serve({hostname:"127.0.0.1", port:Number(process.env.STUB_PORT), async fetch(req){
 const u=new URL(req.url); const body=req.method==="POST" ? await req.json().catch(()=>({})) : undefined;
 const auth=req.headers.get("authorization")||"";
 append({method:req.method, url:u.pathname+u.search, body});
 if(u.pathname.includes("/sendMessage")){ msg++; const r={message_id:msg,chat:{id:body.chat_id},text:body.text}; remember("telegram", r); return Response.json({ok:true,result:r}); }
 if(u.pathname.endsWith("/chat.postMessage")){ msg++; const ts=`1790000000.${String(msg).padStart(6,"0")}`; if(!hidden()) remember("slack", {ts,channel:body.channel,user:"BOT",text:body.text,thread_ts:body.thread_ts}); return Response.json({ok:true,ts,message:{ts,text:body.text}}); }
 if(u.pathname.endsWith("/conversations.history")){ let messages=rows("slack.jsonl").filter((m:any)=>!body.oldest || Number(m.ts)>Number(body.oldest)); if(hidden()) messages=messages.map((m:any)=>({...m,text:"dropped"})); return Response.json({ok:true,messages}); }
 if(u.pathname.endsWith("/conversations.replies")){ let messages=rows("slack.jsonl").filter((m:any)=>String(m.ts)===String(body.ts)||String(m.thread_ts||"")===String(body.ts)); if(hidden()) messages=messages.map((m:any)=>({...m,text:"dropped"})); return Response.json({ok:true,messages}); }
 if(u.pathname.match(/\/messages(?:\/[^/]+\/replies)?$/) && req.method==="POST"){
   msg++; const id=`m${msg}`; const parent=u.pathname.match(/\/messages\/([^/]+)\/replies$/)?.[1];
   const row={id,createdDateTime:`2030-01-01T00:00:${String(msg).padStart(2,"0")}Z`,messageType:"message",from:{user:{id:"u-teams",displayName:"Teams User"}},body:{content:body.body.content},replyToId:parent};
   if(!hidden()) remember("teams", row); return Response.json(row);
 }
 if(u.pathname.match(/\/messages\/[^/]+\/replies\/[^/]+$/) && req.method==="GET"){
   const parts=u.pathname.split("/"); const id=parts.at(-1); const parent=parts.at(-3); const row=rows("teams.jsonl").find((m:any)=>m.id===id && String(m.replyToId||"")===String(parent)); return row?Response.json(hidden()?{...row,body:{content:"dropped"}}:row):Response.json({error:{message:"missing"}},{status:404});
 }
 if(u.pathname.match(/\/messages\/[^/]+$/) && req.method==="GET"){
   const id=u.pathname.split("/").pop(); const row=rows("teams.jsonl").find((m:any)=>m.id===id && !m.replyToId); return row?Response.json(hidden()?{...row,body:{content:"dropped"}}:row):Response.json({error:{message:"missing"}},{status:404});
 }
 if(u.pathname.endsWith("/messages") && req.method==="GET"){ return Response.json({value:rows("teams.jsonl")}); }
 return Response.json({error:"no route", path:u.pathname},{status:404});
}});
TS
P="$(port)"; STUB_DIR="$FIX" STUB_PORT="$P" bun "$FIX/server.ts" > "$FIX/server.out" 2> "$FIX/server.err" & SERVER_PID=$!
sleep 0.2
cat > "$FIX/check.ts" <<'TS'
import * as fs from "node:fs";
import { transportFor } from "./proj/seats/transports/index";
import { demuxUpdates } from "./proj/seats/transports/telegram";
const root=process.env.ROOT!, stub=process.env.STUB_DIR!, kind=process.argv[2], dest=process.argv[3];
const t=transportFor(root, kind as any);
const r=await t.post(dest,"hello", process.argv[4]?{threadRef:process.argv[4]}:undefined);
if(!r.ref) throw new Error("post returned no ref");
if(!await t.readBack(dest,r.ref,"hello")) throw new Error("direct readBack returned false after stored post");
if(kind==="telegram") {
  const got=demuxUpdates([{update_id:7,message:{message_id:8,date:1893456000,chat:{id:dest},from:{id:"tg-user",username:"tgname"},text:"planted inbound"}}], dest);
  if(got.cursor!=="8" || got.messages.length!==1 || got.messages[0].text!=="planted inbound" || got.messages[0].from!=="tg-user") throw new Error(`telegram read assertion failed ${JSON.stringify(got)}`);
  console.log(JSON.stringify({post:r, read:got}));
} else if(kind==="slack") {
  fs.appendFileSync(`${stub}/slack.jsonl`, JSON.stringify({ts:"1790000001.000001",channel:dest,user:"U-IN",text:"planted inbound"})+"\n");
  const got=await t.read(dest,"1790000000.000000");
  if(got.cursor!=="1790000001.000001" || !got.messages.some(m=>m.text==="planted inbound" && m.from==="U-IN")) throw new Error(`slack read assertion failed ${JSON.stringify(got)}`);
  console.log(JSON.stringify({post:r, read:got}));
} else {
  fs.appendFileSync(`${stub}/teams.jsonl`, JSON.stringify({id:"m-planted",createdDateTime:"2030-01-01T00:01:00Z",messageType:"message",from:{user:{id:"U-IN",displayName:"Inbound User"}},body:{content:"planted inbound"}})+"\n");
  const got=await t.read(dest,"2030-01-01T00:00:00Z");
  if(got.cursor!=="2030-01-01T00:01:00Z" || !got.messages.some(m=>m.text==="planted inbound" && m.from==="U-IN")) throw new Error(`teams read assertion failed ${JSON.stringify(got)}`);
  console.log(JSON.stringify({post:r, read:got}));
}
TS
cat > "$FIX/readback-false.ts" <<'TS'
import * as fs from "node:fs";
import { transportFor } from "./proj/seats/transports/index";
const root=process.env.ROOT!, stub=process.env.STUB_DIR!, kind=process.argv[2], dest=process.argv[3];
const t=transportFor(root, kind as any);
const r=await t.post(dest,"hello");
fs.writeFileSync(`${stub}/fail-readback`, "1");
const ok=await t.readBack(dest,r.ref, kind==="telegram" ? "wrong under marker" : "hello");
if(ok) throw new Error(`${kind} readBack unexpectedly true under marker`);
console.log("false");
TS
cat > "$FIX/check-teams-bad.ts" <<'TS'
import * as fs from "node:fs";
import { TeamsTransport } from "./proj/seats/transports/teams-bad";
const root=process.env.ROOT!, stub=process.env.STUB_DIR!, dest=process.argv[2];
const t=new TeamsTransport(root);
const r=await t.post(dest,"hello");
fs.writeFileSync(`${stub}/fail-readback`, "1");
if(await t.readBack(dest,r.ref,"hello")) process.exit(0);
throw new Error("forced-true canary did not mask drop leg");
TS
base_env(){ env ROOT="$ROOT" STUB_DIR="$FIX" WHEELHOUSE_TELEGRAM_CHAT_ID=111 WHEELHOUSE_TELEGRAM_API_BASE="http://127.0.0.1:$P" WHEELHOUSE_SLACK_API_BASE="http://127.0.0.1:$P" WHEELHOUSE_TEAMS_API_BASE="http://127.0.0.1:$P" "$@"; }
run_kind(){ kind="$1" dest="$2" envname="$3" token="$4"; : > "$FIX/requests.jsonl"; rm -f "$FIX/fail-readback" "$FIX/${kind}.jsonl"; base_env "$envname=$token" bun "$FIX/check.ts" "$kind" "$dest" > "$FIX/$kind.out" 2>&1; rc=$?; if [ $rc -eq 0 ] && [ "$(grep -c '"url".*postMessage\|sendMessage\|/messages' "$FIX/requests.jsonl")" -ge 1 ]; then pass "$kind post, direct readBack, planted read and cursor advance work with env token"; else fail "$kind env leg rc=$rc out=$(cat "$FIX/$kind.out") req=$(cat "$FIX/requests.jsonl" 2>/dev/null)"; fi; rm -f "$FIX/fail-readback"; base_env "$envname=$token" bun "$FIX/readback-false.ts" "$kind" "$dest" > "$FIX/$kind-drop.out" 2>&1; [ $? -eq 0 ] && grep -q '^false$' "$FIX/$kind-drop.out" && pass "$kind direct readBack false path is asserted under marker" || fail "$kind readBack false leg failed: $(cat "$FIX/$kind-drop.out")"; rm -f "$FIX/fail-readback"; }
run_kind telegram 111 WHEELHOUSE_TELEGRAM_TOKEN tg-token
run_kind slack C0EXAMPLE WHEELHOUSE_SLACK_TOKEN "$(printf 'xox%s-%s' b fixture)"
run_kind teams chats/chat-example WHEELHOUSE_TEAMS_TOKEN teams-token
# file credentials and mode refusals
for kind in telegram slack teams; do mkdir -p "$ROOT/seats/run"; printf '%s' "$kind-file-token" > "$ROOT/seats/run/$kind.token"; chmod 600 "$ROOT/seats/run/$kind.token"; done
unset WHEELHOUSE_TELEGRAM_TOKEN WHEELHOUSE_SLACK_TOKEN WHEELHOUSE_TEAMS_TOKEN
base_env bun "$FIX/check.ts" telegram 111 >/dev/null 2>&1 && pass 'telegram token from 0600 file works' || fail 'telegram 0600 file token failed'
base_env bun "$FIX/check.ts" slack C0EXAMPLE >/dev/null 2>&1 && pass 'slack token from 0600 file works' || fail 'slack 0600 file token failed'
base_env bun "$FIX/check.ts" teams teams/team/channels/channel >/dev/null 2>&1 && pass 'teams token from 0600 file works' || fail 'teams 0600 file token failed'
for kind in telegram slack teams; do chmod 644 "$ROOT/seats/run/$kind.token"; base_env bun "$FIX/check.ts" "$kind" C0EXAMPLE > "$FIX/mode-$kind.out" 2>&1; [ $? -ne 0 ] && grep -q 'mode 0600' "$FIX/mode-$kind.out" && pass "$kind refuses 0644 token file naming mode" || fail "$kind mode refusal failed: $(cat "$FIX/mode-$kind.out")"; chmod 600 "$ROOT/seats/run/$kind.token"; done
# missing tokens and construction isolation
for kind in telegram slack teams; do rm -f "$ROOT/seats/run/$kind.token"; done
: > "$FIX/requests.jsonl"; ROOT="$ROOT" WHEELHOUSE_SLACK_TOKEN=slack-only bun -e 'import { transportFor } from "./seats/transports/index"; try{transportFor(process.env.ROOT!,"telegram"); process.exit(1)}catch(e:any){console.log(e.message)}' > "$FIX/no-telegram.out" 2>&1
[ $? -eq 0 ] && grep -q 'no telegram token configured' "$FIX/no-telegram.out" && pass 'missing telegram token is named' || fail "missing telegram token failed: $(cat "$FIX/no-telegram.out")"
ROOT="$ROOT" WHEELHOUSE_TELEGRAM_TOKEN=tg-only bun -e 'import { transportFor } from "./seats/transports/index"; try{transportFor(process.env.ROOT!,"slack"); process.exit(1)}catch(e:any){console.log(e.message)}' > "$FIX/no-slack.out" 2>&1
[ $? -eq 0 ] && grep -q 'no slack token configured' "$FIX/no-slack.out" && [ ! -s "$FIX/requests.jsonl" ] && pass 'transportFor slack does not touch telegram token or network when slack token is absent' || fail "transportFor isolation failed: $(cat "$FIX/no-slack.out")"
env -u WHEELHOUSE_TEAMS_TOKEN -u WHEELHOUSE_TEAMS_TOKEN_CMD ROOT="$ROOT" WHEELHOUSE_SLACK_TOKEN=slack-only bun -e 'import { transportFor } from "./seats/transports/index"; try{await transportFor(process.env.ROOT!,"teams").post("chats/missing","hello"); process.exit(1)}catch(e:any){console.log(e.message)}' > "$FIX/no-teams.out" 2>&1
[ $? -eq 0 ] && grep -q 'no teams token configured' "$FIX/no-teams.out" && pass 'missing teams token is named' || fail "missing teams token failed: $(cat "$FIX/no-teams.out")"
# teams token command success/failure and per-call execution
: > "$FIX/token-calls"; cat > "$FIX/teams-token-cmd.sh" <<SH
#!/usr/bin/env bash
echo call >> "$FIX/token-calls"
printf teams-cmd-token
SH
chmod +x "$FIX/teams-token-cmd.sh"
rm -f "$ROOT/seats/run/teams.token" "$FIX/teams.jsonl" "$FIX/fail-readback"; : > "$FIX/requests.jsonl"
base_env WHEELHOUSE_TEAMS_TOKEN_CMD="$FIX/teams-token-cmd.sh" bun "$FIX/check.ts" teams chats/cmd >/dev/null 2>&1 && [ "$(wc -l < "$FIX/token-calls")" -ge 4 ] && pass 'teams TOKEN_CMD supplies a token per call' || fail "teams TOKEN_CMD per-call failed: calls=$(cat "$FIX/token-calls" 2>/dev/null)"
base_env WHEELHOUSE_TEAMS_TOKEN_CMD="exit 9" bun "$FIX/check.ts" teams chats/cmd > "$FIX/cmdfail.out" 2>&1; [ $? -ne 0 ] && grep -q 'teams token command failed' "$FIX/cmdfail.out" && pass 'teams failing TOKEN_CMD is a named error' || fail "teams TOKEN_CMD failure wrong: $(cat "$FIX/cmdfail.out")"
# threaded reply read-back URL
rm -f "$FIX/teams.jsonl" "$FIX/fail-readback"; : > "$FIX/requests.jsonl"
base_env WHEELHOUSE_TEAMS_TOKEN=teams-token bun "$FIX/check.ts" teams chats/thread parent-msg >/dev/null 2>&1
if grep -q '"url":"/chats/thread/messages/parent-msg/replies/m' "$FIX/requests.jsonl"; then pass 'teams threaded reply readBack fetches /messages/<parent>/replies/<id>'; else fail "teams threaded reply readBack URL wrong: $(cat "$FIX/requests.jsonl")"; fi
# token leak check over full request log: URLs and bodies only; auth headers are deliberately not logged, and Telegram bot path is allowed.
SLACK_FIXTURE_TOKEN="$(printf 'xox%s-%s' b fixture)"
TOKENS="tg-token $SLACK_FIXTURE_TOKEN teams-token teams-cmd-token"
leak=""
while IFS= read -r row; do
  for tok in $TOKENS; do
    [ -z "$tok" ] && continue
    case "$row" in
      *"$tok"*)
        if printf '%s\n' "$row" | grep -F "/bot$tok/" >/dev/null 2>&1 && [ "$tok" = "tg-token" ]; then :; else leak="$leak$row
"; fi
        ;;
    esac
  done
done < "$FIX/requests.jsonl"
[ -z "$leak" ] && pass 'full-run request log keeps fixture tokens out of URLs and bodies except Telegram bot path' || fail "fixture token leaked into request log: $leak"
# canary: force teams readBack true and prove the drop leg would pass when it should fail.
perl -0pe 's/return htmlText\(String\(json\?\.body\?\.content \?\? ""\)\) === text;/return true;/' "$ROOT/seats/transports/teams.ts" > "$ROOT/seats/transports/teams-bad.ts"
rm -f "$FIX/teams.jsonl" "$FIX/fail-readback"; : > "$FIX/requests.jsonl"
if base_env WHEELHOUSE_TEAMS_TOKEN=teams-token bun "$FIX/check-teams-bad.ts" chats/canary >/dev/null 2>&1; then pass 'canary forced-true teams readBack masks the drop leg'; else fail 'canary forced-true copy did not run/pass the drop leg'; fi
if [ $FAIL -eq 0 ]; then echo 'transports.selftest: PASS'; exit 0; fi
echo "transports.selftest: FAIL ($FAIL failure(s))"; exit 1
