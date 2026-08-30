#!/usr/bin/env bash
#
# concurrency.selftest.sh — can TWO seats from one roster work distinct beads
# at the same time without touching each other, and does a capacity failure
# on one of them surface where the commander looks?
#
# What "without touching each other" means here, checked one by one:
#   - both seats are RUNNING with a turn in flight at the same moment
#     (overlapping RUNNING: both state.json pids alive, both logs holding an
#     agent_start with no agent_end yet);
#   - each seat's events land ONLY in its own log — seat A's dispatched text
#     never appears in seat B's log or vice versa;
#   - no cross-talk on FIFOs: each seat has its own FIFO, and a command
#     written to one is answered in that seat's log alone (the log check IS
#     the FIFO check — a crossed FIFO would land the response in the wrong
#     log);
#   - worktree isolation: the contract workers run under is one git worktree
#     per bead, never a shared checkout. The test creates two scratch git
#     worktrees from one scratch repo, hands each seat a prompt naming its
#     own worktree, and asserts each seat's work landed only in its own —
#     and that the two worktrees are on distinct branches;
#   - both seats stop cleanly.
#
# Capacity visibility (visibility ONLY — no broker, no meter): a dispatch
# failure that looks like an account limit (quota/usage/429) must be stamped
# into state.json as lastCapacityEvent, `adapter.ts status` must print it,
# and `floor.ts --once` must render the AMBER QUOTA line from it. A dispatch
# that lands afterwards must clear it.
#
# Hermetic: phases 1-5 run against a stub `pi` in a temp HOME on a private
# PATH; your real seats are never touched. The canary phase (house pattern)
# sabotages COPIES of adapter.ts — once merging both seats into one shared
# log, once cutting the capacity stamp — and checks these tests notice; each
# sabotage is cmp-guarded so a sed that no longer bites says so instead of
# proving nothing.
#
# The last phase is ONE real-pi leg: two REAL seats borrowing your login,
# dispatched trivial prompts concurrently (the second dispatch goes out
# before the first turn is waited on), both agent_ends captured, logs
# disjoint. When your working login is not pi's default provider, pin BOTH
# WHEELHOUSE_REAL_PI_PROVIDER and WHEELHOUSE_REAL_PI_MODEL (always together —
# see the roster gotcha in seats/README.md). Skippable: no pi, no login, or
# WHEELHOUSE_SKIP_REAL_PI=1 each print a SKIP line.
#
# Usage: concurrency.selftest.sh [path-to-adapter.ts]
#
# Exit 0 = two-seat concurrency works here. Non-zero = read the FAIL lines;
# a canary failure means these checks cannot be trusted either way.

set -uo pipefail   # deliberately not -e: some cases are meant to fail

HERE="$(cd "$(dirname "$0")" && pwd)"
ADAPTER="${1:-$HERE/adapter.ts}"
FLOOR="$HERE/floor.ts"
[ -f "$ADAPTER" ] || { echo "selftest: not found: $ADAPTER" >&2; exit 2; }
[ -f "$FLOOR" ] || { echo "selftest: not found: $FLOOR" >&2; exit 2; }
command -v bun >/dev/null 2>&1 || { echo "selftest: bun is required" >&2; exit 2; }
NODE_BIN="$(command -v node)" || { echo "selftest: node is required for the stub pi" >&2; exit 2; }
GIT_BIN="$(command -v git)" || { echo "selftest: git is required for the worktree phase" >&2; exit 2; }
REAL_PI="$(command -v pi || true)"

FAILED=0
FIX=""

