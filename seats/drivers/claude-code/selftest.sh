#!/usr/bin/env bash
set -u
ROOT="$(cd "$(dirname "$0")/../../.." && pwd -P)"
FIX="${TMPDIR:-$ROOT/.wheelhouse-runs/wheelhouse-project-er5m.3/tmp}/claude-code-driver.$$"
mkdir -p "$FIX/bin" "$FIX/account" "$FIX/cwd" "$FIX/run" "$FIX/logs"
trap 'pkill -f "$FIX" 2>/dev/null || true; rm -rf "$FIX"' EXIT
cat > "$FIX/bin/claude" <<'STUB'
#!/usr/bin/env node
const fs=require('fs'),path=require('path');
const args=process.argv.slice(2); const acct=process.env.CLAUDE_CONFIG_DIR||process.env.HOME||''; fs.mkdirSync(acct,{recursive:true});
function writeSession(id){ const d=path.join(acct,'projects','actual-Claude-folder-with_hash'); fs.mkdirSync(d,{recursive:true}); fs.appendFileSync(path.join(d,id+'.jsonl'), JSON.stringify({id})+'\n'); }
fs.writeFileSync(path.join(acct,'env.json'),JSON.stringify({ANTHROPIC_API_KEY:process.env.ANTHROPIC_API_KEY||null,ANTHROPIC_AUTH_TOKEN:process.env.ANTHROPIC_AUTH_TOKEN||null,OPENAI_API_KEY:process.env.OPENAI_API_KEY||null}));
fs.writeFileSync(path.join(acct,'argv.json'),JSON.stringify(args));
let buf=''; process.stdin.on('data',c=>{buf+=c; let i; while((i=buf.indexOf('\n'))>=0){buf=buf.slice(i+1); writeSession('shim-session'); console.log(JSON.stringify({type:'system',subtype:'init',session_id:'shim-session',model:'claude-sonnet-5'})); const finish=()=>{ console.log(JSON.stringify({type:'assistant',message:{role:'assistant',content:[{type:'thinking',thinking:'kept thinking'},{type:'tool_use',id:'tool-1',name:'Bash',input:{command:'printf OK'}}]}})); console.log(JSON.stringify({type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:'tool-1',content:'OK',is_error:false}]}})); console.log(JSON.stringify({type:'assistant',message:{role:'assistant',content:[{type:'text',text:'OK'}]}})); console.log(JSON.stringify({type:'result',subtype:'success',result:'OK',session_id:'shim-session'})); }; if(process.env.STUB_RATE_LIMIT_MID){ console.log(JSON.stringify({type:'rate_limit_event',rate_limit_info:{status:'limited',rateLimitType:'five_hour'}})); setTimeout(finish,400); } else finish(); }});
STUB
chmod +x "$FIX/bin/claude"
printf 'BRIEF-TEXT-TOKEN\n' > "$FIX/brief.txt"
mkfifo "$FIX/run/in"
PATH="$FIX/bin:$PATH" CLAUDE_CONFIG_DIR="$FIX/account" ANTHROPIC_API_KEY=secret ANTHROPIC_AUTH_TOKEN=secret OPENAI_API_KEY=secret \
  bun "$ROOT/seats/drivers/claude-code/shim.ts" --log "$FIX/logs/seat.jsonl" --raw-log "$FIX/logs/raw.jsonl" --err-log "$FIX/logs/err.log" --account-dir "$FIX/account" --brief "$FIX/brief.txt" --model sonnet --cwd "$FIX/cwd" --actor worker < "$FIX/run/in" &
pid=$!
exec 3>"$FIX/run/in"
printf '{"id":"one","type":"prompt","message":"hello"}\n' >&3
for _ in $(seq 1 100); do grep -q '"type":"agent_end"' "$FIX/logs/seat.jsonl" 2>/dev/null && break; sleep 0.05; done
kill "$pid" 2>/dev/null || true
fail=0
check(){ if eval "$1"; then :; else echo "FAIL $2"; fail=1; fi; }
check "grep -q 'BRIEF-TEXT-TOKEN' '$FIX/account/argv.json' && ! grep -q '$FIX/brief.txt' '$FIX/account/argv.json'" "brief text not path"
check "grep -q '\"type\":\"thinking\"' '$FIX/logs/seat.jsonl'" "thinking normalized"
check "grep -q '\"type\":\"toolCall\"' '$FIX/logs/seat.jsonl'" "toolCall normalized"
check "grep -q '\"type\":\"tool_execution_start\"' '$FIX/logs/seat.jsonl'" "tool_execution_start normalized"
check "grep -q '\"type\":\"tool_execution_end\"' '$FIX/logs/seat.jsonl' && grep -q '\"toolName\":\"Bash\"' '$FIX/logs/seat.jsonl' && grep -q '\"isError\":false' '$FIX/logs/seat.jsonl'" "tool_execution_end normalized with toolName"
check "[ \$(grep -c '\"type\":\"turn_end\"' '$FIX/logs/seat.jsonl') -eq 1 ]" "one turn_end"
check "grep -q '\"type\":\"agent_end\"' '$FIX/logs/seat.jsonl'" "agent_end normalized"
check "grep -q '\"ANTHROPIC_API_KEY\":null' '$FIX/account/env.json' && grep -q '\"ANTHROPIC_AUTH_TOKEN\":null' '$FIX/account/env.json' && grep -q '\"OPENAI_API_KEY\":null' '$FIX/account/env.json'" "credential env scrub"
mkfifo "$FIX/run/rate-in"
STUB_RATE_LIMIT_MID=1 PATH="$FIX/bin:$PATH" bun "$ROOT/seats/drivers/claude-code/shim.ts" --log "$FIX/logs/rate.jsonl" --raw-log "$FIX/logs/rate.raw.jsonl" --err-log "$FIX/logs/rate.err.log" --account-dir "$FIX/account" --brief "$FIX/brief.txt" --model sonnet --cwd "$FIX/cwd" --actor worker < "$FIX/run/rate-in" &
rpid=$!
exec 4>"$FIX/run/rate-in"
printf '{"id":"rate","type":"prompt","message":"rate then finish"}\n' >&4
for _ in $(seq 1 100); do grep -q '"stopReason":"error"' "$FIX/logs/rate.jsonl" 2>/dev/null && break; sleep 0.02; done
printf '{"id":"state","type":"get_state"}\n' >&4
for _ in $(seq 1 100); do grep -q '"id":"state"' "$FIX/logs/rate.jsonl" 2>/dev/null && break; sleep 0.02; done
for _ in $(seq 1 100); do grep -q '"type":"agent_end"' "$FIX/logs/rate.jsonl" 2>/dev/null && break; sleep 0.05; done
kill "$rpid" 2>/dev/null || true
check "grep -q '\"type\":\"message_end\"' '$FIX/logs/rate.jsonl' && grep -q '\"stopReason\":\"error\"' '$FIX/logs/rate.jsonl' && grep -q '\"id\":\"state\".*\"isStreaming\":true' '$FIX/logs/rate.jsonl' && [ \$(grep -c '\"type\":\"agent_end\"' '$FIX/logs/rate.jsonl') -eq 1 ]" "mid-turn rate limit records capacity while stream stays open until result"
if [ $fail -eq 0 ]; then echo 'claude-code.selftest: PASS (shim normalized events, brief text, rate limits, and stripped credential env vars)'; exit 0; fi
echo 'claude-code.selftest: FAIL'; cat "$FIX/logs/seat.jsonl" 2>/dev/null || true; cat "$FIX/logs/rate.jsonl" 2>/dev/null || true; exit 1
