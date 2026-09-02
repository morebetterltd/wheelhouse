#!/usr/bin/env bash
#
# reset.selftest.sh — does adapter.ts's `reset` verb do what seats/README.md
# and contracts/SEATS.md's Lifecycle section claim, on THIS machine?
#
# Hermetic: a stub `pi` — a small node script speaking the RPC protocol,
# extended past adapter.selftest.sh's stub with a real isStreaming flag so
# `reset`'s mid-turn refusal has something honest to check — in a temp HOME
# on a private PATH. Your real seats and your real pi are never touched.
# spawn/dispatch/stop/resume themselves are adapter.selftest.sh's job; this
# file only exercises what `reset` adds: refuse loudly while a turn is in
# flight, and stop+discard+cold-spawn when idle. No real-pi leg here — the
# real binary's spawn/stop/resume path is already smoke-tested by
# adapter.selftest.sh, and `reset` is built entirely out of that same code
# path plus one get_state check, so a second real-pi leg would prove nothing
# reset-specific that the mocked isStreaming check doesn't already cover.
#
# Usage: reset.selftest.sh [path-to-adapter.ts]
#
# Exit 0 = reset works here. Non-zero = read the FAIL lines: a failure in
# phases 1-3 means reset broke; a canary failure means these checks cannot
# be trusted to tell you either way.

set -uo pipefail   # deliberately not -e: half these cases are meant to fail

HERE="$(cd "$(dirname "$0")" && pwd)"
ADAPTER="${1:-$HERE/adapter.ts}"
BRIEFS="$(cd "$(dirname "$ADAPTER")" && pwd)/briefs.ts"
[ -f "$ADAPTER" ] || { echo "selftest: not found: $ADAPTER" >&2; exit 2; }
[ -f "$BRIEFS" ] || { echo "selftest: not found: $BRIEFS" >&2; exit 2; }
command -v bun >/dev/null 2>&1 || { echo "selftest: bun is required to run adapter.ts" >&2; exit 2; }
NODE_BIN="$(command -v node)" || { echo "selftest: node is required for the stub pi" >&2; exit 2; }

SCRUB="$HERE/evidence-scrub.sh"
[ -x "$SCRUB" ] || { echo "selftest: not executable: $SCRUB" >&2; exit 2; }
# Selftest output is commonly redirected into committed evidence; scrub it as
# it is written so temp dirs, home dirs, and usernames never enter captures.
exec > >("$SCRUB") 2> >("$SCRUB" >&2)

FAILED=0
FIX=""

