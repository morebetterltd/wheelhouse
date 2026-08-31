#!/usr/bin/env bash
#
# recover.selftest.sh — after a forced interruption, does recover.ts still
# tell the truth about every seat, on THIS machine?
#
# Mostly hermetic: phases 1-5 and the canaries run against a stub `pi` (the
# same RPC-speaking node script pattern as adapter.selftest.sh) in a temp
# HOME on a private PATH. The stub REWRITES ITS PROCESS TITLE to a bare `pi`
# exactly like the real binary does, so the hermetic suite exercises the
# process shape recover must actually classify: no role brief, no session
# path, no argv at all in ps output — identity comes from open fds (lsof)
# or not at all. Phase 6 then probes the REAL binary, login-free, to
# document that premise against the pi actually installed here: its ps
# title is bare `pi`, and it holds its stdin FIFO where lsof can see it.
# That probe SKIPs (with the reason printed) only when pi is absent.
#
# What is proven:
#   1. SIGKILL a seat mid-turn -> recover classifies DEAD, names the bead,
#      and the resume command it prints re-attaches the SAME session file.
#   2. Commander-restart simulation: a fresh recover process, reading
#      state.json only, classifies RUNNING / DEAD / STALE correctly; a
#      live-but-reused pid (the machine-restart hazard) reads as DEAD; and
#      a live process merely CARRYING the role-brief path in its argv
#      (tail -f spoof) reads as DEAD, not RUNNING.
#   3. Double-resume refusal: a seat whose session is already attached gets
#      REFUSED, not a resume command.
#   4. Orphaned FIFO cleanup: dead seats' FIFOs (and unrecorded ones) are
#      removed and printed; a RUNNING seat's FIFO is kept.
#   5. No duplicate integration: recover's only writes are FIFO removals —
#      state.json byte-identical, no pi spawned, no bd invoked.
#   6. Real-binary premise probe (see above).
#
# The canary phase sabotages COPIES of recover.ts — once with the FIFO
# removal cut out, once with the double-resume attachment check cut out —
# and checks these tests notice. Each sabotage is guarded with cmp: if the
# sed no longer bites, the canary says so instead of proving nothing.
#
# Usage: recover.selftest.sh [path-to-recover.ts]
#
# Exit 0 = recover.ts works here. Non-zero = read the FAIL lines: a failure
# in phases 1-6 means recover broke (or, for phase 6, pi's process shape
# changed under us); a canary failure means these checks cannot be trusted
# to tell you either way.

set -uo pipefail   # deliberately not -e: half these cases are meant to fail

HERE="$(cd "$(dirname "$0")" && pwd)"
RECOVER="${1:-$HERE/recover.ts}"
ADAPTER="$HERE/adapter.ts"
[ -f "$RECOVER" ] || { echo "selftest: not found: $RECOVER" >&2; exit 2; }
[ -f "$ADAPTER" ] || { echo "selftest: not found: $ADAPTER (recover's resume commands point at it)" >&2; exit 2; }
command -v bun >/dev/null 2>&1 || { echo "selftest: bun is required" >&2; exit 2; }
command -v lsof >/dev/null 2>&1 || { echo "selftest: lsof is required (recover's identity mechanism)" >&2; exit 2; }
NODE_BIN="$(command -v node)" || { echo "selftest: node is required for the stub pi" >&2; exit 2; }
REAL_PI="$(command -v pi || true)"

SCRUB="$HERE/evidence-scrub.sh"
[ -x "$SCRUB" ] || { echo "selftest: not executable: $SCRUB" >&2; exit 2; }
# Selftest output is commonly redirected into committed evidence; scrub it as
# it is written so temp dirs, home dirs, and usernames never enter captures.
exec > >("$SCRUB") 2> >("$SCRUB" >&2)

FAILED=0
FIX=""
SLEEP_PID=""
TAIL_PID=""
SPOOF_PID=""
PROBE_PID=""

