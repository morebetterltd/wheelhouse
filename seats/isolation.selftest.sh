#!/usr/bin/env bash
#
# isolation.selftest.sh — can one project's seat machinery reach another
# project's beads, worktree, or evidence? (It must not — and this test says
# exactly WHY it does not, which is not "the OS forbids it".)
#
# Hermetic: two complete fixture projects, A and B, each with its own seat
# namespace root ($HOME/.pi-seats-<ns>), roster, graph dir (.beads), and
# worktrees dir, all in a temp HOME on a private PATH with a stub `pi` and a
# logging fake `bd`. Only A's machinery ever RUNS; B exists to be reached
# for. Your real seats, pi, and bd are never touched or required.
#
# Three kinds of legs:
#
#   CONFIG   the isolation is written down where claimed: disjoint seat
#            roots per namespace, trust granted per project root and only
#            there, no B path in any A config, and every write surface in
#            the code derived from the project's own root.
#   NEGATIVE the machinery, run hard on A (spawn, dispatch, status, stop,
#            resume, a bead-graph call), leaves B byte-identical — and the
#            doors that could smuggle a foreign path in (seat names,
#            bead-id arguments) refuse or carry it as inert data.
#   HONESTY  a HOSTILE seat process, told where B lives, tries to write
#            there — and on a same-user, unsandboxed machine it SUCCEEDS.
#            The test records that truthfully instead of pretending the OS
#            is a wall. See THE BOUNDARY below.
#
# THE BOUNDARY, stated once and printed by the test:
#   Isolation between projects is by construction and contract, not OS
#   enforcement: every path the wheelhouse machinery writes is derived from
#   the project's own root and its namespaced seat root, and path-shaped
#   arguments are refused — but the processes all run as one user with no
#   sandbox, so the operating system does not forbid a hostile or
#   compromised seat from writing into another project. This selftest
#   proves no wheelhouse code path takes a foreign path even when handed
#   one; it also proves, honestly, that the OS would permit one.
#
# Canaries sabotage COPIES (an adapter whose log dir points into B; a seat
# whose bd call runs from B's root) and check these tests notice; each sed
# is cmp-guarded so a canary that no longer bites says so.
#
# Usage: isolation.selftest.sh [path-to-seats-dir]
#
# Exit 0 = isolation holds here, on the stated terms. Non-zero = read the
# FAIL lines; a canary failure means these checks cannot be trusted either way.

set -uo pipefail   # deliberately not -e: several cases are meant to fail

HERE="$(cd "$(dirname "$0")" && pwd)"
SEATS_SRC="${1:-$HERE}"
ADAPTER="$SEATS_SRC/adapter.ts"
SEAT_ENV="$SEATS_SRC/seat-env.sh"
[ -f "$ADAPTER" ]  || { echo "selftest: not found: $ADAPTER" >&2; exit 2; }
[ -f "$SEAT_ENV" ] || { echo "selftest: not found: $SEAT_ENV" >&2; exit 2; }
command -v bun >/dev/null 2>&1 || { echo "selftest: bun is required" >&2; exit 2; }
NODE_BIN="$(command -v node)" || { echo "selftest: node is required for the stub pi" >&2; exit 2; }

FAILED=0
FIX=""

