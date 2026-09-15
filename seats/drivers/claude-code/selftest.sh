#!/usr/bin/env bash
set -u
ROOT="$(cd "$(dirname "$0")/../../.." && pwd -P)"
FIX="${TMPDIR:-$ROOT/.wheelhouse-runs/wheelhouse-project-er5m.3/tmp}/claude-code-driver.$$"
mkdir -p "$FIX/bin" "$FIX/account" "$FIX/cwd" "$FIX/run" "$FIX/logs"
trap 'pkill -f "$FIX" 2>/dev/null || true; rm -rf "$FIX"' EXIT
cat > "$FIX/bin/claude" <<'STUB'
#!/usr/bin/env node
const fs=require('fs'),path=require('path');
const acct=process.env.CLAUDE_CONFIG_DIR||''; fs.mkdirSync(acct,{recursive:true});
fs.writeFileSync(path.join(acct,'env.json'),JSON.stringify({ANTHROPIC_API_KEY:process.env.ANTHROPIC_API_KEY||null,ANTHROPIC_AUTH_TOKEN:process.env.ANTHROPIC_AUTH_TOKEN||null,OPENAI_API_KEY:process.env.OPENAI_API_KEY||null}));
let buf=''; process.stdin.on('data',c=>{buf+=c; let i; while((i=buf.indexOf('\n'))>=0){buf=buf.slice(i+1); console.log(JSON.stringify({type:'system',subtype:'init',session_id:'shim-session',model:'sonnet'})); console.log(JSON.stringify({type:'assistant',message:{role:'assistant',content:[{type:'text',text:'OK'}]}})); console.log(JSON.stringify({type:'result',subtype:'success',result:'OK'}));}});
STUB
chmod +x "$FIX/bin/claude"
mkfifo "$FIX/run/in"
PATH="$FIX/bin:$PATH" CLAUDE_CONFIG_DIR="$FIX/account" ANTHROPIC_API_KEY=secret ANTHROPIC_AUTH_TOKEN=secret OPENAI_API_KEY=secret \
  bun "$ROOT/seats/drivers/claude-code/shim.ts" --log "$FIX/logs/seat.jsonl" --raw-log "$FIX/logs/raw.jsonl" --err-log "$FIX/logs/err.log" --account-dir "$FIX/account" --brief "$ROOT/contracts/WORKER.md" --model sonnet --cwd "$FIX/cwd" --actor worker < "$FIX/run/in" &
pid=$!
exec 3>"$FIX/run/in"
printf '{"id":"one","type":"prompt","message":"hello"}\n' >&3
for _ in $(seq 1 100); do grep -q '"type":"agent_end"' "$FIX/logs/seat.jsonl" 2>/dev/null && break; sleep 0.05; done
kill "$pid" 2>/dev/null || true
if grep -q '"type":"agent_end"' "$FIX/logs/seat.jsonl" && grep -q '"ANTHROPIC_API_KEY":null' "$FIX/account/env.json" && grep -q '"ANTHROPIC_AUTH_TOKEN":null' "$FIX/account/env.json" && grep -q '"OPENAI_API_KEY":null' "$FIX/account/env.json"; then
  echo 'claude-code.selftest: PASS (shim normalized events and stripped credential env vars)'
  exit 0
fi
echo 'claude-code.selftest: FAIL'
cat "$FIX/logs/seat.jsonl" 2>/dev/null || true
cat "$FIX/account/env.json" 2>/dev/null || true
exit 1
