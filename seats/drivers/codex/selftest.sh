#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/wheelhouse-codex-selftest.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/home" "$TMP/proj/contracts" "$TMP/proj/.wheelhouse-worktrees/bead-a"
cat > "$TMP/bin/codex" <<'CODEX'
#!/usr/bin/env node
const fs=require('fs'),path=require('path');
const home=process.env.CODEX_HOME||process.env.HOME; fs.mkdirSync(home,{recursive:true});
fs.writeFileSync(path.join(home,'env.json'),JSON.stringify({OPENAI_API_KEY:process.env.OPENAI_API_KEY||null,ANTHROPIC_API_KEY:process.env.ANTHROPIC_API_KEY||null,ANTHROPIC_AUTH_TOKEN:process.env.ANTHROPIC_AUTH_TOKEN||null}));
let buf='',thread='thread-fixture',turn='turn-1',threadPath=path.join(home,'sessions','odd','rollout--thread-fixture.jsonl'),turns=0;
function send(o){console.log(JSON.stringify(o));}
function call(o){fs.appendFileSync(path.join(home,'calls.jsonl'),JSON.stringify(o)+'\n');}
function ensure(){fs.mkdirSync(path.dirname(threadPath),{recursive:true});fs.appendFileSync(threadPath,'{}\n');}
function text(input){return (input||[]).map(x=>x.text||'').join('\n')}
function complete(msg){
  send({jsonrpc:'2.0',method:'item/completed',params:{threadId:thread,item:{id:'reason-1',type:'reasoning',text:'thinking about '+msg}}});
  send({jsonrpc:'2.0',method:'item/started',params:{threadId:thread,item:{id:'tool-1',type:'commandExecution',command:'printf OK'}}});
  send({jsonrpc:'2.0',method:'item/completed',params:{threadId:thread,item:{id:'tool-1',type:'commandExecution',command:'printf OK',status:'completed',exitCode:0,output:'OK'}}});
  send({jsonrpc:'2.0',method:'account/rateLimits/updated',params:{rateLimits:{primary:{windowDurationMins:300,usedPercent:99},note:'quota text'}}});
  if(/AUTH/.test(msg)){send({jsonrpc:'2.0',method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'failed',error:{message:'401 not logged in'}}}});return;}
  send({jsonrpc:'2.0',method:'item/completed',params:{threadId:thread,item:{id:'msg-1',type:'agentMessage',text:/RESUME/.test(msg)?'RESUME_OK':'OK'}}});
  send({jsonrpc:'2.0',method:'thread/status/changed',params:{threadId:thread,status:{type:'idle'}}});
  send({jsonrpc:'2.0',method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'completed'}}});
}
process.stdin.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\n'))>=0){const l=buf.slice(0,i);buf=buf.slice(i+1);if(!l.trim())continue;const r=JSON.parse(l),m=r.method,p=r.params||{};call({method:m,params:p});if(m==='initialize')send({jsonrpc:'2.0',id:r.id,result:{codexHome:home,userAgent:'stub'}});else if(m==='thread/start'){ensure();send({jsonrpc:'2.0',id:r.id,result:{thread:{id:thread,path:threadPath,status:{type:'idle'}},model:p.model,sandbox:p.sandbox,approvalPolicy:p.approvalPolicy}})}else if(m==='thread/resume'){thread=p.threadId;ensure();send({jsonrpc:'2.0',id:r.id,result:{thread:{id:thread,path:threadPath,status:{type:'idle'}},model:p.model}})}else if(m==='turn/start'||m==='turn/steer'){turn='turn-'+(++turns);const msg=text(p.input);send({jsonrpc:'2.0',id:r.id,result:{turn:{id:turn,status:'inProgress'}}});send({jsonrpc:'2.0',method:'thread/status/changed',params:{threadId:thread,status:{type:'active'}}});send({jsonrpc:'2.0',method:'turn/started',params:{threadId:thread,turn:{id:turn,status:'inProgress'}}});setTimeout(()=>complete(msg),250);}}});
CODEX
chmod +x "$TMP/bin/codex"
printf 'brief CONTENT token\n' > "$TMP/proj/contracts/WORKER.md"
printf 'x\n' > "$TMP/proj/contracts/COMMANDER.md"; printf 'x\n' > "$TMP/proj/contracts/REVIEWER.md"
PATH="$TMP/bin:$PATH" HOME="$TMP/home" OPENAI_API_KEY=leak ANTHROPIC_API_KEY=leak ANTHROPIC_AUTH_TOKEN=leak bun "$ROOT/seats/drivers/codex/shim.ts" --log "$TMP/log.jsonl" --raw-log "$TMP/raw.jsonl" --err-log "$TMP/err.log" --account-dir "$TMP/home/codex" --brief "$TMP/proj/contracts/WORKER.md" --model gpt-5.5 --cwd "$TMP/proj" --actor worker-1 < <(printf '{"id":"s","type":"get_state"}\n{"id":"p","type":"prompt","message":"tools"}\n{"id":"x","type":"steer","message":"steer now"}\n') & pid=$!
for i in {1..100}; do [ -f "$TMP/log.jsonl" ] && [ "$(grep -c '"type":"agent_end"' "$TMP/log.jsonl")" -ge 1 ] && break; sleep .1; done
kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true
grep -q 'brief CONTENT token' "$TMP/home/codex/calls.jsonl"
grep -q '"method":"turn/steer"' "$TMP/home/codex/calls.jsonl"
grep -q '"expectedTurnId":"turn-1"' "$TMP/home/codex/calls.jsonl"
[ "$(grep -c '"method":"turn/start"' "$TMP/home/codex/calls.jsonl")" -eq 1 ]
grep -q '"type":"thinking"' "$TMP/log.jsonl"
grep -q '"type":"toolCall"' "$TMP/log.jsonl"
grep -q '"stopReason":"error"' "$TMP/log.jsonl"
! grep -q '"type":"capacity"' "$TMP/log.jsonl"
grep -q '"type":"turn_end"' "$TMP/log.jsonl"; grep -q '"type":"agent_end"' "$TMP/log.jsonl"
! grep -q leak "$TMP/home/codex/env.json"
PATH="$TMP/bin:$PATH" HOME="$TMP/home" bun "$ROOT/seats/drivers/codex/shim.ts" --log "$TMP/auth-log.jsonl" --raw-log "$TMP/auth-raw.jsonl" --err-log "$TMP/auth-err.log" --account-dir "$TMP/home/codex" --brief "$TMP/proj/contracts/WORKER.md" --model gpt-5.5 --cwd "$TMP/proj" --actor worker-1 < <(printf '{"id":"a","type":"prompt","message":"AUTH failure"}
') & apid=$!
for i in {1..100}; do [ -f "$TMP/auth-log.jsonl" ] && grep -q '"authDead":true' "$TMP/auth-log.jsonl" && break; sleep .1; done
kill "$apid" 2>/dev/null || true; wait "$apid" 2>/dev/null || true
grep -q '"authDead":true' "$TMP/auth-log.jsonl"
grep -q '401 not logged in' "$TMP/auth-log.jsonl"
echo "codex.selftest: PASS (shim queue, steer, mappings, auth-dead, idle settle, and stripped credential env vars)"