pass() { printf '  ok    %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; FAILED=$((FAILED + 1)); }
note() { printf '  note  %s\n' "$*"; }
phase(){ printf '\n%s\n' "$*"; }

cleanup() {
  [ -n "$FIX" ] && pkill -f "$FIX" 2>/dev/null
  [ -n "$FIX" ] && rm -rf "$FIX"
  return 0
}
trap cleanup EXIT INT TERM

# --- stale-fixture sweep (same rule as the sibling selftests) ----------------
FIX_PREFIX="wheelhouse-isolation-selftest"
sweep_stale_fixtures() {
  local base="${TMPDIR:-/tmp}" d stamp phys sf spid
  while IFS= read -r d; do
    [ -d "$d" ] || continue
    stamp="${d##*/}"; stamp="${stamp#"$FIX_PREFIX".}"; stamp="${stamp%%.*}"
    case "$stamp" in ''|*[!0-9]*) continue ;; esac
    kill -0 "$stamp" 2>/dev/null && continue
    phys="$(cd "$d" 2>/dev/null && pwd -P)" || phys="$d"
    while IFS= read -r sf; do
      [ -f "$sf" ] || continue
      for spid in $(sed -n 's/.*"pid": \([0-9][0-9]*\).*/\1/p' "$sf"); do
        if kill -0 "$spid" 2>/dev/null && lsof -p "$spid" 2>/dev/null | grep -qF "$phys"; then
          kill "$spid" 2>/dev/null
          echo "swept: killed leaked seat pid $spid (held open files under $d)"
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

# --- the stub pi -------------------------------------------------------------
# The adapter.selftest stub (RPC over stdin, LF-only), plus two behaviors this
# test needs: a prompt containing GRAPH makes the seat call `bd` (which is the
# fake below) from its own cwd — the cwd the ADAPTER chose — and a prompt
# containing XPROBE makes the seat HOSTILE: it attempts four cross-project
# writes at the paths in WH_XPROBE_* and reports each outcome, because the
# honesty leg needs a real attempt, not an assumption.
cat > "$BIN/pi" <<'STUB'
#!/usr/bin/env node
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const cp = require("child_process");
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
function xprobe() {
  // A hostile seat: mkdir + write, the way an attacker would, so the report
  // reflects what a same-user process can actually do — not a permissions
  // accident of a missing parent directory.
  const report = process.env.WH_XPROBE_REPORT;
  const attempts = [
    ["append-B-log",      process.env.WH_XPROBE_BLOG,   (p) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.appendFileSync(p, "hostile append\n"); }],
    ["write-B-state",     process.env.WH_XPROBE_BSTATE, (p) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, "{\"hostile\":true}\n"); }],
    ["create-in-B-worktree", process.env.WH_XPROBE_BWT, (p) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, "hostile file\n"); }],
    ["touch-B-graph",     process.env.WH_XPROBE_BGRAPH, (p) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, "hostile graph write\n"); }],
  ];
  for (const [label, target, act] of attempts) {
    let line;
    try { act(target); line = "OK   " + label + " " + target; }
    catch (e) { line = "FAIL " + label + " " + target + " (" + (e.code || e.message) + ")"; }
    fs.appendFileSync(report, line + "\n");
  }
}
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
      if (/XPROBE/.test(cmd.message)) xprobe();
      if (/GRAPH/.test(cmd.message)) {
        const cwd = process.env.WH_CANARY_BD_CWD || process.cwd();
        try { cp.execFileSync("bd", ["update", "dummy-bead", "--note", "from-seat"], { cwd }); } catch (e) {}
      }
      fs.appendFileSync(sessionFile, JSON.stringify({ type: "prompt", message: cmd.message }) + "\n");
      out({ type: "message_end", message: { role: "assistant",
            content: [{ type: "text", text: "echo: " + cmd.message }] } });
      out({ type: "agent_end", messages: [] });
      break;
    }
    case "steer":
      fs.appendFileSync(sessionFile, JSON.stringify({ type: "steer", message: cmd.message }) + "\n");
      out({ id, type: "response", command: "steer", success: true });
      break;
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

# --- the fake bd -------------------------------------------------------------
# It never mutates anything; it LOGS every call — cwd, the graph dir it would
# resolve by walking up from that cwd (bd's actual scoping mechanism), and the
# args — so the test can assert which project's store each call was scoped to.
cat > "$BIN/bd" <<'FAKEBD'
#!/bin/sh
logf="${WH_BD_LOG:?fake bd needs WH_BD_LOG}"
d="$(pwd -P)"
g="none"
w="$d"
while [ "$w" != "/" ]; do
  if [ -d "$w/.beads" ]; then g="$w/.beads"; break; fi
  w="$(dirname "$w")"
done
printf 'cwd=%s graph=%s args=%s\n' "$d" "$g" "$*" >> "$logf"
exit 0
FAKEBD
chmod +x "$BIN/bd"

