#!/usr/bin/env bash
# stop-all.selftest.sh — hermetic checks for adapter.ts stop-all.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ADAPTER="${1:-$HERE/adapter.ts}"
BRIEFS="$(cd "$(dirname "$ADAPTER")" && pwd)/briefs.ts"
[ -f "$ADAPTER" ] || { echo "selftest: not found: $ADAPTER" >&2; exit 2; }
[ -f "$BRIEFS" ] || { echo "selftest: not found: $BRIEFS" >&2; exit 2; }
command -v bun >/dev/null 2>&1 || { echo "selftest: bun is required" >&2; exit 2; }
NODE_BIN="$(command -v node)" || { echo "selftest: node is required" >&2; exit 2; }
SCRUB="$HERE/evidence-scrub.sh"
[ -x "$SCRUB" ] || { echo "selftest: not executable: $SCRUB" >&2; exit 2; }
exec > >("$SCRUB") 2> >("$SCRUB" >&2)

FAILED=0
FIX=""
pass(){ printf '  ok    %s\n' "$*"; }
fail(){ printf '  FAIL  %s\n' "$*"; FAILED=$((FAILED+1)); }
phase(){ printf '\n%s\n' "$*"; }
cleanup(){ [ -n "$FIX" ] && pkill -f "$FIX" 2>/dev/null; [ -n "$FIX" ] && rm -rf "$FIX"; }
trap cleanup EXIT INT TERM

FIX="$(mktemp -d "${TMPDIR:-/tmp}/wheelhouse-stop-all-selftest.$$.XXXXXX")"
FIX="$(cd "$FIX" && pwd -P)"
HOME_FIX="$FIX/home"; BIN="$FIX/bin"; mkdir -p "$HOME_FIX" "$BIN"
RUN_PATH="$BIN:$(dirname "$(command -v bun)"):$(dirname "$NODE_BIN"):/usr/bin:/bin"

cat > "$BIN/pi" <<'STUB'
#!/usr/bin/env node
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const agentDir = process.env.PI_CODING_AGENT_DIR;
if (!agentDir) { process.stderr.write("stub pi: no PI_CODING_AGENT_DIR\n"); process.exit(1); }
const args = process.argv.slice(2);
fs.mkdirSync(agentDir, { recursive: true });
fs.writeFileSync(path.join(agentDir, "argv.json"), JSON.stringify(args));
const sessDir = path.join(agentDir, "sessions"); fs.mkdirSync(sessDir, { recursive: true });
let sessionFile, sessionId;
const si = args.indexOf("--session");
if (si !== -1) { sessionFile = args[si + 1]; sessionId = path.basename(sessionFile, ".jsonl"); fs.appendFileSync(sessionFile, JSON.stringify({type:"resumed"})+"\n"); }
else { sessionId = crypto.randomUUID(); sessionFile = path.join(sessDir, sessionId + ".jsonl"); fs.writeFileSync(sessionFile, JSON.stringify({type:"session-start"})+"\n"); }
let streaming = false;
const out = (o) => process.stdout.write(JSON.stringify(o)+"\n");
function finish(cmd){ fs.appendFileSync(sessionFile, JSON.stringify({type:"prompt", message:cmd.message})+"\n"); out({type:"agent_end", messages:[]}); streaming = false; }
function handle(cmd){
  const id = cmd.id;
  if (cmd.type === "get_state") out({id, type:"response", command:"get_state", success:true, data:{isStreaming:streaming, sessionFile, sessionId}});
  else if (cmd.type === "prompt") { streaming = true; out({id, type:"response", command:"prompt", success:true}); out({type:"agent_start"}); /SLOW/.test(cmd.message) ? setTimeout(()=>finish(cmd), 1500) : finish(cmd); }
  else out({id, type:"response", command:cmd.type, success:false, error:"stub unknown"});
}
let buf=""; process.stdin.on("data", c => { buf += c.toString("utf8"); let i; while ((i=buf.indexOf("\n")) !== -1) { const line=buf.slice(0,i); buf=buf.slice(i+1); if (line.trim()) handle(JSON.parse(line)); }});
process.on("SIGTERM", () => process.exit(0));
STUB
chmod +x "$BIN/pi"

build_proj(){
  local proj="$1" ns="$2"
  mkdir -p "$proj/seats" "$proj/contracts" "$proj/.wheelhouse-worktrees/bead-x"
  cp "$ADAPTER" "$proj/seats/adapter.ts"; cp "$BRIEFS" "$proj/seats/briefs.ts"
  printf '# Fleet: Worker\n\nfixture brief.\n' > "$proj/contracts/WORKER.md"
  cat > "$proj/seats/seats.json" <<EOF
{
  "commander": { "role": "commander", "external": true, "runtime": "claude-code" },
  "seats": {
    "worker-a": { "role": "worker", "provider": "anthropic", "model": "stub", "account": { "dir": "~/.pi-seats-$ns/worker-a" } },
    "worker-b": { "role": "worker", "provider": "anthropic", "model": "stub", "account": { "dir": "~/.pi-seats-$ns/worker-b" } }
  }
}
EOF
  for seat in worker-a worker-b; do mkdir -p "$HOME_FIX/.pi-seats-$ns/$seat"; printf '{"stub":true}\n' > "$HOME_FIX/.pi-seats-$ns/$seat/auth.json"; done
}

