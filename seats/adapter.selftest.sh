#!/usr/bin/env bash

SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"
#
# adapter.selftest.sh — does adapter.ts still do what seats/README.md claims,
# on THIS machine?
#
# Hermetic where the protocol is concerned: phases 1-6 run against a stub `pi`
# — a small node script speaking the RPC protocol (strict JSONL, LF-only) —
# in a temp HOME on a private PATH, so your real seats and your real pi are
# never touched or required. The stub records its argv, so the tests can see
# what the adapter actually launched, not what it printed.
#
# The canary phase sabotages COPIES of adapter.ts — once with the state write
# cut out, once with the resume --session attachment cut out — and checks
# that these tests notice. Each sabotage is guarded with cmp: if the sed no
# longer bites, the canary says so instead of proving nothing.
#
# The last phase is ONE real-pi smoke leg: spawn a real seat in a temp HOME,
# dispatch a trivial prompt, capture agent_end, resume, and confirm the
# session file grew. It borrows your real login (auth.json is COPIED into the
# temp seat and deleted with the fixture; it never enters state.json or the
# logs, which phase 5 asserts). Skippable: no pi, no login, or
# WHEELHOUSE_SKIP_REAL_PI=1 each print a SKIP line and phases 1-7 still
# decide the exit code.
#
# Usage: adapter.selftest.sh [path-to-adapter.ts]
#
# Exit 0 = the adapter works here. Non-zero = read the FAIL lines: a failure
# in phases 1-6 or the real leg means the adapter broke; a canary failure
# means these checks cannot be trusted to tell you either way.

set -uo pipefail   # deliberately not -e: half these cases are meant to fail

HERE="$(cd "$(dirname "$0")" && pwd)"
ADAPTER="${1:-$HERE/adapter.ts}"
ADAPTER_DIR="$(cd "$(dirname "$ADAPTER")" && pwd)"
BRIEFS="$ADAPTER_DIR/briefs.ts"
FLOOR="$ADAPTER_DIR/floor.ts"
HARNESS="$ADAPTER_DIR/harness.ts"
FLEET_GATE="$ADAPTER_DIR/fleet-gate.sh"
HERALD="$ADAPTER_DIR/herald.ts"
[ -f "$ADAPTER" ] || { echo "selftest: not found: $ADAPTER" >&2; exit 2; }
[ -f "$BRIEFS" ] || { echo "selftest: not found: $BRIEFS" >&2; exit 2; }
[ -f "$HARNESS" ] || { echo "selftest: not found: $HARNESS" >&2; exit 2; }
[ -f "$FLOOR" ] || { echo "selftest: not found: $FLOOR" >&2; exit 2; }
[ -f "$FLEET_GATE" ] || { echo "selftest: not found: $FLEET_GATE" >&2; exit 2; }
[ -f "$HERALD" ] || { echo "selftest: not found: $HERALD" >&2; exit 2; }
command -v bun >/dev/null 2>&1 || { echo "selftest: bun is required to run adapter.ts" >&2; exit 2; }
NODE_BIN="$(command -v node)" || { echo "selftest: node is required for the stub pi" >&2; exit 2; }
REAL_PI="$(command -v pi || true)"

SCRUB="$HERE/evidence-scrub.sh"
[ -x "$SCRUB" ] || { echo "selftest: not executable: $SCRUB" >&2; exit 2; }
# Evidence captures should pipe this script through seats/evidence-scrub.sh.

FAILED=0
FIX=""

pass() { printf '  ok    %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; FAILED=$((FAILED + 1)); }
skip() { printf '  SKIP  %s\n' "$*"; }
phase(){ printf '\n%s\n' "$*"; }

cleanup() {
  selftest_cleanup_fixture_processes "${FIX:-}" "${SOCK:-}"
  # Seats spawned from the fixture carry the fixture path in their argv
  # (their role brief lives there); kill any that outlived their phase.
  [ -n "$FIX" ] && pkill -f "$FIX" 2>/dev/null
  [ -n "$FIX" ] && rm -rf "$FIX"
  return 0
}
trap cleanup EXIT INT TERM

# --- fixture -----------------------------------------------------------------
# Canonicalized for the same reason seat-env.selftest.sh canonicalizes: on
# macOS mktemp hands out /var/... paths that are really /private/var/...
# --- stale-fixture sweep -----------------------------------------------------
# The EXIT trap below cannot run on SIGKILL, so a killed selftest leaves its
# fixture dir — and possibly a live detached seat — behind. Fixture dirs are
# pid-stamped (wheelhouse-adapter-selftest.<pid>.XXXXXX) so a later run can tell a
# dead owner from a live one. The sweep kills only pids that a fixture's own
# state.json records AND that still hold files open under that fixture — the
# fd-based identity rule recover.ts uses, because a pid number alone proves
# nothing after reuse — then removes the dir, printing everything it swept.
FIX_PREFIX="wheelhouse-adapter-selftest"
sweep_stale_fixtures() {
  # find, not a glob: a glob with no match stays literal in bash but is an
  # error in zsh, and these scripts are exercised under both.
  local base="${TMPDIR:-/tmp}" d stamp phys sf pid
  while IFS= read -r d; do
    [ -d "$d" ] || continue
    stamp="${d##*/}"; stamp="${stamp#"$FIX_PREFIX".}"; stamp="${stamp%%.*}"
    case "$stamp" in ''|*[!0-9]*) continue ;; esac
    kill -0 "$stamp" 2>/dev/null && continue   # owner still running — not stale
    phys="$(cd "$d" 2>/dev/null && pwd -P)" || phys="$d"
    while IFS= read -r sf; do
      [ -f "$sf" ] || continue
      for pid in $(sed -n 's/.*"pid": \([0-9][0-9]*\).*/\1/p' "$sf"); do
        if kill -0 "$pid" 2>/dev/null && lsof -p "$pid" 2>/dev/null | grep -qF "$phys"; then
          kill "$pid" 2>/dev/null
          echo "swept: killed leaked seat pid $pid (held open files under $d)"
        fi
      done
    done < <(find "$d" -mindepth 3 -maxdepth 3 -path "*/seats/state.json" 2>/dev/null)
    rm -rf "$d"
    echo "swept: removed stale fixture $d"
  done < <(find "$base" -mindepth 1 -maxdepth 1 -type d -name "$FIX_PREFIX.*" 2>/dev/null)
  return 0
}
sweep_stale_fixtures

FIX="$(mktemp -d "${TMPDIR:-/tmp}/$FIX_PREFIX.$$.XXXXXX")"
FIX="$(cd "$FIX" && pwd -P)"
HOME_FIX="$FIX/home"
BIN="$FIX/bin"
mkdir -p "$HOME_FIX" "$BIN"
RUN_PATH="${BIN}:$(dirname "$(command -v bun)"):$(dirname "$NODE_BIN"):/usr/bin:/bin"

# The stub pi: a long-lived RPC process. It records argv, honours
# PI_CODING_AGENT_DIR, answers get_state/prompt/steer, appends to a session
# file, resumes one via --session, and dies cleanly on SIGTERM. A prompt
# containing SLOW finishes its turn late, so steer has a mid-turn to land in.
cat > "$BIN/pi" <<STUB
#!/usr/bin/env node
const fs = require("fs"), path = require("path"), crypto = require("crypto"), cp = require("child_process");
const agentDir = process.env.PI_CODING_AGENT_DIR;
if (!agentDir) { process.stderr.write("stub pi: no PI_CODING_AGENT_DIR\n"); process.exit(1); }
const args = process.argv.slice(2);
const mi = args.indexOf("--model");
if (mi !== -1) {
  const model = args[mi + 1] || "";
  const colon = model.lastIndexOf(":");
  if (colon !== -1) {
    const thinking = model.slice(colon + 1);
    if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinking)) {
      process.stderr.write("stub pi: unsupported thinking level " + JSON.stringify(thinking) + " in --model " + JSON.stringify(model) + "\n");
      process.exit(2);
    }
  }
}
fs.mkdirSync(agentDir, { recursive: true });
fs.writeFileSync(path.join(agentDir, "argv.json"), JSON.stringify(args));
// The adapter sets our cwd by construction (child_process spawn's cwd
// option), not by telling us in a prompt to cd there. Recording it here
// lets the selftest see what the OS-level cwd actually was, not what the
// adapter merely printed.
fs.writeFileSync(path.join(agentDir, "cwd.txt"), process.cwd());
// Same construction argument for BEADS_ACTOR: the adapter is supposed to set
// it in OUR process env directly (not rely on an operator export reaching
// us), so record what we actually got, not what anyone claims to have set.
fs.writeFileSync(path.join(agentDir, "env.json"), JSON.stringify({ BEADS_ACTOR: process.env.BEADS_ACTOR ?? null, PATH: process.env.PATH ?? null }));
if (process.env.STUB_RUN_CARGO_ON_START) {
  const r = cp.spawnSync("cargo", ["build"], { stdio: "ignore", env: process.env });
  if (r.status !== 0) process.exit(r.status || 1);
}
if (args.includes("-p")) {
  const prompt = args[args.length - 1] || "";
  fs.writeFileSync(path.join(agentDir, "probe-prompt.txt"), prompt);
  if (process.env.STUB_PROBE_FAIL) {
    process.stderr.write(process.env.STUB_PROBE_FAIL + "\n");
    process.exit(23);
  }
  process.stdout.write("OK\n");
  process.exit(0);
}
const sessDir = path.join(agentDir, "sessions");
fs.mkdirSync(sessDir, { recursive: true });
let sessionFile, sessionId;
const si = args.indexOf("--session");
if (si !== -1) {
  sessionFile = args[si + 1];
  sessionId = path.basename(sessionFile, ".jsonl");
  if (process.env.STUB_PIN_SESSION_CWD) {
    const meta = JSON.parse(fs.readFileSync(sessionFile + ".cwd.json", "utf8"));
    process.chdir(meta.cwd);
  }
  fs.appendFileSync(sessionFile, JSON.stringify({ type: "resumed", cwd: process.cwd() }) + "\n");
} else {
  sessionId = crypto.randomUUID();
  sessionFile = path.join(sessDir, sessionId + ".jsonl");
  fs.writeFileSync(sessionFile, JSON.stringify({ type: "session-start", cwd: process.cwd() }) + "\n");
  if (process.env.STUB_PIN_SESSION_CWD) fs.writeFileSync(sessionFile + ".cwd.json", JSON.stringify({ cwd: process.cwd() }));
}
let matchingChild;
if (process.env.STUB_SPAWN_MATCHING_CHILD) {
  matchingChild = cp.spawn("sleep", ["1000"], { argv0: "pi --mode rpc child " + agentDir + " " + process.cwd(), stdio: "ignore" });
  fs.writeFileSync(path.join(agentDir, "matching-child.pid"), String(matchingChild.pid));
}
const commandsFile = path.join(agentDir, "commands.jsonl");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
let streaming = false;
function handle(cmd) {
  fs.appendFileSync(commandsFile, JSON.stringify(cmd) + "\n");
  const id = cmd.id;
  switch (cmd.type) {
    case "get_state": {
      const ignoreGetState = path.join(agentDir, "ignore-get-state");
      if (fs.existsSync(ignoreGetState)) break;
      if (process.env.STUB_GET_STATE_FAIL_ONCE && !fs.existsSync(path.join(agentDir, "get-state-failed-once"))) {
        fs.writeFileSync(path.join(agentDir, "get-state-failed-once"), "1");
        out({ id, type: "response", command: "get_state", success: false, error: process.env.STUB_GET_STATE_FAIL_ONCE });
        break;
      }
      const stallFile = path.join(agentDir, "stall-next-get-state");
      const stallMs = process.env.STUB_GET_STATE_STALL_ONCE || (fs.existsSync(stallFile) ? fs.readFileSync(stallFile, "utf8").trim() : "");
      if (stallMs && !fs.existsSync(path.join(agentDir, "get-state-stalled"))) {
        fs.writeFileSync(path.join(agentDir, "get-state-stalled"), "1");
        try { fs.rmSync(stallFile, { force: true }); } catch {}
        setTimeout(() => out({ id, type: "response", command: "get_state", success: true,
              data: { isStreaming: streaming, sessionFile, sessionId, messageCount: 0 } }), Number(stallMs));
        break;
      }
      try { fs.rmSync(path.join(agentDir, "get-state-stalled"), { force: true }); } catch {}
      out({ id, type: "response", command: "get_state", success: true,
            data: { isStreaming: streaming, sessionFile, sessionId, messageCount: 0 } });
      if (process.env.STUB_PAUSE_STDIN_AFTER_GET_STATE_MS && !fs.existsSync(path.join(agentDir, "stdin-paused-once"))) {
        fs.writeFileSync(path.join(agentDir, "stdin-paused-once"), "1");
        process.stdin.pause();
        setTimeout(() => process.stdin.resume(), Number(process.env.STUB_PAUSE_STDIN_AFTER_GET_STATE_MS));
      }
      break;
    }
    case "prompt": {
      const ack = () => out({ id, type: "response", command: "prompt", success: true });
      if (process.env.STUB_PROMPT_ACK_DELAY_MS) setTimeout(ack, Number(process.env.STUB_PROMPT_ACK_DELAY_MS)); else ack();
      if (!process.env.STUB_PROMPT_ACK_NO_DELIVERY) {
        out({ type: "agent_start" });
        out({ type: "message_start", message: { role: "user", content: [{ type: "text", text: cmd.message }] } });
      }
      streaming = true;
      const finish = () => {
        fs.appendFileSync(sessionFile, JSON.stringify({ type: "prompt", message: cmd.message, streamingBehavior: cmd.streamingBehavior, cwd: process.cwd() }) + "\n");
        if (/QUOTA/.test(cmd.message)) {
          const failed = { role: "assistant", content: [{ type: "text", text: "partial before quota" }], stopReason: "error", errorMessage: "Codex error: The usage limit has been reached" };
          out({ type: "message_end", message: failed });
          out({ type: "turn_end", message: failed });
          out({ type: "agent_end", messages: [{ role: "user", content: [{ type: "text", text: cmd.message }] }, failed] });
          streaming = false;
          return;
        }
        if (/MIDTOOL/.test(cmd.message)) {
          out({ type: "tool_execution_start", toolCallId: "midtool-1", toolName: "Bash", command: "sleep 1000" });
          return;
        }
        if (/TOOLBIG/.test(cmd.message)) out({ type: "tool_execution_update", output: "X".repeat(200000) });
        out({ type: "message_end", message: { role: "assistant",
              content: [{ type: "text", text: "echo: " + cmd.message }] } });
        out({ type: "agent_end", messages: [] });
        streaming = false;
      };
      if (/SLOW/.test(cmd.message)) setTimeout(finish, 1500); else finish();
      break;
    }
    case "steer":
      fs.appendFileSync(sessionFile, JSON.stringify({ type: "steer", message: cmd.message }) + "\n");
      out({ id, type: "response", command: "steer", success: true });
      out({ type: "message_start", message: { role: "user",
            content: [{ type: "text", text: "steered: " + cmd.message }] } });
      break;
    default:
      out({ id, type: "response", command: cmd.type, success: false, error: "stub: unknown " + cmd.type });
  }
}
// LF-only line buffering by hand — the same framing the adapter must use.
let buf = "";
process.stdin.on("data", (c) => {
  buf += c.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (line.trim()) { try { handle(JSON.parse(line)); } catch (e) { out({ type: "response", command: "parse", success: false, error: String(e) }); } }
  }
});
process.stdin.on("end", () => process.exit(0));
process.on("exit", () => { if (matchingChild?.pid) { try { process.kill(matchingChild.pid, "SIGTERM"); } catch {} } });
process.on("SIGTERM", () => {
  try { fs.rmSync(path.join(agentDir, "ignore-get-state"), { force: true }); } catch {}
  if (!process.env.STUB_IGNORE_SIGTERM) process.exit(0);
});
STUB
chmod +x "$BIN/pi"
[ -x "$BIN/pi" ] || { echo "selftest: fixture stub pi was not created" >&2; exit 2; }
cat > "$BIN/bd" <<'BDSTUB'
#!/usr/bin/env bash
case "$1" in
  ready) printf '[{"id":"fixture-ready"}]\n' ;;
  list) printf '[{"id":"fixture-in-progress"}]\n' ;;
  *) printf '[]\n' ;;