# --- two fixture projects ----------------------------------------------------
# Each is a complete wheelhouse project shape: seats/, contracts/, a graph dir
# (.beads with a marker), and a worktrees dir (.wheelhouse-worktrees with a
# marker). Namespaces nsA/nsB give each its own seat root under $HOME.
build_proj() {   # $1 = project dir, $2 = namespace, $3 = seat name
  local proj="$1" ns="$2" seat="$3"
  mkdir -p "$proj/seats" "$proj/contracts" "$proj/.beads" "$proj/.wheelhouse-worktrees/wt-1"
  cp "$ADAPTER" "$proj/seats/adapter.ts"
  printf 'graph store of %s\n' "$proj" > "$proj/.beads/marker.txt"
  printf 'worktree of %s\n' "$proj" > "$proj/.wheelhouse-worktrees/wt-1/marker.txt"
  printf '# Fleet: Worker\n\nfixture brief.\n' > "$proj/contracts/WORKER.md"
  cat > "$proj/seats/seats.json" <<EOF
{
  "commander": { "role": "commander", "external": true, "runtime": "claude-code" },
  "seats": {
    "$seat": {
      "role": "worker",
      "provider": "anthropic",
      "model": "stub-model-1",
      "account": { "dir": "$HOME_FIX/.pi-seats-$ns/$seat" }
    }
  }
}
EOF
}

PROJA="$FIX/projA"
PROJB="$FIX/projB"
build_proj "$PROJA" nsA worker-a
build_proj "$PROJB" nsB worker-b

SEAT_A="$HOME_FIX/.pi-seats-nsA/worker-a"
SEAT_B="$HOME_FIX/.pi-seats-nsB/worker-b"
BD_LOG="$FIX/bd-calls.log"
: > "$BD_LOG"

phase "0. provisioning — the REAL seat-env.sh builds both seats in the temp HOME"
PROV_A="$(env HOME="$HOME_FIX" PATH="$RUN_PATH" bash "$SEAT_ENV" nsA worker-a "$PROJA" 2>&1)"; RCA=$?
PROV_B="$(env HOME="$HOME_FIX" PATH="$RUN_PATH" bash "$SEAT_ENV" nsB worker-b "$PROJB" 2>&1)"; RCB=$?
if [ $RCA -eq 0 ] && [ -d "$SEAT_A" ]; then pass "seat-env.sh provisioned A's seat under .pi-seats-nsA"
else fail "seat-env.sh for A exited $RCA: $PROV_A"; fi
if [ $RCB -eq 0 ] && [ -d "$SEAT_B" ]; then pass "seat-env.sh provisioned B's seat under .pi-seats-nsB"
else fail "seat-env.sh for B exited $RCB: $PROV_B"; fi
printf '{"stub":"identity-a"}\n' > "$SEAT_A/auth.json"
printf '{"stub":"identity-b"}\n' > "$SEAT_B/auth.json"

phase "1. config inspection — the isolation is written where claimed"
if [ -d "$HOME_FIX/.pi-seats-nsA" ] && [ -d "$HOME_FIX/.pi-seats-nsB" ] \
   && [ "$HOME_FIX/.pi-seats-nsA" != "$HOME_FIX/.pi-seats-nsB" ]; then
  pass "seat roots are disjoint per namespace (.pi-seats-nsA vs .pi-seats-nsB)"
else fail "namespace seat roots missing or not disjoint"; fi

if grep -q "\"$PROJA\": true" "$SEAT_A/trust.json" 2>/dev/null; then
  pass "A's trust.json grants A's project root"
else fail "A's trust.json does not grant $PROJA"; fi
if ! grep -qF "$PROJB" "$SEAT_A/trust.json" 2>/dev/null; then
  pass "A's trust.json contains no grant for B's root (B's path absent)"
else fail "B's path appears in A's trust.json"; fi
if ! grep -qF "$PROJA" "$SEAT_B/trust.json" 2>/dev/null; then
  pass "B's trust.json contains no grant for A's root (symmetric)"
else fail "A's path appears in B's trust.json"; fi

