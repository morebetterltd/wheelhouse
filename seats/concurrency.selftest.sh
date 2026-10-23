#!/usr/bin/env bash

SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"
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
export WHEELHOUSE_CONTRACT_FIXTURE="$HERE/fixtures/contracts/valid.md"
ADAPTER="${1:-$HERE/adapter.ts}"
FLOOR="$HERE/floor.ts"
BRIEFS="$HERE/briefs.ts"
HARNESS="$HERE/harness.ts"
HOST_BUDGET_TS="$HERE/host-budget.ts"
[ -f "$ADAPTER" ] || { echo "selftest: not found: $ADAPTER" >&2; exit 2; }
[ -f "$FLOOR" ] || { echo "selftest: not found: $FLOOR" >&2; exit 2; }
[ -f "$HARNESS" ] || { echo "selftest: not found: $HARNESS" >&2; exit 2; }
[ -f "$BRIEFS" ] || { echo "selftest: not found: $BRIEFS" >&2; exit 2; }
[ -f "$HOST_BUDGET_TS" ] || { echo "selftest: not found: $HOST_BUDGET_TS" >&2; exit 2; }
command -v bun >/dev/null 2>&1 || { echo "selftest: bun is required" >&2; exit 2; }
NODE_BIN="$(command -v node)" || { echo "selftest: node is required for the stub pi" >&2; exit 2; }
GIT_BIN="$(command -v git)" || { echo "selftest: git is required for the worktree phase" >&2; exit 2; }
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

launch_diagnostics() {
  [ -d "$HOME_FIX" ] || return 0
  while IFS= read -r record; do
    printf 'fixture launch record %s: ' "$record"; cat "$record"
    local stderr_file="${record/stub-launch./stub-stderr.}"
    printf 'fixture child stderr: '; cat "${stderr_file%.json}.log" 2>/dev/null || true
  done < <(find "$HOME_FIX" -name 'stub-launch.*.json' -type f)
}
cleanup() {
  [ "$FAILED" = 0 ] || launch_diagnostics
  selftest_cleanup_fixture_processes "${FIX:-}" "${SOCK:-}"
  [ -n "$FIX" ] && pkill -f "$FIX" 2>/dev/null
  [ -n "$FIX" ] && selftest_remove_fixture_dir "$FIX"
  return 0
}
selftest_install_cleanup_traps cleanup

# --- stale-fixture sweep (same rules as adapter.selftest.sh) -----------------
# SIGKILL skips the EXIT trap; pid-stamped fixture dirs let a later run tell
# a dead owner from a live one, and the fd-based identity rule (a pid counts
# only if it still holds files open under the fixture) is what recover.ts
# uses, because a pid number alone proves nothing after reuse.
FIX_PREFIX="wheelhouse-concurrency-selftest"
selftest_sweep_stale_fixtures "$FIX_PREFIX" || exit 2

FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/$FIX_PREFIX.$$.XXXXXX" "$FIX_PREFIX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
FIX="$(cd "$FIX" && pwd -P)"
HOME_FIX="$FIX/home"
BIN="$FIX/bin"
mkdir -p "$HOME_FIX" "$BIN"
RUN_PATH="${BIN}:$(dirname "$(command -v bun)"):$(dirname "$NODE_BIN"):$(dirname "$GIT_BIN"):/usr/bin:/bin"

barrier_regression() {
  "$NODE_BIN" "$HERE/fixtures/concurrency-barrier-regression.mjs" "$FIX/barrier-regression" \
    "$HERE/fixtures/concurrency-barrier.cjs" "$HERE/fixtures/concurrency-stub-supervisor.cjs" \
    "$HERE/fixtures/concurrency-barrier-observer.mjs"
}
if [ "${WHEELHOUSE_CONCURRENCY_BARRIER_ONLY:-}" = 1 ]; then
  barrier_regression
  exit $?
fi

# Run the deterministic regression BEFORE any full-adapter barrier can wait.
# An old/broken barrier must fail the ordinary suite here and release its caller
# (including a sweep lock holder), not hang in a later serialized canary.
phase "0. deterministic barrier lifecycle and lost-notification regression"
if ! barrier_regression; then
  fail 'deterministic barrier regression failed; refusing later barrier exercises'
  exit 1
fi