esac
BDSTUB
chmod +x "$BIN/bd"
cat > "$BIN/claude" <<'CLAUDESTUB'
#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
const account = process.env.CLAUDE_CONFIG_DIR || process.env.HOME || '';
fs.mkdirSync(account, { recursive: true });
function writeSession(id){ const d=path.join(account,'projects','Claude_replaces_non_alnum_and_hashes-long-cwd-x9z'); fs.mkdirSync(d,{recursive:true}); fs.appendFileSync(path.join(d,id+'.jsonl'), JSON.stringify({type:'session', id, cwd:process.cwd()})+'\n'); }
fs.writeFileSync(path.join(account, 'claude-env.json'), JSON.stringify({ANTHROPIC_API_KEY:process.env.ANTHROPIC_API_KEY||null,ANTHROPIC_AUTH_TOKEN:process.env.ANTHROPIC_AUTH_TOKEN||null,OPENAI_API_KEY:process.env.OPENAI_API_KEY||null,BEADS_ACTOR:process.env.BEADS_ACTOR||null}));
fs.writeFileSync(path.join(account, 'claude-argv.json'), JSON.stringify(args));
if (args.includes('--output-format') && args.includes('json') && !args.includes('stream-json')) { console.log(JSON.stringify({type:'result',subtype:'success',result:'OK',session_id:'probe-session'})); process.exit(0); }
if (!args.includes('--permission-mode') || args[args.indexOf('--permission-mode')+1] !== 'acceptEdits') { console.error('expected --permission-mode acceptEdits'); process.exit(2); }
if (!args.includes('--permission-prompts') || args[args.indexOf('--permission-prompts')+1] !== 'none') { console.error('expected --permission-prompts none'); process.exit(2); }
const brief = args[args.indexOf('--append-system-prompt') + 1] || '';
if (!/fixture brief/.test(brief) || /contracts\/WORKER\.md/.test(brief)) { console.error('expected brief text, not path: '+brief); process.exit(3); }
const session = args.includes('--resume') ? args[args.indexOf('--resume')+1] : `claude-session-${process.pid}`;
const model = args.includes('--model') ? args[args.indexOf('--model')+1] : 'sonnet';
let buf='';
process.stdin.on('data', c => { buf += c.toString(); let i; while ((i=buf.indexOf('\n')) >= 0) { const line=buf.slice(0,i); buf=buf.slice(i+1); if(!line.trim()) continue; const msg=JSON.parse(line).message?.content?.[0]?.text || ''; writeSession(session); console.log(JSON.stringify({type:'system',subtype:'init',session_id:session,model})); const done=()=>{ if (/tools/i.test(msg)) { console.log(JSON.stringify({type:'assistant',message:{role:'assistant',content:[{type:'thinking',thinking:'thinking kept'},{type:'tool_use',id:'tool-1',name:'Bash',input:{command:'printf OK'}}]}})); console.log(JSON.stringify({type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:'tool-1',content:'OK',is_error:false}]}})); } console.log(JSON.stringify({type:'assistant',message:{role:'assistant',content:[{type:'text',text:/steer|slow/i.test(msg)?'STEERED':'OK'}]}})); console.log(JSON.stringify({type:'result',subtype:'success',result:/steer|slow/i.test(msg)?'STEERED':'OK',session_id:session,num_turns:/steer|slow/i.test(msg)?2:1})); }; /slow/i.test(msg) ? setTimeout(done, 900) : done(); }});
setTimeout(() => console.log(JSON.stringify({type:'rate_limit_event',rate_limit_info:{status:'limited',rateLimitType:'five_hour'}})), process.env.STUB_RATE_LIMIT ? 100 : 2147483647);
process.on('SIGTERM', () => process.exit(0));
CLAUDESTUB
chmod +x "$BIN/claude"

# A fixture project: adapter.ts expects to live at <root>/seats/adapter.ts
# with crew briefs at <root>/contracts/. build_proj makes one; the canaries
# make more, each with its own seat namespace so nothing collides.
SENTINEL='SENTINEL-TOKEN-4a7f'
build_proj() {   # $1 = project dir, $2 = seat namespace
  local proj="$1" ns="$2" seatdir
  mkdir -p "$proj/seats" "$proj/contracts"
  cp "$ADAPTER" "$proj/seats/adapter.ts"
  cp "$ADAPTER_DIR/host-budget.ts" "$proj/seats/host-budget.ts"
  cp "$HARNESS" "$proj/seats/harness.ts"
  cp "$BRIEFS" "$proj/seats/briefs.ts"
  cp "$FLOOR" "$proj/seats/floor.ts"
  cp "$FLEET_GATE" "$proj/seats/fleet-gate.sh"
  cp "$HERALD" "$proj/seats/herald.ts"
  cp -R "$ADAPTER_DIR/drivers" "$proj/seats/drivers"
  printf '# Fleet: Worker\n\nfixture brief — the stub never reads it, the argv check does.\n' \
    > "$proj/contracts/WORKER.md"
  cat > "$proj/seats/seats.json" <<EOF
{
  "commander": { "role": "commander", "external": true, "runtime": "claude-code" },
  "seats": {
    "worker-1": {
      "role": "worker",
      "provider": "anthropic",
      "model": "stub-model-1:high",
      "account": { "dir": "~/.pi-seats-$ns/worker-1" }
    }
  }
}
EOF
  seatdir="$HOME_FIX/.pi-seats-$ns/worker-1"
  mkdir -p "$seatdir"
  printf '{\n  "%s": true\n}\n' "$proj" > "$seatdir/trust.json"
  printf '{"stub":"%s"}\n' "$SENTINEL" > "$seatdir/auth.json"
}

build_installed_proj() {   # $1 = project dir, $2 = seat namespace
  local proj="$1" ns="$2" seatdir
  build_proj "$proj" "$ns"
  rm -rf "$proj/contracts"
  mkdir -p "$proj/wheelhouse/fleet" "$proj/wheelhouse/crew"
  printf '# Fleet: Worker\n\ninstalled-layout worker brief.\n' > "$proj/wheelhouse/fleet/WORKER.md"
}

PROJ="$FIX/proj"
build_proj "$PROJ" alpha

# BEADS_ACTOR is unset here on purpose, every invocation: the whole point of
# this bug's fix is that the adapter sets it in the SPAWNED SEAT's env by
# construction, not that it forwards whatever the invoking shell happened to
# export. A selftest that left an ambient BEADS_ACTOR in place could pass
# for the wrong reason — the operator-export mechanism working, not the
# adapter setting it — so it is stripped before every `run`, and phase 1's
# override case sets WHEELHOUSE_BEADS_ACTOR_WORKER_1 explicitly instead.
run() { OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" bun "$RUN_PROJ/seats/adapter.ts" "$@" 2>&1)"; RC=$?; }
says() { case "$OUT" in *"$1"*) return 0 ;; *) return 1 ;; esac; }
RUN_PROJ="$PROJ"

phase "0a. launch paths validate the whole roster before choosing a seat"
BAD_ROSTER_PROJ="$FIX/bad-roster-proj"
build_proj "$BAD_ROSTER_PROJ" badroster
RUN_PROJ="$BAD_ROSTER_PROJ"
env HOME="$HOME_FIX" PROJ="$BAD_ROSTER_PROJ" bun -e 'const fs=require("fs"); const p=process.env.PROJ+"/seats/seats.json"; const r=require(p); r.seats["bad-peer"]={role:"worker", provider:"anthropic", model:"stub", account:{dir:"~/.pi-seats-badroster/bad-peer", authRoute:"bogus"}}; fs.writeFileSync(p, JSON.stringify(r,null,2)+"\n")'
run spawn worker-1
if [ $RC -eq 1 ] && says 'seat "bad-peer" has an invalid account.authRoute "bogus"'; then
  pass "spawn refuses before launch when a peer roster entry has a bad authRoute"
else fail "spawn did not preserve whole-roster validation for launch paths (rc=$RC): $OUT"; fi
RUN_PROJ="$PROJ"

phase "0b. claude-code driver — spawn, dispatch ack, steer, settled, resume, stop, dead-process"
CLAUDE_PROJ="$FIX/claude-proj"
build_proj "$CLAUDE_PROJ" claude
mkdir -p "$CLAUDE_PROJ/.wheelhouse-worktrees/bead-y"
RUN_PROJ="$CLAUDE_PROJ"
env HOME="$HOME_FIX" PROJ="$CLAUDE_PROJ" bun -e 'const fs=require("fs"); const p=process.env.PROJ+"/seats/seats.json"; const r=require(p); r.seats["worker-1"].harness="claude-code"; r.seats["worker-1"].model="sonnet"; r.seats["worker-1"].allowedTools="Bash(printf *)"; r.seats["worker-1"].account.authRoute="oauth"; fs.writeFileSync(p, JSON.stringify(r,null,2)+"\n")'
mkdir -p "$HOME_FIX/.pi-seats-claude/worker-1"
printf '{"loggedIn":true}\n' > "$HOME_FIX/.pi-seats-claude/worker-1/.claude.json"
ANTHROPIC_API_KEY=leak ANTHROPIC_AUTH_TOKEN=leak OPENAI_API_KEY=leak run spawn worker-1
if [ $RC -eq 0 ] && grep -q 'seat worker-1' <<<"$OUT"; then pass "claude-code spawn exits 0 through the adapter"; else fail "claude-code spawn failed: $OUT"; fi
for _ in $(seq 1 100); do [ -f "$HOME_FIX/.pi-seats-claude/worker-1/claude-argv.json" ] && break; sleep 0.05; done
if grep -q 'fixture brief' "$HOME_FIX/.pi-seats-claude/worker-1/claude-argv.json" && ! grep -q 'contracts/WORKER.md' "$HOME_FIX/.pi-seats-claude/worker-1/claude-argv.json"; then pass "claude-code passes brief text, not a path"; else fail "claude-code did not pass brief text: $(cat "$HOME_FIX/.pi-seats-claude/worker-1/claude-argv.json" 2>/dev/null)"; fi
CLAUDE_LOG="$CLAUDE_PROJ/seats/logs/worker-1.jsonl"
run dispatch worker-1 bead-y "tools hello claude"
if [ $RC -eq 0 ] && grep -q 'dispatched bead-y to worker-1' <<<"$OUT"; then pass "claude-code dispatch ack exits 0"; else fail "claude-code dispatch ack failed (rc=$RC): $OUT"; fi
for _ in $(seq 1 100); do grep -q '"type":"agent_end"' "$CLAUDE_LOG" 2>/dev/null && break; sleep 0.05; done
if grep -q '"type":"agent_end"' "$CLAUDE_LOG" && grep -q '"type":"turn_end"' "$CLAUDE_LOG"; then pass "claude-code settled detection lands turn_end and agent_end"; else fail "claude-code did not settle with expected events"; fi
if grep -q '"type":"thinking"' "$CLAUDE_LOG" && grep -q '"type":"toolCall"' "$CLAUDE_LOG" && grep -q '"type":"tool_execution_start"' "$CLAUDE_LOG" && grep -q '"type":"tool_execution_end"' "$CLAUDE_LOG" && grep -q '"toolName":"Bash"' "$CLAUDE_LOG" && grep -q '"isError":false' "$CLAUDE_LOG"; then pass "claude-code normalizes thinking, toolCall, tool_execution_start/end with toolName"; else fail "claude-code missing normalized tool/thinking events: $(cat "$CLAUDE_LOG" 2>/dev/null)"; fi
if [ "$(grep -c '"type":"turn_end"' "$CLAUDE_LOG")" -eq 1 ]; then pass "claude-code emits one turn_end for the turn"; else fail "claude-code emitted wrong turn_end count"; fi
if grep -q '"ANTHROPIC_API_KEY":null' "$HOME_FIX/.pi-seats-claude/worker-1/claude-env.json" && grep -q '"ANTHROPIC_AUTH_TOKEN":null' "$HOME_FIX/.pi-seats-claude/worker-1/claude-env.json" && grep -q '"OPENAI_API_KEY":null' "$HOME_FIX/.pi-seats-claude/worker-1/claude-env.json"; then pass "claude-code child env strips provider credential variables"; else fail "claude-code child env leaked provider credentials: $(cat "$HOME_FIX/.pi-seats-claude/worker-1/claude-env.json" 2>/dev/null)"; fi
run dispatch worker-1 bead-y "slow claude"
sleep 0.1
run steer worker-1 "steer now"
if [ $RC -eq 0 ]; then pass "claude-code steer mid-turn returns ack"; else fail "claude-code steer failed (rc=$RC): $OUT"; fi
for _ in $(seq 1 100); do grep -q 'STEERED' "$CLAUDE_LOG" 2>/dev/null && break; sleep 0.05; done
if grep -q 'STEERED' "$CLAUDE_LOG"; then pass "claude-code steer reaches the running turn"; else fail "claude-code steer text did not settle"; fi
CLAUDE_SESSION_FILE="$(env HOME="$HOME_FIX" bun -e "const s=require('$CLAUDE_PROJ/seats/state.json'); console.log(s.seats['worker-1'].sessionFile||'')")"
if [ -n "$CLAUDE_SESSION_FILE" ] && [ -f "$CLAUDE_SESSION_FILE" ] && grep -q 'Claude_replaces_non_alnum' <<<"$CLAUDE_SESSION_FILE"; then pass "claude-code locates Claude's session file instead of deriving cwd slug"; else fail "claude-code did not record the actual session file: $CLAUDE_SESSION_FILE"; fi
run stop worker-1
if [ $RC -eq 0 ] && grep -q 'stopped' <<<"$OUT"; then pass "claude-code stop exits 0"; else fail "claude-code stop failed (rc=$RC): $OUT"; fi
run resume worker-1
if [ $RC -eq 0 ]; then pass "claude-code resume exits 0 with recorded session"; else fail "claude-code resume failed: $OUT"; fi
pid="$(env HOME="$HOME_FIX" bun -e "const s=require('$CLAUDE_PROJ/seats/state.json'); console.log(s.seats['worker-1'].pid)")"
kill -9 "$pid" 2>/dev/null || true
run status
if [ $RC -eq 0 ] && grep -q 'DIED' <<<"$OUT"; then pass "claude-code dead-process status reports DIED"; else fail "claude-code dead-process status did not report DIED (rc=$RC): $OUT"; fi
run resume worker-1 >/dev/null 2>&1
run stop worker-1 >/dev/null 2>&1
printf '\nchanged brief\n' >> "$CLAUDE_PROJ/contracts/WORKER.md"
run resume worker-1
if [ $RC -eq 1 ] && grep -q 'brief changed; reset instead' <<<"$OUT"; then pass "claude-code resume STOPs on brief-hash mismatch"; else fail "claude-code resume did not stop on brief-hash mismatch (rc=$RC): $OUT"; fi
RUN_PROJ="$PROJ"

STATE="$PROJ/seats/state.json"
LOG="$PROJ/seats/logs/worker-1.jsonl"
ARGV="$HOME_FIX/.pi-seats-alpha/worker-1/argv.json"
CWD_FILE="$HOME_FIX/.pi-seats-alpha/worker-1/cwd.txt"
state_get() { env HOME="$HOME_FIX" bun -e "const s=require('$STATE');const v=s.seats['worker-1']?.['$1'];if(v!=null)console.log(v)"; }
live_cwd_for_pid() {
  local pid="$1"
  [ -n "$pid" ] || return 0
  if command -v lsof >/dev/null 2>&1; then
    lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1
  elif [ -e "/proc/$pid/cwd" ]; then
    readlink "/proc/$pid/cwd"
  fi
}
assert_state_cwd_is_live_cwd() {
  local label="$1" pid live recorded
  pid="$(state_get pid)"
  recorded="$(state_get cwd)"
  live="$(live_cwd_for_pid "$pid")"
  if [ -n "$pid" ] && [ -n "$live" ] && [ "$recorded" = "$live" ]; then
    pass "$label: state.json cwd equals process live cwd"
  else
    fail "$label: state cwd '$recorded' did not equal live cwd '$live' for pid $pid"
  fi
}

wait_for() {   # $1 = file, $2 = substring, $3 = seconds
  local i=0 max=$((${3:-10} * 10))
  while [ $i -lt $max ]; do
    [ -f "$1" ] && grep -q "$2" "$1" 2>/dev/null && return 0
    sleep 0.1; i=$((i + 1))
  done
  return 1
}

wait_for_from() {   # $1 = file, $2 = byte offset, $3 = substring, $4 = seconds
  local i=0 max=$((${4:-10} * 10))
  while [ $i -lt $max ]; do
    [ -f "$1" ] && tail -c +"$(($2 + 1))" "$1" 2>/dev/null | grep -q "$3" && return 0
    sleep 0.1; i=$((i + 1))
  done
  return 1
}

phase "installed layout — wheelhouse/fleet brief is preferred without contracts/"
INST_PROJ="$FIX/installed-proj"
build_installed_proj "$INST_PROJ" installed
RUN_PROJ="$INST_PROJ"; STATE="$INST_PROJ/seats/state.json"; ARGV="$HOME_FIX/.pi-seats-installed/worker-1/argv.json"
run spawn worker-1
if [ $RC -eq 0 ]; then pass "installed layout: spawn exits 0 with no contracts/ directory"
else fail "installed layout: spawn exited ${RC}: $OUT"; fi
if grep -q "\"--append-system-prompt\",\"$INST_PROJ/wheelhouse/fleet/WORKER.md\"" "$ARGV" 2>/dev/null; then
  pass "installed layout: worker brief resolves to wheelhouse/fleet/WORKER.md"
else fail "installed layout: worker brief was not the installed path"; fi
run stop worker-1 >/dev/null 2>&1
MISS_PROJ="$FIX/missing-brief-proj"
build_proj "$MISS_PROJ" missing
rm -rf "$MISS_PROJ/contracts" "$MISS_PROJ/wheelhouse"
RUN_PROJ="$MISS_PROJ"; STATE="$MISS_PROJ/seats/state.json"; ARGV="$HOME_FIX/.pi-seats-missing/worker-1/argv.json"
run spawn worker-1
if [ $RC -ne 0 ] && says "$MISS_PROJ/wheelhouse/fleet/WORKER.md" && says "$MISS_PROJ/contracts/WORKER.md"; then
  pass "missing brief: STOP names both installed and template paths tried"
else fail "missing brief: STOP did not name both paths (exit $RC): $OUT"; fi
RUN_PROJ="$PROJ"; STATE="$PROJ/seats/state.json"; ARGV="$HOME_FIX/.pi-seats-alpha/worker-1/argv.json"

phase "roster account.label — shown when present, optional when absent"
LABEL_PROJ="$FIX/label-proj"
build_proj "$LABEL_PROJ" labeled
RUN_PROJ="$LABEL_PROJ"; STATE="$LABEL_PROJ/seats/state.json"; ARGV="$HOME_FIX/.pi-seats-labeled/worker-1/argv.json"
env HOME="$HOME_FIX" bun -e '
  const fs = require("fs");
  const f = process.argv[1];
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  j.seats["worker-1"].account.label = "fixture-human-account";
  fs.writeFileSync(f, JSON.stringify(j, null, 2));
' "$LABEL_PROJ/seats/seats.json"
run spawn worker-1
if [ $RC -eq 0 ] && says "account label: fixture-human-account"; then
  pass "spawn output includes account.label when the roster has one"
else fail "spawn did not include account.label when present (exit $RC): $OUT"; fi
run status
if [ $RC -eq 0 ] && says "account fixture-human-account"; then
  pass "status output includes account.label when the roster has one"
else fail "status did not include account.label when present (exit $RC): $OUT"; fi
run stop worker-1 >/dev/null 2>&1
RUN_PROJ="$PROJ"; STATE="$PROJ/seats/state.json"; ARGV="$HOME_FIX/.pi-seats-alpha/worker-1/argv.json"