if ! grep -qF "$PROJB" "$PROJA/seats/seats.json" && ! grep -q "nsB" "$PROJA/seats/seats.json"; then
  pass "A's seats.json references no B path and no B namespace"
else fail "a B path or namespace appears in A's roster"; fi

# The write surfaces, enumerated FROM THE CODE: every durable path adapter.ts
# writes is joined from ROOT (= the project the adapter file lives in) —
# state.json, run/, logs/ via SEATS_DIR — and the only other write target is
# the seat's own account dir, which the roster names and phase 2 fences.
if grep -q 'const ROOT = path.resolve(import.meta.dir, "..")' "$ADAPTER" \
   && grep -q 'const STATE_FILE = path.join(SEATS_DIR, "state.json")' "$ADAPTER" \
   && grep -q 'const RUN_DIR = path.join(SEATS_DIR, "run")' "$ADAPTER" \
   && grep -q 'const LOG_DIR = path.join(SEATS_DIR, "logs")' "$ADAPTER"; then
  pass "adapter's write surfaces (state.json, run/, logs/) all derive from its own project root"
else fail "adapter path constants moved — re-enumerate the write surfaces before trusting this test"; fi
if ! grep -qE 'path\.(join|resolve)\("/' "$ADAPTER"; then
  pass "adapter builds no absolute path from a literal — nothing escapes ROOT by construction"
else fail "adapter joins from an absolute literal — a write surface may live outside the project"; fi

# --- snapshots of everything A must not touch --------------------------------
cp -R "$PROJB" "$FIX/projB.snap"
cp -R "$SEAT_B" "$FIX/seatB.snap"
home_listing() { find "$HOME_FIX" -not -path "$HOME_FIX/.pi-seats-nsA*" | LC_ALL=C sort; }
HOME_BEFORE="$(home_listing)"

b_pristine() {   # $1 = label
  local label="$1" d1 d2
  d1="$(diff -r "$PROJB" "$FIX/projB.snap" 2>&1)"
  d2="$(diff -r "$SEAT_B" "$FIX/seatB.snap" 2>&1)"
  if [ -z "$d1" ] && [ -z "$d2" ]; then
    pass "$label: B's project tree and seat root are byte-identical to the snapshot"
    return 0
  else
    fail "$label: B was mutated: ${d1:0:200} ${d2:0:200}"
    return 1
  fi
}
restore_b() {
  rm -rf "$PROJB" "$SEAT_B"
  cp -R "$FIX/projB.snap" "$PROJB"
  cp -R "$FIX/seatB.snap" "$SEAT_B"
}

# --- driving A's machinery ---------------------------------------------------
arun() { OUT="$(env HOME="$HOME_FIX" PATH="$RUN_PATH" WH_BD_LOG="$BD_LOG" bun "$PROJA/seats/adapter.ts" "$@" 2>&1)"; RC=$?; }
says() { case "$OUT" in *"$1"*) return 0 ;; *) return 1 ;; esac; }
STATE_A="$PROJA/seats/state.json"
LOG_A="$PROJA/seats/logs/worker-a.jsonl"
astate_get() { env HOME="$HOME_FIX" bun -e "const s=require('$STATE_A');const v=s.seats['worker-a']?.['$1'];if(v!=null)console.log(v)"; }
wait_for_from() {   # $1 = file, $2 = byte offset, $3 = substring, $4 = seconds
  local i=0 max=$((${4:-10} * 10))
  while [ $i -lt $max ]; do
    [ -f "$1" ] && tail -c +"$(($2 + 1))" "$1" 2>/dev/null | grep -q "$3" && return 0
    sleep 0.1; i=$((i + 1))
  done
  return 1
}
log_mark() { [ -f "$LOG_A" ] && wc -c < "$LOG_A" | tr -d ' ' || echo 0; }

phase "2. A's machinery runs hard; every write lands inside A's boundaries"
arun spawn worker-a
[ $RC -eq 0 ] && pass "A: spawn exits 0" || fail "A: spawn exited $RC: $OUT"
MARK=$(log_mark)
arun dispatch worker-a bead-a1 "ordinary work; B lives at $PROJB and its graph at $PROJB/.beads — mentioning a path is not touching it"
[ $RC -eq 0 ] && pass "A: dispatch exits 0" || fail "A: dispatch exited $RC: $OUT"
wait_for_from "$LOG_A" "$MARK" '"agent_end"' 10 \
  && pass "A: turn completed (agent_end)" || fail "A: no agent_end after dispatch"