pass() { printf '  ok    %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; FAILED=$((FAILED + 1)); }
skip() { printf '  SKIP  %s\n' "$*"; }
phase(){ printf '\n%s\n' "$*"; }

cleanup() {
  # The stub retitles itself to `pi`, so pkill -f on the fixture path cannot
  # find it — kill every pid any fixture state.json ever recorded instead.
  local f
  for f in "$FIX"/*/seats/state.json; do
    [ -f "$f" ] || continue
    grep -o '"pid": [0-9]*' "$f" 2>/dev/null | grep -o '[0-9]*' | while read -r p; do
      kill -9 "$p" 2>/dev/null
    done
  done
  [ -n "$SLEEP_PID" ] && kill "$SLEEP_PID" 2>/dev/null
  [ -n "$TAIL_PID" ] && kill "$TAIL_PID" 2>/dev/null
  [ -n "$SPOOF_PID" ] && kill "$SPOOF_PID" 2>/dev/null
  [ -n "$PROBE_PID" ] && kill -9 "$PROBE_PID" 2>/dev/null
  [ -n "$FIX" ] && pkill -f "$FIX" 2>/dev/null
  [ -n "$FIX" ] && rm -rf "$FIX"
  return 0
}
trap cleanup EXIT INT TERM

# --- fixture -----------------------------------------------------------------
FIX="$(mktemp -d)"
FIX="$(cd "$FIX" && pwd -P)"
HOME_FIX="$FIX/home"
BIN="$FIX/bin"
mkdir -p "$HOME_FIX" "$BIN"
# /usr/sbin is where macOS keeps lsof; recover dies honestly without it.
RUN_PATH="$BIN:$(dirname "$(command -v bun)"):$(dirname "$NODE_BIN"):/usr/sbin:/sbin:/usr/bin:/bin"

# Fake bd: if recover ever reaches for the graph, this logs the call and the
# no-bd-calls assertion in phase 5 catches it.
BD_LOG="$FIX/bd-calls.log"
cat > "$BIN/bd" <<EOF
#!/bin/sh
echo "\$@" >> "$BD_LOG"
exit 0
EOF
chmod +x "$BIN/bd"

# The stub pi: same shape as adapter.selftest.sh's — long-lived RPC process,
# records argv, honours PI_CODING_AGENT_DIR, appends to a session file,
# resumes one via --session. Two deliberate matches with the real binary:
# it REWRITES ITS PROCESS TITLE to bare `pi` (so ps carries no argv and any
# command-line-based identity test would misclassify it, exactly as it would
# the real pi), and its stdin stays on the seat FIFO the adapter opened. A
# prompt containing SLOW finishes its turn late — the SIGKILL window.
cat > "$BIN/pi" <<STUB
#!/usr/bin/env node
process.title = "pi"; // the real pi does this too — ps shows NO argv
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
      if (/SLOW/.test(cmd.message)) setTimeout(finish, 3000); else finish();
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

# A fixture project: recover.ts expects to live at <root>/seats/recover.ts
# beside adapter.ts, with state under the same seats/.
PROJ="$FIX/proj"
mkdir -p "$PROJ/seats" "$PROJ/contracts"
cp "$ADAPTER" "$PROJ/seats/adapter.ts"
cp "$RECOVER" "$PROJ/seats/recover.ts"
printf '# Fleet: Worker\n\nfixture brief.\n' > "$PROJ/contracts/WORKER.md"
cat > "$PROJ/seats/seats.json" <<EOF
{
  "commander": { "role": "commander", "external": true, "runtime": "claude-code" },
  "seats": {
    "worker-1": {
      "role": "worker",
      "provider": "anthropic",
      "model": "stub-model-1",
      "account": { "dir": "~/.pi-seats-rec/worker-1" }
    }
  }
}
EOF
SEATDIR="$HOME_FIX/.pi-seats-rec/worker-1"
mkdir -p "$SEATDIR"
printf '{\n  "%s": true\n}\n' "$PROJ" > "$SEATDIR/trust.json"
printf '{"stub":"identity"}\n' > "$SEATDIR/auth.json"

STATE="$PROJ/seats/state.json"
ARGV="$SEATDIR/argv.json"

adapter_run() { OUT="$(env HOME="$HOME_FIX" PATH="$RUN_PATH" bun "$PROJ/seats/adapter.ts" "$@" 2>&1)"; RC=$?; }
recover_run() { OUT="$(env HOME="$HOME_FIX" PATH="$RUN_PATH" bun "$PROJ/seats/recover.ts" 2>&1)"; RC=$?; }
says() { case "$OUT" in *"$1"*) return 0 ;; *) return 1 ;; esac; }
seat_line() { printf '%s\n' "$OUT" | grep "^$1 "; }
state_get() { env HOME="$HOME_FIX" bun -e "const s=require('$STATE');const v=s.seats['$1']?.['$2'];if(v!=null)console.log(v)"; }
pi_count() { ps -axo command= | sed 's/ *$//' | grep -cx pi | tr -d ' '; }

# a pid that is definitely dead (spawned, then reaped)
sleep 0.01 & DEADPID=$!
wait "$DEADPID" 2>/dev/null

phase "1. SIGKILL mid-turn — DEAD, bead named, printed resume re-attaches the same session"
adapter_run spawn worker-1
[ $RC -eq 0 ] || { echo "selftest: fixture spawn failed: $OUT" >&2; exit 2; }
SPAWN_PID="$(state_get worker-1 pid)"
if [ "$(ps -p "$SPAWN_PID" -o command= | sed 's/ *$//')" = "pi" ]; then
  pass "stub mimics the title rewrite: the live seat's ps line is bare 'pi', no argv"
else
  fail "stub did not rewrite its title (ps: '$(ps -p "$SPAWN_PID" -o command=)') — this suite would not be testing the real process shape"
fi
mkdir -p "$PROJ/.wheelhouse-worktrees/bead-98m"
adapter_run dispatch worker-1 bead-98m "SLOW think about it"
[ $RC -eq 0 ] || { echo "selftest: fixture dispatch failed: $OUT" >&2; exit 2; }
# dispatch relaunches into the bead's worktree (the spawn above rooted at
# the project root, not this bead) — a NEW pid, same session file. The pid
# to kill mid-turn is whichever one is actually running now, not the one
# spawn reported before dispatch replaced it.
KPID="$(state_get worker-1 pid)"
SESS="$(state_get worker-1 sessionFile)"
kill -9 "$KPID" 2>/dev/null
i=0; while kill -0 "$KPID" 2>/dev/null && [ $i -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
if ! kill -0 "$KPID" 2>/dev/null; then pass "seat pid $KPID force-killed mid-turn"
else fail "could not kill the stub seat"; fi

recover_run
if [ $RC -eq 0 ]; then pass "recover exits 0"
else fail "recover exited $RC: $OUT"; fi
if seat_line worker-1 | grep -q 'DEAD'; then pass "killed seat classified DEAD"
else fail "worker-1 not classified DEAD: $OUT"; fi
if seat_line worker-1 | grep -q 'bead bead-98m'; then pass "the unfinished bead is named on the seat line"
else fail "lastBead bead-98m not named: $OUT"; fi
if says "resume: bun $PROJ/seats/adapter.ts resume worker-1"; then
  pass "exact resume command printed"
else fail "no exact resume command in output: $OUT"; fi
if says "removed orphaned FIFO: $PROJ/seats/run/worker-1.stdin"; then
  pass "the killed seat's orphaned FIFO was removed and printed"
else fail "orphaned FIFO of the killed seat not cleaned: $OUT"; fi

RESUME_CMD="$(printf '%s\n' "$OUT" | sed -n 's/^  resume: \(.*\)   #.*$/\1/p' | head -1)"
OUT="$(env HOME="$HOME_FIX" PATH="$RUN_PATH" sh -c "$RESUME_CMD" 2>&1)"; RC=$?
if [ $RC -eq 0 ]; then pass "the printed resume command runs clean"
else fail "printed resume command failed (exit $RC): $OUT"; fi
if grep -q "\"--session\",\"$SESS\"" "$ARGV" 2>/dev/null; then
  pass "resume re-attached via --session"
else fail "--session with the recorded file not in pi's argv"; fi
if [ "$(state_get worker-1 sessionFile)" = "$SESS" ] && grep -q '"resumed"' "$SESS"; then
  pass "the SAME session file was re-attached and grew — no acceptance state lost"
else fail "session file changed or did not record the resume"; fi
if [ "$(state_get worker-1 lastBead)" = "bead-98m" ]; then
  pass "lastBead survived the kill/resume cycle"
else fail "lastBead lost across the forced kill"; fi

phase "2. commander-restart simulation — fresh process, state.json only, all classes correct"
sleep 300 & SLEEP_PID=$!; disown 2>/dev/null || true
tail -f "$PROJ/contracts/WORKER.md" >/dev/null 2>&1 & SPOOF_PID=$!; disown 2>/dev/null || true
env HOME="$HOME_FIX" bun -e "
const fs=require('fs');
const s=JSON.parse(fs.readFileSync('$STATE','utf8'));
const w=s.seats['worker-1'];
fs.writeFileSync('$FIX/dead-sess.jsonl','{}\n');
fs.writeFileSync('$FIX/reuse-sess.jsonl','{}\n');
fs.writeFileSync('$FIX/spoof-sess.jsonl','{}\n');
s.seats['worker-dead']={...w,pid:$DEADPID,sessionFile:'$FIX/dead-sess.jsonl',sessionId:'dead',lastBead:'bead-dead'};
s.seats['worker-stale']={...w,pid:null,sessionFile:'$FIX/gone.jsonl',sessionId:'stale',lastBead:'bead-stale'};
s.seats['worker-reuse']={...w,pid:$SLEEP_PID,sessionFile:'$FIX/reuse-sess.jsonl',sessionId:'reuse',lastBead:'bead-reuse'};
s.seats['worker-spoof']={...w,pid:$SPOOF_PID,sessionFile:'$FIX/spoof-sess.jsonl',sessionId:'spoof',lastBead:'bead-spoof'};
fs.writeFileSync('$STATE',JSON.stringify(s,null,2)+'\n');
"
recover_run
if [ $RC -eq 0 ]; then pass "fresh recover process exits 0"
else fail "recover exited $RC: $OUT"; fi
if seat_line worker-1 | grep -q 'RUNNING'; then pass "live seat classified RUNNING (holds its FIFO, despite a bare-pi ps line)"
else fail "worker-1 should be RUNNING: $OUT"; fi
if seat_line worker-dead | grep -q 'DEAD' && says "resume worker-dead"; then
  pass "dead pid with intact session classified DEAD, resume offered"
else fail "worker-dead misclassified: $OUT"; fi
if seat_line worker-stale | grep -q 'STALE' && ! says "resume worker-stale"; then
  pass "entry with no session artifacts classified STALE, no resume offered"
else fail "worker-stale misclassified: $OUT"; fi
if seat_line worker-reuse | grep -q 'DEAD' && seat_line worker-reuse | grep -q 'reused or foreign'; then
  pass "live-but-reused pid classified DEAD and called out (restart hazard)"
else fail "worker-reuse (pid held by 'sleep 300') misclassified: $OUT"; fi
if seat_line worker-spoof | grep -q 'DEAD' && ! seat_line worker-spoof | grep -q 'RUNNING'; then
  pass "argv spoof (tail -f on the role brief) classified DEAD — identity is fds, not command lines"
else fail "worker-spoof (tail -f carrying the brief path in argv) misclassified: $OUT"; fi

phase "3. double-resume refusal — an attached session gets REFUSED, not a command"
env HOME="$HOME_FIX" bun -e "
const fs=require('fs');
const s=JSON.parse(fs.readFileSync('$STATE','utf8'));
const w=s.seats['worker-1'];
s.seats['worker-ghost']={...w,pid:$DEADPID,lastBead:'bead-ghost'};
fs.writeFileSync('$STATE',JSON.stringify(s,null,2)+'\n');
"
recover_run
if seat_line worker-ghost | grep -q 'DEAD'; then pass "ghost sharing a RUNNING seat's session is DEAD"
else fail "worker-ghost not DEAD: $OUT"; fi
if says "REFUSED double-resume" && printf '%s\n' "$OUT" | grep -A1 '^worker-ghost ' | grep -q 'worker-1'; then
  pass "resume REFUSED, naming who holds the session"
else fail "no refusal naming worker-1: $OUT"; fi
if ! says "resume worker-ghost"; then
  pass "no resume command printed for the refused seat"
else fail "a resume command was printed despite the attachment: $OUT"; fi

phase "4. orphaned FIFO cleanup — dead and unrecorded FIFOs go, the live one stays"
mkfifo "$PROJ/seats/run/worker-dead.stdin"
mkfifo "$PROJ/seats/run/bogus.stdin"
recover_run
if says "removed orphaned FIFO: $PROJ/seats/run/worker-dead.stdin" && [ ! -e "$PROJ/seats/run/worker-dead.stdin" ]; then
  pass "dead seat's FIFO removed and printed"
else fail "worker-dead.stdin not cleaned: $OUT"; fi
if says "removed orphaned FIFO: $PROJ/seats/run/bogus.stdin" && [ ! -e "$PROJ/seats/run/bogus.stdin" ]; then
  pass "FIFO with no state entry removed and printed"
else fail "bogus.stdin not cleaned: $OUT"; fi
if [ -p "$PROJ/seats/run/worker-1.stdin" ]; then
  pass "the RUNNING seat's FIFO was left alone"
else fail "worker-1.stdin was removed while the seat is RUNNING"; fi

phase "5. no duplicate integration — recover observes; its only writes are FIFO removals"
cp "$STATE" "$FIX/state.before"
PI_BEFORE="$(pi_count)"
recover_run
if cmp -s "$STATE" "$FIX/state.before"; then
  pass "state.json byte-identical after recover (no lastBead mutation, no re-dispatch record)"
else fail "recover MUTATED state.json: $(diff "$FIX/state.before" "$STATE" | head -5)"; fi
PI_AFTER="$(pi_count)"
if [ "$PI_AFTER" = "$PI_BEFORE" ]; then
  pass "no pi spawned (bare-'pi'-titled process count: $PI_BEFORE before, $PI_AFTER after)"
else fail "pi process count changed: $PI_BEFORE -> $PI_AFTER"; fi
if [ ! -s "$BD_LOG" ]; then
  pass "no bd calls (fake bd on PATH logged nothing)"
else fail "recover called bd: $(cat "$BD_LOG")"; fi

phase "6. real binary — the premise probe: pi's ps title is bare, its FIFO is not hidden"
if [ -z "$REAL_PI" ]; then
  skip "real-binary probe: no pi on PATH (npm install -g @earendil-works/pi-coding-agent) — premise unverified on this machine"
else
  # Login-free: an env API key (value irrelevant — no request is ever made)
  # lets pi start in RPC mode without touching any real identity.
  RPDIR="$FIX/realprobe"
  mkdir -p "$RPDIR/agent"
  mkfifo "$RPDIR/probe.stdin"
  env PI_CODING_AGENT_DIR="$RPDIR/agent" ANTHROPIC_API_KEY="sk-selftest-dummy" \
    bash -c "exec pi --mode rpc --provider anthropic 0<> '$RPDIR/probe.stdin' >> '$RPDIR/probe.log' 2>> '$RPDIR/probe.err'" &
  PROBE_PID=$!; disown 2>/dev/null || true
  # The title rewrite lands only once pi's own code is running, which on a
  # busy machine trails process creation by seconds — poll for it instead of
  # sampling once and calling a slow start a changed premise.
  PS_LINE=""
  i=0
  while [ $i -lt 40 ] && kill -0 "$PROBE_PID" 2>/dev/null; do
    PS_LINE="$(ps -p "$PROBE_PID" -o command= | sed 's/ *$//')"
    [ "$PS_LINE" = "pi" ] && break
    sleep 0.5; i=$((i + 1))
  done
  if kill -0 "$PROBE_PID" 2>/dev/null; then
    pass "real pi started login-free in the RPC shape (pid $PROBE_PID)"
    if [ "$PS_LINE" = "pi" ]; then
      pass "real pi's ps line is exactly 'pi' — NO argv: any command-line identity test is blind here"
    else
      fail "real pi's ps line is '$PS_LINE' after 20s — the title-rewrite premise changed; re-examine recover's identity mechanism AND this suite"
    fi
    if lsof -Fn -p "$PROBE_PID" 2>/dev/null | grep -qF "n$RPDIR/probe.stdin"; then
      pass "real pi holds its stdin FIFO where lsof sees it — the identity mechanism recover relies on"
    else
      fail "lsof does not show the FIFO on the real pi — recover's fd-based identity would misclassify real seats"
    fi
    kill -9 "$PROBE_PID" 2>/dev/null
    PROBE_PID=""
  else
    fail "real pi exited during an RPC-shape launch — probe tail: $(tail -c 300 "$RPDIR/probe.err" 2>/dev/null)"
  fi
fi

phase "7. canary — can these checks detect a broken recover?"
# 7a: a recover that never removes the orphaned FIFO
CAN_A="$FIX/can-a"
mkdir -p "$CAN_A/seats/run"
sed 's|^      fs.unlinkSync(fifoPath); // fifo-clean$|      ; // fifo-clean|' "$RECOVER" > "$CAN_A/seats/recover.ts"
if cmp -s "$RECOVER" "$CAN_A/seats/recover.ts"; then
  fail "canary: could not cut the FIFO removal — the line no longer matches, so the canary proves nothing"
else
  printf '{}\n' > "$CAN_A/sess-a.jsonl"
  cat > "$CAN_A/seats/state.json" <<EOF
{ "seats": { "w": { "pid": $DEADPID, "fifo": "$CAN_A/seats/run/w.stdin", "sessionFile": "$CAN_A/sess-a.jsonl", "lastBead": "bead-a" } } }
EOF
  mkfifo "$CAN_A/seats/run/w.stdin"
  OUT="$(env HOME="$HOME_FIX" PATH="$RUN_PATH" bun "$CAN_A/seats/recover.ts" 2>&1)"; RC=$?
  if [ $RC -ne 0 ]; then
    fail "canary: sabotaged recover crashed (exit $RC) instead of running — inconclusive: $OUT"
  elif [ -p "$CAN_A/seats/run/w.stdin" ]; then
    pass "canary: a recover that skips FIFO cleanup is caught (orphan still on disk)"
  else
    fail "canary: recover with its FIFO removal cut still cleaned up — these checks prove nothing"
  fi
fi

# 7b: a recover with the double-resume attachment check cut out
CAN_B="$FIX/can-b"
mkdir -p "$CAN_B/seats/run"
sed 's|^        const attachedBy = sessionAttachment(name, rec, rows); // attach-check$|        const attachedBy = null; // attach-check|' "$RECOVER" > "$CAN_B/seats/recover.sabotaged.ts"
if cmp -s "$RECOVER" "$CAN_B/seats/recover.sabotaged.ts"; then
  fail "canary: could not cut the attachment check — the line no longer matches, so the canary proves nothing"
else
  cp "$RECOVER" "$CAN_B/seats/recover.ts"
  printf '{}\n' > "$CAN_B/sess-b.jsonl"
  cat > "$CAN_B/seats/state.json" <<EOF
{ "seats": { "ghost": { "pid": $DEADPID, "fifo": "$CAN_B/seats/run/ghost.stdin", "sessionFile": "$CAN_B/sess-b.jsonl", "lastBead": "bead-b" } } }
EOF
  tail -f "$CAN_B/sess-b.jsonl" >/dev/null 2>&1 & TAIL_PID=$!; disown 2>/dev/null || true
  sleep 0.2
  # the REAL recover must refuse: a live process HOLDS the session file open
  OUT="$(env HOME="$HOME_FIX" PATH="$RUN_PATH" bun "$CAN_B/seats/recover.ts" 2>&1)"; RC=$?
  if [ $RC -eq 0 ] && says "REFUSED double-resume"; then
    pass "real recover refuses when a live process holds the session file open (fd path, not argv)"
  else fail "real recover did not refuse the attached session (exit $RC): $OUT"; fi
  OUT="$(env HOME="$HOME_FIX" PATH="$RUN_PATH" bun "$CAN_B/seats/recover.sabotaged.ts" 2>&1)"; RC=$?
  if [ $RC -ne 0 ]; then
    fail "canary: sabotaged recover crashed (exit $RC) instead of running — inconclusive: $OUT"
  elif says "resume ghost" && ! says "REFUSED double-resume"; then
    pass "canary: a recover with the attachment check cut prints the double-resume — and is caught"
  else
    fail "canary: recover with its attachment check cut still refused — these checks prove nothing"
  fi
  kill "$TAIL_PID" 2>/dev/null; TAIL_PID=""
fi

adapter_run stop worker-1

printf '\n'
if [ $FAILED -eq 0 ]; then
  echo "recover.ts works on this machine."
  exit 0
fi
echo "$FAILED check(s) failed."
echo "If the failures are in phases 1-6, recover broke, pi's process shape"
echo "changed, or output wording moved. If a failure is in the canary, fix"
echo "this test first."
exit 1