phase "roster account.authRoute — absent is valid, present-valid passes, present-invalid is a loud STOP"
# Absent: the default fixture roster (build_proj) never sets authRoute, so a
# plain spawn against it exercises the absent case for free.
run spawn worker-1
if [ $RC -eq 0 ]; then pass "authRoute absent: spawn exits 0 (pre-existing roster stays valid)"
else fail "authRoute absent: spawn exited ${RC}: $OUT"; fi
run stop worker-1 >/dev/null 2>&1

AUTHROUTE_OK_PROJ="$FIX/authroute-ok-proj"
build_proj "$AUTHROUTE_OK_PROJ" authroute-ok
env HOME="$HOME_FIX" bun -e '
  const fs = require("fs");
  const f = process.argv[1];
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  j.seats["worker-1"].account.authRoute = "api_key";
  fs.writeFileSync(f, JSON.stringify(j, null, 2));
' "$AUTHROUTE_OK_PROJ/seats/seats.json"
RUN_PROJ="$AUTHROUTE_OK_PROJ"; STATE="$AUTHROUTE_OK_PROJ/seats/state.json"; ARGV="$HOME_FIX/.pi-seats-authroute-ok/worker-1/argv.json"
run spawn worker-1
if [ $RC -eq 0 ]; then pass "authRoute present-valid (api_key): spawn exits 0"
else fail "authRoute present-valid: spawn exited ${RC}: $OUT"; fi
run stop worker-1 >/dev/null 2>&1

AUTHROUTE_ENV_PROJ="$FIX/authroute-env-proj"
build_proj "$AUTHROUTE_ENV_PROJ" authroute-env
env HOME="$HOME_FIX" bun -e '
  const fs = require("fs");
  const f = process.argv[1];
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  j.seats["worker-1"].provider = "openai";
  j.seats["worker-1"].model = "gpt-fixture";
  j.seats["worker-1"].account.authRoute = "env";
  fs.writeFileSync(f, JSON.stringify(j, null, 2));
' "$AUTHROUTE_ENV_PROJ/seats/seats.json"
AUTHROUTE_ENV_DIR="$HOME_FIX/.pi-seats-authroute-env/worker-1"
rm -f "$AUTHROUTE_ENV_DIR/auth.json"
RUN_PROJ="$AUTHROUTE_ENV_PROJ"; STATE="$AUTHROUTE_ENV_PROJ/seats/state.json"; LOG="$AUTHROUTE_ENV_PROJ/seats/logs/worker-1.jsonl"; ARGV="$AUTHROUTE_ENV_DIR/argv.json"; CWD_FILE="$AUTHROUTE_ENV_DIR/cwd.txt"
OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" PI_CODING_AGENT_DIR="$AUTHROUTE_ENV_DIR" OPENAI_API_KEY='fixture-openai-key' pi -p --no-session --provider openai --model gpt-fixture 'Reply with exactly OK.' 2>&1)"; RC=$?
if [ $RC -eq 0 ] && [ "$OUT" = "OK" ]; then pass "authRoute env: direct pi probe succeeds with only OPENAI_API_KEY and no auth.json"
else fail "authRoute env: direct pi probe failed without auth.json (exit $RC): $OUT"; fi
OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" OPENAI_API_KEY='fixture-openai-key' bun "$RUN_PROJ/seats/adapter.ts" probe worker-1 2>&1)"; RC=$?
if [ $RC -eq 0 ] && [ "$OUT" = "OK" ]; then pass "authRoute env: adapter probe exits 0 without auth.json"
else fail "authRoute env: adapter probe failed without auth.json (exit $RC): $OUT"; fi
OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" OPENAI_API_KEY='fixture-openai-key' bun "$RUN_PROJ/seats/adapter.ts" spawn worker-1 2>&1)"; RC=$?
if [ $RC -eq 0 ]; then pass "authRoute env: adapter spawn exits 0 without auth.json"
else fail "authRoute env: adapter spawn failed without auth.json (exit $RC): $OUT"; fi
mkdir -p "$AUTHROUTE_ENV_PROJ/.wheelhouse-worktrees/env-bead"
OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" OPENAI_API_KEY='fixture-openai-key' bun "$RUN_PROJ/seats/adapter.ts" dispatch worker-1 env-bead 'hello env route' 2>&1)"; RC=$?
if [ $RC -eq 0 ] && wait_for "$LOG" 'echo: Bead env-bead' 5; then pass "authRoute env: adapter dispatch succeeds without auth.json"
else fail "authRoute env: adapter dispatch failed without auth.json (exit $RC): $OUT"; fi
OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" OPENAI_API_KEY='fixture-openai-key' bun "$RUN_PROJ/seats/adapter.ts" stop worker-1 2>&1)"; RC=$?
printf '{"openai":{"type":"env"}}\n' > "$AUTHROUTE_ENV_DIR/auth.json"
OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" OPENAI_API_KEY='fixture-openai-key' bun "$RUN_PROJ/seats/adapter.ts" spawn worker-1 2>&1)"; RC=$?
if [ $RC -ne 0 ] && says "authRoute=env" && says "auth.json" && says "shadows"; then
  pass "authRoute env: an auth.json env stub is forbidden instead of shadowing a valid env key"
else fail "authRoute env: auth.json env stub was not refused as a shadowing hazard (exit $RC): $OUT"; fi
RUN_PROJ="$PROJ"; STATE="$PROJ/seats/state.json"; LOG="$PROJ/seats/logs/worker-1.jsonl"; ARGV="$HOME_FIX/.pi-seats-alpha/worker-1/argv.json"; CWD_FILE="$HOME_FIX/.pi-seats-alpha/worker-1/cwd.txt"

AUTHROUTE_BAD_PROJ="$FIX/authroute-bad-proj"
build_proj "$AUTHROUTE_BAD_PROJ" authroute-bad
env HOME="$HOME_FIX" bun -e '
  const fs = require("fs");
  const f = process.argv[1];
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  j.seats["worker-1"].account.authRoute = "sudo";
  fs.writeFileSync(f, JSON.stringify(j, null, 2));
' "$AUTHROUTE_BAD_PROJ/seats/seats.json"
RUN_PROJ="$AUTHROUTE_BAD_PROJ"; STATE="$AUTHROUTE_BAD_PROJ/seats/state.json"; ARGV="$HOME_FIX/.pi-seats-authroute-bad/worker-1/argv.json"
run spawn worker-1
if [ $RC -ne 0 ] && says "invalid account.authRoute" && says "oauth, api_key, env"; then
  pass "authRoute present-invalid: adapter STOPs naming the offending value and the allowed set"
else fail "authRoute present-invalid did not STOP as expected (exit $RC): $OUT"; fi
RUN_PROJ="$PROJ"; STATE="$PROJ/seats/state.json"; ARGV="$HOME_FIX/.pi-seats-alpha/worker-1/argv.json"

phase "roster skills — valid entries become --skill args; missing paths STOP before spawn"
SKILL_OK_PROJ="$FIX/skill-ok-proj"
build_proj "$SKILL_OK_PROJ" skill-ok
mkdir -p "$HOME_FIX/skills/research-skill"
env HOME="$HOME_FIX" bun -e '
  const fs = require("fs");
  const f = process.argv[1];
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  j.seats["worker-1"].skills = ["~/skills/research-skill"];
  fs.writeFileSync(f, JSON.stringify(j, null, 2));
' "$SKILL_OK_PROJ/seats/seats.json"
RUN_PROJ="$SKILL_OK_PROJ"; STATE="$SKILL_OK_PROJ/seats/state.json"; ARGV="$HOME_FIX/.pi-seats-skill-ok/worker-1/argv.json"
run spawn worker-1
if [ $RC -eq 0 ]; then pass "skills present-valid: spawn exits 0"
else fail "skills present-valid: spawn exited ${RC}: $OUT"; fi
if grep -q '"--skill","'$HOME_FIX'/skills/research-skill"' "$ARGV" 2>/dev/null; then
  pass "skills present-valid: expanded --skill path reaches pi argv"
else fail "skills present-valid: --skill arg missing from argv: $(cat "$ARGV" 2>/dev/null)"; fi
run stop worker-1 >/dev/null 2>&1

SKILL_BAD_PROJ="$FIX/skill-bad-proj"
build_proj "$SKILL_BAD_PROJ" skill-bad
env HOME="$HOME_FIX" bun -e '
  const fs = require("fs");
  const f = process.argv[1];
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  j.seats["worker-1"].skills = ["~/skills/missing-skill"];
  fs.writeFileSync(f, JSON.stringify(j, null, 2));
' "$SKILL_BAD_PROJ/seats/seats.json"
RUN_PROJ="$SKILL_BAD_PROJ"; STATE="$SKILL_BAD_PROJ/seats/state.json"; ARGV="$HOME_FIX/.pi-seats-skill-bad/worker-1/argv.json"
run spawn worker-1
if [ $RC -ne 0 ] && says 'seat "worker-1" lists skill ~/skills/missing-skill' && says "$HOME_FIX/skills/missing-skill" && says 'does not exist' && [ ! -e "$ARGV" ]; then
  pass "skills missing path: adapter STOPs at roster read before spawning pi"
else fail "skills missing path did not STOP before spawn (exit $RC): $OUT; argv=$(cat "$ARGV" 2>/dev/null)"; fi
RUN_PROJ="$PROJ"; STATE="$PROJ/seats/state.json"; ARGV="$HOME_FIX/.pi-seats-alpha/worker-1/argv.json"

phase "roster shadow — absent is false, true is visible in status, non-boolean is a loud STOP"
# Absent: the default fixture roster (build_proj) never sets shadow, so status
# must not render worker-1 as a shadow seat.
run spawn worker-1
run status
if [ $RC -eq 0 ] && ! says "worker (shadow)"; then pass "shadow absent: status does not mark the seat as shadow"
else fail "shadow absent rendered as shadow or status failed (exit $RC): $OUT"; fi
run stop worker-1 >/dev/null 2>&1

SHADOW_OK_PROJ="$FIX/shadow-ok-proj"
build_proj "$SHADOW_OK_PROJ" shadow-ok
env HOME="$HOME_FIX" bun -e '
  const fs = require("fs");
  const f = process.argv[1];
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  j.seats["worker-1"].shadow = true;
  fs.writeFileSync(f, JSON.stringify(j, null, 2));
' "$SHADOW_OK_PROJ/seats/seats.json"
RUN_PROJ="$SHADOW_OK_PROJ"; STATE="$SHADOW_OK_PROJ/seats/state.json"; ARGV="$HOME_FIX/.pi-seats-shadow-ok/worker-1/argv.json"
run spawn worker-1
run status
if [ $RC -eq 0 ] && says "worker (shadow)"; then pass "shadow present-true: status marks the seat as shadow"
else fail "shadow present-true did not render in status (exit $RC): $OUT"; fi
run stop worker-1 >/dev/null 2>&1

SHADOW_BAD_PROJ="$FIX/shadow-bad-proj"
build_proj "$SHADOW_BAD_PROJ" shadow-bad
env HOME="$HOME_FIX" bun -e '
  const fs = require("fs");
  const f = process.argv[1];
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  j.seats["worker-1"].shadow = "yes";
  fs.writeFileSync(f, JSON.stringify(j, null, 2));
' "$SHADOW_BAD_PROJ/seats/seats.json"
RUN_PROJ="$SHADOW_BAD_PROJ"; STATE="$SHADOW_BAD_PROJ/seats/state.json"; ARGV="$HOME_FIX/.pi-seats-shadow-bad/worker-1/argv.json"
run spawn worker-1
if [ $RC -ne 0 ] && says "invalid shadow" && says "boolean true or false"; then
  pass "shadow present-invalid: adapter STOPs naming the offending value and boolean requirement"
else fail "shadow present-invalid did not STOP as expected (exit $RC): $OUT"; fi
RUN_PROJ="$PROJ"; STATE="$PROJ/seats/state.json"; ARGV="$HOME_FIX/.pi-seats-alpha/worker-1/argv.json"

phase "roster model suffix — malformed thinking suffix is pi's validation failure, surfaced at spawn"
BAD_SUFFIX_PROJ="$FIX/bad-suffix-proj"
build_proj "$BAD_SUFFIX_PROJ" bad-suffix
env HOME="$HOME_FIX" bun -e '
  const fs = require("fs");
  const f = process.argv[1];
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  j.seats["worker-1"].model = "stub-model-1:turbo";
  fs.writeFileSync(f, JSON.stringify(j, null, 2));
' "$BAD_SUFFIX_PROJ/seats/seats.json"
RUN_PROJ="$BAD_SUFFIX_PROJ"; STATE="$BAD_SUFFIX_PROJ/seats/state.json"; ARGV="$HOME_FIX/.pi-seats-bad-suffix/worker-1/argv.json"
run spawn worker-1
if [ $RC -ne 0 ] && says "unsupported thinking level" && says "stderr tail"; then
  pass "malformed suffix: pi rejects it and adapter surfaces the stderr tail"
else fail "malformed suffix was not a loud pi validation failure (exit $RC): $OUT"; fi
RUN_PROJ="$PROJ"; STATE="$PROJ/seats/state.json"; ARGV="$HOME_FIX/.pi-seats-alpha/worker-1/argv.json"

phase "capacity events — in-turn quota errors park the seat and a later success clears it"
CAPACITY_PROJ="$FIX/capacity-proj"
build_proj "$CAPACITY_PROJ" capacity
RUN_PROJ="$CAPACITY_PROJ"; STATE="$CAPACITY_PROJ/seats/state.json"; LOG="$CAPACITY_PROJ/seats/logs/worker-1.jsonl"; ARGV="$HOME_FIX/.pi-seats-capacity/worker-1/argv.json"
env HOME="$HOME_FIX" bun -e '
  const fs = require("fs");
  const f = process.argv[1];
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  j.seats["worker-1"].account.label = "fixture-quota-account";
  fs.writeFileSync(f, JSON.stringify(j, null, 2));
' "$CAPACITY_PROJ/seats/seats.json"
mkdir -p "$CAPACITY_PROJ/.wheelhouse-worktrees/quota-bead"
run spawn worker-1
run dispatch worker-1 quota-bead 'QUOTA turn from provider'
if [ $RC -eq 0 ] && wait_for "$LOG" 'usage limit has been reached' 5; then pass "capacity: quota-shaped agent_end fixture reached the event log"
else fail "capacity: quota fixture did not land (exit $RC): $OUT"; fi
run status
if [ $RC -eq 0 ] && says "PARKED" && says "CAPACITY: QUOTA" && says "usage limit has been reached" && says "fixture-quota-account" && says "RE-PROBE: bun seats/adapter.ts probe worker-1"; then
  pass "capacity: adapter status renders PARKED/QUOTA with provider text, account label, and re-probe command"
else fail "capacity: adapter status did not park on in-turn quota event (exit $RC): $OUT"; fi
STATE_MTIME_BEFORE="$(stat -f %m "$STATE")"
sleep 1
run status >/dev/null 2>&1
STATE_MTIME_AFTER="$(stat -f %m "$STATE")"
if [ "$STATE_MTIME_AFTER" = "$STATE_MTIME_BEFORE" ]; then
  pass "capacity: rescanning the same quota marker does not rewrite state.json"
else fail "capacity: status rewrote state.json without a marker change ($STATE_MTIME_BEFORE -> $STATE_MTIME_AFTER)"; fi
OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" NO_COLOR=1 bun "$RUN_PROJ/seats/floor.ts" --once --pin 0 2>&1)"; RC=$?
if [ $RC -eq 0 ] && says "PARKED/QUOTA" && says "bun seats/adapter.ts probe worker-1"; then
  pass "capacity: floor row surfaces PARKED/QUOTA and the re-probe command"
else fail "capacity: floor did not surface PARKED/QUOTA (exit $RC): $OUT"; fi
OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" bash "$RUN_PROJ/seats/fleet-gate.sh" 2>&1)"; RC=$?
if [ $RC -eq 0 ] && says "PARKED/QUOTA" && says "bun seats/adapter.ts probe worker-1"; then
  pass "capacity: fleet-gate surfaces PARKED/QUOTA and the re-probe command"
else fail "capacity: fleet-gate did not surface PARKED/QUOTA (exit $RC): $OUT"; fi
run probe worker-1
if [ $RC -eq 0 ] && says "OK" && says "capacity cleared at"; then
  pass "capacity: successful probe records capacity cleared time"
else fail "capacity: probe did not report a capacity clear (exit $RC): $OUT"; fi
run status
if [ $RC -eq 0 ] && says "RUNNING" && ! says "PARKED" && ! says "CAPACITY: QUOTA"; then
  pass "capacity: successful probe clears the parked quota marker"
else fail "capacity: status stayed parked after successful probe (exit $RC): $OUT"; fi
run dispatch worker-1 quota-bead 'successful turn after quota'
if [ $RC -eq 0 ] && wait_for "$LOG" 'echo: Bead quota-bead' 5; then pass "capacity: later successful turn reached the event log"
else fail "capacity: later successful turn did not land (exit $RC): $OUT"; fi
run status
if [ $RC -eq 0 ] && says "RUNNING" && ! says "CAPACITY: QUOTA" && ! says "PARKED"; then
  pass "capacity: later successful turn clears the parked quota state"
else fail "capacity: later successful turn did not clear quota state (exit $RC): $OUT"; fi
run stop worker-1 >/dev/null 2>&1
RUN_PROJ="$PROJ"; STATE="$PROJ/seats/state.json"; LOG="$PROJ/seats/logs/worker-1.jsonl"; ARGV="$HOME_FIX/.pi-seats-alpha/worker-1/argv.json"