arun status
[ $RC -eq 0 ] && says "worker-a" && pass "A: status reads A's own state" || fail "A: status failed: $OUT"
arun stop worker-a
[ $RC -eq 0 ] && pass "A: stop exits 0" || fail "A: stop exited $RC: $OUT"
arun resume worker-a
[ $RC -eq 0 ] && pass "A: resume exits 0" || fail "A: resume exited $RC: $OUT"

# the write surfaces exist — and only under A
WS_OK=1
for ws in "seats/state.json" "seats/run" "seats/logs"; do
  [ -e "$PROJA/$ws" ] || { WS_OK=0; fail "A write surface missing: $PROJA/$ws"; }
  [ -e "$PROJB/$ws" ] && { WS_OK=0; fail "write surface appeared under B: $PROJB/$ws"; }
done
[ $WS_OK -eq 1 ] && pass "write surfaces (state.json, run/, logs/) exist under A and only A (verdicts/: not exercised — verify.ts does not run here, and none appeared)"
[ -e "$PROJB/seats/verdicts" ] && fail "verdicts/ appeared under B" || true

if ! grep -qF "$PROJB" "$STATE_A" && ! grep -q "nsB" "$STATE_A"; then
  pass "A's state.json references no B path and no B namespace"
else fail "a B path or namespace appears in A's state.json"; fi

b_pristine "after the full benign run"
HOME_AFTER="$(home_listing)"
if [ "$HOME_BEFORE" = "$HOME_AFTER" ]; then
  pass "nothing new in \$HOME outside A's own seat namespace"
else fail "unexpected paths appeared in \$HOME: $(comm -13 <(printf '%s\n' "$HOME_BEFORE") <(printf '%s\n' "$HOME_AFTER") | head -5 | tr '\n' ' ')"; fi

phase "3. bead-graph isolation — A's bd calls are scoped to A's store, never B's"
if [ -d "$PROJA/.beads" ] && [ -d "$PROJB/.beads" ] \
   && [ ! -L "$PROJA/.beads" ] && [ ! -L "$PROJB/.beads" ]; then
  pass "the fixture graphs are separate real stores (no symlink between them)"
else fail "graph dirs missing or symlinked"; fi
MARK=$(log_mark)
arun dispatch worker-a bead-g1 "GRAPH: update your bead"
wait_for_from "$LOG_A" "$MARK" '"agent_end"' 10 || fail "A: GRAPH turn never ended"
if [ -s "$BD_LOG" ]; then
  pass "the seat's bd call was captured ($(wc -l < "$BD_LOG" | tr -d ' ') call(s) logged)"
else fail "no bd call reached the fake bd — the graph leg measured nothing"; fi
if [ -s "$BD_LOG" ] && ! grep -v "graph=$PROJA/.beads" "$BD_LOG" | grep -q .; then
  pass "every logged bd call resolved to A's graph dir"
else fail "a bd call resolved outside A's graph: $(grep -v "graph=$PROJA/.beads" "$BD_LOG" | head -2)"; fi
if ! grep -qF "$PROJB" "$BD_LOG"; then
  pass "zero B-scoped bd calls (B's path appears in no call, cwd, or resolved graph)"
else fail "a bd call carried B's path: $(grep -F "$PROJB" "$BD_LOG" | head -2)"; fi
b_pristine "after the graph leg"

phase "4. the doors — path-shaped arguments refuse or stay inert data"
arun spawn "../projB"
if [ $RC -ne 0 ] && says "invalid seat name"; then
  pass "spawn with a seat name pointing at B is refused (seat-name validation)"
else fail "spawn '../projB' was not refused (exit $RC): $OUT"; fi
arun dispatch "../../projB/seats/worker-b" bead-x "hello"
if [ $RC -ne 0 ] && says "invalid seat name"; then
  pass "dispatch with a path-shaped seat name is refused"