RUN_PROJ=""
run(){ OUT="$(env HOME="$HOME_FIX" PATH="$RUN_PATH" WHEELHOUSE_RPC_TIMEOUT_MS=5000 bun "$RUN_PROJ/seats/adapter.ts" "$@" 2>&1)"; RC=$?; }
says(){ case "$OUT" in *"$1"*) return 0;; *) return 1;; esac; }
state_get(){ env HOME="$HOME_FIX" bun -e "const s=require('$RUN_PROJ/seats/state.json');const v=s.seats['$1']?.['$2'];if(v!=null)console.log(v)"; }
wait_for(){ local file="$1" text="$2" i=0; while [ $i -lt 50 ]; do [ -f "$file" ] && grep -q "$text" "$file" && return 0; sleep 0.1; i=$((i+1)); done; return 1; }

phase "1. all-idle stop-all stops every running rostered seat"
PROJ="$FIX/proj"; build_proj "$PROJ" alpha; RUN_PROJ="$PROJ"
run spawn worker-a; [ $RC -eq 0 ] && pass "worker-a spawned" || fail "worker-a spawn failed: $OUT"
run spawn worker-b; [ $RC -eq 0 ] && pass "worker-b spawned" || fail "worker-b spawn failed: $OUT"
SESS_A="$(state_get worker-a sessionFile)"; SESS_B="$(state_get worker-b sessionFile)"
run stop-all
if [ $RC -eq 0 ] && says "seat worker-a stopped" && says "seat worker-b stopped"; then pass "stop-all prints a stopped line for each idle seat"; else fail "stop-all did not stop both idle seats (rc=$RC): $OUT"; fi
if [ "$(state_get worker-a pid)" = "" ] && [ "$(state_get worker-b pid)" = "" ]; then pass "state.json clears pids for stopped seats"; else fail "state.json still has a stopped pid"; fi
if [ "$(state_get worker-a sessionFile)" = "$SESS_A" ] && [ "$(state_get worker-b sessionFile)" = "$SESS_B" ] && [ -f "$SESS_A" ] && [ -f "$SESS_B" ]; then pass "sessions remain recorded and resumable after stop-all"; else fail "a session was lost after stop-all"; fi
run resume worker-a; [ $RC -eq 0 ] && grep -q '"--session"' "$HOME_FIX/.pi-seats-alpha/worker-a/argv.json" && pass "a stopped seat resumes warm after stop-all" || fail "resume after stop-all failed: $OUT"
run stop-all >/dev/null

phase "2. one busy seat is reported, not killed; idle peers still stop"
PROJ2="$FIX/proj2"; build_proj "$PROJ2" beta; RUN_PROJ="$PROJ2"
run spawn worker-a; [ $RC -eq 0 ] || fail "busy setup spawn a failed: $OUT"
run spawn worker-b; [ $RC -eq 0 ] || fail "busy setup spawn b failed: $OUT"
run dispatch worker-a bead-x "SLOW keep this turn open"; [ $RC -eq 0 ] || fail "busy setup dispatch failed: $OUT"
wait_for "$PROJ2/seats/logs/worker-a.jsonl" 'agent_start' || fail "busy turn did not start"
PID_BUSY="$(state_get worker-a pid)"; SESS_BUSY="$(state_get worker-a sessionFile)"; SESS_IDLE="$(state_get worker-b sessionFile)"
run stop-all
if [ $RC -eq 0 ] && says "worker-a: BUSY mid-turn; NOT stopped" && says "worker-b stopped"; then pass "stop-all reports busy seat and still stops idle peer"; else fail "busy stop-all outcome wrong (rc=$RC): $OUT"; fi
if [ "$(state_get worker-a pid)" = "$PID_BUSY" ] && kill -0 "$PID_BUSY" 2>/dev/null; then pass "busy seat was not killed"; else fail "busy seat was touched or killed"; fi
if [ "$(state_get worker-a sessionFile)" = "$SESS_BUSY" ] && [ "$(state_get worker-b sessionFile)" = "$SESS_IDLE" ]; then pass "busy and stopped sessions remain resumable in state.json"; else fail "session records changed unexpectedly"; fi
wait_for "$PROJ2/seats/logs/worker-a.jsonl" 'agent_end' || fail "busy turn did not finish after being spared"
run stop-all >/dev/null

phase "3. canary — removing the busy check must be caught"
CAN="$FIX/can"; build_proj "$CAN" can; sed 's|if (st.data?.isStreaming) {|if (false \&\& st.data?.isStreaming) {|' "$ADAPTER" > "$CAN/seats/adapter.ts"
if cmp -s "$ADAPTER" "$CAN/seats/adapter.ts"; then
  fail "canary: could not cut stop-all's isStreaming check"
else
  RUN_PROJ="$CAN"; run spawn worker-a; run spawn worker-b; run dispatch worker-a bead-x "SLOW canary"; wait_for "$CAN/seats/logs/worker-a.jsonl" 'agent_start'
  BEFORE=$FAILED; run stop-all >/dev/null 2>&1
  PID="$(state_get worker-a pid)"
  if [ -z "$PID" ]; then FAILED=$BEFORE; pass "canary: stop-all without the busy check kills the busy seat and is caught"; else FAILED=$((BEFORE+1)); fail "canary: busy-check-cut adapter did not expose a detectable failure"; fi
fi

printf '\n'
if [ $FAILED -eq 0 ]; then echo "adapter.ts stop-all works on this machine."; exit 0; fi
echo "$FAILED check(s) failed."
echo "If phases 1-2 fail, stop-all broke. If the canary fails, fix this test first."
exit 1