# --- the spawn checks, parameterized so the canary can reuse them ------------
check_spawn() {   # $1 = label
  local label="$1" pid
  run spawn worker-1
  if [ $RC -eq 0 ]; then pass "${label}: spawn exits 0"
  else fail "${label}: spawn exited ${RC}: $OUT"; fi

  pid="$(state_get pid)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    pass "${label}: state.json records a live pid"
  else fail "${label}: state.json has no live pid for worker-1"; fi

  if [ -n "$(state_get sessionFile)" ] && [ -f "$(state_get sessionFile)" ]; then
    pass "${label}: state.json records a session file that exists"
  else fail "${label}: no session file recorded, or it does not exist"; fi
}


phase "0b. codex driver — spawn, dispatch, normalized events, resume, stop"
CODEX_TMP="$FIX/codex-driver"; mkdir -p "$CODEX_TMP/bin" "$CODEX_TMP/home" "$CODEX_TMP/home/codex" "$CODEX_TMP/proj/contracts" "$CODEX_TMP/proj/.wheelhouse-worktrees/bead-codex" "$CODEX_TMP/proj/.wheelhouse-worktrees/bead-resume"; printf "{}\n" > "$CODEX_TMP/home/codex/auth.json"
cat > "$CODEX_TMP/bin/codex" <<'CODEXSTUB'
#!/usr/bin/env node
const fs=require('fs'),path=require('path'); const home=process.env.CODEX_HOME||process.env.HOME; fs.mkdirSync(home,{recursive:true}); fs.appendFileSync(path.join(home,'codex-calls.jsonl'),JSON.stringify({argv:process.argv.slice(2)})+'\n'); if(process.argv[2]==='login'&&process.argv[3]==='status') process.exit(0); if(process.argv[2]==='exec'){console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'OK'}}));process.exit(0);} fs.writeFileSync(path.join(home,'codex-env.json'),JSON.stringify({OPENAI_API_KEY:process.env.OPENAI_API_KEY||null,ANTHROPIC_API_KEY:process.env.ANTHROPIC_API_KEY||null,ANTHROPIC_AUTH_TOKEN:process.env.ANTHROPIC_AUTH_TOKEN||null})); let thread='thread-'+process.pid, threadPath=path.join(home,'sessions','odd','rollout--'+thread+'.jsonl'), buf=''; function ensure(){fs.mkdirSync(path.dirname(threadPath),{recursive:true});fs.appendFileSync(threadPath,'{}\n');} function send(o){console.log(JSON.stringify(o));} function text(input){return (input||[]).map(x=>x.text||'').join('\n')}
process.stdin.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\n'))>=0){const l=buf.slice(0,i);buf=buf.slice(i+1);if(!l.trim())continue;const r=JSON.parse(l),m=r.method,p=r.params||{};if(m==='initialize')send({jsonrpc:'2.0',id:r.id,result:{codexHome:home,userAgent:'stub'}});else if(m==='thread/start'){ensure();send({jsonrpc:'2.0',id:r.id,result:{thread:{id:thread,path:threadPath,status:{type:'idle'}},model:p.model,sandbox:p.sandbox,approvalPolicy:p.approvalPolicy}})}else if(m==='thread/resume'){thread=p.threadId;threadPath=path.join(home,'sessions','odd','rollout--'+thread+'.jsonl');ensure();send({jsonrpc:'2.0',id:r.id,result:{thread:{id:thread,path:threadPath,status:{type:'idle'}},model:p.model}})}else if(m==='turn/start'||m==='turn/steer'){const turn='turn-'+Date.now(), msg=text(p.input);send({jsonrpc:'2.0',id:r.id,result:{turn:{id:turn,status:'inProgress'}}});send({jsonrpc:'2.0',method:'thread/status/changed',params:{threadId:thread,status:{type:'active'}}});send({jsonrpc:'2.0',method:'turn/started',params:{threadId:thread,turn:{id:turn,status:'inProgress'}}});if(/tools/i.test(msg)){send({jsonrpc:'2.0',method:'item/started',params:{threadId:thread,item:{id:'tool-1',type:'commandExecution',command:'printf OK'}}});send({jsonrpc:'2.0',method:'item/completed',params:{threadId:thread,item:{id:'tool-1',type:'commandExecution',command:'printf OK',status:'completed',exitCode:0,output:'OK'}}});}send({jsonrpc:'2.0',method:'item/completed',params:{threadId:thread,item:{id:'msg-1',type:'agentMessage',text:/resume/i.test(msg)?'RESUME_OK':'OK'}}});send({jsonrpc:'2.0',method:'thread/status/changed',params:{threadId:thread,status:{type:'idle'}}});send({jsonrpc:'2.0',method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'completed'}}});}}});process.on('SIGTERM',()=>process.exit(0));
CODEXSTUB
chmod +x "$CODEX_TMP/bin/codex"
printf 'worker brief\n' > "$CODEX_TMP/proj/contracts/WORKER.md"; printf 'x\n' > "$CODEX_TMP/proj/contracts/COMMANDER.md"; printf 'x\n' > "$CODEX_TMP/proj/contracts/REVIEWER.md"
mkdir -p "$CODEX_TMP/proj/seats/bin"; cp "$CODEX_TMP/bin/codex" "$CODEX_TMP/proj/seats/bin/codex"; printf '{}\n' > "$CODEX_TMP/proj/seats/host-budget.json"; cp "$PWD/seats/adapter.ts" "$CODEX_TMP/proj/seats/adapter.ts"; cp -R "$PWD/seats/drivers" "$CODEX_TMP/proj/seats/drivers"; cp "$PWD/seats/host-budget.ts" "$CODEX_TMP/proj/seats/host-budget.ts"; cp "$PWD/seats/briefs.ts" "$CODEX_TMP/proj/seats/briefs.ts"; cp "$PWD/seats/harness.ts" "$CODEX_TMP/proj/seats/harness.ts"
cat > "$CODEX_TMP/proj/seats/seats.json" <<JSON
{"seats":{"worker-1":{"role":"worker","harness":"codex","provider":"openai-codex","model":"gpt-5.5","account":{"dir":"$CODEX_TMP/home/codex","authRoute":"oauth"}}}}
JSON
OLD_RUN_PROJ="$RUN_PROJ"; OLD_STATE="$STATE"; OLD_LOG="$LOG"; OLD_ARGV="$ARGV"
RUN_PROJ="$CODEX_TMP/proj"; STATE="$CODEX_TMP/proj/seats/state.json"; LOG="$CODEX_TMP/proj/seats/logs/worker-1.jsonl"; ARGV="$CODEX_TMP/home/codex/unused-argv.json"
PATH="$CODEX_TMP/bin:$PATH" OPENAI_API_KEY=leak ANTHROPIC_API_KEY=leak ANTHROPIC_AUTH_TOKEN=leak run spawn worker-1
[ $RC -eq 0 ] && pass "codex spawn exits 0 through the adapter" || fail "codex spawn failed: $OUT"
session_file=$(node -e 'const s=require(process.argv[1]).seats["worker-1"]; process.stdout.write(s.sessionFile||"")' "$CODEX_TMP/proj/seats/state.json")
[ -n "$session_file" ] && [ -f "$session_file" ] && pass "codex records thread.path session file that exists" || fail "codex session file missing: $session_file"
if grep -q leak "$CODEX_TMP/home/codex/codex-env.json"; then fail "codex child env leaked provider credentials"; else pass "codex child env strips provider credential variables"; fi
PATH="$CODEX_TMP/bin:$PATH" run probe worker-1; [ $RC -eq 0 ] && [ "$OUT" = "OK" ] && grep -Fq '"argv":["login","status"]' "$CODEX_TMP/home/codex/codex-calls.jsonl" && pass "codex probe checks login status and accepts exact OK agent_message" || fail "codex probe failed/login not checked (rc=$RC out=$OUT calls=$(cat "$CODEX_TMP/home/codex/codex-calls.jsonl" 2>/dev/null))"
PATH="$CODEX_TMP/bin:$PATH" run dispatch worker-1 bead-codex "tools please"; [ $RC -eq 0 ] && pass "codex dispatch ack exits 0" || fail "codex dispatch ack failed (rc=$RC): $OUT"
for i in {1..80}; do grep -q '"type":"agent_end"' "$CODEX_TMP/proj/seats/logs/worker-1.jsonl" && break; sleep .1; done
if grep -q '"type":"tool_execution_start".*"toolName":"shell"' "$CODEX_TMP/proj/seats/logs/worker-1.jsonl" && grep -q '"type":"turn_end"' "$CODEX_TMP/proj/seats/logs/worker-1.jsonl"; then pass "codex normalizes tool execution, turn_end, and agent_end"; else fail "codex normalized events missing: $(tail -20 "$CODEX_TMP/proj/seats/logs/worker-1.jsonl" 2>/dev/null)"; fi
PATH="$CODEX_TMP/bin:$PATH" run stop worker-1; [ $RC -eq 0 ] && pass "codex stop exits 0" || fail "codex stop failed (rc=$RC): $OUT"
PATH="$CODEX_TMP/bin:$PATH" run resume worker-1; [ $RC -eq 0 ] && pass "codex resume exits 0 with recorded thread" || fail "codex resume failed: $OUT"
PATH="$CODEX_TMP/bin:$PATH" run dispatch worker-1 bead-resume "resume check"; for i in {1..80}; do grep -q 'RESUME_OK' "$CODEX_TMP/proj/seats/logs/worker-1.jsonl" && break; sleep .1; done
if grep -q 'RESUME_OK' "$CODEX_TMP/proj/seats/logs/worker-1.jsonl"; then pass "codex dispatch after resume answers"; else fail "codex resumed dispatch did not answer"; fi
codex_pid=$(node -e 'const s=require(process.argv[1]).seats["worker-1"]; process.stdout.write(String(s.pid||""))' "$CODEX_TMP/proj/seats/state.json")
[ -n "$codex_pid" ] || fail "codex pid missing before dead-process check"
kill -9 "$codex_pid" 2>/dev/null || true
for i in {1..80}; do PATH="$CODEX_TMP/bin:$PATH" run status worker-1; echo "$OUT" | grep -q 'DIED' && break; sleep .1; done
if [ $RC -eq 0 ] && echo "$OUT" | grep -q 'DIED'; then pass "codex status reports DIED after the recorded process is killed"; else fail "codex dead process was not reported DIED (rc=$RC): $OUT"; fi
printf 'changed brief\n' >> "$CODEX_TMP/proj/contracts/WORKER.md"
PATH="$CODEX_TMP/bin:$PATH" run resume worker-1
if [ $RC -eq 1 ] && says "brief changed; reset instead of resume"; then pass "codex resume refuses when the role brief hash changed"; else fail "codex resume did not refuse changed brief (rc=$RC): $OUT"; fi
PATH="$CODEX_TMP/bin:$PATH" run stop worker-1 >/dev/null 2>&1 || true
RUN_PROJ="$OLD_RUN_PROJ"; STATE="$OLD_STATE"; LOG="$OLD_LOG"; ARGV="$OLD_ARGV"

phase "0. seat-name validation — a name is one path segment or it is refused"
check_bad_name() {   # $1 = label, $2 = offending name
  run spawn "$2"
  if [ $RC -ne 0 ] && says "invalid seat name"; then
    pass "seat name with $1 is refused with a loud STOP"
  else fail "seat name with $1 was not refused (exit $RC): $OUT"; fi
}
check_bad_name "a path separator" "wor/ker"
check_bad_name "a dot segment" ".."
check_bad_name "whitespace" "wor ker"
check_bad_name "a quote" 'wor"ker'
check_bad_name "nothing (empty)" ""
run spawn "wor/ker"
if says '"wor/ker"'; then
  pass "the STOP names the offending key"
else fail "the STOP does not name the offending key: $OUT"; fi

phase "1. spawn — process, identity, and what was actually launched"
check_spawn "spawn"
if [ -f "$ARGV" ] && grep -q '"--mode","rpc"' "$ARGV"; then
  pass "pi was launched in RPC mode"
else fail "argv.json missing or pi not launched with --mode rpc"; fi
if grep -q "\"--append-system-prompt\",\"$PROJ/contracts/WORKER.md\"" "$ARGV" 2>/dev/null; then
  pass "role brief injected: --append-system-prompt names contracts/WORKER.md"
else fail "role brief not passed, or not the worker's brief"; fi
if grep -q '"--provider","anthropic","--model","stub-model-1:high"' "$ARGV" 2>/dev/null; then
  pass "roster's provider and model-plus-thinking pin the launch"
else fail "provider/model-plus-thinking from seats.json did not reach pi's argv"; fi
if [ "$(state_get model)" = "stub-model-1:high" ]; then
  pass "state.json records the exact model-plus-thinking pin"
else fail "state.json model was $(state_get model) — expected stub-model-1:high"; fi
if [ "$(cat "$CWD_FILE" 2>/dev/null)" = "$PROJ" ]; then
  pass "spawn with no bead id roots the seat at the project root"
else fail "spawn's cwd was $(cat "$CWD_FILE" 2>/dev/null) — expected $PROJ"; fi
assert_state_cwd_is_live_cwd "spawn"
if grep -q '"BEADS_ACTOR":"worker-1"' "${ARGV%argv.json}env.json" 2>/dev/null; then
  pass "the spawned seat's own env carries BEADS_ACTOR=worker-1, with no operator export"
else fail "spawned seat env.json was $(cat "${ARGV%argv.json}env.json" 2>/dev/null) — expected BEADS_ACTOR:worker-1 set by the adapter itself"; fi
run spawn worker-1
if [ $RC -ne 0 ] && says "already running"; then
  pass "a second spawn of a live seat is refused"
else fail "spawning an already-running seat did not stop (exit $RC)"; fi

phase "1b. BEADS_ACTOR override — WHEELHOUSE_BEADS_ACTOR_<SEAT> beats the seat name"
run stop worker-1
OUT="$(env -u BEADS_ACTOR WHEELHOUSE_BEADS_ACTOR_WORKER_1=custom-actor HOME="$HOME_FIX" PATH="$RUN_PATH" bun "$RUN_PROJ/seats/adapter.ts" spawn worker-1 2>&1)"; RC=$?
if [ $RC -eq 0 ]; then pass "spawn with the override env var exits 0"
else fail "spawn with the override env var exited ${RC}: $OUT"; fi
if grep -q '"BEADS_ACTOR":"custom-actor"' "${ARGV%argv.json}env.json" 2>/dev/null; then
  pass "WHEELHOUSE_BEADS_ACTOR_WORKER_1 overrides the default seat-name actor"
else fail "override env.json was $(cat "${ARGV%argv.json}env.json" 2>/dev/null) — expected BEADS_ACTOR:custom-actor"; fi
run stop worker-1
run spawn worker-1

phase "1c. probe — one-shot provider/model liveness check, no bead worktree"
run probe worker-1
if [ $RC -eq 0 ] && [ "$OUT" = "OK" ]; then pass "probe exits 0 and prints exactly OK"
else fail "probe did not print OK (exit $RC): $OUT"; fi
if grep -q '"-p","--no-session","--provider","anthropic","--model","stub-model-1:high"' "$ARGV" 2>/dev/null; then
  pass "probe launches pi one-shot with --no-session and the roster provider/model"
else fail "probe argv did not include the one-shot roster provider/model pin: $(cat "$ARGV" 2>/dev/null)"; fi
if grep -q 'Reply with exactly the word OK. Use no tools.' "${ARGV%argv.json}probe-prompt.txt" 2>/dev/null; then
  pass "probe sends the fixed one-line liveness turn"
else fail "probe prompt was not the fixed liveness turn: $(cat "${ARGV%argv.json}probe-prompt.txt" 2>/dev/null)"; fi
if [ ! -d "$PROJ/.wheelhouse-worktrees" ]; then
  pass "probe did not require or create a bead worktree"
else fail "probe created or required a bead worktree directory"; fi
OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_PROBE_FAIL='HTTP 429 quota exhausted' bun "$RUN_PROJ/seats/adapter.ts" probe worker-1 2>&1)"; RC=$?
if [ $RC -eq 23 ] && [ "$OUT" = "HTTP 429 quota exhausted" ]; then
  pass "probe failure preserves the provider error verbatim and exit status"
else fail "probe failure was not verbatim (exit $RC): $OUT"; fi

phase "2. dispatch — prompt round trip lands in log and session"
PID_BEFORE_BAD="$(state_get pid)"
run dispatch worker-1 no-such-bead "hello adapter"
if [ $RC -ne 0 ] && says "does not exist"; then
  pass "dispatching a bead with no worktree is a loud STOP"
else fail "dispatch to a bead with no worktree did not STOP (exit $RC): $OUT"; fi
if [ "$(state_get pid)" = "$PID_BEFORE_BAD" ] && kill -0 "$PID_BEFORE_BAD" 2>/dev/null; then
  pass "the seat is left running, not stopped, when the target worktree is missing"
else fail "a rejected dispatch left the seat stopped (pid was $PID_BEFORE_BAD, now $(state_get pid))"; fi

mkdir -p "$PROJ/.wheelhouse-worktrees/bead-x"
SESS="$(state_get sessionFile)"
SESS_LINES_BEFORE=$(wc -l < "$SESS" | tr -d ' ')
run dispatch worker-1 bead-x "hello adapter"
if [ $RC -eq 0 ]; then pass "dispatch exits 0"
else fail "dispatch exited ${RC}: $OUT"; fi
if wait_for "$LOG" '"agent_end"' 5; then pass "agent_end captured in the event log"
else fail "no agent_end in $LOG"; fi
if grep -q 'echo: Bead bead-x' "$LOG" 2>/dev/null; then
  pass "the dispatched text (bead-prefixed) came back through the turn"
else fail "dispatched message did not round-trip"; fi
SESS_LINES_AFTER=$(wc -l < "$SESS" | tr -d ' ')
if [ "$SESS_LINES_AFTER" -gt "$SESS_LINES_BEFORE" ]; then
  pass "session file grew ($SESS_LINES_BEFORE -> $SESS_LINES_AFTER lines)"
else fail "session file did not grow"; fi
if [ "$(state_get lastBead)" = "bead-x" ]; then
  pass "state.json records the dispatched bead"
else fail "lastBead not recorded"; fi
if [ "$(cat "$CWD_FILE" 2>/dev/null)" = "$PROJ/.wheelhouse-worktrees/bead-x" ]; then
  pass "dispatch relaunched the seat rooted in the bead's worktree, by construction"