else fail "dispatch with a B-path seat name was not refused (exit $RC): $OUT"; fi
arun stop "../projB"
if [ $RC -ne 0 ] && says "invalid seat name"; then
  pass "stop with a path-shaped seat name is refused"
else fail "stop '../projB' was not refused (exit $RC): $OUT"; fi
# A bead id is never used as a path: it rides in the prompt text and in
# state.json's lastBead field as DATA. Hand it a B-shaped path and prove
# nothing is created there and B stays untouched.
MARK=$(log_mark)
arun dispatch worker-a "../../projB/pwn" "bead id shaped like a path into B"
[ $RC -eq 0 ] || fail "dispatch with a path-shaped BEAD ID errored (exit $RC) — expected inert acceptance: $OUT"
wait_for_from "$LOG_A" "$MARK" '"agent_end"' 10 || fail "A: path-bead turn never ended"
if [ ! -e "$FIX/projB/pwn" ] && [ ! -e "$PROJA/seats/../../projB/pwn" ]; then
  pass "no file appeared where a path-interpreted bead id would land"
else fail "a bead id was interpreted as a path: $FIX/projB/pwn exists"; fi
if [ "$(astate_get lastBead)" = "../../projB/pwn" ]; then
  pass "the bead id landed in state.json verbatim, as data"
else fail "lastBead is not the literal dispatched id: $(astate_get lastBead)"; fi
b_pristine "after the door probes"
arun stop worker-a

phase "5. honesty — a HOSTILE seat process CAN reach B; the OS is not the wall"
XREPORT="$SEAT_A/xprobe-report.txt"
: > "$XREPORT"
# The hostile behavior triggers in the STUB, not in any wheelhouse code: the
# adapter spawns and dispatches exactly as always. Targets ride in env vars,
# standing in for what a compromised seat could trivially discover itself.
XRUN() { OUT="$(env HOME="$HOME_FIX" PATH="$RUN_PATH" WH_BD_LOG="$BD_LOG" \
  WH_XPROBE_REPORT="$XREPORT" \
  WH_XPROBE_BLOG="$PROJB/seats/logs/worker-b.jsonl" \
  WH_XPROBE_BSTATE="$PROJB/seats/state.json" \
  WH_XPROBE_BWT="$PROJB/.wheelhouse-worktrees/wt-1/hostile.txt" \
  WH_XPROBE_BGRAPH="$PROJB/.beads/hostile.txt" \
  bun "$PROJA/seats/adapter.ts" "$@" 2>&1)"; RC=$?; }
XRUN spawn worker-a
[ $RC -eq 0 ] || fail "hostile leg: spawn exited $RC: $OUT"
MARK=$(log_mark)
XRUN dispatch worker-a bead-h1 "XPROBE: attempt the cross-project writes"
wait_for_from "$LOG_A" "$MARK" '"agent_end"' 10 || fail "hostile leg: turn never ended"
if [ "$(grep -c . "$XREPORT" | tr -d ' ')" = "4" ]; then
  pass "all four cross-project attempts were made and reported"
else fail "expected 4 attempt lines in $XREPORT, got: $(cat "$XREPORT")"; fi
OK_COUNT="$(grep -c '^OK' "$XREPORT" | tr -d ' ')"
note "OS boundary: $OK_COUNT/4 hostile cross-writes SUCCEEDED — same user, no sandbox."
note "Isolation here is by construction and contract, not OS enforcement."
B_DIFF="$(diff -r "$PROJB" "$FIX/projB.snap" 2>&1)"
if { [ "$OK_COUNT" -gt 0 ] && [ -n "$B_DIFF" ]; } || { [ "$OK_COUNT" -eq 0 ] && [ -z "$B_DIFF" ]; }; then
  pass "the report and B's actual state agree ($OK_COUNT succeeded; B mutated: $([ -n "$B_DIFF" ] && echo yes || echo no)) — the test tells the truth either way"