# The stub pi: same long-lived RPC shape as adapter.selftest.sh's, with two
# additions this exercise needs:
#   - a prompt containing QUOTA answers success:false with a 429-shaped
#     error, so the capacity path has a failure to stamp;
#   - a prompt containing "WORKDIR:<path>" makes the stub touch
#     <path>/touched-by-<bead-id> before finishing the turn — the on-disk
#     footprint the worktree-isolation assertions read.
cp -f "$HERE/fixtures/concurrency-stub-supervisor.cjs" "$BIN/pi"
cat > "$BIN/pi-stub.cjs" <<STUB
#!/usr/bin/env node
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const agentDir = process.env.PI_CODING_AGENT_DIR;
if (!agentDir) { process.stderr.write("stub pi: no PI_CODING_AGENT_DIR\n"); process.exit(1); }
if (process.env.WHEELHOUSE_CONCURRENCY_STUB_EXIT) {
  process.stderr.write("fixture forced launch exit " + process.env.WHEELHOUSE_CONCURRENCY_STUB_EXIT + "\n");
  process.exit(Number(process.env.WHEELHOUSE_CONCURRENCY_STUB_EXIT));
}
const args = process.argv.slice(2);
fs.mkdirSync(agentDir, { recursive: true });
fs.writeFileSync(path.join(agentDir, "argv.json"), JSON.stringify(args));
const sessDir = path.join(agentDir, "sessions");
fs.mkdirSync(sessDir, { recursive: true });
const sessionId = crypto.randomUUID();
const sessionFile = path.join(sessDir, sessionId + ".jsonl");
fs.writeFileSync(sessionFile, JSON.stringify({ type: "session-start" }) + "\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
let held = false, streaming = false;
function handle(cmd) {
  const id = cmd.id;
  switch (cmd.type) {
    case "get_state":
      out({ id, type: "response", command: "get_state", success: true,
            data: { isStreaming: streaming, sessionFile, sessionId, messageCount: 0 } });
      break;
    case "barrier_probe":
      out({ id, type: "response", command: "barrier_probe", success: true, data: { held } });
      break;
    case "prompt": {
      if (/QUOTA/.test(cmd.message)) {
        out({ id, type: "response", command: "prompt", success: false,
              error: "429 rate limit exceeded — usage limit reached for this account" });
        break;
      }
      out({ id, type: "response", command: "prompt", success: true });
      const bead = (cmd.message.match(/^Bead (\S+)/) || [])[1] || "unknown";
      const wd = (cmd.message.match(/WORKDIR:(\S+)/) || [])[1];
      const barrier = (cmd.message.match(/BARRIER:(\S+)/) || [])[1];
      let done = false, watcher;
      const finish = () => {
        if (done) return;
        done = true; held = false; streaming = false;
        if (watcher) watcher.close();
        if (wd) fs.writeFileSync(path.join(wd, "touched-by-" + bead), bead + "\n");
        fs.appendFileSync(sessionFile, JSON.stringify({ type: "prompt", message: cmd.message }) + "\n");
        out({ type: "message_end", message: { role: "assistant",
              content: [{ type: "text", text: "echo: " + cmd.message }] } });
        out({ type: "agent_end", messages: [] });
        if (barrier) fs.writeFileSync(path.join(barrier, bead + ".finished"), "finished\n");
      };
      const start = () => {
        streaming = true;
        out({ type: "agent_start" });
        if (!barrier) { finish(); return; }
        held = true;
        const released = () => { if (fs.existsSync(path.join(barrier, "release"))) finish(); };
        watcher = fs.watch(barrier, released);
        released();
      };
      if (barrier && process.env.WHEELHOUSE_CONCURRENCY_SERIAL_TURNS && bead === "bead-b") {
        // Real serialization sabotage: B cannot start until A has finished.
        let queued = true;
        const unqueue = () => {
          if (queued && fs.existsSync(path.join(barrier, "bead-a.finished"))) { queued = false; watcher.close(); start(); }
        };
        watcher = fs.watch(barrier, unqueue);
        unqueue();
      } else start();
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

# A worker seat owns one persistent git worktree, .wheelhouse-worktrees/<seat>,
# created from the project repo, so every fixture project is a git repo with
# one commit on main. Fixture state (seats/, contracts/, worktrees, the stub's
# touched-by-* footprints) is ignored so it never dirties a worktree.
init_fixture_repo() {   # $1 = project dir
  git -C "$1" init -q -b main
  printf 'seats/\ncontracts/\n.wheelhouse-worktrees/\n.wheelhouse-runs/\ntouched-by-*\n' > "$1/.gitignore"
  git -C "$1" add .gitignore
  git -C "$1" -c user.email=selftest@example.invalid -c user.name=selftest -c commit.gpgsign=false commit -q -m fixture
}

# A fixture project with a TWO-seat roster — one roster, two account dirs.
build_proj() {   # $1 = project dir, $2 = seat namespace
  local proj="$1" ns="$2" seat seatdir
  mkdir -p "$proj/seats" "$proj/contracts"
  selftest_copy_seat_runtime "$proj" "$HERE"
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
  init_fixture_repo "$proj"
}

PROJ="$FIX/proj"
build_proj "$PROJ" alpha
RUN_PROJ="$PROJ"

run() {
  RC=0; OUT="$(env HOME="$HOME_FIX" PATH="$RUN_PATH" WHEELHOUSE_SKIP_BD=1 WHEELHOUSE_CLEANUP=0 bun "$RUN_PROJ/seats/adapter.ts" "$@" 2>&1)" || RC=$?
  if [ "$RC" != 0 ] && [ "${1:-}" = spawn ]; then launch_diagnostics; fi
}
says() { case "$OUT" in *"$1"*) return 0 ;; *) return 1 ;; esac; }
state_get() {   # $1 = seat, $2 = field  (reads $RUN_PROJ's state.json)
  env HOME="$HOME_FIX" bun -e "import fs from 'node:fs'; const s=JSON.parse(fs.readFileSync('$RUN_PROJ/seats/state.json','utf8'));const v=s.seats['$1']?.['$2'];if(v!=null)console.log(typeof v==='object'?JSON.stringify(v):v)"
}
wait_for() {   # file, regex; legacy seconds argument is not a verdict
  local seat producer
  seat="$(basename "$1" .jsonl)"
  producer="$(state_get "$seat" pid)"
  [ -n "$producer" ] || { echo "missing producer for $1" >&2; return 1; }
  bun "$HERE/fixtures/adapter-selftest-signals.ts" regex "$1" "$2" 0 "$producer"
}

phase "0. owned lifecycle events reject premature completion"
if bun "$HERE/fixtures/adapter-selftest-signals.ts" selftest "$FIX/lifecycle"; then
  pass 'lifecycle waits consume actual delayed text/count and owned FIFO release'
else
  fail 'lifecycle ownership regression'
fi

LOG_A="$PROJ/seats/logs/worker-a.jsonl"
LOG_B="$PROJ/seats/logs/worker-b.jsonl"

# --- the two-seat exercise, parameterized so the canary can reuse it ---------
# Spawns both seats of $RUN_PROJ, dispatches barrier-held bead-a/bead-b
# (each naming its own worktree), proves overlap before release, and
# asserts log/worktree isolation. $1 = label. Each worker seat works in its
# own adapter-made worktree, .wheelhouse-worktrees/<seat>, on fleet/<bead>.
run_two_seat_exercise() {
  local label="$1" turn_logs_ok=0
  EXERCISE_SETUP=0; EXERCISE_SHARED_LOG=0
  local wta="$RUN_PROJ/.wheelhouse-worktrees/worker-a" wtb="$RUN_PROJ/.wheelhouse-worktrees/worker-b"
  local la="$RUN_PROJ/seats/logs/worker-a.jsonl" lb="$RUN_PROJ/seats/logs/worker-b.jsonl"

  run spawn worker-a
  if [ $RC -eq 0 ]; then pass "${label}: worker-a spawns"; else fail "${label}: worker-a spawn exited ${RC}: $OUT"; return; fi
  run spawn worker-b
  if [ $RC -eq 0 ]; then pass "${label}: worker-b spawns"; else fail "${label}: worker-b spawn exited ${RC}: $OUT"; return; fi

  local fa fb
  fa="$(state_get worker-a fifo)"; fb="$(state_get worker-b fifo)"
  if [ -n "$fa" ] && [ -n "$fb" ] && [ "$fa" != "$fb" ] && [ -p "$fa" ] && [ -p "$fb" ]; then
    pass "${label}: each seat has its OWN FIFO ($(basename "$fa"), $(basename "$fb"))"
    EXERCISE_SETUP=1
  else fail "${label}: FIFOs missing or shared (a=$fa b=$fb)"; return; fi

  # Each accepted turn waits for OUR release file, never a guessed duration.
  # Probe acknowledgements are ordered after prompts in each seat's FIFO.
  local barrier="$RUN_PROJ/turn-barrier" barrier_rc=0
  mkdir -p "$barrier"
  rm -f "$barrier/release"
  run dispatch worker-a bead-a "BARRIER:$barrier MARKER-ALPHA work bead-a in WORKDIR:$wta"
  [ $RC -eq 0 ] && pass "${label}: bead-a dispatched to worker-a" || fail "${label}: dispatch a exited ${RC}: $OUT"
  run dispatch worker-b bead-b "BARRIER:$barrier MARKER-BRAVO work bead-b in WORKDIR:$wtb"
  [ $RC -eq 0 ] && pass "${label}: bead-b dispatched to worker-b (before bead-a's turn ended)" || fail "${label}: dispatch b exited ${RC}: $OUT"

  "$NODE_BIN" "$HERE/fixtures/concurrency-barrier.cjs" "$RUN_PROJ" "$barrier" || barrier_rc=$?
  if [ "$barrier_rc" = 0 ]; then pass "${label}: controller observed both held turns before release"
  else fail "${label}: barrier did not prove concurrent turns"; fi

  # Overlap remains held while these independent PID/log/status checks run.
  local pa pb
  pa="$(state_get worker-a pid)"; pb="$(state_get worker-b pid)"
  if kill -0 "$pa" 2>/dev/null && kill -0 "$pb" 2>/dev/null; then
    pass "${label}: overlapping RUNNING — both state.json pids alive at once ($pa, $pb)"
  else fail "${label}: pids not simultaneously alive (a=$pa b=$pb)"; fi
  if grep -q '"agent_start"' "$la" 2>/dev/null && ! grep -q '"agent_end"' "$la" 2>/dev/null \
     && grep -q '"agent_start"' "$lb" 2>/dev/null && ! grep -q '"agent_end"' "$lb" 2>/dev/null; then
    pass "${label}: both turns in flight at the same moment (agent_start seen, no agent_end yet, both logs)"
    turn_logs_ok=1
  else fail "${label}: could not observe both turns in flight simultaneously"; fi
  if [ "$EXERCISE_SETUP" = 1 ] && [ "$(state_get worker-a log)" = "$(state_get worker-b log)" ] && [ -s "$(state_get worker-a log)" ]; then
    EXERCISE_SHARED_LOG=1
    printf 'MEASUREMENT shared-log wrong world: both healthy seat records point to %s\n' "$(state_get worker-a log)"
  fi
  run status
  if says "worker-a" && says "worker-b" && [ "$(printf '%s\n' "$OUT" | grep -c RUNNING)" -ge 2 ]; then
    pass "${label}: status shows both seats RUNNING"
  else fail "${label}: status does not show two RUNNING seats: $OUT"; fi

  touch "$barrier/release"
  if [ "$turn_logs_ok" = 1 ]; then
    wait_for "$la" '"agent_end"' 15 && pass "${label}: worker-a's turn finished" || fail "${label}: no agent_end in worker-a's log"
    wait_for "$lb" '"agent_end"' 15 && pass "${label}: worker-b's turn finished" || fail "${label}: no agent_end in worker-b's log"
  fi # A barrier-acknowledged wrong log was already measured, not a time budget.

  # Log isolation — and, through it, FIFO isolation: each dispatch was
  # written to one FIFO, so its echo landing only in that seat's log is the
  # no-cross-talk proof.
  if grep -q 'MARKER-ALPHA' "$la" 2>/dev/null && selftest_capture_lacks "$lb" -q -- 'MARKER-ALPHA'; then
    pass "${label}: worker-a's events land ONLY in worker-a's log"
  else fail "${label}: worker-a's dispatch text leaked into worker-b's log (or missing from its own)"; fi
  if grep -q 'MARKER-BRAVO' "$lb" 2>/dev/null && selftest_capture_lacks "$la" -q -- 'MARKER-BRAVO'; then
    pass "${label}: worker-b's events land ONLY in worker-b's log"
  else fail "${label}: worker-b's dispatch text leaked into worker-a's log (or missing from its own)"; fi

  # Worktree isolation: each seat's work footprint is in its own seat
  # worktree and nowhere else, and the worktrees sit on distinct branches.
  if [ -f "$wta/touched-by-bead-a" ] && [ ! -e "$wta/touched-by-bead-b" ] \
     && [ -f "$wtb/touched-by-bead-b" ] && [ ! -e "$wtb/touched-by-bead-a" ]; then
    pass "${label}: each seat's work landed only in its own seat worktree"
  else fail "${label}: worktree cross-write (or missing footprint): $(ls "$wta" "$wtb" 2>&1 | tr '\n' ' ')"; fi
  local ba bb
  ba="$(git -C "$wta" branch --show-current 2>/dev/null)"
  bb="$(git -C "$wtb" branch --show-current 2>/dev/null)"
  if [ "$ba" = "fleet/bead-a" ] && [ "$bb" = "fleet/bead-b" ]; then
    pass "${label}: the two worktrees are on distinct fleet/<bead> branches"
  else fail "${label}: worktree branches wrong (a=$ba b=$bb)"; fi

  run stop worker-a
  [ $RC -eq 0 ] && pass "${label}: worker-a stops cleanly" || fail "${label}: worker-a stop exited ${RC}: $OUT"
  run stop worker-b
  [ $RC -eq 0 ] && pass "${label}: worker-b stops cleanly" || fail "${label}: worker-b stop exited ${RC}: $OUT"
}

phase "1. two seats, one roster — spawn, overlap, isolation, clean stop"
run_two_seat_exercise "hermetic"

phase "1b. state.json concurrent writers preserve both seat records"
run_state_race() { # label delay-ms project
  local label="$1" delay="$2" race_proj="$3"
  build_proj "$race_proj" race
  RUN_PROJ="$race_proj"
  local safe_label
  safe_label="$(printf '%s' "$label" | tr ' /' '__')"
  OUT_A="$FIX/${safe_label}-a.out"; OUT_B="$FIX/${safe_label}-b.out"
  env HOME="$HOME_FIX" PATH="$RUN_PATH" WHEELHOUSE_SKIP_BD=1 WHEELHOUSE_CLEANUP=0 WHEELHOUSE_STATE_WRITE_DELAY_MS="$delay" bun "$RUN_PROJ/seats/adapter.ts" spawn worker-a >"$OUT_A" 2>&1 & PA=$!
  env HOME="$HOME_FIX" PATH="$RUN_PATH" WHEELHOUSE_SKIP_BD=1 WHEELHOUSE_CLEANUP=0 WHEELHOUSE_STATE_WRITE_DELAY_MS="$delay" bun "$RUN_PROJ/seats/adapter.ts" spawn worker-b >"$OUT_B" 2>&1 & PB=$!
  wait "$PA"; RCA=$?
  wait "$PB"; RCB=$?
  if [ $RCA -eq 0 ] && [ $RCB -eq 0 ]; then pass "$label: concurrent spawns both exit 0"
  else fail "$label: concurrent spawns failed (a=$RCA $(cat "$OUT_A") / b=$RCB $(cat "$OUT_B"))"; launch_diagnostics; fi
  if [ -n "$(state_get worker-a pid)" ] && [ -n "$(state_get worker-b pid)" ]; then
    pass "$label: state lock preserves both seat records in state.json"
  else fail "$label: one seat record was erased from state.json: $(cat "$RUN_PROJ/seats/state.json" 2>/dev/null)"; fi
  run stop worker-a >/dev/null 2>&1
  run stop worker-b >/dev/null 2>&1
  RUN_PROJ="$PROJ"
}
run_state_race "race no-delay" 0 "$FIX/race-proj-no-delay"
race_passes=0
for i in 1 2 3 4 5 6 7 8 9 10; do
  before_fail=$FAILED
  run_state_race "race delay-300ms run $i/10" 300 "$FIX/race-proj-delay-$i"
  if [ "$FAILED" = "$before_fail" ]; then race_passes=$((race_passes + 1)); fi
done
if [ "$race_passes" = 10 ]; then
  pass "race delay-300ms summary: 10/10 preserved both seat records"
else
  fail "race delay-300ms summary: only $race_passes/10 preserved both seat records"
fi
RUN_PROJ="$PROJ"

phase "2. capacity visibility — a quota-shaped failure is stamped and rendered"
run spawn worker-a
run dispatch worker-a bead-q "QUOTA please"
if [ $RC -ne 0 ] && says "dispatch failed"; then
  pass "quota-shaped dispatch fails loudly"
else fail "quota-shaped dispatch did not fail (exit $RC): $OUT"; fi
CAP="$(state_get worker-a lastCapacityEvent)"
if [ -n "$CAP" ] && printf '%s' "$CAP" | grep >/dev/null '429 rate limit'; then
  pass "state.json records lastCapacityEvent with the failure detail: $CAP"
else fail "no lastCapacityEvent in state.json after quota failure (got: $CAP)"; fi
run status
if says "CAPACITY: QUOTA"; then
  pass "adapter status surfaces the capacity event"
else fail "status does not surface the capacity event: $OUT"; fi
FLOOR_OUT="$(env HOME="$HOME_FIX" PATH="$RUN_PATH" COLUMNS=220 LINES=50 NO_COLOR=1 bun "$PROJ/seats/floor.ts" --once 2>&1)"
if printf '%s' "$FLOOR_OUT" | grep >/dev/null 'AMBER.*PARKED/QUOTA.*bun seats/adapter.ts probe worker-a'; then
  pass "floor --once renders the AMBER PARKED/QUOTA line with the re-probe command"
else fail "floor --once has no AMBER PARKED/QUOTA line: $(printf '%s' "$FLOOR_OUT" | grep -i 'worker-a' | sed -n '1,3p')"; fi
FLOOR_STATUS="$(env HOME="$HOME_FIX" PATH="$RUN_PATH" COLUMNS=220 LINES=60 NO_COLOR=1 bun "$PROJ/seats/floor.ts" --once --pin 0 2>&1)"
if printf '%s' "$FLOOR_STATUS" | grep >/dev/null 'capacity QUOTA '; then
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
  CANARY_FAILED_BEFORE=$FAILED
  RUN_PROJ="$CAN_A"
  run_two_seat_exercise "canary" > "$FIX/shared-log-canary.out" 2>&1
  cat "$FIX/shared-log-canary.out"
  if [ "$EXERCISE_SETUP" = 1 ] && [ "$EXERCISE_SHARED_LOG" = 1 ] && [ $FAILED -gt $CANARY_FAILED_BEFORE ]; then
    FAILED=$CANARY_FAILED_BEFORE
    pass "canary: an adapter that merges both seats into one log is caught"
  else
    FAILED=$((CANARY_FAILED_BEFORE + 1))
    fail "canary: a shared-log adapter PASSED the isolation checks — they prove nothing"
  fi
  RUN_PROJ="$CAN_A" run stop worker-a > /dev/null 2>&1
  RUN_PROJ="$CAN_A" run stop worker-b > /dev/null 2>&1
fi

# Force B to queue behind A's completion, retaining healthy distinct seats.
CAN_SERIAL="$FIX/can-serial"
build_proj "$CAN_SERIAL" can-serial
CANARY_FAILED_BEFORE=$FAILED
RUN_PROJ="$CAN_SERIAL"
WHEELHOUSE_CONCURRENCY_SERIAL_TURNS=1 run_two_seat_exercise "serialized canary" > "$FIX/serialized-canary.out" 2>&1
if [ "$FAILED" -gt "$CANARY_FAILED_BEFORE" ] && grep -F 'barrier did not prove concurrent turns' "$FIX/serialized-canary.out" >/dev/null; then
  FAILED=$CANARY_FAILED_BEFORE
  pass 'canary: serialized turns fail the same barrier assertion'
  printf 'BEGIN expected non-overlap failure evidence\n'; cat "$FIX/serialized-canary.out"; printf 'END expected non-overlap failure evidence\n'
else
  FAILED=$((CANARY_FAILED_BEFORE + 1))
  fail 'canary: non-overlapping turns escaped the barrier assertion'
fi

# Record an actual native child exit and stderr before fixture cleanup.
CAN_EXIT="$FIX/can-exit"
build_proj "$CAN_EXIT" can-exit
RUN_PROJ="$CAN_EXIT"
WHEELHOUSE_CONCURRENCY_STUB_EXIT=23 run spawn worker-a
EXIT_RECORD="$HOME_FIX/.pi-seats-can-exit/worker-a/stub-launch.json"
if [ "$RC" != 0 ] && "$NODE_BIN" -e 'const fs=require("fs"),p=process.argv[1],r=JSON.parse(fs.readFileSync(p)); if(r.code!==23 || r.signal!==null || !r.exited || !fs.readFileSync(p.replace("stub-launch.json","stub-stderr.log"),"utf8").includes("fixture forced launch exit 23")) process.exit(1); console.log("captured native fixture child exit="+r.code+" signal="+r.signal)' "$EXIT_RECORD"; then
  pass 'canary: launch exit cause and stderr retained before teardown'
else fail 'canary: launch exit diagnostics missing or wrong'; fi

# 3b: an adapter that swallows the capacity stamp.
CAN_B="$FIX/can-b"
build_proj "$CAN_B" can-b
sed 's|^        state.seats\[name\].lastCapacityEvent = {$|        const unstamped = {|' \
  "$ADAPTER" > "$CAN_B/seats/adapter.ts"
if cmp -s "$ADAPTER" "$CAN_B/seats/adapter.ts"; then
  fail "canary: could not cut the capacity stamp — the line no longer matches, so the canary proves nothing"
else
  RUN_PROJ="$CAN_B"
  run spawn worker-a > /dev/null 2>&1
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
  selftest_copy_seat_runtime "$RPROJ" "$HERE"
  printf '# Fleet: Worker\n\nfixture brief.\n' > "$RPROJ/contracts/WORKER.md"
  init_fixture_repo "$RPROJ"
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
  rrun() { RC=0; OUT="$(env HOME="$RHOME" PATH="$REAL_PATH" WHEELHOUSE_SKIP_BD=1 WHEELHOUSE_CLEANUP=0 WHEELHOUSE_RPC_TIMEOUT_MS=90000 bun "$RPROJ/seats/adapter.ts" "$@" 2>&1)" || RC=$?; }
  RLOG_A="$RPROJ/seats/logs/worker-a.jsonl"
  RLOG_B="$RPROJ/seats/logs/worker-b.jsonl"

  rrun spawn worker-a
  [ $RC -eq 0 ] && pass "real: worker-a spawns ($OUT)" || fail "real: worker-a spawn exited ${RC}: $OUT"
  rrun spawn worker-b
  [ $RC -eq 0 ] && pass "real: worker-b spawns ($OUT)" || fail "real: worker-b spawn exited ${RC}: $OUT"
  # Concurrent dispatch: bead-b goes out before bead-a's turn is waited on.
  rrun dispatch worker-a real-a "Reply with exactly the text REAL-CONC-ALPHA and nothing else. Use no tools."
  [ $RC -eq 0 ] && pass "real: bead real-a dispatched" || fail "real: dispatch a exited ${RC}: $OUT"
  A_DONE_AT_B_DISPATCH="no"
  grep -q '"agent_end"' "$RLOG_A" 2>/dev/null && A_DONE_AT_B_DISPATCH="yes"
  rrun dispatch worker-b real-b "Reply with exactly the text REAL-CONC-BRAVO and nothing else. Use no tools."
  [ $RC -eq 0 ] && pass "real: bead real-b dispatched (worker-a's turn already ended at that moment: $A_DONE_AT_B_DISPATCH)" \
                || fail "real: dispatch b exited ${RC}: $OUT"
  RUN_PROJ="$RPROJ" wait_for "$RLOG_A" '"agent_end"' 180 && pass "real: worker-a agent_end captured" || fail "real: no agent_end for worker-a — tail: $(tail -c 300 "$RLOG_A" 2>/dev/null)"
  RUN_PROJ="$RPROJ" wait_for "$RLOG_B" '"agent_end"' 180 && pass "real: worker-b agent_end captured" || fail "real: no agent_end for worker-b — tail: $(tail -c 300 "$RLOG_B" 2>/dev/null)"
  if grep -q 'REAL-CONC-ALPHA' "$RLOG_A" 2>/dev/null && ! grep -q 'REAL-CONC-ALPHA' "$RLOG_B" 2>/dev/null \
     && grep -q 'REAL-CONC-BRAVO' "$RLOG_B" 2>/dev/null && ! grep -q 'REAL-CONC-BRAVO' "$RLOG_A" 2>/dev/null; then
    pass "real: logs are disjoint — each seat's turn landed only in its own log"
  else fail "real: cross-contamination between the two real seats' logs"; fi
  rrun stop worker-a
  [ $RC -eq 0 ] && pass "real: worker-a stops cleanly" || fail "real: worker-a stop exited ${RC}: $OUT"
  rrun stop worker-b
  [ $RC -eq 0 ] && pass "real: worker-b stops cleanly" || fail "real: worker-b stop exited ${RC}: $OUT"
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
