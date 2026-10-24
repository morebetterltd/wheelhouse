#!/usr/bin/env bash
set -u
ROOT="$(cd "$(dirname "$0")/../../.." && pwd -P)"
. "$ROOT/seats/selftest-lib.sh"
. "$ROOT/seats/fixtures/driver-readiness.sh"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-claude-code-driver.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
selftest_install_cleanup_traps 'selftest_cleanup_fixture_processes "$FIX"; selftest_remove_fixture_dir "$FIX"'
if [ "${WHEELHOUSE_SCRATCH_COLLISION_CHILD:-}" != 1 ]; then
  bun "$ROOT/seats/fixtures/scratch-ownership.ts" claude "$ROOT" "$FIX" || exit 1
fi
mkdir -p "$FIX/bin" "$FIX/account" "$FIX/cwd" "$FIX/run" "$FIX/logs"
cat > "$FIX/bin/claude" <<'STUB'
#!/usr/bin/env node
const fs=require('fs'),path=require('path');
const args=process.argv.slice(2); const acct=process.env.CLAUDE_CONFIG_DIR||process.env.HOME||''; fs.mkdirSync(acct,{recursive:true});
function writeSession(id){ const d=path.join(acct,'projects','actual-Claude-folder-with_hash'); fs.mkdirSync(d,{recursive:true}); fs.appendFileSync(path.join(d,id+'.jsonl'), JSON.stringify({id})+'\n'); }
fs.writeFileSync(path.join(acct,'env.json'),JSON.stringify({ANTHROPIC_API_KEY:process.env.ANTHROPIC_API_KEY||null,ANTHROPIC_AUTH_TOKEN:process.env.ANTHROPIC_AUTH_TOKEN||null,OPENAI_API_KEY:process.env.OPENAI_API_KEY||null}));
fs.writeFileSync(path.join(acct,'argv.json'),JSON.stringify(args));
let buf=''; process.stdin.on('data',c=>{buf+=c; let i; while((i=buf.indexOf('\n'))>=0){buf=buf.slice(i+1); writeSession('shim-session'); console.log(JSON.stringify({type:'system',subtype:'init',session_id:'shim-session',model:'claude-sonnet-5'})); const finish=()=>{ console.log(JSON.stringify({type:'assistant',message:{role:'assistant',content:[{type:'thinking',thinking:'kept thinking'},{type:'tool_use',id:'tool-1',name:'Bash',input:{command:'printf OK'}}]}})); console.log(JSON.stringify({type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:'tool-1',content:'OK',is_error:false}]}})); console.log(JSON.stringify({type:'assistant',message:{role:'assistant',content:[{type:'text',text:'OK'}]}})); if(process.env.STUB_ABORT_NO_RESULT) console.log(JSON.stringify({type:'result',subtype:'error_during_execution',terminal_reason:'aborted_tools',session_id:'shim-session'})); else console.log(JSON.stringify({type:'result',subtype:'success',result:'OK',session_id:'shim-session'})); }; if(process.env.STUB_RATE_LIMIT_MID){ console.log(JSON.stringify({type:'rate_limit_event',rate_limit_info:{status:'limited',rateLimitType:'five_hour'}})); const release=setInterval(()=>{if(fs.existsSync(path.join(acct,'rate-release'))){clearInterval(release);finish();}},10); } else finish(); }});
STUB
chmod +x "$FIX/bin/claude"
printf 'BRIEF-TEXT-TOKEN\n' > "$FIX/brief.txt"
mkfifo "$FIX/run/in"
PATH="$FIX/bin:$PATH" CLAUDE_CONFIG_DIR="$FIX/account" ANTHROPIC_API_KEY=secret ANTHROPIC_AUTH_TOKEN=secret OPENAI_API_KEY=secret \
  bun "$ROOT/seats/drivers/claude-code/shim.ts" --log "$FIX/logs/seat.jsonl" --raw-log "$FIX/logs/raw.jsonl" --err-log "$FIX/logs/err.log" --account-dir "$FIX/account" --brief "$FIX/brief.txt" --model sonnet --cwd "$FIX/cwd" --actor worker --allowed-tools 'Bash(printf *)' --disallowed-tools 'Bash(rm -rf:*)' < "$FIX/run/in" &