else fail "seat cwd after dispatch was $(cat "$CWD_FILE" 2>/dev/null) — expected the bead-x worktree"; fi
assert_state_cwd_is_live_cwd "dispatch relaunch"
if grep -Fq -- "\"--session\",\"$SESS\"" "$ARGV" 2>/dev/null; then
  pass "the cwd-changing relaunch reattached the SAME session (--session), not a cold start"
else fail "relaunch did not carry --session with the prior session file"; fi
if grep -q '"BEADS_ACTOR":"worker-1"' "${ARGV%argv.json}env.json" 2>/dev/null; then
  pass "the dispatch relaunch still carries BEADS_ACTOR=worker-1, with no operator export in this shell either"
else fail "relaunched seat env.json was $(cat "${ARGV%argv.json}env.json" 2>/dev/null) — expected BEADS_ACTOR:worker-1"; fi
LARGE_PROMPT="$(node -e 'process.stdout.write("L".repeat(70 * 1024))')"
run dispatch worker-1 bead-x "$LARGE_PROMPT"
if [ $RC -eq 0 ]; then pass "dispatch writes and acks a prompt larger than 64 KB"
else fail "large dispatch did not ack (exit $RC): $OUT"; fi

mkdir -p "$PROJ/.wheelhouse-worktrees/bead-missing-session"
rm -f "$SESS"
OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" bun "$RUN_PROJ/seats/adapter.ts" dispatch worker-1 bead-missing-session "missing session file keeps pi continuity" 2>&1)"; RC=$?
if [ $RC -eq 0 ] && grep -Fq -- "\"--session\",\"$SESS\"" "$ARGV" 2>/dev/null && ! says "session continuity intentionally dropped"; then
  pass "pi missing recorded session file still relaunches with the recorded --session path"
else fail "pi missing recorded session file did not preserve --session (exit $RC): $OUT argv=$(cat "$ARGV" 2>/dev/null)"; fi
LOG_MARK=$(wc -c < "$LOG" | tr -d ' ')
OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" WHEELHOUSE_LOG_EVENT_STRING_BYTES=1024 bun "$RUN_PROJ/seats/adapter.ts" dispatch worker-1 bead-x "TOOLBIG payload" 2>&1)"; RC=$?
if [ $RC -eq 0 ] && wait_for_from "$LOG" "$LOG_MARK" 'wheelhouse_truncated_bytes' 5 && grep -q 'wheelhouse log truncated' "$LOG"; then
  pass "tool_execution_update payload is trimmed in the seat log with byte count noted"
else fail "tool_execution_update payload was not trimmed (exit $RC): $OUT"; fi

printf '%s\n' '{"type":"filler","text":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}' '{"type":"agent_end","messages":[]}' >> "$LOG"
OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" WHEELHOUSE_LOG_ROTATE_BYTES=100 bun "$RUN_PROJ/seats/adapter.ts" status 2>&1)"; RC=$?
if [ $RC -eq 0 ] && says "last-event agent_end" && [ -s "$LOG.1" ] && [ ! -s "$LOG" ]; then
  pass "live settled log past cap is copy-truncated without renaming the writer away"
else fail "live settled log was not copy-truncated as expected (exit $RC): $OUT current=$(wc -c < "$LOG" 2>/dev/null || echo missing) archive=$(wc -c < "$LOG.1" 2>/dev/null || echo missing)"; fi
LOG_MARK=0
run dispatch worker-1 bead-x "after live rotation"
if [ $RC -eq 0 ] && wait_for_from "$LOG" "$LOG_MARK" 'echo: Bead bead-x' 5 && grep -q 'after live rotation' "$LOG"; then
  pass "after live rotation, get_state answers and the writer's next event lands in the current log"
else fail "dispatch after live rotation did not read responses from the current log (exit $RC): $OUT current=$(cat "$LOG" 2>/dev/null) archive_tail=$(tail -5 "$LOG.1" 2>/dev/null)"; fi

phase "2a. wedged idle seat — status diagnoses, dispatch stop+resumes and retries once"
ANSWERING_PID_BEFORE="$(state_get pid)"
run dispatch worker-1 bead-x "answering seat should not relaunch"
if [ $RC -eq 0 ] && [ "$(state_get pid)" = "$ANSWERING_PID_BEFORE" ] && ! says "WEDGED"; then
  pass "answering idle seat dispatches without a relaunch"
else fail "answering idle seat was relaunched or diagnosed wedged (exit $RC): before=$ANSWERING_PID_BEFORE after=$(state_get pid) out=$OUT"; fi
WEDGED_AGENT_DIR="${ARGV%argv.json}"
touch "$WEDGED_AGENT_DIR/ignore-get-state"
OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" WHEELHOUSE_WEDGED_GET_STATE_MS=200 bun "$RUN_PROJ/seats/adapter.ts" status 2>&1)"; RC=$?
if [ $RC -eq 0 ] && grep -q 'worker-1.*WEDGED' <<<"$OUT" && says 'remedy: bun seats/adapter.ts stop worker-1; bun seats/adapter.ts resume worker-1'; then
  pass "status renders an idle get_state-timeout seat as WEDGED with remedy"
else fail "status did not render WEDGED/remedy for ignored get_state (exit $RC): $OUT"; fi
WEDGED_PID_BEFORE="$(state_get pid)"
WEDGED_SESSION_BEFORE="$(state_get sessionFile)"
OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" WHEELHOUSE_RPC_TIMEOUT_MS=200 bun "$RUN_PROJ/seats/adapter.ts" dispatch worker-1 bead-x "wedged seat self-heals" 2>&1)"; RC=$?
WEDGED_PID_AFTER="$(state_get pid)"
if [ $RC -eq 0 ] && says "WEDGED" && says "stopping and resuming" && says "retrying dispatch once" && [ "$WEDGED_PID_AFTER" != "$WEDGED_PID_BEFORE" ]; then
  pass "dispatch self-heals an idle get_state timeout by stop+resume and retry"
else fail "dispatch did not self-heal WEDGED seat (exit $RC): before=$WEDGED_PID_BEFORE after=$WEDGED_PID_AFTER out=$OUT"; fi
if [ "$(state_get sessionFile)" = "$WEDGED_SESSION_BEFORE" ] && grep -Fq -- "\"--session\",\"$WEDGED_SESSION_BEFORE\"" "$ARGV" 2>/dev/null; then
  pass "wedged self-heal keeps the recorded session"
else fail "wedged self-heal did not keep session: before=$WEDGED_SESSION_BEFORE after=$(state_get sessionFile) argv=$(cat "$ARGV" 2>/dev/null)"; fi
if grep -q 'wedged seat self-heals' "$LOG" 2>/dev/null; then
  pass "wedged self-heal retry delivered the dispatch after resume"
else fail "wedged self-heal did not deliver retried prompt: $(tail -20 "$LOG" 2>/dev/null)"; fi

phase "2b. dispatch — late prompt ack after delivery is a warning, not stale state"
SAVE_RUN_PROJ="$RUN_PROJ"; SAVE_STATE="$STATE"; SAVE_LOG="$LOG"; SAVE_ARGV="$ARGV"; SAVE_CWD_FILE="$CWD_FILE"
LATE_PROJ="$FIX/late-ack-proj"
build_proj "$LATE_PROJ" late-ack
mkdir -p "$LATE_PROJ/.wheelhouse-worktrees/old-bead" "$LATE_PROJ/.wheelhouse-worktrees/new-bead"
RUN_PROJ="$LATE_PROJ"; STATE="$LATE_PROJ/seats/state.json"; LOG="$LATE_PROJ/seats/logs/worker-1.jsonl"; ARGV="$HOME_FIX/.pi-seats-late-ack/worker-1/argv.json"; CWD_FILE="$HOME_FIX/.pi-seats-late-ack/worker-1/cwd.txt"
run spawn worker-1 old-bead
OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" WHEELHOUSE_PROMPT_ACK_MS=200 STUB_PROMPT_ACK_DELAY_MS=800 bun "$RUN_PROJ/seats/adapter.ts" dispatch worker-1 new-bead "late ack fixture" 2>&1)"; RC=$?
if [ $RC -eq 0 ] && says "prompt delivered, ack late" && says "new-bead"; then pass "late prompt ack after delivery exits 0 with warning"
else fail "late prompt ack dispatch did not warn/succeed (exit $RC): $OUT"; fi
if [ "$(state_get lastBead)" = "new-bead" ] && grep -q 'Bead new-bead' "$LOG" 2>/dev/null; then
  pass "late prompt ack leaves state.json on the new bead after log delivery"
else fail "late prompt ack left stale state/log: lastBead=$(state_get lastBead) log=$(tail -5 "$LOG" 2>/dev/null)"; fi
run stop worker-1 >/dev/null 2>&1

NO_DELIVERY_PROJ="$FIX/no-delivery-proj"
build_proj "$NO_DELIVERY_PROJ" no-delivery
mkdir -p "$NO_DELIVERY_PROJ/.wheelhouse-worktrees/old-bead" "$NO_DELIVERY_PROJ/.wheelhouse-worktrees/new-bead"
RUN_PROJ="$NO_DELIVERY_PROJ"; STATE="$NO_DELIVERY_PROJ/seats/state.json"; LOG="$NO_DELIVERY_PROJ/seats/logs/worker-1.jsonl"; ARGV="$HOME_FIX/.pi-seats-no-delivery/worker-1/argv.json"; CWD_FILE="$HOME_FIX/.pi-seats-no-delivery/worker-1/cwd.txt"
run spawn worker-1 old-bead
OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" WHEELHOUSE_PROMPT_ACK_MS=200 STUB_PROMPT_ACK_DELAY_MS=800 STUB_PROMPT_ACK_NO_DELIVERY=1 bun "$RUN_PROJ/seats/adapter.ts" dispatch worker-1 new-bead "late ack without delivery" 2>&1)"; RC=$?
if [ $RC -ne 0 ] && says "timed out after 200ms waiting for prompt response" && ! says "prompt delivered, ack late"; then pass "late prompt ack without delivery remains a STOP"
else fail "late prompt ack without delivery did not STOP (exit $RC): $OUT"; fi
run stop worker-1 >/dev/null 2>&1

FIFO_TIMEOUT_PROJ="$FIX/fifo-timeout-proj"
build_proj "$FIFO_TIMEOUT_PROJ" fifo-timeout
mkdir -p "$FIFO_TIMEOUT_PROJ/.wheelhouse-worktrees/old-bead" "$FIFO_TIMEOUT_PROJ/.wheelhouse-worktrees/new-bead"
RUN_PROJ="$FIFO_TIMEOUT_PROJ"; STATE="$FIFO_TIMEOUT_PROJ/seats/state.json"; LOG="$FIFO_TIMEOUT_PROJ/seats/logs/worker-1.jsonl"; ARGV="$HOME_FIX/.pi-seats-fifo-timeout/worker-1/argv.json"; CWD_FILE="$HOME_FIX/.pi-seats-fifo-timeout/worker-1/cwd.txt"
OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_PAUSE_STDIN_AFTER_GET_STATE_MS=5000 bun "$RUN_PROJ/seats/adapter.ts" spawn worker-1 old-bead 2>&1)"; RC=$?
if [ $RC -eq 0 ]; then pass "fifo timeout setup: spawn exits 0 with a live paused seat"
else fail "fifo timeout setup spawn failed (exit $RC): $OUT"; fi
HUGE_PROMPT="$(node -e 'process.stdout.write("H".repeat(128 * 1024))')"
OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" WHEELHOUSE_FIFO_WRITE_MS=200 WHEELHOUSE_PROMPT_ACK_MS=1000 bun "$RUN_PROJ/seats/adapter.ts" dispatch worker-1 new-bead "$HUGE_PROMPT" 2>&1)"; RC=$?
if [ $RC -ne 0 ] && says "prompt not delivered (partial FIFO write?)"; then pass "fifo write timeout names possible partial FIFO write"
else fail "fifo write timeout did not report partial FIFO write (exit $RC): $OUT"; fi
run stop worker-1 >/dev/null 2>&1
RUN_PROJ="$SAVE_RUN_PROJ"; STATE="$SAVE_STATE"; LOG="$SAVE_LOG"; ARGV="$SAVE_ARGV"; CWD_FILE="$SAVE_CWD_FILE"

phase "2b. dispatch — pinned session cwd starts fresh instead of recording a lie"
SAVE_RUN_PROJ="$RUN_PROJ"; SAVE_STATE="$STATE"; SAVE_LOG="$LOG"; SAVE_ARGV="$ARGV"; SAVE_CWD_FILE="$CWD_FILE"
PINPROJ="$FIX/pinproj"
build_proj "$PINPROJ" pin
mkdir -p "$PINPROJ/.wheelhouse-worktrees/bead-a" "$PINPROJ/.wheelhouse-worktrees/bead-b"
RUN_PROJ="$PINPROJ"; STATE="$PINPROJ/seats/state.json"; LOG="$PINPROJ/seats/logs/worker-1.jsonl"; ARGV="$HOME_FIX/.pi-seats-pin/worker-1/argv.json"; CWD_FILE="$HOME_FIX/.pi-seats-pin/worker-1/cwd.txt"
OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_PIN_SESSION_CWD=1 bun "$RUN_PROJ/seats/adapter.ts" spawn worker-1 bead-a 2>&1)"; RC=$?
if [ $RC -eq 0 ]; then pass "pinned-cwd setup spawn exits 0"
else fail "pinned-cwd setup spawn exited ${RC}: $OUT"; fi
PIN_SESS_BEFORE="$(state_get sessionFile)"
OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_PIN_SESSION_CWD=1 bun "$RUN_PROJ/seats/adapter.ts" dispatch worker-1 bead-b "hello pinned" 2>&1)"; RC=$?
if [ $RC -eq 0 ] && says "starting a fresh session"; then pass "pinned-cwd cross-bead dispatch drops session continuity and says so"
else fail "pinned-cwd dispatch did not fresh-start as specified (exit $RC): $OUT"; fi
if [ "$(state_get sessionFile)" != "$PIN_SESS_BEFORE" ] && ! grep -q "\"--session\",\"$PIN_SESS_BEFORE\"" "$ARGV" 2>/dev/null; then
  pass "pinned-cwd fallback records a new session, not the immovable old one"
else fail "pinned-cwd fallback kept the old session file or argv: before=$PIN_SESS_BEFORE after=$(state_get sessionFile) argv=$(cat "$ARGV" 2>/dev/null)"; fi
if [ "$(cat "$CWD_FILE" 2>/dev/null)" = "$PINPROJ/.wheelhouse-worktrees/bead-b" ]; then pass "pinned-cwd fresh session starts in the target worktree"
else fail "pinned-cwd fresh session cwd was $(cat "$CWD_FILE" 2>/dev/null)"; fi
assert_state_cwd_is_live_cwd "pinned-cwd fallback"
run stop worker-1
RUN_PROJ="$SAVE_RUN_PROJ"; STATE="$SAVE_STATE"; LOG="$SAVE_LOG"; ARGV="$SAVE_ARGV"; CWD_FILE="$SAVE_CWD_FILE"

mkdir -p "$PROJ/.wheelhouse-worktrees/bead-mid" "$PROJ/.wheelhouse-worktrees/bead-other" "$PROJ/.wheelhouse-worktrees/bead-force"
run dispatch worker-1 bead-mid "SLOW in-flight review"
if [ $RC -eq 0 ]; then pass "mid-turn setup dispatch exits 0"
else fail "mid-turn setup dispatch exited ${RC}: $OUT"; fi
PID_MID="$(state_get pid)"
SESS_MID="$(state_get sessionFile)"
run dispatch worker-1 bead-other "cross-bead should refuse"
if [ $RC -ne 0 ] && says "mid-turn on bead-mid" && says "bead-other" && says "agent_end/isStreaming=false"; then
  pass "mid-turn cross-bead dispatch refuses loudly with both bead ids and the settle it waits on"
else fail "mid-turn cross-bead dispatch did not refuse as specified (exit $RC): $OUT"; fi
if [ "$(state_get pid)" = "$PID_MID" ] && kill -0 "$PID_MID" 2>/dev/null; then
  pass "mid-turn cross-bead refusal leaves the running fake pi process untouched"
else fail "mid-turn cross-bead refusal killed or replaced pid $PID_MID (now $(state_get pid))"; fi
if wait_for "$LOG" 'echo: Bead bead-mid' 5 && ! grep -q 'echo: Bead bead-other' "$LOG" 2>/dev/null; then
  pass "the refused cross-bead dispatch did not kill the in-flight turn or enqueue the other bead"
else fail "refused dispatch either killed bead-mid or reached bead-other"; fi
run dispatch worker-1 bead-mid "SLOW deliberately abandoned"
if [ $RC -eq 0 ]; then pass "force setup dispatch exits 0"
else fail "force setup dispatch exited ${RC}: $OUT"; fi
PID_FORCE_BEFORE="$(state_get pid)"
OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" WHEELHOUSE_DISPATCH_FORCE=1 bun "$RUN_PROJ/seats/adapter.ts" dispatch worker-1 bead-force "forced escape" 2>&1)"; RC=$?
if [ $RC -eq 0 ] && says "WHEELHOUSE_DISPATCH_FORCE=1" && says "deliberately abandoning mid-turn bead bead-mid" && says "bead-force"; then
  pass "force escape announces deliberate abandonment and dispatches the new bead"
else fail "force escape did not announce and dispatch (exit $RC): $OUT"; fi
if [ "$(state_get pid)" != "$PID_FORCE_BEFORE" ] && ! kill -0 "$PID_FORCE_BEFORE" 2>/dev/null && [ "$(cat "$CWD_FILE" 2>/dev/null)" = "$PROJ/.wheelhouse-worktrees/bead-force" ]; then
  pass "force escape relaunches the seat in the new bead worktree"