pass() { printf '  ok    %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; FAILED=$((FAILED + 1)); }
skip() { printf '  SKIP  %s\n' "$*"; }
phase(){ printf '\n%s\n' "$*"; }

cleanup() {
  [ -n "$FIX" ] && pkill -f "$FIX" 2>/dev/null
  [ -n "$FIX" ] && rm -rf "$FIX"
  return 0
}
trap cleanup EXIT INT TERM

# --- stale-fixture sweep (same rules as adapter.selftest.sh) -----------------
# SIGKILL skips the EXIT trap; pid-stamped fixture dirs let a later run tell
# a dead owner from a live one, and the fd-based identity rule (a pid counts
# only if it still holds files open under the fixture) is what recover.ts
# uses, because a pid number alone proves nothing after reuse.
FIX_PREFIX="wheelhouse-concurrency-selftest"
sweep_stale_fixtures() {
  local base="${TMPDIR:-/tmp}" d stamp phys sf pid
  while IFS= read -r d; do
    [ -d "$d" ] || continue
    stamp="${d##*/}"; stamp="${stamp#"$FIX_PREFIX".}"; stamp="${stamp%%.*}"
    case "$stamp" in ''|*[!0-9]*) continue ;; esac
    kill -0 "$stamp" 2>/dev/null && continue
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
RUN_PATH="$BIN:$(dirname "$(command -v bun)"):$(dirname "$NODE_BIN"):$(dirname "$GIT_BIN"):/usr/bin:/bin"

# The stub pi: same long-lived RPC shape as adapter.selftest.sh's, with two
# additions this exercise needs:
#   - a prompt containing QUOTA answers success:false with a 429-shaped
#     error, so the capacity path has a failure to stamp;
#   - a prompt containing "WORKDIR:<path>" makes the stub touch
#     <path>/touched-by-<bead-id> before finishing the turn — the on-disk
#     footprint the worktree-isolation assertions read.
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
const sessionId = crypto.randomUUID();
const sessionFile = path.join(sessDir, sessionId + ".jsonl");
fs.writeFileSync(sessionFile, JSON.stringify({ type: "session-start" }) + "\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
function handle(cmd) {
  const id = cmd.id;
  switch (cmd.type) {
    case "get_state":
      out({ id, type: "response", command: "get_state", success: true,
            data: { isStreaming: false, sessionFile, sessionId, messageCount: 0 } });
      break;
    case "prompt": {
      if (/QUOTA/.test(cmd.message)) {
        out({ id, type: "response", command: "prompt", success: false,
              error: "429 rate limit exceeded — usage limit reached for this account" });
        break;
      }
      out({ id, type: "response", command: "prompt", success: true });
      out({ type: "agent_start" });
      const bead = (cmd.message.match(/^Bead (\S+)/) || [])[1] || "unknown";
      const wd = (cmd.message.match(/WORKDIR:(\S+)/) || [])[1];
      const finish = () => {
        if (wd) fs.writeFileSync(path.join(wd, "touched-by-" + bead), bead + "\n");
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

# A fixture project with a TWO-seat roster — one roster, two account dirs.
build_proj() {   # $1 = project dir, $2 = seat namespace
  local proj="$1" ns="$2" seat seatdir
  mkdir -p "$proj/seats" "$proj/contracts"
  cp "$ADAPTER" "$proj/seats/adapter.ts"
  cp "$FLOOR" "$proj/seats/floor.ts"
  printf '# Fleet: Worker\n\nfixture brief.\n' > "$proj/contracts/WORKER.md"
  cat > "$proj/seats/seats.json" <<EOF
{
  "commander": { "role": "commander", "external": true, "runtime": "claude-code" },
  "seats": {
    "worker-a": { "role": "worker", "provider": "anthropic", "model": "stub-a",
                  "account": { "dir": "~/.pi-seats-$ns/worker-a" } },
    "worker-b": { "role": "worker", "provider": "anthropic", "model": "stub-b",
                  "account": { "dir": "~/.pi-seats-$ns/worker-b" } }
  }
}
EOF
  for seat in worker-a worker-b; do
    seatdir="$HOME_FIX/.pi-seats-$ns/$seat"
    mkdir -p "$seatdir"
    printf '{\n  "%s": true\n}\n' "$proj" > "$seatdir/trust.json"
    printf '{"stub":"identity-%s"}\n' "$seat" > "$seatdir/auth.json"
  done
}

PROJ="$FIX/proj"
build_proj "$PROJ" alpha
RUN_PROJ="$PROJ"

run() { OUT="$(env HOME="$HOME_FIX" PATH="$RUN_PATH" bun "$RUN_PROJ/seats/adapter.ts" "$@" 2>&1)"; RC=$?; }
says() { case "$OUT" in *"$1"*) return 0 ;; *) return 1 ;; esac; }
state_get() {   # $1 = seat, $2 = field  (reads $RUN_PROJ's state.json)
  env HOME="$HOME_FIX" bun -e "const s=require('$RUN_PROJ/seats/state.json');const v=s.seats['$1']?.['$2'];if(v!=null)console.log(typeof v==='object'?JSON.stringify(v):v)"
}
wait_for() {   # $1 = file, $2 = substring, $3 = seconds
  local i=0 max=$((${3:-10} * 10))
  while [ $i -lt $max ]; do
    [ -f "$1" ] && grep -q "$2" "$1" 2>/dev/null && return 0
    sleep 0.1; i=$((i + 1))
  done
  return 1
}

# The scratch repo and its two worktrees — the isolation contract in
# miniature: one worktree per bead, each on its own fleet/<bead> branch.
REPO="$FIX/scratch-repo"
git init -q "$REPO"
( cd "$REPO" && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m root )
git -C "$REPO" worktree add -q "$FIX/wt-bead-a" -b fleet/bead-a >/dev/null 2>&1
git -C "$REPO" worktree add -q "$FIX/wt-bead-b" -b fleet/bead-b >/dev/null 2>&1

LOG_A="$PROJ/seats/logs/worker-a.jsonl"
LOG_B="$PROJ/seats/logs/worker-b.jsonl"

# --- the two-seat exercise, parameterized so the canary can reuse it ---------
# Spawns both seats of $RUN_PROJ, dispatches SLOW bead-a/bead-b back-to-back
# (each naming its own worktree), asserts overlap, waits both turns out, and
# asserts log/worktree isolation. $1 = label, $2/$3 = worktree dirs.
run_two_seat_exercise() {
  local label="$1" wta="$2" wtb="$3"
  local la="$RUN_PROJ/seats/logs/worker-a.jsonl" lb="$RUN_PROJ/seats/logs/worker-b.jsonl"

  run spawn worker-a
  [ $RC -eq 0 ] && pass "$label: worker-a spawns" || fail "$label: worker-a spawn exited $RC: $OUT"
  run spawn worker-b
  [ $RC -eq 0 ] && pass "$label: worker-b spawns" || fail "$label: worker-b spawn exited $RC: $OUT"

  local fa fb
  fa="$(state_get worker-a fifo)"; fb="$(state_get worker-b fifo)"
  if [ -n "$fa" ] && [ -n "$fb" ] && [ "$fa" != "$fb" ] && [ -p "$fa" ] && [ -p "$fb" ]; then
    pass "$label: each seat has its OWN FIFO ($(basename "$fa"), $(basename "$fb"))"
  else fail "$label: FIFOs missing or shared (a=$fa b=$fb)"; fi

  # Both dispatches go out before either turn is waited on — that is the
  # concurrency under test. SLOW keeps both turns in flight long enough to
  # observe the overlap. The adapter roots seats in the project-local bead
  # worktree path; the stub's WORKDIR marker separately names where to leave
  # the proof footprint.
  mkdir -p "$RUN_PROJ/.wheelhouse-worktrees/bead-a" "$RUN_PROJ/.wheelhouse-worktrees/bead-b"
  run dispatch worker-a bead-a "SLOW MARKER-ALPHA work bead-a in WORKDIR:$wta"
  [ $RC -eq 0 ] && pass "$label: bead-a dispatched to worker-a" || fail "$label: dispatch a exited $RC: $OUT"
  run dispatch worker-b bead-b "SLOW MARKER-BRAVO work bead-b in WORKDIR:$wtb"
  [ $RC -eq 0 ] && pass "$label: bead-b dispatched to worker-b (before bead-a's turn ended)" || fail "$label: dispatch b exited $RC: $OUT"

  # Overlap: both pids alive, both logs mid-turn (agent_start, no agent_end).
  local pa pb
  pa="$(state_get worker-a pid)"; pb="$(state_get worker-b pid)"
  if kill -0 "$pa" 2>/dev/null && kill -0 "$pb" 2>/dev/null; then
    pass "$label: overlapping RUNNING — both state.json pids alive at once ($pa, $pb)"
  else fail "$label: pids not simultaneously alive (a=$pa b=$pb)"; fi
  if grep -q '"agent_start"' "$la" 2>/dev/null && ! grep -q '"agent_end"' "$la" 2>/dev/null \
     && grep -q '"agent_start"' "$lb" 2>/dev/null && ! grep -q '"agent_end"' "$lb" 2>/dev/null; then
    pass "$label: both turns in flight at the same moment (agent_start seen, no agent_end yet, both logs)"
  else fail "$label: could not observe both turns in flight simultaneously"; fi
  run status
  if says "worker-a" && says "worker-b" && [ "$(printf '%s\n' "$OUT" | grep -c RUNNING)" -ge 2 ]; then
    pass "$label: status shows both seats RUNNING"
  else fail "$label: status does not show two RUNNING seats: $OUT"; fi

  wait_for "$la" '"agent_end"' 15 && pass "$label: worker-a's turn finished" || fail "$label: no agent_end in worker-a's log"
  wait_for "$lb" '"agent_end"' 15 && pass "$label: worker-b's turn finished" || fail "$label: no agent_end in worker-b's log"

  # Log isolation — and, through it, FIFO isolation: each dispatch was
  # written to one FIFO, so its echo landing only in that seat's log is the
  # no-cross-talk proof.
  if grep -q 'MARKER-ALPHA' "$la" 2>/dev/null && ! grep -q 'MARKER-ALPHA' "$lb" 2>/dev/null; then
    pass "$label: worker-a's events land ONLY in worker-a's log"
  else fail "$label: worker-a's dispatch text leaked into worker-b's log (or missing from its own)"; fi
  if grep -q 'MARKER-BRAVO' "$lb" 2>/dev/null && ! grep -q 'MARKER-BRAVO' "$la" 2>/dev/null; then
    pass "$label: worker-b's events land ONLY in worker-b's log"
  else fail "$label: worker-b's dispatch text leaked into worker-a's log (or missing from its own)"; fi

  # Worktree isolation: each seat's work footprint is in its own worktree
  # and nowhere else, and the worktrees sit on distinct branches.
  if [ -f "$wta/touched-by-bead-a" ] && [ ! -e "$wta/touched-by-bead-b" ] \
     && [ -f "$wtb/touched-by-bead-b" ] && [ ! -e "$wtb/touched-by-bead-a" ]; then
    pass "$label: each bead's work landed only in its own worktree"
  else fail "$label: worktree cross-write (or missing footprint): $(ls "$wta" "$wtb" 2>&1 | tr '\n' ' ')"; fi
  local ba bb
  ba="$(git -C "$wta" branch --show-current 2>/dev/null)"
  bb="$(git -C "$wtb" branch --show-current 2>/dev/null)"
  if [ "$ba" = "fleet/bead-a" ] && [ "$bb" = "fleet/bead-b" ]; then
    pass "$label: the two worktrees are on distinct fleet/<bead> branches"
  else fail "$label: worktree branches wrong (a=$ba b=$bb)"; fi

  run stop worker-a
  [ $RC -eq 0 ] && pass "$label: worker-a stops cleanly" || fail "$label: worker-a stop exited $RC: $OUT"
  run stop worker-b
  [ $RC -eq 0 ] && pass "$label: worker-b stops cleanly" || fail "$label: worker-b stop exited $RC: $OUT"
}

phase "1. two seats, one roster — spawn, overlap, isolation, clean stop"
run_two_seat_exercise "hermetic" "$FIX/wt-bead-a" "$FIX/wt-bead-b"

phase "2. capacity visibility — a quota-shaped failure is stamped and rendered"
run spawn worker-a
mkdir -p "$RUN_PROJ/.wheelhouse-worktrees/bead-q" "$RUN_PROJ/.wheelhouse-worktrees/bead-ok"
run dispatch worker-a bead-q "QUOTA please"
if [ $RC -ne 0 ] && says "dispatch failed"; then
  pass "quota-shaped dispatch fails loudly"
else fail "quota-shaped dispatch did not fail (exit $RC): $OUT"; fi
CAP="$(state_get worker-a lastCapacityEvent)"
if [ -n "$CAP" ] && printf '%s' "$CAP" | grep -q '429 rate limit'; then
  pass "state.json records lastCapacityEvent with the failure detail: $CAP"
else fail "no lastCapacityEvent in state.json after quota failure (got: $CAP)"; fi
run status
if says "CAPACITY: quota-shaped dispatch failure"; then
  pass "adapter status surfaces the capacity event"
else fail "status does not surface the capacity event: $OUT"; fi
FLOOR_OUT="$(env HOME="$HOME_FIX" PATH="$RUN_PATH" COLUMNS=220 LINES=50 NO_COLOR=1 bun "$PROJ/seats/floor.ts" --once 2>&1)"
if printf '%s' "$FLOOR_OUT" | grep -q 'AMBER.*QUOTA EXHAUSTED — dispatch failed at'; then
  pass "floor --once renders the AMBER QUOTA line from the recorded event"
else fail "floor --once has no AMBER QUOTA line: $(printf '%s' "$FLOOR_OUT" | grep -i 'worker-a' | head -3)"; fi
FLOOR_STATUS="$(env HOME="$HOME_FIX" PATH="$RUN_PATH" COLUMNS=220 LINES=60 NO_COLOR=1 bun "$PROJ/seats/floor.ts" --once --pin 0 2>&1)"
if printf '%s' "$FLOOR_STATUS" | grep -q 'capacity QUOTA at'; then
  pass "floor STATUS cell shows per-account capacity state"
else fail "floor STATUS cell missing capacity line"; fi
run dispatch worker-a bead-ok "plain work, no quota"
wait_for "$LOG_A" 'echo: Bead bead-ok' 10 >/dev/null
if [ -z "$(state_get worker-a lastCapacityEvent)" ]; then
  pass "a dispatch that lands clears the capacity event"
else fail "lastCapacityEvent survived a successful dispatch"; fi
run stop worker-a

phase "3. canary — can these checks detect broken isolation and a lost stamp?"
# 3a: an adapter that writes every seat's events into ONE shared log.
CAN_A="$FIX/can-a"
build_proj "$CAN_A" can-a
sed 's|^  const log = path.join(LOG_DIR, `${name}.jsonl`);$|  const log = path.join(LOG_DIR, `shared.jsonl`);|' \
  "$ADAPTER" > "$CAN_A/seats/adapter.ts"
if cmp -s "$ADAPTER" "$CAN_A/seats/adapter.ts"; then
  fail "canary: could not merge the logs — the line no longer matches, so the canary proves nothing"
else
  git -C "$REPO" worktree add -q "$FIX/can-wt-a" -b canary/bead-a >/dev/null 2>&1
  git -C "$REPO" worktree add -q "$FIX/can-wt-b" -b canary/bead-b >/dev/null 2>&1
  CANARY_FAILED_BEFORE=$FAILED
  RUN_PROJ="$CAN_A"
  run_two_seat_exercise "canary" "$FIX/can-wt-a" "$FIX/can-wt-b" > /dev/null 2>&1
  if [ $FAILED -gt $CANARY_FAILED_BEFORE ]; then
    FAILED=$CANARY_FAILED_BEFORE
    pass "canary: an adapter that merges both seats into one log is caught"
  else
    FAILED=$((CANARY_FAILED_BEFORE + 1))
    fail "canary: a shared-log adapter PASSED the isolation checks — they prove nothing"
  fi
  RUN_PROJ="$CAN_A" run stop worker-a > /dev/null 2>&1
  RUN_PROJ="$CAN_A" run stop worker-b > /dev/null 2>&1
fi

# 3b: an adapter that swallows the capacity stamp.
CAN_B="$FIX/can-b"
build_proj "$CAN_B" can-b
sed 's|^      state.seats\[name\].lastCapacityEvent = {$|      const unstamped = {|' \
  "$ADAPTER" > "$CAN_B/seats/adapter.ts"
if cmp -s "$ADAPTER" "$CAN_B/seats/adapter.ts"; then
  fail "canary: could not cut the capacity stamp — the line no longer matches, so the canary proves nothing"
else
  RUN_PROJ="$CAN_B"
  run spawn worker-a > /dev/null 2>&1
  mkdir -p "$RUN_PROJ/.wheelhouse-worktrees/bead-q"
  run dispatch worker-a bead-q "QUOTA please" > /dev/null 2>&1
  if [ -z "$(state_get worker-a lastCapacityEvent)" ]; then
    pass "canary: an adapter with the capacity stamp cut is caught (no lastCapacityEvent lands)"
  else
    fail "canary: the stamp-cut adapter still recorded lastCapacityEvent — the sabotage missed"
  fi
  run stop worker-a > /dev/null 2>&1
fi
RUN_PROJ="$PROJ"

phase "4. real pi — two real seats, concurrent dispatch, disjoint logs"
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
  mkdir -p "$RPROJ/seats" "$RPROJ/contracts"
  cp "$ADAPTER" "$RPROJ/seats/adapter.ts"
  printf '# Fleet: Worker\n\nfixture brief.\n' > "$RPROJ/contracts/WORKER.md"
  # Two real seats, BOTH borrowing your login (auth is copied per seat dir
  # and dies with the fixture; it never enters state.json or the logs —
  # adapter.selftest.sh's real leg asserts that non-leak rule).
  RPIN=""
  if [ -n "${WHEELHOUSE_REAL_PI_PROVIDER:-}" ] && [ -n "${WHEELHOUSE_REAL_PI_MODEL:-}" ]; then
    RPIN="\"provider\": \"$WHEELHOUSE_REAL_PI_PROVIDER\", \"model\": \"$WHEELHOUSE_REAL_PI_MODEL\", "
  fi
  for seat in worker-a worker-b; do
    RSEAT="$RHOME/.pi-seats-real/$seat"
    mkdir -p "$RSEAT"
    printf '{\n  "%s": true\n}\n' "$RPROJ" > "$RSEAT/trust.json"
    cp "$REAL_AUTH" "$RSEAT/auth.json" && chmod 600 "$RSEAT/auth.json"
    [ -f "$HOME/.pi/agent/settings.json" ] && cp "$HOME/.pi/agent/settings.json" "$RSEAT/settings.json"
  done
  cat > "$RPROJ/seats/seats.json" <<EOF
{
  "commander": { "role": "commander", "external": true, "runtime": "claude-code" },
  "seats": {
    "worker-a": { "role": "worker", $RPIN"account": { "dir": "$RHOME/.pi-seats-real/worker-a" } },
    "worker-b": { "role": "worker", $RPIN"account": { "dir": "$RHOME/.pi-seats-real/worker-b" } }
  }
}
EOF
  REAL_PATH="$(dirname "$REAL_PI"):$(dirname "$(command -v bun)"):/usr/bin:/bin"
  rrun() { OUT="$(env HOME="$RHOME" PATH="$REAL_PATH" WHEELHOUSE_RPC_TIMEOUT_MS=90000 bun "$RPROJ/seats/adapter.ts" "$@" 2>&1)"; RC=$?; }
  RLOG_A="$RPROJ/seats/logs/worker-a.jsonl"
  RLOG_B="$RPROJ/seats/logs/worker-b.jsonl"

  rrun spawn worker-a
  [ $RC -eq 0 ] && pass "real: worker-a spawns ($OUT)" || fail "real: worker-a spawn exited $RC: $OUT"
  rrun spawn worker-b
  [ $RC -eq 0 ] && pass "real: worker-b spawns ($OUT)" || fail "real: worker-b spawn exited $RC: $OUT"
  # Concurrent dispatch: bead-b goes out before bead-a's turn is waited on.
  rrun dispatch worker-a real-a "Reply with exactly the text REAL-CONC-ALPHA and nothing else. Use no tools."
  [ $RC -eq 0 ] && pass "real: bead real-a dispatched" || fail "real: dispatch a exited $RC: $OUT"
  A_DONE_AT_B_DISPATCH="no"
  grep -q '"agent_end"' "$RLOG_A" 2>/dev/null && A_DONE_AT_B_DISPATCH="yes"
  rrun dispatch worker-b real-b "Reply with exactly the text REAL-CONC-BRAVO and nothing else. Use no tools."
  [ $RC -eq 0 ] && pass "real: bead real-b dispatched (worker-a's turn already ended at that moment: $A_DONE_AT_B_DISPATCH)" \
                || fail "real: dispatch b exited $RC: $OUT"
  wait_for "$RLOG_A" '"agent_end"' 180 && pass "real: worker-a agent_end captured" || fail "real: no agent_end for worker-a — tail: $(tail -c 300 "$RLOG_A" 2>/dev/null)"
  wait_for "$RLOG_B" '"agent_end"' 180 && pass "real: worker-b agent_end captured" || fail "real: no agent_end for worker-b — tail: $(tail -c 300 "$RLOG_B" 2>/dev/null)"
  if grep -q 'REAL-CONC-ALPHA' "$RLOG_A" 2>/dev/null && ! grep -q 'REAL-CONC-ALPHA' "$RLOG_B" 2>/dev/null \
     && grep -q 'REAL-CONC-BRAVO' "$RLOG_B" 2>/dev/null && ! grep -q 'REAL-CONC-BRAVO' "$RLOG_A" 2>/dev/null; then
    pass "real: logs are disjoint — each seat's turn landed only in its own log"
  else fail "real: cross-contamination between the two real seats' logs"; fi
  rrun stop worker-a
  [ $RC -eq 0 ] && pass "real: worker-a stops cleanly" || fail "real: worker-a stop exited $RC: $OUT"
  rrun stop worker-b
  [ $RC -eq 0 ] && pass "real: worker-b stops cleanly" || fail "real: worker-b stop exited $RC: $OUT"
fi

printf '\n'
if [ $FAILED -eq 0 ]; then
  echo "two-seat concurrency and capacity visibility work on this machine."
  exit 0
fi
echo "$FAILED check(s) failed."
echo "If the failures are in phases 1-2 or the real leg, the adapter or floor"
echo "broke (or their wording moved). If a failure is in the canary, fix this"
echo "test first."
exit 1