pass() { printf '  ok    %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; FAILED=$((FAILED + 1)); }
phase(){ printf '\n%s\n' "$*"; }

cleanup() {
  # Seats spawned from the fixture carry the fixture path in their argv
  # (their role brief lives there); kill any that outlived their phase.
  [ -n "$FIX" ] && pkill -f "$FIX" 2>/dev/null
  [ -n "$FIX" ] && rm -rf "$FIX"
  return 0
}
trap cleanup EXIT INT TERM

# --- stale-fixture sweep -----------------------------------------------------
# The EXIT trap above cannot run on SIGKILL, so a killed selftest leaves its
# fixture dir — and possibly a live detached seat — behind. Fixture dirs are
# pid-stamped so a later run can tell a dead owner from a live one. Same
# fd-based identity rule recover.ts and adapter.selftest.sh use: a pid number
# alone proves nothing after reuse.
FIX_PREFIX="wheelhouse-reset-selftest"
sweep_stale_fixtures() {
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
RUN_PATH="$BIN:$(dirname "$(command -v bun)"):$(dirname "$NODE_BIN"):/usr/bin:/bin"

# The stub pi: same RPC shape as adapter.selftest.sh's stub, plus a real
# `streaming` flag so get_state's isStreaming answers honestly instead of
# always false — reset's mid-turn refusal has nothing to check otherwise. A
# prompt containing SLOW keeps `streaming` true for 1.5s so reset has a
# mid-turn to land in, the same trick adapter.selftest.sh's stub uses for
# steer.
cat > "$BIN/pi" <<STUB
#!/usr/bin/env node
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const agentDir = process.env.PI_CODING_AGENT_DIR;
if (!agentDir) { process.stderr.write("stub pi: no PI_CODING_AGENT_DIR\n"); process.exit(1); }
const args = process.argv.slice(2);
fs.mkdirSync(agentDir, { recursive: true });
fs.writeFileSync(path.join(agentDir, "argv.json"), JSON.stringify(args));
fs.writeFileSync(path.join(agentDir, "cwd.txt"), process.cwd());
fs.writeFileSync(path.join(agentDir, "env.json"), JSON.stringify({ BEADS_ACTOR: process.env.BEADS_ACTOR ?? null }));
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
let streaming = false;
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
function handle(cmd) {
  const id = cmd.id;
  switch (cmd.type) {
    case "get_state":
      out({ id, type: "response", command: "get_state", success: true,
            data: { isStreaming: streaming, sessionFile, sessionId, messageCount: 0 } });
      break;
    case "prompt": {
      streaming = true;
      out({ id, type: "response", command: "prompt", success: true });
      out({ type: "agent_start" });
      const finish = () => {
        fs.appendFileSync(sessionFile, JSON.stringify({ type: "prompt", message: cmd.message }) + "\n");
        out({ type: "message_end", message: { role: "assistant",
              content: [{ type: "text", text: "echo: " + cmd.message }] } });
        out({ type: "agent_end", messages: [] });
        streaming = false;
      };
      if (/SLOW/.test(cmd.message)) setTimeout(finish, 1500); else finish();
      break;
    }
    default:
      out({ id, type: "response", command: cmd.type, success: false, error: "stub: unknown " + cmd.type });
  }
}
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

SENTINEL='SENTINEL-TOKEN-RESET'
build_proj() {   # $1 = project dir, $2 = seat namespace
  local proj="$1" ns="$2" seatdir
  mkdir -p "$proj/seats" "$proj/contracts"
  cp "$ADAPTER" "$proj/seats/adapter.ts"
  cp "$BRIEFS" "$proj/seats/briefs.ts"
  printf '# Fleet: Worker\n\nfixture brief.\n' > "$proj/contracts/WORKER.md"
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

PROJ="$FIX/proj"
build_proj "$PROJ" alpha

# BEADS_ACTOR unset on purpose, same reasoning as adapter.selftest.sh: reset
# must set it in the cold-respawned seat's own env by construction, not by
# forwarding whatever this shell happened to have.
run() { OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" bun "$RUN_PROJ/seats/adapter.ts" "$@" 2>&1)"; RC=$?; }
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

mkdir -p "$PROJ/.wheelhouse-worktrees/bead-x"

# --- the reset checks, parameterized so the canary can reuse them -----------
check_reset_midturn_refused() {   # $1 = label
  local label="$1" pid_before sess_before
  run spawn worker-1
  [ $RC -eq 0 ] || { fail "$label: setup spawn failed (exit $RC): $OUT"; return; }
  run dispatch worker-1 bead-x "SLOW long think"
  [ $RC -eq 0 ] || { fail "$label: setup dispatch failed (exit $RC): $OUT"; return; }
  wait_for "$LOG" '"agent_start"' 5 >/dev/null
  pid_before="$(state_get pid)"
  sess_before="$(state_get sessionFile)"
  run reset worker-1
  if [ $RC -ne 0 ] && says "mid-turn"; then
    pass "$label: reset refuses a seat that is mid-turn"
  else fail "$label: reset did not refuse a mid-turn seat (exit $RC): $OUT"; fi
  if [ "$(state_get pid)" = "$pid_before" ] && kill -0 "$pid_before" 2>/dev/null; then
    pass "$label: the seat is left running untouched by a refused reset"
  else fail "$label: a refused reset still touched the running seat (pid was $pid_before, now $(state_get pid))"; fi
  if [ "$(state_get sessionFile)" = "$sess_before" ]; then
    pass "$label: session record is unchanged by a refused reset"
  else fail "$label: a refused reset still changed the recorded session"; fi
  wait_for "$LOG" 'echo: Bead bead-x' 5 >/dev/null   # let the slow turn finish
  run stop worker-1
}

phase "1. reset refuses a seat mid-turn"
check_reset_midturn_refused "mid-turn"

phase "2. reset on an idle seat: stop, discard session, cold respawn"
run spawn worker-1
[ $RC -eq 0 ] || fail "setup: spawn before idle-reset failed (exit $RC): $OUT"
run dispatch worker-1 bead-x "hello before reset"
[ $RC -eq 0 ] || fail "setup: warm-up dispatch failed (exit $RC): $OUT"
wait_for "$LOG" 'echo: Bead bead-x' 5 >/dev/null
PID_BEFORE="$(state_get pid)"
SESS_BEFORE="$(state_get sessionFile)"
run reset worker-1
if [ $RC -eq 0 ]; then pass "reset exits 0 on an idle seat"
else fail "reset exited $RC on an idle seat: $OUT"; fi
PID_AFTER="$(state_get pid)"
if [ -n "$PID_AFTER" ] && [ "$PID_AFTER" != "$PID_BEFORE" ] && kill -0 "$PID_AFTER" 2>/dev/null; then
  pass "reset relaunched the seat under a new pid"
else fail "reset did not relaunch cleanly (pid was $PID_BEFORE, now $PID_AFTER)"; fi
SESS_AFTER="$(state_get sessionFile)"
if [ -n "$SESS_AFTER" ] && [ "$SESS_AFTER" != "$SESS_BEFORE" ]; then
  pass "reset's respawn produced a fresh session file, not the old one"
else fail "reset kept the same session file — the cache was not discarded"; fi
if [ -f "$SESS_BEFORE" ]; then
  pass "the discarded session file is left on disk, not deleted"
else fail "reset deleted the old session file — it should be discarded from state, not destroyed"; fi
if ! grep -q '"--session"' "$ARGV" 2>/dev/null; then
  pass "the post-reset spawn did not pass --session — it came back cold"
else fail "the post-reset spawn still attached --session — reset did not go cold"; fi
if grep -q '"BEADS_ACTOR":"worker-1"' "${ARGV%argv.json}env.json" 2>/dev/null; then
  pass "reset's cold respawn carries BEADS_ACTOR=worker-1, with no operator export"
else fail "reset's respawned seat env.json was $(cat "${ARGV%argv.json}env.json" 2>/dev/null) — expected BEADS_ACTOR:worker-1"; fi
run stop worker-1

phase "3. reset on a seat that is not running"
run reset worker-1
if [ $RC -ne 0 ] && says "not running"; then
  pass "reset on a stopped seat is refused the same way dispatch/steer are"
else fail "reset on a stopped seat did not refuse (exit $RC): $OUT"; fi

phase "4. canary — can the mid-turn check detect a reset with the refusal removed?"
CAN="$FIX/can-a"
build_proj "$CAN" can-a
sed 's|^  if (st.data?.isStreaming) {$|  if (false \&\& st.data?.isStreaming) {|' "$ADAPTER" > "$CAN/seats/adapter.ts"
if cmp -s "$ADAPTER" "$CAN/seats/adapter.ts"; then
  fail "canary: could not cut the isStreaming refusal — the line no longer matches, so the canary proves nothing"
else
  RUN_PROJ="$CAN"; STATE="$CAN/seats/state.json"; LOG="$CAN/seats/logs/worker-1.jsonl"
  ARGV="$HOME_FIX/.pi-seats-can-a/worker-1/argv.json"
  mkdir -p "$CAN/.wheelhouse-worktrees/bead-x"
  CANARY_FAILED_BEFORE=$FAILED
  check_reset_midturn_refused "canary" > /dev/null 2>&1
  if [ $FAILED -gt $CANARY_FAILED_BEFORE ]; then
    FAILED=$CANARY_FAILED_BEFORE
    pass "canary: a reset with its mid-turn refusal cut is caught"
  else
    FAILED=$((CANARY_FAILED_BEFORE + 1))
    fail "canary: a reset with its mid-turn refusal cut PASSED — this check proves nothing"
  fi
  run stop worker-1 >/dev/null 2>&1
fi
RUN_PROJ="$PROJ"; STATE="$PROJ/seats/state.json"; LOG="$PROJ/seats/logs/worker-1.jsonl"
ARGV="$HOME_FIX/.pi-seats-alpha/worker-1/argv.json"

printf '\n'
if [ $FAILED -eq 0 ]; then
  echo "adapter.ts reset works on this machine."
  exit 0
fi
echo "$FAILED check(s) failed."
echo "If the failures are in phases 1-3, reset broke. If a failure is in the"
echo "canary, fix this test first."
exit 1