else fail "force escape did not relaunch from pid $PID_FORCE_BEFORE to bead-force (now pid $(state_get pid), cwd $(cat "$CWD_FILE" 2>/dev/null))"; fi
wait_for "$LOG" 'echo: Bead bead-force' 5 >/dev/null

phase "3. steer — a redirect lands inside a turn still in flight"
mkdir -p "$PROJ/.wheelhouse-worktrees/bead-y"
run dispatch worker-1 bead-y "SLOW long think"
run steer worker-1 "change course"
if [ $RC -eq 0 ]; then pass "steer exits 0"
else fail "steer exited ${RC}: $OUT"; fi
if wait_for "$LOG" 'steered: change course' 5; then
  pass "the steer reached the seat mid-turn"
else fail "steer text never surfaced in the event log"; fi
wait_for "$LOG" 'echo: Bead bead-y' 5 >/dev/null   # let the slow turn finish

phase "4. state survives the adapter — every invocation is a fresh process"
BIGLOG="$PROJ/seats/logs/worker-big.jsonl"
cp "$STATE" "$FIX/state-before-big.json"
python3 - <<PY
from pathlib import Path
p=Path('$BIGLOG'); p.parent.mkdir(parents=True, exist_ok=True)
with p.open('wb') as f:
    f.truncate(2*1024*1024*1024 + 1024)
    f.write(b'{"type":"agent_end"}\n')
PY
bun -e "const fs=require('fs'); const p='$STATE'; const s=require(p); s.seats['worker-big']={...s.seats['worker-1'], pid:Number('$(state_get pid)'), log:'$BIGLOG', role:'worker'}; fs.writeFileSync(p, JSON.stringify(s,null,2)+'\\n')"
OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" WHEELHOUSE_LOG_ROTATE_BYTES=$((1024*1024*1024*3)) bun "$RUN_PROJ/seats/adapter.ts" status 2>&1)"; RC=$?
if [ $RC -eq 0 ] && says "worker-big" && says "last-event agent_end"; then pass "status reads last event from a synthetic >2GB sparse log without full-file parsing"
else fail "status did not survive synthetic >2GB log (exit $RC): $OUT"; fi
BADLOG="$PROJ/seats/logs/worker-badlog.jsonl"
python3 - <<PY
from pathlib import Path
p=Path('$BADLOG'); p.parent.mkdir(parents=True, exist_ok=True)
with p.open('wb') as f:
    f.truncate(2*1024*1024*1024 + 1024)
    f.write(b'not json at tail but process is alive\n')
PY
bun -e "const fs=require('fs'); const p='$STATE'; const s=require(p); s.seats['worker-badlog']={...s.seats['worker-1'], pid:Number('$(state_get pid)'), log:'$BADLOG', role:'worker'}; fs.writeFileSync(p, JSON.stringify(s,null,2)+'\\n')"
OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" WHEELHOUSE_LOG_ROTATE_BYTES=$((1024*1024*1024*3)) bun "$RUN_PROJ/seats/adapter.ts" status 2>&1)"; RC=$?
if [ $RC -eq 0 ] && says "worker-badlog" && says "RUNNING" && says "log too large to parse"; then pass "oversize unparsable log keeps live seat visible with log-too-large marker"
else fail "oversize unparsable log aborted or hid live seat (exit $RC): $OUT"; fi
ROTLOG="$PROJ/seats/logs/worker-rotate.jsonl"
printf '{"type":"agent_start"}\n' > "$ROTLOG"
bun -e "const fs=require('fs'); const p='$STATE'; const s=require(p); s.seats['worker-rotate']={...s.seats['worker-1'], pid:Number('$(state_get pid)'), log:'$ROTLOG', role:'worker'}; fs.writeFileSync(p, JSON.stringify(s,null,2)+'\\n')"
OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" WHEELHOUSE_LOG_ROTATE_BYTES=1 bun "$RUN_PROJ/seats/adapter.ts" status 2>&1)"; RC=$?
if [ $RC -eq 0 ] && [ -f "$ROTLOG" ] && [ ! -f "$ROTLOG.1" ]; then pass "rotation refuses mid-turn logs whose last event is not agent_settled/agent_end"
else fail "rotation moved an unsettled log (exit $RC): $OUT"; fi
printf '{"type":"agent_end"}\n' >> "$ROTLOG"
OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" WHEELHOUSE_LOG_ROTATE_BYTES=1 bun "$RUN_PROJ/seats/adapter.ts" status 2>&1)"; RC=$?
if [ $RC -eq 0 ] && [ -f "$ROTLOG.1" ] && [ -f "$ROTLOG" ]; then pass "rotation runs after agent_settled/agent_end and keeps current log present"
else fail "rotation did not archive settled oversize log (exit $RC): $OUT"; fi
mv "$FIX/state-before-big.json" "$STATE"
run status
if [ $RC -eq 0 ] && says "worker-1" && says "RUNNING"; then
  pass "a fresh status invocation reads worker-1 as RUNNING from state.json"
else fail "status did not survive adapter restart (exit $RC): $OUT"; fi
if ! says "account fixture-human-account"; then
  pass "status still works for a roster with no account.label"
else fail "status carried a label from a different roster into an unlabeled seat: $OUT"; fi

phase "5. no tokens — identity never leaks into state or logs"
if ! grep -q "$SENTINEL" "$STATE" && ! grep -rq "$SENTINEL" "$PROJ/seats/logs/"; then
  pass "auth.json's content appears nowhere in state.json or the logs"
else fail "the auth sentinel leaked into state.json or a log"; fi

phase "6. stop, then resume — the session comes back warm"
PID_BEFORE="$(state_get pid)"
run stop worker-1
if [ $RC -eq 0 ] && ! kill -0 "$PID_BEFORE" 2>/dev/null; then
  pass "stop exits 0 and the process is gone"
else fail "stop did not terminate pid $PID_BEFORE (exit $RC)"; fi
if [ -z "$(state_get pid)" ] && [ -n "$(state_get sessionFile)" ]; then
  pass "state keeps the session but drops the pid"
else fail "stopped state is wrong (pid=$(state_get pid))"; fi

run resume worker-1 >/dev/null 2>&1
PID_BEFORE="$(state_get pid)"
mv -f "$PROJ/seats/seats.json" "$PROJ/seats/seats.json.missing-fixture"
run stop worker-1
if [ $RC -eq 0 ] && ! kill -0 "$PID_BEFORE" 2>/dev/null; then
  pass "stop does not need seats.json when state already records a running pi seat"
else fail "stop was blocked by a missing roster (exit $RC): $OUT"; fi
mv -f "$PROJ/seats/seats.json.missing-fixture" "$PROJ/seats/seats.json"

run resume worker-1 >/dev/null 2>&1
PID_BEFORE="$(state_get pid)"
cp "$PROJ/seats/seats.json" "$PROJ/seats/seats.json.good"
env HOME="$HOME_FIX" PROJ="$PROJ" bun -e 'const fs=require("fs"); const p=process.env.PROJ+"/seats/seats.json"; const r=require(p); r.seats["bad-peer"]={role:"worker", provider:"anthropic", model:"stub", account:{dir:"~/.pi-seats-alpha/bad-peer", authRoute:"definitely-not-valid"}}; fs.writeFileSync(p, JSON.stringify(r,null,2)+"\n")'
run stop worker-1
if [ $RC -eq 0 ] && ! kill -0 "$PID_BEFORE" 2>/dev/null; then
  pass "stop validates only the named running seat, not another seat's broken authRoute"
else fail "stop was blocked by another roster entry's bad authRoute (exit $RC): $OUT"; fi
mv -f "$PROJ/seats/seats.json.good" "$PROJ/seats/seats.json"

check_resume() {   # $1 = label; expects a stopped seat with a recorded session
  local label="$1" sess
  sess="$(state_get sessionFile)"
  run resume worker-1
  if [ $RC -eq 0 ]; then pass "${label}: resume exits 0"
  else fail "${label}: resume exited ${RC}: $OUT"; fi
  if grep -q "\"--session\",\"$sess\"" "$ARGV" 2>/dev/null; then
    pass "${label}: relaunch attached the recorded session via --session"
  else fail "${label}: --session with the recorded file is not in pi's argv"; fi
  if grep -q '"BEADS_ACTOR":"worker-1"' "${ARGV%argv.json}env.json" 2>/dev/null; then
    pass "${label}: resume still carries BEADS_ACTOR=worker-1"
  else fail "${label}: resumed seat env.json was $(cat "${ARGV%argv.json}env.json" 2>/dev/null) — expected BEADS_ACTOR:worker-1"; fi
}
SESS_LINES_BEFORE=$(wc -l < "$SESS" | tr -d ' ')
check_resume "resume"
if grep -q '"resumed"' "$SESS" && [ "$(wc -l < "$SESS" | tr -d ' ')" -gt "$SESS_LINES_BEFORE" ]; then
  pass "the same session file grew on resume — warm context survives"
else fail "session file unchanged after resume"; fi
assert_state_cwd_is_live_cwd "resume"
if [ "$(state_get lastBead)" = "bead-y" ]; then
  pass "lastBead survives the stop/resume cycle"
else fail "lastBead was lost across resume"; fi
run reset worker-1
if [ $RC -eq 0 ]; then pass "reset exits 0"
else fail "reset exited ${RC}: $OUT"; fi
if grep -q '"BEADS_ACTOR":"worker-1"' "${ARGV%argv.json}env.json" 2>/dev/null; then
  pass "reset's cold respawn still carries BEADS_ACTOR=worker-1"
else fail "reset's respawned seat env.json was $(cat "${ARGV%argv.json}env.json" 2>/dev/null) — expected BEADS_ACTOR:worker-1"; fi
run stop worker-1

phase "6a. resume after mid-tool death surfaces a stalled seat and herald row"
run resume worker-1 >/dev/null 2>&1
run dispatch worker-1 bead-y "MIDTOOL sleep until killed"
if [ $RC -eq 0 ]; then pass "mid-tool setup: dispatch exits 0"; else fail "mid-tool setup: dispatch failed (rc=$RC): $OUT"; fi
for _ in $(seq 1 100); do grep -q '"type":"tool_execution_start"' "$LOG" 2>/dev/null && break; sleep 0.05; done
if grep -q '"type":"tool_execution_start"' "$LOG"; then pass "mid-tool setup: log records unfinished tool start"; else fail "mid-tool setup: no tool_execution_start in log"; fi
# Seed herald's cursor before the resume appends the synthetic stalled settle row;
# first sight starts at EOF by design, so this makes the later row observable.
env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" bun "$RUN_PROJ/seats/herald.ts" --once >/dev/null 2>&1
PID_BEFORE="$(state_get pid)"
kill -9 "$PID_BEFORE" 2>/dev/null || true
for _ in $(seq 1 100); do kill -0 "$PID_BEFORE" 2>/dev/null || break; sleep 0.05; done
run resume worker-1
if [ $RC -eq 0 ] && says "STALLED" && says "cut off during a tool call"; then pass "resume detects the unfinished tool call and marks the seat STALLED"; else fail "resume did not surface mid-tool cutoff (rc=$RC): $OUT"; fi
run status
if [ $RC -eq 0 ] && says "STALLED" && says "last-event agent_settled"; then pass "status renders resumed mid-tool cutoff as STALLED, not RUNNING"; else fail "status did not render STALLED after mid-tool resume (rc=$RC): $OUT"; fi
OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" bun "$RUN_PROJ/seats/herald.ts" --once 2>&1)"; RC=$?
if [ $RC -eq 0 ] && grep -q '"class":"settle"' "$RUN_PROJ/seats/inbox.jsonl" 2>/dev/null && grep -q '"state":"stalled"' "$RUN_PROJ/seats/inbox.jsonl" 2>/dev/null; then
  pass "herald appends a settle/stalled inbox row for the resumed cutoff"
else fail "herald did not append settle/stalled row (rc=$RC out=$OUT inbox=$(cat "$RUN_PROJ/seats/inbox.jsonl" 2>/dev/null))"; fi
run stop worker-1 >/dev/null 2>&1

phase "6b. pruned cwd — dispatch and plain resume fall back visibly"
run resume worker-1
if [ $RC -eq 0 ]; then pass "pruned cwd setup: resume exits 0 before pruning"
else fail "pruned cwd setup: resume exited ${RC}: $OUT"; fi
OLD_SESS="$(state_get sessionFile)"
rm -rf "$PROJ/.wheelhouse-worktrees/bead-y"
mkdir -p "$PROJ/.wheelhouse-worktrees/bead-z"
run dispatch worker-1 bead-z "hello after prune"
if [ $RC -eq 0 ]; then pass "pruned cwd dispatch: dispatch exits 0 via fallback"
else fail "pruned cwd dispatch: exited ${RC}: $OUT"; fi
if says "session continuity intentionally dropped" && says "recorded cwd is gone" && says "falling back to fresh spawn"; then
  pass "pruned cwd dispatch: fallback announcement is visible and names why"
else fail "pruned cwd dispatch: fallback announcement missing (exit $RC): $OUT"; fi
if [ "$(state_get sessionFile)" != "$OLD_SESS" ] && ! grep -q "\"--session\",\"$OLD_SESS\"" "$ARGV" 2>/dev/null; then
  pass "pruned cwd dispatch: fallback used a fresh session rather than --session"
else fail "pruned cwd dispatch: fallback still attached the pruned-cwd session"; fi
if [ "$(state_get lastBead)" = "bead-z" ]; then
  pass "pruned cwd dispatch: state records the new dispatched bead"
else fail "pruned cwd dispatch: lastBead was not updated"; fi
run stop worker-1
MISSING_CWD="$PROJ/.wheelhouse-worktrees/pruned-resume-cwd"
OLD_SESS="$(state_get sessionFile)"
env HOME="$HOME_FIX" MISSING_CWD="$MISSING_CWD" bun -e 'const fs=require("fs"); const s=require(process.argv[1]); s.seats["worker-1"].cwd=process.env.MISSING_CWD; fs.writeFileSync(process.argv[1], JSON.stringify(s,null,2)+"\n")' "$STATE"
run resume worker-1
if [ $RC -eq 0 ] && says "recorded seat cwd is gone: $MISSING_CWD" && says "session continuity intentionally dropped" && says "resuming fresh in $PROJ/.wheelhouse-worktrees/bead-z"; then
  pass "pruned cwd resume: existing bead worktree fallback line names missing cwd and chosen cwd"
else fail "pruned cwd resume: missing fallback line for bead worktree (exit $RC): $OUT"; fi
if [ "$(state_get sessionFile)" != "$OLD_SESS" ] && ! grep -q "\"--session\",\"$OLD_SESS\"" "$ARGV" 2>/dev/null && [ "$(cat "$CWD_FILE" 2>/dev/null)" = "$PROJ/.wheelhouse-worktrees/bead-z" ]; then
  pass "pruned cwd resume: falls back with a fresh session in the current bead worktree"
else fail "pruned cwd resume: did not fresh-start in bead-z (session before=$OLD_SESS after=$(state_get sessionFile) cwd=$(cat "$CWD_FILE" 2>/dev/null) argv=$(cat "$ARGV" 2>/dev/null))"; fi
run stop worker-1
rm -rf "$PROJ/.wheelhouse-worktrees/bead-z"
OLD_SESS="$(state_get sessionFile)"
env HOME="$HOME_FIX" MISSING_CWD="$MISSING_CWD" bun -e 'const fs=require("fs"); const s=require(process.argv[1]); s.seats["worker-1"].cwd=process.env.MISSING_CWD; fs.writeFileSync(process.argv[1], JSON.stringify(s,null,2)+"\n")' "$STATE"
run resume worker-1
if [ $RC -eq 0 ] && says "recorded seat cwd is gone: $MISSING_CWD" && says "resuming fresh in $PROJ"; then
  pass "pruned cwd resume: missing bead worktree falls back to the project root"
else fail "pruned cwd resume: did not fall back to project root (exit $RC): $OUT"; fi
if [ "$(state_get sessionFile)" != "$OLD_SESS" ] && ! grep -q "\"--session\",\"$OLD_SESS\"" "$ARGV" 2>/dev/null && [ "$(cat "$CWD_FILE" 2>/dev/null)" = "$PROJ" ]; then
  pass "pruned cwd resume: root fallback is also a fresh session"
else fail "pruned cwd resume: root fallback did not fresh-start (session before=$OLD_SESS after=$(state_get sessionFile) cwd=$(cat "$CWD_FILE" 2>/dev/null) argv=$(cat "$ARGV" 2>/dev/null))"; fi
run stop worker-1

phase "6c. readiness timeout cleanup, orphan status, and queued steer"
CLEAN_PROJ="$FIX/cleanup-proj"
build_proj "$CLEAN_PROJ" cleanup
RUN_PROJ="$CLEAN_PROJ"; STATE="$CLEAN_PROJ/seats/state.json"; LOG="$CLEAN_PROJ/seats/logs/worker-1.jsonl"; ARGV="$HOME_FIX/.pi-seats-cleanup/worker-1/argv.json"
run spawn worker-1
run stop worker-1 >/dev/null 2>&1
OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_GET_STATE_STALL_ONCE=2000 STUB_IGNORE_SIGTERM=1 WHEELHOUSE_RPC_TIMEOUT_MS=300 WHEELHOUSE_SPAWN_TERM_GRACE_MS=200 bun "$RUN_PROJ/seats/adapter.ts" resume worker-1 2>&1)"; RC=$?
CLEAN_PID="$(printf '%s\n' "$OUT" | sed -n 's/.*spawned pid \([0-9][0-9]*\).*/\1/p' | head -1)"
if [ $RC -ne 0 ] && says "launch-only cleanup" && says "SIGKILL" && [ -n "$CLEAN_PID" ] && ! kill -0 "$CLEAN_PID" 2>/dev/null; then
  pass "launch readiness timeout kills only the newly spawned unready pid before STOP"
else fail "launch readiness timeout did not clean up spawned pid (exit $RC pid=$CLEAN_PID): $OUT"; fi
if [ -z "$(state_get pid)" ] && [ -n "$(state_get sessionFile)" ]; then
  pass "launch cleanup leaves the stopped pre-existing state record intact"
