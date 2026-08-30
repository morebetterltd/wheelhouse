#!/usr/bin/env bash
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
[ -f "$ADAPTER" ] || { echo "selftest: not found: $ADAPTER" >&2; exit 2; }
command -v bun >/dev/null 2>&1 || { echo "selftest: bun is required to run adapter.ts" >&2; exit 2; }
NODE_BIN="$(command -v node)" || { echo "selftest: node is required for the stub pi" >&2; exit 2; }
REAL_PI="$(command -v pi || true)"

FAILED=0
FIX=""

pass() { printf '  ok    %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; FAILED=$((FAILED + 1)); }
skip() { printf '  SKIP  %s\n' "$*"; }
phase(){ printf '\n%s\n' "$*"; }

cleanup() {
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
FIX="$(mktemp -d)"
FIX="$(cd "$FIX" && pwd -P)"
HOME_FIX="$FIX/home"
BIN="$FIX/bin"
mkdir -p "$HOME_FIX" "$BIN"
RUN_PATH="$BIN:$(dirname "$(command -v bun)"):$(dirname "$NODE_BIN"):/usr/bin:/bin"

# The stub pi: a long-lived RPC process. It records argv, honours
# PI_CODING_AGENT_DIR, answers get_state/prompt/steer, appends to a session
# file, resumes one via --session, and dies cleanly on SIGTERM. A prompt
# containing SLOW finishes its turn late, so steer has a mid-turn to land in.
cat > "$BIN/pi" <<STUB
#!/usr/bin/env node
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const agentDir = process.env.PI_CODING_AGENT_DIR;
if (!agentDir) { process.stderr.write("stub pi: no PI_CODING_AGENT_DIR\n"); process.exit(1); }
const args = process.argv.slice(2);
fs.mkdirSync(agentDir, { recursive: true });
fs.writeFileSync(path.join(agentDir, "argv.json"), JSON.stringify(args));
const sessDir = path.join(agentDir, "sessions");
fs.mkdirSync(sessDir, { recursive: true });
let sessionFile, sessionId;
const si = args.indexOf("--session");
if (si !== -1) {
  sessionFile = args[si + 1];
  sessionId = path.basename(sessionFile, ".jsonl");
  fs.appendFileSync(sessionFile, JSON.stringify({ type: "resumed" }) + "\n");
} else {
  sessionId = crypto.randomUUID();
  sessionFile = path.join(sessDir, sessionId + ".jsonl");
  fs.writeFileSync(sessionFile, JSON.stringify({ type: "session-start" }) + "\n");
}
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
function handle(cmd) {
  const id = cmd.id;
  switch (cmd.type) {
    case "get_state":
      out({ id, type: "response", command: "get_state", success: true,
            data: { isStreaming: false, sessionFile, sessionId, messageCount: 0 } });
      break;
    case "prompt": {
      out({ id, type: "response", command: "prompt", success: true });
      out({ type: "agent_start" });
      const finish = () => {
        fs.appendFileSync(sessionFile, JSON.stringify({ type: "prompt", message: cmd.message }) + "\n");
        out({ type: "message_end", message: { role: "assistant",
              content: [{ type: "text", text: "echo: " + cmd.message }] } });
        out({ type: "agent_end", messages: [] });
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
process.on("SIGTERM", () => process.exit(0));
STUB
chmod +x "$BIN/pi"
[ -x "$BIN/pi" ] || { echo "selftest: fixture stub pi was not created" >&2; exit 2; }

# A fixture project: adapter.ts expects to live at <root>/seats/adapter.ts
# with crew briefs at <root>/contracts/. build_proj makes one; the canaries
# make more, each with its own seat namespace so nothing collides.
SENTINEL='SENTINEL-TOKEN-4a7f'
build_proj() {   # $1 = project dir, $2 = seat namespace
  local proj="$1" ns="$2" seatdir
  mkdir -p "$proj/seats" "$proj/contracts"
  cp "$ADAPTER" "$proj/seats/adapter.ts"
  printf '# Fleet: Worker\n\nfixture brief — the stub never reads it, the argv check does.\n' \
    > "$proj/contracts/WORKER.md"
  cat > "$proj/seats/seats.json" <<EOF
{
  "commander": { "role": "commander", "external": true, "runtime": "claude-code" },
  "seats": {
    "worker-1": {
      "role": "worker",
      "provider": "anthropic",
      "model": "stub-model-1",
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

PROJ="$FIX/proj"
build_proj "$PROJ" alpha

run() { OUT="$(env HOME="$HOME_FIX" PATH="$RUN_PATH" bun "$RUN_PROJ/seats/adapter.ts" "$@" 2>&1)"; RC=$?; }
says() { case "$OUT" in *"$1"*) return 0 ;; *) return 1 ;; esac; }
RUN_PROJ="$PROJ"

STATE="$PROJ/seats/state.json"
LOG="$PROJ/seats/logs/worker-1.jsonl"
ARGV="$HOME_FIX/.pi-seats-alpha/worker-1/argv.json"
state_get() { env HOME="$HOME_FIX" bun -e "const s=require('$STATE');const v=s.seats['worker-1']?.['$1'];if(v!=null)console.log(v)"; }

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

# --- the spawn checks, parameterized so the canary can reuse them ------------
check_spawn() {   # $1 = label
  local label="$1" pid
  run spawn worker-1
  if [ $RC -eq 0 ]; then pass "$label: spawn exits 0"
  else fail "$label: spawn exited $RC: $OUT"; fi

  pid="$(state_get pid)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    pass "$label: state.json records a live pid"
  else fail "$label: state.json has no live pid for worker-1"; fi

  if [ -n "$(state_get sessionFile)" ] && [ -f "$(state_get sessionFile)" ]; then
    pass "$label: state.json records a session file that exists"
  else fail "$label: no session file recorded, or it does not exist"; fi
}

phase "1. spawn — process, identity, and what was actually launched"
check_spawn "spawn"
if [ -f "$ARGV" ] && grep -q '"--mode","rpc"' "$ARGV"; then
  pass "pi was launched in RPC mode"
else fail "argv.json missing or pi not launched with --mode rpc"; fi
if grep -q "\"--append-system-prompt\",\"$PROJ/contracts/WORKER.md\"" "$ARGV" 2>/dev/null; then
  pass "role brief injected: --append-system-prompt names contracts/WORKER.md"
else fail "role brief not passed, or not the worker's brief"; fi
if grep -q '"--provider","anthropic","--model","stub-model-1"' "$ARGV" 2>/dev/null; then
  pass "roster's provider and model pin the launch"
else fail "provider/model from seats.json did not reach pi's argv"; fi
run spawn worker-1
if [ $RC -ne 0 ] && says "already running"; then
  pass "a second spawn of a live seat is refused"
else fail "spawning an already-running seat did not stop (exit $RC)"; fi

phase "2. dispatch — prompt round trip lands in log and session"
SESS="$(state_get sessionFile)"
SESS_LINES_BEFORE=$(wc -l < "$SESS" | tr -d ' ')
run dispatch worker-1 bead-x "hello adapter"
if [ $RC -eq 0 ]; then pass "dispatch exits 0"
else fail "dispatch exited $RC: $OUT"; fi
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

phase "3. steer — a redirect lands inside a turn still in flight"
run dispatch worker-1 bead-y "SLOW long think"
run steer worker-1 "change course"
if [ $RC -eq 0 ]; then pass "steer exits 0"
else fail "steer exited $RC: $OUT"; fi
if wait_for "$LOG" 'steered: change course' 5; then
  pass "the steer reached the seat mid-turn"
else fail "steer text never surfaced in the event log"; fi
wait_for "$LOG" 'echo: Bead bead-y' 5 >/dev/null   # let the slow turn finish

phase "4. state survives the adapter — every invocation is a fresh process"
run status
if [ $RC -eq 0 ] && says "worker-1" && says "RUNNING"; then
  pass "a fresh status invocation reads worker-1 as RUNNING from state.json"
else fail "status did not survive adapter restart (exit $RC): $OUT"; fi

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

check_resume() {   # $1 = label; expects a stopped seat with a recorded session
  local label="$1" sess
  sess="$(state_get sessionFile)"
  run resume worker-1
  if [ $RC -eq 0 ]; then pass "$label: resume exits 0"
  else fail "$label: resume exited $RC: $OUT"; fi
  if grep -q "\"--session\",\"$sess\"" "$ARGV" 2>/dev/null; then
    pass "$label: relaunch attached the recorded session via --session"
  else fail "$label: --session with the recorded file is not in pi's argv"; fi
}
SESS_LINES_BEFORE=$(wc -l < "$SESS" | tr -d ' ')
check_resume "resume"
if grep -q '"resumed"' "$SESS" && [ "$(wc -l < "$SESS" | tr -d ' ')" -gt "$SESS_LINES_BEFORE" ]; then
  pass "the same session file grew on resume — warm context survives"
else fail "session file unchanged after resume"; fi
if [ "$(state_get lastBead)" = "bead-y" ]; then
  pass "lastBead survives the stop/resume cycle"
else fail "lastBead was lost across resume"; fi
run stop worker-1

phase "7. canary — can these checks detect a broken adapter?"
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

phase "8. real pi — one smoke leg, spawn/dispatch/agent_end/resume/grow"
REAL_AUTH="$HOME/.pi/agent/auth.json"
real_auth_is_identity() {
  [ -f "$REAL_AUTH" ] && [ -n "$(tr -d '{}[:space:]' < "$REAL_AUTH" 2>/dev/null)" ]
}
if [ "${WHEELHOUSE_SKIP_REAL_PI:-}" = "1" ]; then
  skip "real-pi leg: WHEELHOUSE_SKIP_REAL_PI=1"
elif [ -z "$REAL_PI" ]; then
  skip "real-pi leg: no pi on PATH (npm install -g @earendil-works/pi-coding-agent)"
elif ! real_auth_is_identity; then
  skip "real-pi leg: $REAL_AUTH missing or empty — run pi /login once as yourself"
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
  # No --provider/--model pin: whatever your login can actually run.
  cat > "$RPROJ/seats/seats.json" <<EOF
{
  "commander": { "role": "commander", "external": true, "runtime": "claude-code" },
  "seats": {
    "worker-1": { "role": "worker", "account": { "dir": "$RSEAT" } }
  }
}
EOF
  REAL_PATH="$(dirname "$REAL_PI"):$(dirname "$(command -v bun)"):/usr/bin:/bin"
  rrun() { OUT="$(env HOME="$RHOME" PATH="$REAL_PATH" WHEELHOUSE_RPC_TIMEOUT_MS=90000 bun "$RPROJ/seats/adapter.ts" "$@" 2>&1)"; RC=$?; }
  RSTATE="$RPROJ/seats/state.json"
  RLOG="$RPROJ/seats/logs/worker-1.jsonl"
  rstate_get() { bun -e "const s=require('$RSTATE');const v=s.seats['worker-1']?.['$1'];if(v!=null)console.log(v)"; }

  rrun spawn worker-1
  if [ $RC -eq 0 ]; then pass "real: spawn exits 0 ($OUT)"
  else fail "real: spawn exited $RC: $OUT"; fi
  rrun dispatch worker-1 smoke-1 "Reply with exactly the text WHEELHOUSE-SMOKE-OK and nothing else. Use no tools."
  if [ $RC -eq 0 ]; then pass "real: dispatch accepted"
  else fail "real: dispatch exited $RC: $OUT"; fi
  if wait_for "$RLOG" '"agent_end"' 180; then pass "real: agent_end captured"
  else fail "real: no agent_end within 180s — tail: $(tail -c 400 "$RLOG" 2>/dev/null)"; fi
  RSESS="$(rstate_get sessionFile)"
  RL_BEFORE=$(wc -l < "$RSESS" | tr -d ' ')
  rrun stop worker-1
  [ $RC -eq 0 ] && pass "real: stop exits 0" || fail "real: stop exited $RC: $OUT"
  rrun resume worker-1
  [ $RC -eq 0 ] && pass "real: resume exits 0 ($OUT)" || fail "real: resume exited $RC: $OUT"
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
fi

printf '\n'
if [ $FAILED -eq 0 ]; then
  echo "adapter.ts works on this machine."
  exit 0
fi
echo "$FAILED check(s) failed."
echo "If the failures are in phases 1-6 or the real leg, the adapter broke or"
echo "its output wording moved. If a failure is in the canary, fix this test first."
exit 1