else fail "report/reality mismatch: $OK_COUNT OK lines but B mutated=$([ -n "$B_DIFF" ] && echo yes || echo no)"; fi
restore_b
b_pristine "after restoring B from the snapshot"
XRUN stop worker-a

phase "6. canary — can these checks detect a machinery that DOES cross over?"
# 6a: an adapter whose log dir points into B — the pristine-B check must bite.
CANP="$FIX/canproj"
build_proj "$CANP" nsCan worker-a
env HOME="$HOME_FIX" PATH="$RUN_PATH" bash "$SEAT_ENV" nsCan worker-a "$CANP" >/dev/null 2>&1
printf '{"stub":"identity-can"}\n' > "$HOME_FIX/.pi-seats-nsCan/worker-a/auth.json"
sed "s|const LOG_DIR = path.join(SEATS_DIR, \"logs\");|const LOG_DIR = \"$PROJB/seats/logs\";|" \
  "$ADAPTER" > "$CANP/seats/adapter.ts"
if cmp -s "$ADAPTER" "$CANP/seats/adapter.ts"; then
  fail "canary 6a: could not redirect LOG_DIR — the line no longer matches, so the canary proves nothing"
else
  CRUN() { OUT="$(env HOME="$HOME_FIX" PATH="$RUN_PATH" WH_BD_LOG="$BD_LOG" bun "$CANP/seats/adapter.ts" "$@" 2>&1)"; RC=$?; }
  CRUN spawn worker-a
  CANARY_FAILED_BEFORE=$FAILED
  b_pristine "canary 6a" > /dev/null 2>&1
  if [ $FAILED -gt $CANARY_FAILED_BEFORE ]; then
    FAILED=$CANARY_FAILED_BEFORE
    pass "canary 6a: an adapter that writes its logs into B is caught by the pristine-B check"
  else
    FAILED=$((CANARY_FAILED_BEFORE + 1))
    fail "canary 6a: a cross-writing adapter PASSED the pristine-B check — it proves nothing"
  fi
  CRUN stop worker-a
  restore_b
fi

# 6b: a seat whose bd call runs from B's root — the zero-B-scoped-calls check
# must bite. Separate log file so the real phase-3 evidence stays clean.
CAN_BD_LOG="$FIX/bd-calls.canary.log"
: > "$CAN_BD_LOG"
BRUN() { OUT="$(env HOME="$HOME_FIX" PATH="$RUN_PATH" WH_BD_LOG="$CAN_BD_LOG" \
  WH_CANARY_BD_CWD="$PROJB" bun "$PROJA/seats/adapter.ts" "$@" 2>&1)"; RC=$?; }
BRUN spawn worker-a
MARK=$(log_mark)
BRUN dispatch worker-a bead-c1 "GRAPH: canary call"
wait_for_from "$LOG_A" "$MARK" '"agent_end"' 10 || fail "canary 6b: turn never ended"
if [ -s "$CAN_BD_LOG" ] && grep -qF "$PROJB" "$CAN_BD_LOG" \
   && grep -q "graph=$PROJB/.beads" "$CAN_BD_LOG"; then
  pass "canary 6b: a bd call scoped to B's store IS visible to the B-scoped-call check"
else
  fail "canary 6b: a B-scoped bd call left no detectable trace — the phase-3 check proves nothing: $(cat "$CAN_BD_LOG")"
fi
BRUN stop worker-a
b_pristine "after canary 6b (fake bd only logs; B untouched)"

printf '\n'
printf 'THE BOUNDARY: isolation between projects is by construction and contract,\n'
printf 'not OS enforcement. Every path the machinery writes derives from its own\n'
printf 'project root and namespaced seat root, and path-shaped arguments are\n'
printf 'refused — but one user, no sandbox: the OS permits a hostile seat to write\n'
printf 'anywhere, and phase 5 proved it rather than assuming otherwise.\n\n'
if [ $FAILED -eq 0 ]; then
  echo "project isolation holds on this machine — on the stated terms."
  exit 0
fi
echo "$FAILED check(s) failed."
echo "If a failure is in phases 0-5, the isolation story broke or its wording"
echo "moved. If a failure is in phase 6, fix this test before trusting it."
exit 1