else fail "launch cleanup changed the stopped state record (pid=$(state_get pid), session=$(state_get sessionFile))"; fi
FAIL_PROJ="$FIX/getstate-fail-proj"
build_proj "$FAIL_PROJ" getstatefail
RUN_PROJ="$FAIL_PROJ"; STATE="$FAIL_PROJ/seats/state.json"; LOG="$FAIL_PROJ/seats/logs/worker-1.jsonl"; ARGV="$HOME_FIX/.pi-seats-getstatefail/worker-1/argv.json"
OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_GET_STATE_FAIL_ONCE='fixture get_state failure' bun "$RUN_PROJ/seats/adapter.ts" spawn worker-1 2>&1)"; RC=$?
FAIL_PID="$(printf '%s\n' "$OUT" | sed -n 's/.*spawned pid \([0-9][0-9]*\).*/\1/p' | head -1)"
if [ $RC -ne 0 ] && says "get_state failed on fresh seat" && says "launch-only cleanup" && [ -n "$FAIL_PID" ] && ! kill -0 "$FAIL_PID" 2>/dev/null; then
  pass "launch get_state success:false kills the spawned child before STOP"
else fail "get_state success:false did not clean up spawned pid (exit $RC pid=$FAIL_PID): $OUT"; fi
if state_get lastLaunchFailure | grep -q 'fixture get_state failure'; then
  pass "launch get_state success:false records lastLaunchFailure in state.json"
else fail "get_state success:false did not record lastLaunchFailure: $(cat "$STATE" 2>/dev/null)"; fi
RUN_PROJ="$CLEAN_PROJ"; STATE="$CLEAN_PROJ/seats/state.json"; LOG="$CLEAN_PROJ/seats/logs/worker-1.jsonl"; ARGV="$HOME_FIX/.pi-seats-cleanup/worker-1/argv.json"
OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" WHEELHOUSE_ORPHAN_CONFIRM_MS=100 bun "$RUN_PROJ/seats/adapter.ts" status 2>&1)"; RC=$?
if [ $RC -eq 0 ] && ! says "ORPHAN"; then pass "status reports zero orphans after launch cleanup"
else fail "status found an orphan after cleanup (exit $RC): $OUT"; fi

CHILD_PROJ="$FIX/child-proj"
build_proj "$CHILD_PROJ" child
RUN_PROJ="$CHILD_PROJ"; STATE="$CHILD_PROJ/seats/state.json"; LOG="$CHILD_PROJ/seats/logs/worker-1.jsonl"; ARGV="$HOME_FIX/.pi-seats-child/worker-1/argv.json"
OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_SPAWN_MATCHING_CHILD=1 bun "$RUN_PROJ/seats/adapter.ts" spawn worker-1 2>&1)"; RC=$?
CHILD_PID="$(cat "$HOME_FIX/.pi-seats-child/worker-1/matching-child.pid" 2>/dev/null || true)"
OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" WHEELHOUSE_ORPHAN_CONFIRM_MS=100 bun "$RUN_PROJ/seats/adapter.ts" status 2>&1)"; RC=$?
if [ $RC -eq 0 ] && [ -n "$CHILD_PID" ] && kill -0 "$CHILD_PID" 2>/dev/null && ! says "ORPHAN"; then
  pass "status does not flag a live child of the recorded seat as ORPHAN"
else fail "status flagged a recorded seat child as orphan or child missing (exit $RC child=${CHILD_PID:-none}): $OUT"; fi
run stop worker-1 >/dev/null 2>&1