pid=$!
exec 3>"$FIX/run/in"
printf '{"id":"one","type":"prompt","message":"hello"}\n' >&3
driver_wait_record "$FIX/logs/seat.jsonl" type agent_end "$pid" || exit 2
kill "$pid" 2>/dev/null || true
wait "$pid" 2>/dev/null; printf 'OBSERVED_DRIVER_EXIT pid=%s\n' "$?"
fail=0
check(){ if eval "$1"; then :; else echo "FAIL $2"; fail=1; fi; }
check "grep -q 'BRIEF-TEXT-TOKEN' '$FIX/account/argv.json' && ! grep -q '$FIX/brief.txt' '$FIX/account/argv.json'" "brief text not path"
check "grep -q '\"--allowedTools\",\"Bash(printf \\*)\"' '$FIX/account/argv.json' && grep -q '\"--disallowedTools\",\"Bash(rm -rf:\\*)\"' '$FIX/account/argv.json'" "tool permission lists forwarded"
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
driver_wait_record "$FIX/logs/rate.jsonl" message.stopReason error "$rpid" || exit 2
printf '{"id":"state","type":"get_state"}\n' >&4
driver_wait_record "$FIX/logs/rate.jsonl" id state "$rpid" || exit 2
if driver_read_record "$FIX/logs/rate.jsonl" type agent_end; then
  echo 'FAIL driver turn completed before explicit release' >&2; exit 1
else
  rc=$?; [ "$rc" = 1 ] || exit "$rc"
fi
printf "release after native state observation\n" > "$FIX/account/rate-release"
driver_wait_record "$FIX/logs/rate.jsonl" type agent_end "$rpid" || exit 2
kill "$rpid" 2>/dev/null || true
wait "$rpid" 2>/dev/null; printf 'OBSERVED_DRIVER_EXIT rpid=%s\n' "$?"
check "grep -q '\"type\":\"message_end\"' '$FIX/logs/rate.jsonl' && grep -q '\"stopReason\":\"error\"' '$FIX/logs/rate.jsonl' && grep -q '\"id\":\"state\".*\"isStreaming\":true' '$FIX/logs/rate.jsonl' && [ \$(grep -c '\"type\":\"agent_end\"' '$FIX/logs/rate.jsonl') -eq 1 ]" "mid-turn rate limit records capacity while stream stays open until result"
mkfifo "$FIX/run/abort-in"
STUB_ABORT_NO_RESULT=1 PATH="$FIX/bin:$PATH" bun "$ROOT/seats/drivers/claude-code/shim.ts" --log "$FIX/logs/abort.jsonl" --raw-log "$FIX/logs/abort.raw.jsonl" --err-log "$FIX/logs/abort.err.log" --account-dir "$FIX/account" --brief "$FIX/brief.txt" --model sonnet --cwd "$FIX/cwd" --actor worker < "$FIX/run/abort-in" &
apid=$!
exec 5>"$FIX/run/abort-in"
printf '{"id":"abort","type":"prompt","message":"abort without result key"}\n' >&5
driver_wait_record "$FIX/logs/abort.jsonl" type agent_end "$apid" || exit 2
kill "$apid" 2>/dev/null || true
wait "$apid" 2>/dev/null; printf 'OBSERVED_DRIVER_EXIT apid=%s\n' "$?"
check "grep -q '\"type\":\"agent_end\"' '$FIX/logs/abort.jsonl' && grep -q '\"stopReason\":\"aborted\"' '$FIX/logs/abort.jsonl' && ! grep -q 'TypeError\|Cannot read' '$FIX/logs/abort.err.log' 2>/dev/null" "missing result key maps error_during_execution to aborted without throwing"
if [ $fail -eq 0 ]; then echo 'claude-code.selftest: PASS (shim normalized events, brief text, tool lists, rate limits, stripped credential env vars, and missing-result aborts)'; exit 0; fi
echo 'claude-code.selftest: FAIL'; cat "$FIX/logs/seat.jsonl" 2>/dev/null || true; cat "$FIX/logs/rate.jsonl" 2>/dev/null || true; exit 1