ORPHAN_PROJ="$FIX/orphan-proj"
build_proj "$ORPHAN_PROJ" orphan
RUN_PROJ="$ORPHAN_PROJ"; STATE="$ORPHAN_PROJ/seats/state.json"; LOG="$ORPHAN_PROJ/seats/logs/worker-1.jsonl"; ARGV="$HOME_FIX/.pi-seats-orphan/worker-1/argv.json"
run spawn worker-1
REC_PID="$(state_get pid)"
FIFO="$ORPHAN_PROJ/seats/run/worker-1.stdin"
ERR="$ORPHAN_PROJ/seats/logs/worker-1.stderr.log"
( env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" PI_CODING_AGENT_DIR="$HOME_FIX/.pi-seats-orphan/worker-1" BEADS_ACTOR=worker-1 bash -c "cd '$ORPHAN_PROJ' && exec -a 'pi --mode rpc duplicate $HOME_FIX/.pi-seats-orphan/worker-1 $ORPHAN_PROJ' sleep 1000" 0<> "$FIFO" >> "$LOG" 2>> "$ERR" ) &
ORPHAN_PID=$!
sleep 0.5
OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" WHEELHOUSE_ORPHAN_CONFIRM_MS=100 bun "$RUN_PROJ/seats/adapter.ts" status 2>&1)"; RC=$?
if [ $RC -eq 0 ] && says "pid $ORPHAN_PID" && says "remedy:" && { says "ORPHAN" || says "fixture leak"; } && { says "FIFO" || says "argv/cwd/account match"; }; then
  pass "status reports a duplicate pi process as ORPHAN or fixture leak with match reason and remedy"
else fail "status did not report the duplicate process as ORPHAN/fixture leak (exit $RC orphan=$ORPHAN_PID recorded=$REC_PID): $OUT"; fi
kill "$ORPHAN_PID" 2>/dev/null
FIXTURE_LEAK_ROOT="$FIX/.wheelhouse-runs/fixture-leak-bead/repro-fixture"
mkdir -p "$FIXTURE_LEAK_ROOT"
( env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" bash -c "cd '$FIXTURE_LEAK_ROOT' && exec -a 'pi --mode rpc fixture-leak $HOME_FIX/.pi-seats-orphan/worker-1 $ORPHAN_PROJ $FIXTURE_LEAK_ROOT' sleep 1000" ) &
FIXTURE_LEAK_PID=$!
sleep 0.5
OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" WHEELHOUSE_ORPHAN_CONFIRM_MS=100 bun "$RUN_PROJ/seats/adapter.ts" status 2>&1)"; RC=$?
if [ $RC -eq 0 ] && says "fixture leak" && says "pid $FIXTURE_LEAK_PID" && ! grep -q "ORPHAN: pid $FIXTURE_LEAK_PID" <<<"$OUT"; then
  pass "status labels leaked fixture processes separately instead of ORPHAN"
else fail "status did not label fixture leak separately (exit $RC leak=$FIXTURE_LEAK_PID): $OUT"; fi
kill "$FIXTURE_LEAK_PID" 2>/dev/null
run stop worker-1 >/dev/null 2>&1

STEER_PROJ="$FIX/steer-slow-proj"
build_proj "$STEER_PROJ" steer-slow
RUN_PROJ="$STEER_PROJ"; STATE="$STEER_PROJ/seats/state.json"; LOG="$STEER_PROJ/seats/logs/worker-1.jsonl"; ARGV="$HOME_FIX/.pi-seats-steer-slow/worker-1/argv.json"
run spawn worker-1
printf '2000\n' > "$HOME_FIX/.pi-seats-steer-slow/worker-1/stall-next-get-state"
OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" WHEELHOUSE_RPC_TIMEOUT_MS=300 bun "$RUN_PROJ/seats/adapter.ts" steer worker-1 'queued from slow state' 2>&1)"; RC=$?
COMMANDS="$HOME_FIX/.pi-seats-steer-slow/worker-1/commands.jsonl"
if [ $RC -eq 0 ] && says "queued steer" && grep -q '"streamingBehavior":"steer"' "$COMMANDS" 2>/dev/null && grep -q 'queued from slow state' "$COMMANDS" 2>/dev/null; then
  pass "slow get_state steer queues prompt with streamingBehavior=steer instead of losing text"
else fail "slow get_state steer was not queued (exit $RC): $OUT commands=$(cat "$COMMANDS" 2>/dev/null)"; fi
run stop worker-1 >/dev/null 2>&1
RUN_PROJ="$PROJ"; STATE="$PROJ/seats/state.json"; LOG="$PROJ/seats/logs/worker-1.jsonl"; ARGV="$HOME_FIX/.pi-seats-alpha/worker-1/argv.json"

phase "6d. status cost — six recorded seats with no orphan candidates returns promptly"
STATUS_COST_PROJ="$FIX/status-cost-proj"
build_proj "$STATUS_COST_PROJ" status-cost
mkdir -p "$STATUS_COST_PROJ/seats/logs"
env HOME="$HOME_FIX" PROJ="$STATUS_COST_PROJ" ME="$$" bun -e '
  const fs = require("fs"), path = require("path");
  const proj = process.env.PROJ, seats = {};
  for (let i = 1; i <= 6; i++) {
    const name = `cost-${i}`;
    const log = path.join(proj, "seats", "logs", `${name}.jsonl`);
    fs.writeFileSync(log, "");
    seats[name] = { pid: Number(process.env.ME), startedAt: new Date().toISOString(), accountDir: path.join(proj, "acct", name), role: "worker", roleBrief: "x", cwd: proj, fifo: path.join(proj, "seats", "run", `${name}.stdin`), log, sessionId: "s", sessionFile: null };
  }
  fs.writeFileSync(path.join(proj, "seats", "state.json"), JSON.stringify({ seats }, null, 2));
'
RUN_PROJ="$STATUS_COST_PROJ"; STATE="$STATUS_COST_PROJ/seats/state.json"
START_MS="$(node -e 'console.log(Date.now())')"
OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" WHEELHOUSE_ORPHAN_CONFIRM_MS=0 bun "$RUN_PROJ/seats/adapter.ts" status 2>&1)"; RC=$?
END_MS="$(node -e 'console.log(Date.now())')"
ELAPSED_MS=$((END_MS - START_MS))
if [ $RC -eq 0 ] && [ "$ELAPSED_MS" -lt 2000 ]; then pass "status cost: 6 fixture seats and no candidates completes under 2s (${ELAPSED_MS}ms)"
else fail "status cost: rc=$RC elapsed=${ELAPSED_MS}ms output=$OUT"; fi
RUN_PROJ="$PROJ"; STATE="$PROJ/seats/state.json"; LOG="$PROJ/seats/logs/worker-1.jsonl"; ARGV="$HOME_FIX/.pi-seats-alpha/worker-1/argv.json"

phase "7. host build budget — opt-in PATH shim serializes cargo and allows re-entrant children"
BUDGET_PROJ="$FIX/host-budget-proj"
build_proj "$BUDGET_PROJ" budget
mkdir -p "$BUDGET_PROJ/seats/bin"
cp "$HERE/bin/host-build-shim" "$BUDGET_PROJ/seats/bin/host-build-shim"
ln -sf host-build-shim "$BUDGET_PROJ/seats/bin/cargo"
ln -sf host-build-shim "$BUDGET_PROJ/seats/bin/dotnet"
printf '{"enabled":true}\n' > "$BUDGET_PROJ/seats/host-budget.json"
cat > "$BIN/cargo" <<'CARGO_STUB'
#!/usr/bin/env bash
now_ms(){ node -e 'console.log(Date.now())'; }
printf '%s pid=%s ms=%s args=%s guard=%s jobs=%s\n' start "$$" "$(now_ms)" "$*" "${WHEELHOUSE_BUILD_LOCK_HELD:-}" "${CARGO_BUILD_JOBS:-}" >> "$STUB_CARGO_LOG"
if [ "${STUB_CARGO_REENTER:-}" = 1 ] && [ "${STUB_CARGO_REENTERED:-}" != 1 ]; then
  STUB_CARGO_REENTERED=1 cargo build-child
fi
if [ "${STUB_CARGO_HOLD:-}" = 1 ]; then while :; do :; done; fi
sleep 0.4
printf '%s pid=%s ms=%s args=%s guard=%s jobs=%s\n' end "$$" "$(now_ms)" "$*" "${WHEELHOUSE_BUILD_LOCK_HELD:-}" "${CARGO_BUILD_JOBS:-}" >> "$STUB_CARGO_LOG"
CARGO_STUB
chmod +x "$BIN/cargo"
cat > "$BIN/dotnet" <<'DOTNET_STUB'
#!/usr/bin/env bash
printf 'dotnet pid=%s args=%s node_reuse=%s guard=%s\n' "$$" "$*" "${MSBUILDDISABLENODEREUSE:-unset}" "${WHEELHOUSE_BUILD_LOCK_HELD:-}" >> "$STUB_DOTNET_LOG"
DOTNET_STUB
chmod +x "$BIN/dotnet"
RUN_PROJ="$BUDGET_PROJ"; STATE="$BUDGET_PROJ/seats/state.json"
STUB_CARGO_LOG="$FIX/host-budget-cargo.log" STUB_RUN_CARGO_ON_START=1 STUB_CARGO_REENTER=1 OUT_A="$FIX/budget-a.out" OUT_B="$FIX/budget-b.out" bash -c '
  env -u BEADS_ACTOR HOME="$0" PATH="$1" STUB_CARGO_LOG="$2" STUB_RUN_CARGO_ON_START=1 STUB_CARGO_REENTER=1 bun "$3/seats/adapter.ts" spawn worker-1 > "$4" 2>&1 & p1=$!
  env -u BEADS_ACTOR HOME="$0" PATH="$1" STUB_CARGO_LOG="$2" STUB_RUN_CARGO_ON_START=1 STUB_CARGO_REENTER=1 bun "$3/seats/adapter.ts" probe worker-1 > "$5" 2>&1 & p2=$!
  wait $p1; r1=$?; wait $p2; r2=$?; exit $((r1+r2))
' "$HOME_FIX" "$RUN_PATH" "$FIX/host-budget-cargo.log" "$BUDGET_PROJ" "$FIX/budget-a.out" "$FIX/budget-b.out"
BUDGET_RC=$?
if [ "$BUDGET_RC" -eq 0 ]; then pass "host budget: concurrent spawn/probe both complete through shim"
else fail "host budget: concurrent spawn/probe failed rc=$BUDGET_RC a=$(cat "$FIX/budget-a.out" 2>/dev/null) b=$(cat "$FIX/budget-b.out" 2>/dev/null)"; fi
HOST_LOG="$FIX/host-budget-cargo.log"
if env HOST_LOG="$HOST_LOG" node <<'NODE'
const fs=require('fs'); const lines=fs.readFileSync(process.env.HOST_LOG,'utf8').trim().split(/\n/);
const main=lines.filter(l=>/args=build( |$)/.test(l));
const starts=main.filter(l=>l.startsWith('start')).map(l=>+l.match(/ms=(\d+)/)[1]).sort((a,b)=>a-b);
const ends=main.filter(l=>l.startsWith('end')).map(l=>+l.match(/ms=(\d+)/)[1]).sort((a,b)=>a-b);
const serialized=starts.length===2 && ends.length===2 && starts[1] >= ends[0];
process.exit(serialized ? 0 : 1);
NODE
then pass "host budget: second cargo build starts after first cargo build exits"
else fail "host budget: cargo builds overlapped or log malformed: $(cat "$HOST_LOG" 2>/dev/null)"; fi
if grep -q 'args=build-child guard=1 jobs=8' "$HOST_LOG" 2>/dev/null; then pass "host budget: re-entrant child reaches real cargo without deadlock and inherits caps"
else fail "host budget: re-entrant child did not run with guard/caps: $(cat "$HOST_LOG" 2>/dev/null)"; fi
STUB_DOTNET_LOG="$FIX/host-budget-dotnet.log" HOME="$HOME_FIX" PATH="$BUDGET_PROJ/seats/bin:$RUN_PATH" "$BUDGET_PROJ/seats/bin/dotnet" build -maxcpucount:64 >/dev/null 2>&1; DOTNET_RC=$?
if [ $DOTNET_RC -eq 0 ] && grep -q 'args=build -maxcpucount:8 node_reuse=1 guard=1' "$FIX/host-budget-dotnet.log" 2>/dev/null; then
  pass "host budget: dotnet real tool sees -maxcpucount:8 and MSBUILDDISABLENODEREUSE=1"
else fail "host budget: dotnet caps/env missing rc=$DOTNET_RC log=$(cat "$FIX/host-budget-dotnet.log" 2>/dev/null)"; fi
FAKE_PERL_DIR="$FIX/fake-perl"; mkdir -p "$FAKE_PERL_DIR"; printf '#!/usr/bin/env bash\nexit 1\n' > "$FAKE_PERL_DIR/perl"; chmod +x "$FAKE_PERL_DIR/perl"
PRIM_OUT="$(STUB_CARGO_LOG="$FIX/no-primitive.log" HOME="$HOME_FIX" PATH="$BUDGET_PROJ/seats/bin:$FAKE_PERL_DIR:$BIN:/usr/bin:/bin" "$BUDGET_PROJ/seats/bin/cargo" no-primitive 2>&1)"; PRIM_RC=$?
if [ $PRIM_RC -eq 127 ] && printf '%s\n' "$PRIM_OUT" | grep -q 'STOP: host-build-shim needs a crash-safe flock(2) primitive' && printf '%s\n' "$PRIM_OUT" | grep -q 'Refusing mkdir locks'; then
  pass "host budget: missing lock primitive fails with actionable STOP"
else fail "host budget: missing lock primitive was not actionable rc=$PRIM_RC: $PRIM_OUT"; fi
HOST_KILL_LOG="$FIX/host-budget-kill.log"
STUB_CARGO_LOG="$HOST_KILL_LOG" STUB_CARGO_HOLD=1 HOME="$HOME_FIX" PATH="$BUDGET_PROJ/seats/bin:$RUN_PATH" "$BUDGET_PROJ/seats/bin/cargo" hold >/dev/null 2>&1 & HOLD_PID=$!
if wait_for "$HOST_KILL_LOG" 'args=hold' 5; then
  kill -9 "$HOLD_PID" 2>/dev/null || true
  wait "$HOLD_PID" 2>/dev/null || true
  sleep 0.2
  STUB_CARGO_LOG="$HOST_KILL_LOG" HOME="$HOME_FIX" PATH="$BUDGET_PROJ/seats/bin:$RUN_PATH" "$BUDGET_PROJ/seats/bin/cargo" after-kill >/dev/null 2>&1; AFTER_RC=$?
  if [ $AFTER_RC -eq 0 ] && grep -q 'args=after-kill' "$HOST_KILL_LOG" 2>/dev/null; then pass "host budget: real flock(2) primitive releases lock after SIGKILLed holder"
  else fail "host budget: next build did not acquire after killed holder rc=$AFTER_RC log=$(cat "$HOST_KILL_LOG" 2>/dev/null)"; fi
else fail "host budget: killed-holder setup never acquired lock: $(cat "$HOST_KILL_LOG" 2>/dev/null)"; fi
CONTRACT_OUT="$(WHEELHOUSE_HOST_BUDGET_PARITY_DIR="$FIX/no-parity-dir" HOME="$HOME_FIX" PATH="$BUDGET_PROJ/seats/bin:$RUN_PATH" "$BUDGET_PROJ/seats/bin/cargo" --contract 2>&1)"; CONTRACT_RC=$?
if [ $CONTRACT_RC -eq 0 ] && printf '%s\n' "$CONTRACT_OUT" | grep -q 'lock=.*/.cache/wheelhouse-build.lock jobs=8 test_threads=4 reentry=WHEELHOUSE_BUILD_LOCK_HELD' && printf '%s\n' "$CONTRACT_OUT" | grep -q 'parity=ok scanned='; then
  pass "host budget: cargo --contract prints lock/jobs/test_threads/reentry and parity scan result"
else fail "host budget: cargo --contract mismatch rc=$CONTRACT_RC: $CONTRACT_OUT"; fi
BAD_PARITY="$FIX/parity/fleet-x"; mkdir -p "$BAD_PARITY"; printf '#!/usr/bin/env bash\nprintf "tool=cargo lock=/other jobs=99 test_threads=9 reentry=OTHER\\n"\n' > "$BAD_PARITY/cargo"; chmod +x "$BAD_PARITY/cargo"
CONTRACT_OUT="$(WHEELHOUSE_HOST_BUDGET_PARITY_DIR="$FIX/parity" HOME="$HOME_FIX" PATH="$BUDGET_PROJ/seats/bin:$RUN_PATH" "$BUDGET_PROJ/seats/bin/cargo" --contract 2>&1)"; CONTRACT_RC=$?
if [ $CONTRACT_RC -ne 0 ] && printf '%s\n' "$CONTRACT_OUT" | grep -q 'parity=mismatch'; then pass "host budget: --contract parity scan reports mismatched fleet shims"
else fail "host budget: parity mismatch not reported rc=$CONTRACT_RC: $CONTRACT_OUT"; fi

setup_worktree_cap_repo() { # $1 proj, $2 max, $3 auto
  local proj="$1" max="$2" auto="$3" fakebin wtbase
  fakebin="$proj/fakebin"
  wtbase="$proj/.wheelhouse-worktrees"
  mkdir -p "$wtbase" "$fakebin" "$proj/seats/logs"
  git -C "$proj" init -q
  git -C "$proj" config user.email fixture@example.invalid
  git -C "$proj" config user.name Fixture
  printf base > "$proj/base.txt"; git -C "$proj" add base.txt; git -C "$proj" commit -qm base
  git -C "$proj" branch fleet/closed
  git -C "$proj" branch fleet/closed2
  git -C "$proj" worktree add -q "$wtbase/closed" fleet/closed
  git -C "$proj" worktree add -q "$wtbase/closed2" fleet/closed2
  printf '{"enabled":true,"max_worktrees":%s,"auto_prune":%s}\n' "$max" "$auto" > "$proj/seats/host-budget.json"
  printf '{"commander":{"role":"commander","external":true},"seats":{"worker-1":{"role":"worker","provider":"anthropic","model":"stub","account":{"dir":"%s"}}}}\n' "$HOME_FIX/.pi-seats-budget/worker-1" > "$proj/seats/seats.json"
  printf '{"type":"agent_end"}\n' > "$proj/seats/logs/worker-1.jsonl"
  printf '{"seats":{"worker-1":{"pid":null,"role":"worker","accountDir":"%s","log":"%s","fifo":"%s","sessionId":"s"}}}\n' "$HOME_FIX/.pi-seats-budget/worker-1" "$proj/seats/logs/worker-1.jsonl" "$proj/seats/run/worker-1.stdin" > "$proj/seats/state.json"
  cat > "$fakebin/bun" <<EOF
#!/usr/bin/env bash
if [ "\$1" = "seats/prune.ts" ] && [ "\$2" = "scan" ]; then
  cat <<JSON
[{"category":"merged-worktree","safe":1,"repo":"$proj","path":"$wtbase/closed","branch":"fleet/closed","size_bytes":1,"size_human":"1.0B","action":"worktree","reason":"fixture safe merged worktree"}]
JSON
  exit 0
fi
if [ "\$1" = "seats/prune.ts" ] && [ "\$2" = "prune" ]; then
  rm -rf "$wtbase/closed"
  printf 'PRUNED worktree merged-worktree %s\\nprune summary: touched=1 skipped=0 dry_run=0 reclaimed_bytes=1 reclaimed_human=1.0B\\n' "$wtbase/closed"
  exit 0
fi
exec "$(command -v bun)" "\$@"
EOF
  chmod +x "$fakebin/bun"
}
CAP_UNDER="$FIX/host-budget-cap-under"; build_proj "$CAP_UNDER" cap-under; setup_worktree_cap_repo "$CAP_UNDER" 9 false
OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$CAP_UNDER/fakebin:$RUN_PATH" bun "$CAP_UNDER/seats/adapter.ts" status 2>&1)"; RC=$?
if [ $RC -eq 0 ] && ! printf '%s\n' "$OUT" | grep -q 'HOST-BUDGET worktree cap'; then pass "host budget worktree cap: under cap is silent"
else fail "host budget worktree cap: under cap printed or failed rc=$RC: $OUT"; fi
CAP_OVER="$FIX/host-budget-cap-over"; build_proj "$CAP_OVER" cap-over; setup_worktree_cap_repo "$CAP_OVER" 1 false
OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$CAP_OVER/fakebin:$RUN_PATH" bun "$CAP_OVER/seats/adapter.ts" status 2>&1)"; RC=$?
if [ $RC -eq 0 ] && printf '%s\n' "$OUT" | grep -q 'HOST-BUDGET worktree cap exceeded' && printf '%s\n' "$OUT" | grep -q 'HOST-BUDGET safe merged-worktree' && printf '%s\n' "$OUT" | grep -q 'bun seats/prune.ts prune --from-file seats/logs/prune-worktree-cap-scan.json --yes --categories merged-worktree'; then pass "host budget worktree cap: over cap reports safe rows and exact prune command"
else fail "host budget worktree cap: over cap report missing rc=$RC: $OUT"; fi
CAP_AUTO="$FIX/host-budget-cap-auto"; build_proj "$CAP_AUTO" cap-auto; setup_worktree_cap_repo "$CAP_AUTO" 1 true
OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$CAP_AUTO/fakebin:$RUN_PATH" bun "$CAP_AUTO/seats/adapter.ts" status 2>&1)"; RC=$?
if [ $RC -eq 0 ] && printf '%s\n' "$OUT" | grep -q 'PRUNED worktree merged-worktree' && [ ! -e "$CAP_AUTO/.wheelhouse-worktrees/closed" ]; then pass "host budget worktree cap: auto_prune removes a safe merged worktree"
else fail "host budget worktree cap: auto_prune failed rc=$RC out=$OUT exists=$(test -e "$CAP_AUTO/.wheelhouse-worktrees/closed" && echo yes || echo no)"; fi
OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" bun "$RUN_PROJ/seats/adapter.ts" stop worker-1 2>&1)"; RC=$?
RUN_PROJ="$PROJ"; STATE="$PROJ/seats/state.json"; LOG="$PROJ/seats/logs/worker-1.jsonl"; ARGV="$HOME_FIX/.pi-seats-alpha/worker-1/argv.json"

phase "8. canary — can these checks detect a broken adapter?"
# 7a: an adapter that never records what it spawned
CAN_A="$FIX/can-a"
build_proj "$CAN_A" can-a
sed 's|^  writeState(state); // spawn-record$|  ; // spawn-record|' "$ADAPTER" > "$CAN_A/seats/adapter.ts"
if cmp -s "$ADAPTER" "$CAN_A/seats/adapter.ts"; then
  fail "canary: could not cut the state write — the line no longer matches, so the canary proves nothing"
else
  CANARY_FAILED_BEFORE=$FAILED
  RUN_PROJ="$CAN_A"; STATE="$CAN_A/seats/state.json"
  check_spawn "canary" > /dev/null 2>&1
  if [ $FAILED -gt $CANARY_FAILED_BEFORE ]; then
    FAILED=$CANARY_FAILED_BEFORE
    pass "canary: an adapter that records no state is caught"
  else
    FAILED=$((CANARY_FAILED_BEFORE + 1))
    fail "canary: an adapter with its state write removed PASSED — these checks prove nothing"
  fi
fi

# 7b: an adapter that respawns cold instead of attaching the session
CAN_B="$FIX/can-b"
build_proj "$CAN_B" can-b
sed 's|^    args.push("--session", sessionFile); // resume-attach$|    ; // resume-attach|' "$ADAPTER" > "$CAN_B/seats/adapter.ts"
if cmp -s "$ADAPTER" "$CAN_B/seats/adapter.ts"; then
  fail "canary: could not cut the resume attachment — the line no longer matches, so the canary proves nothing"
else
  RUN_PROJ="$CAN_B"; STATE="$CAN_B/seats/state.json"
  ARGV="$HOME_FIX/.pi-seats-can-b/worker-1/argv.json"
  run spawn worker-1; run stop worker-1
  CANARY_FAILED_BEFORE=$FAILED
  check_resume "canary" > /dev/null 2>&1
  if [ $FAILED -gt $CANARY_FAILED_BEFORE ]; then
    FAILED=$CANARY_FAILED_BEFORE
    pass "canary: an adapter that resumes without the session is caught"
  else
    FAILED=$((CANARY_FAILED_BEFORE + 1))
    fail "canary: an adapter with its --session attachment removed PASSED — these checks prove nothing"
  fi
  run stop worker-1
fi
RUN_PROJ="$PROJ"; STATE="$PROJ/seats/state.json"
ARGV="$HOME_FIX/.pi-seats-alpha/worker-1/argv.json"

phase "9. real pi — one smoke leg, spawn/dispatch/agent_end/resume/grow"
REAL_AUTH="$HOME/.pi/agent/auth.json"
real_auth_is_identity() {
  [ -f "$REAL_AUTH" ] && [ -n "$(tr -d '{}[:space:]' < "$REAL_AUTH" 2>/dev/null)" ]
}
if [ "${WHEELHOUSE_SKIP_REAL_PI:-}" = "1" ]; then
  skip "real-pi leg: WHEELHOUSE_SKIP_REAL_PI=1"
elif [ -z "$REAL_PI" ]; then
  skip "real-pi leg: no pi on PATH (npm install -g @earendil-works/pi-coding-agent)"
elif ! real_auth_is_identity; then
  skip "real-pi leg: $REAL_AUTH missing or empty — run pi, then /login inside the REPL once as yourself"
else
  RPROJ="$FIX/realproj"
  RHOME="$FIX/realhome"
  mkdir -p "$RHOME"
  build_proj "$RPROJ" real
  # The real leg borrows your login: auth (and settings, which may pin your
  # default model) are copied into the temp seat and die with the fixture.
  RSEAT="$RHOME/.pi-seats-real/worker-1"
  mkdir -p "$RSEAT"
  printf '{\n  "%s": true\n}\n' "$RPROJ" > "$RSEAT/trust.json"
  cp "$REAL_AUTH" "$RSEAT/auth.json" && chmod 600 "$RSEAT/auth.json"
  [ -f "$HOME/.pi/agent/settings.json" ] && cp "$HOME/.pi/agent/settings.json" "$RSEAT/settings.json"
  # No --provider/--model pin by default: whatever your login can actually
  # run. When the working login is NOT pi's default provider, pin both
  # (always together — see the roster gotcha in README.md):
  #   WHEELHOUSE_REAL_PI_PROVIDER=... WHEELHOUSE_REAL_PI_MODEL=...
  RPIN=""
  if [ -n "${WHEELHOUSE_REAL_PI_PROVIDER:-}" ] && [ -n "${WHEELHOUSE_REAL_PI_MODEL:-}" ]; then
    RPIN="\"provider\": \"$WHEELHOUSE_REAL_PI_PROVIDER\", \"model\": \"$WHEELHOUSE_REAL_PI_MODEL\", "
  fi
  cat > "$RPROJ/seats/seats.json" <<EOF
{
  "commander": { "role": "commander", "external": true, "runtime": "claude-code" },
  "seats": {
    "worker-1": { "role": "worker", $RPIN"account": { "dir": "$RSEAT" } }
  }
}
EOF
  REAL_PATH="$(dirname "$REAL_PI"):$(dirname "$(command -v bun)"):/usr/bin:/bin"
  rrun() { OUT="$(env HOME="$RHOME" PATH="$REAL_PATH" WHEELHOUSE_RPC_TIMEOUT_MS=90000 bun "$RPROJ/seats/adapter.ts" "$@" 2>&1)"; RC=$?; }
  RSTATE="$RPROJ/seats/state.json"
  RLOG="$RPROJ/seats/logs/worker-1.jsonl"
  rstate_get() { bun -e "const s=require('$RSTATE');const v=s.seats['worker-1']?.['$1'];if(v!=null)console.log(v)"; }
  rassert_state_cwd_is_live_cwd() {
    local label="$1" pid live recorded
    pid="$(rstate_get pid)"
    recorded="$(rstate_get cwd)"
    live="$(live_cwd_for_pid "$pid")"
    if [ -n "$pid" ] && [ -n "$live" ] && [ "$recorded" = "$live" ]; then
      pass "real: $label state.json cwd equals process live cwd"
    else
      fail "real: $label state cwd '$recorded' did not equal live cwd '$live' for pid $pid"
    fi
  }

  mkdir -p "$RPROJ/.wheelhouse-worktrees/smoke-1" "$RPROJ/.wheelhouse-worktrees/smoke-2"
  rrun spawn worker-1
  if [ $RC -eq 0 ]; then pass "real: spawn exits 0 ($OUT)"
  else fail "real: spawn exited ${RC}: $OUT"; fi
  rassert_state_cwd_is_live_cwd "spawn"
  rrun dispatch worker-1 smoke-1 "Reply with exactly the text WHEELHOUSE-SMOKE-OK and nothing else. Use no tools."
  if [ $RC -eq 0 ]; then pass "real: dispatch accepted"
  else fail "real: dispatch exited ${RC}: $OUT"; fi
  if wait_for "$RLOG" '"agent_end"' 180; then pass "real: agent_end captured"
  else fail "real: no agent_end within 180s — tail: $(tail -c 400 "$RLOG" 2>/dev/null)"; fi
  rassert_state_cwd_is_live_cwd "cross-bead dispatch"
  RSESS="$(rstate_get sessionFile)"
  RL_BEFORE=$(wc -l < "$RSESS" | tr -d ' ')
  rrun stop worker-1
  [ $RC -eq 0 ] && pass "real: stop exits 0" || fail "real: stop exited ${RC}: $OUT"
  rrun resume worker-1
  [ $RC -eq 0 ] && pass "real: resume exits 0 ($OUT)" || fail "real: resume exited ${RC}: $OUT"
  rassert_state_cwd_is_live_cwd "resume"
  LOG_MARK=$(wc -c < "$RLOG" | tr -d ' ')
  rrun dispatch worker-1 smoke-2 "Reply with exactly the text OK and nothing else. Use no tools."
  if [ $RC -eq 0 ] && wait_for_from "$RLOG" "$LOG_MARK" '"agent_end"' 180; then
    pass "real: post-resume dispatch reached agent_end"
  else fail "real: post-resume dispatch failed (exit $RC): $OUT"; fi
  RL_AFTER=$(wc -l < "$(rstate_get sessionFile)" | tr -d ' ')
  if [ "$(rstate_get sessionFile)" = "$RSESS" ] && [ "$RL_AFTER" -gt "$RL_BEFORE" ]; then
    pass "real: the SAME session file grew across resume ($RL_BEFORE -> $RL_AFTER lines)"
  else fail "real: session file did not grow, or resume opened a different one"; fi
  rrun stop worker-1
  # The hermetic no-leak phase proves the rule with a sentinel; the real leg
  # must hold the same line for the REAL credential, before the fixture (and
  # the copied auth.json) is deleted: no string value from auth.json may
  # appear in state.json or any log.
  AUTH_LEAK=0
  while IFS= read -r tok; do
    [ -n "$tok" ] || continue
    if grep -qF -- "$tok" "$RSTATE" 2>/dev/null || grep -rqF -- "$tok" "$RPROJ/seats/logs/" 2>/dev/null; then
      AUTH_LEAK=1
    fi
  done < <("$NODE_BIN" -e '
    const fs = require("fs");
    const out = [];
    const walk = (v) => {
      if (typeof v === "string") { if (v.length >= 16 && !v.includes("\n")) out.push(v); }
      else if (v && typeof v === "object") for (const k of Object.keys(v)) walk(v[k]);
    };
    walk(JSON.parse(fs.readFileSync(process.argv[1], "utf8")));
    for (const t of out) process.stdout.write(t + "\n");
  ' "$RSEAT/auth.json")
  if [ "$AUTH_LEAK" -eq 0 ]; then
    pass "real: no auth material in state.json or the logs before fixture deletion"
  else fail "real: a value from the borrowed auth.json appears in state.json or a log"; fi
fi

printf '\n'
if [ $FAILED -eq 0 ]; then
  echo "adapter.ts works on this machine."
  exit 0
fi
echo "$FAILED check(s) failed."
echo "If the failures are in phases 0-6 or the real leg, the adapter broke or"
echo "its output wording moved. If a failure is in the canary, fix this test first."
exit 1
