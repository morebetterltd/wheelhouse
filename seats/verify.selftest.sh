#!/usr/bin/env bash

SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"
#
# verify.selftest.sh — does verify.ts still do what seats/README.md claims,
# on THIS machine?
#
# Hermetic: every phase but the last runs against a stub `pi` — a node script
# that records its argv and environment, prints a scripted reply, and exits —
# in a temp HOME on a private PATH, so your real seats and your real pi are
# never touched or required. The scripted replies drive all four verdict
# paths: APPROVE, BOUNCE, DISCOVER, and the malformed output that must map
# to an error, not a judgment — plus the heterogeneous-evidence gate: bead-
# named artifacts committed on the branch, floor-checked at the tip, where
# an APPROVE over a missing/empty/mistyped artifact must be exit 1.
#
# The self-approval case is the one this tool exists for: an author seat and
# a verifier seat resolving to the SAME account directory must be a STOP
# BEFORE anything spawns — asserted by checking the stub was never invoked.
#
# The canary phase sabotages COPIES of verify.ts — once with the account-
# distinctness gate disarmed, once with the verdict-file write cut — and
# checks these tests notice. Each sabotage is guarded with cmp: if the sed
# no longer bites, the canary says so instead of proving nothing.
#
# The last phase is ONE real-pi smoke leg (SKIP-able): a fixture project
# whose REVIEWER.md brief is a scripted-reply instruction, so one trivial
# model turn proves the spawn/parse/record plumbing against the real binary.
# It borrows your login the way adapter.selftest.sh does; no pi, no login,
# or WHEELHOUSE_SKIP_REAL_PI=1 each print a SKIP line and the hermetic
# phases still decide the exit code.
#
# Usage: verify.selftest.sh [path-to-verify.ts]
#
# Exit 0 = verify.ts works here. Non-zero = read the FAIL lines: a failure
# in phases 1-8 or the real leg means verify.ts broke; a canary failure
# means these checks cannot be trusted to tell you either way.

set -uo pipefail   # deliberately not -e: half these cases are meant to fail

HERE="$(cd "$(dirname "$0")" && pwd)"
VERIFY="${1:-$HERE/verify.ts}"
VERIFY_DIR="$(cd "$(dirname "$VERIFY")" && pwd)"
BRIEFS="$VERIFY_DIR/briefs.ts"
HARNESS="$VERIFY_DIR/harness.ts"
HOST_BUDGET_TS="$VERIFY_DIR/host-budget.ts"
REAL_FIXTURES_DIR="$VERIFY_DIR/fixtures/verify-real"
[ -f "$VERIFY" ] || { echo "selftest: not found: $VERIFY" >&2; exit 2; }
[ -f "$HARNESS" ] || { echo "selftest: not found: $HARNESS" >&2; exit 2; }
[ -f "$BRIEFS" ] || { echo "selftest: not found: $BRIEFS" >&2; exit 2; }
command -v bun >/dev/null 2>&1 || { echo "selftest: bun is required to run verify.ts" >&2; exit 2; }
NODE_BIN="$(command -v node)" || { echo "selftest: node is required for the stub pi" >&2; exit 2; }
GIT_BIN="$(command -v git)" || { echo "selftest: git is required" >&2; exit 2; }
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

cleanup() { selftest_cleanup_fixture_processes "${FIX:-}" "${SOCK:-}"; [ -n "$FIX" ] && rm -rf "$FIX"; return 0; }
trap cleanup EXIT INT TERM

# --- fixture -----------------------------------------------------------------
# Canonicalized for the same reason the other seat selftests canonicalize: on
# macOS mktemp hands out /var/... paths that are really /private/var/...
# --- stale-fixture sweep -----------------------------------------------------
# The EXIT trap below cannot run on SIGKILL, so a killed selftest leaves its
# fixture dir behind (verify's pi runs are one-shot, so unlike the adapter
# selftest no live seat should outlive it — the sweep still checks). Fixture
# dirs are pid-stamped (wheelhouse-verify-selftest.<pid>.XXXXXX) so a later
# run can tell a dead owner from a live one. The sweep kills only pids that a
# fixture's own state.json records AND that still hold files open under that
# fixture — the fd-based identity rule recover.ts uses, because a pid number
# alone proves nothing after reuse — then removes the dir, printing
# everything it swept.
FIX_PREFIX="wheelhouse-verify-selftest"
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
RUN_PATH="${BIN}:$(dirname "$(command -v bun)"):$(dirname "$NODE_BIN"):$(dirname "$GIT_BIN"):/usr/bin:/bin"

# The stub pi: one shot. Records argv and PI_CODING_AGENT_DIR into the agent
# dir, touches an "invoked" marker, prints the scripted reply named by
# STUB_REPLY_FILE, exits STUB_EXIT (default 0). No sessions, no protocol —
# the one-shot path is argv in, stdout out, and that is what gets asserted.
cat > "$BIN/pi" <<'STUB'
#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const agentDir = process.env.PI_CODING_AGENT_DIR;
if (!agentDir) { process.stderr.write("stub pi: no PI_CODING_AGENT_DIR\n"); process.exit(1); }
fs.mkdirSync(agentDir, { recursive: true });
fs.writeFileSync(path.join(agentDir, "argv.json"), JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(path.join(agentDir, "invoked"), "");
fs.writeFileSync(path.join(agentDir, "pi-pid.txt"), String(process.pid));
// The dispatcher must set BEADS_ACTOR in OUR env by construction (adapter.ts's
// beadsActorFor mirrored here for the verifier), not rely on an operator
// export reaching this one-shot process.
fs.writeFileSync(path.join(agentDir, "env.json"), JSON.stringify({ BEADS_ACTOR: process.env.BEADS_ACTOR ?? null, PATH: process.env.PATH ?? null }));
// The dispatcher sets our cwd by construction (a scratch worktree), not by
// telling us in a prompt to stay off the live checkout. Recording it here
// lets the selftest see what the OS-level cwd actually was.
fs.writeFileSync(path.join(agentDir, "cwd.txt"), process.cwd());
if (process.env.STUB_CANONICAL_WRITE_REPO) {
  const cp = require("child_process");
  const repo = process.env.STUB_CANONICAL_WRITE_REPO;
  let status = "not-run";
  try {
    cp.execFileSync("git", ["-C", repo, "checkout", "--", "canonical-guard.txt"], { env: process.env, stdio: "pipe" });
    status = "ok";
  } catch (e) {
    status = `failed:${e.status ?? e.code ?? "unknown"}`;
  }
  fs.writeFileSync(path.join(agentDir, "canonical-write-attempt.txt"), `repo=${repo}\nstatus=${status}\ncwd=${process.cwd()}\nGIT_WORK_TREE=${process.env.GIT_WORK_TREE ?? ""}\n`);
}
const reply = process.env.STUB_REPLY_FILE;
let text = reply ? fs.readFileSync(reply, "utf8") : "";
if (process.env.STUB_MOVE_BRANCH_REPO && process.env.STUB_MOVE_BRANCH) {
  const cp = require("child_process");
  const repo = process.env.STUB_MOVE_BRANCH_REPO;
  const branch = process.env.STUB_MOVE_BRANCH;
  const gitEnv = { ...process.env };
  delete gitEnv.GIT_DIR;
  delete gitEnv.GIT_WORK_TREE;
  const pinned = cp.execFileSync("git", ["-C", repo, "rev-parse", `${branch}^{commit}`], { encoding: "utf8", env: gitEnv }).trim();
  cp.execFileSync("git", ["-C", repo, "checkout", "-q", branch], { env: gitEnv });
  fs.writeFileSync(path.join(repo, "midpass-move.txt"), `moved ${Date.now()}\n`);
  cp.execFileSync("git", ["-C", repo, "add", "midpass-move.txt"], { env: gitEnv });
  cp.execFileSync("git", ["-C", repo, "-c", "user.email=selftest@local", "-c", "user.name=selftest", "commit", "-q", "-m", "mid-pass move"], { env: gitEnv });
  const moved = cp.execFileSync("git", ["-C", repo, "rev-parse", `${branch}^{commit}`], { encoding: "utf8", env: gitEnv }).trim();
  text = text.replaceAll("__PINNED__", pinned).replaceAll("__MOVED__", moved);
}
const streamRequested = process.argv.includes("--mode") && process.argv[process.argv.indexOf("--mode") + 1] === "json";
if (process.env.STUB_STREAM_FILE) {
  process.stdout.write(fs.readFileSync(process.env.STUB_STREAM_FILE, "utf8"));
  process.exit(Number(process.env.STUB_EXIT || 0));
}
if (process.env.STUB_STALL === "1") {
  // Match real pi behavior: without --mode json, a stalled one-shot emits no
  // JSON events before timeout, so this selftest catches a missing stream flag.
  if (streamRequested) {
    process.stdout.write(JSON.stringify({type:"tool_execution_start",toolName:"bash",args:{cmd:"cargo test"}})+"\n");
  }
  setTimeout(() => {}, 10000);
} else {
  if (!process.env.STUB_SUPPRESS_DEFAULT_PUSH && text && !/^PUSH:/m.test(text)) text += "PUSH:    NOT CONSIDERED\n";
  if (streamRequested) process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:text}})+"\n");
  else process.stdout.write(text);
  process.exit(Number(process.env.STUB_EXIT || 0));
}
STUB
chmod +x "$BIN/pi"
cat > "$BIN/claude" <<'STUB'
#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const agentDir = process.env.CLAUDE_CONFIG_DIR;
if (!agentDir) { process.stderr.write("stub claude: no CLAUDE_CONFIG_DIR\n"); process.exit(1); }
fs.mkdirSync(agentDir, { recursive: true });
fs.writeFileSync(path.join(agentDir, "argv.json"), JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(path.join(agentDir, "invoked"), "");
fs.writeFileSync(path.join(agentDir, "env.json"), JSON.stringify({ BEADS_ACTOR: process.env.BEADS_ACTOR ?? null, PATH: process.env.PATH ?? null, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR ?? null }));
fs.writeFileSync(path.join(agentDir, "cwd.txt"), process.cwd());
const reply = process.env.STUB_REPLY_FILE;
const text = reply ? fs.readFileSync(reply, "utf8") : "";
if (process.env.STUB_STREAM_FILE) {
  process.stdout.write(fs.readFileSync(process.env.STUB_STREAM_FILE, "utf8"));
  process.exit(Number(process.env.STUB_EXIT || 0));
}
const streamRequested = process.argv.includes("--output-format") && process.argv[process.argv.indexOf("--output-format") + 1] === "stream-json";
if (streamRequested) {
  process.stdout.write(JSON.stringify({type:"assistant",message:{role:"assistant",content:[{type:"text",text}]}})+"\n");
  process.stdout.write(JSON.stringify({type:"result",subtype:"success",result:text})+"\n");
} else process.stdout.write(text);
process.exit(Number(process.env.STUB_EXIT || "0"));
STUB
cat > "$BIN/codex" <<'STUB'
#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const agentDir = process.env.CODEX_HOME;
if (!agentDir) { process.stderr.write("stub codex: no CODEX_HOME\n"); process.exit(1); }
fs.mkdirSync(agentDir, { recursive: true });
fs.writeFileSync(path.join(agentDir, "argv.json"), JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(path.join(agentDir, "invoked"), "");
fs.writeFileSync(path.join(agentDir, "env.json"), JSON.stringify({ BEADS_ACTOR: process.env.BEADS_ACTOR ?? null, PATH: process.env.PATH ?? null, CODEX_HOME: process.env.CODEX_HOME ?? null, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR ?? null }));
fs.writeFileSync(path.join(agentDir, "cwd.txt"), process.cwd());
const reply = process.env.STUB_REPLY_FILE;
const text = reply ? fs.readFileSync(reply, "utf8") : "";
if (process.env.STUB_STREAM_FILE) {
  process.stdout.write(fs.readFileSync(process.env.STUB_STREAM_FILE, "utf8"));
  process.exit(Number(process.env.STUB_EXIT || 0));
}
const streamRequested = process.argv.includes("--json");
if (streamRequested) {
  process.stdout.write(JSON.stringify({type:"item.completed",item:{type:"agent_message",text}})+"\n");
  process.stdout.write(JSON.stringify({type:"turn.completed",usage:{}})+"\n");
} else process.stdout.write(text);
process.exit(Number(process.env.STUB_EXIT || "0"));
STUB
chmod +x "$BIN/claude" "$BIN/codex"
[ -x "$BIN/pi" ] || { echo "selftest: fixture stub pi was not created" >&2; exit 2; }

# A fixture project: verify.ts expects to live at <root>/seats/verify.ts with
# the brief at <root>/contracts/REVIEWER.md, and the root to be a git repo
# holding the branch under review.
SENTINEL='SENTINEL-TOKEN-9c2e'
build_proj() {   # $1 = project dir, $2 = seat namespace, $3 = verify.ts source
  local proj="$1" ns="$2" src="$3" d
  mkdir -p "$proj/seats" "$proj/contracts"
  cp "$src" "$proj/seats/verify.ts"
  cp "$BRIEFS" "$proj/seats/briefs.ts"
  cp "$HARNESS" "$proj/seats/harness.ts"
  cp "$HOST_BUDGET_TS" "$proj/seats/host-budget.ts"
  printf '# Crew: Reviewer\n\nfixture brief — the stub never reads it, the argv check does.\n' \
    > "$proj/contracts/REVIEWER.md"
  cat > "$proj/seats/seats.json" <<EOF
{
  "commander": { "role": "commander", "external": true, "runtime": "claude-code" },
  "seats": {
    "worker-1": {
      "role": "worker",
      "provider": "anthropic",
      "model": "stub-model-1",
      "account": { "dir": "~/.pi-seats-$ns/worker-1" }
    },
    "verifier": {
      "role": "verifier",
      "provider": "openai",
      "model": "stub-model-v",
      "account": { "dir": "~/.pi-seats-$ns/verifier" }
    }
  }
}
EOF
  for d in worker-1 verifier; do
    mkdir -p "$HOME_FIX/.pi-seats-$ns/$d"
    printf '{\n  "%s": true\n}\n' "$proj" > "$HOME_FIX/.pi-seats-$ns/$d/trust.json"
    printf '{"stub":"%s"}\n' "$SENTINEL" > "$HOME_FIX/.pi-seats-$ns/$d/auth.json"
  done
  ( cd "$proj" &&
    git init -q &&
    git -c user.email=selftest@local -c user.name=selftest commit -q --allow-empty -m base &&
    git branch fleet/bead-1 ) || { echo "selftest: could not build fixture git repo" >&2; exit 2; }
}

build_installed_proj() {   # $1 = project dir, $2 = seat namespace, $3 = verify.ts source
  local proj="$1" ns="$2" src="$3"
  build_proj "$proj" "$ns" "$src"
  rm -rf "$proj/contracts"
  mkdir -p "$proj/wheelhouse/fleet" "$proj/wheelhouse/crew"
  printf '# Crew: Reviewer\n\ninstalled-layout reviewer brief.\n' > "$proj/wheelhouse/crew/REVIEWER.md"
}

build_umbrella_proj() {   # $1 = umbrella dir, $2 = seat namespace, $3 = verify.ts source
  local umb="$1" ns="$2" src="$3" product="$1/product"
  mkdir -p "$umb/seats" "$umb/contracts" "$product"
  cp "$src" "$umb/seats/verify.ts"
  cp "$BRIEFS" "$umb/seats/briefs.ts"
  cp "$HARNESS" "$umb/seats/harness.ts"
  cp "$HOST_BUDGET_TS" "$umb/seats/host-budget.ts"
  printf '# Crew: Reviewer\n\numbrella reviewer brief.\n' > "$umb/contracts/REVIEWER.md"
  cat > "$umb/seats/seats.json" <<EOF
{
  "commander": { "role": "commander", "external": true, "runtime": "claude-code" },
  "seats": {
    "worker-1": {
      "role": "worker",
      "provider": "anthropic",
      "model": "stub-model-1",
      "account": { "dir": "~/.pi-seats-$ns/worker-1" }
    },
    "verifier": {
      "role": "verifier",
      "provider": "openai",
      "model": "stub-model-v",
      "account": { "dir": "~/.pi-seats-$ns/verifier" }
    }
  }
}
EOF
  for d in worker-1 verifier; do
    mkdir -p "$HOME_FIX/.pi-seats-$ns/$d"
    printf '{\n  "%s": true\n}\n' "$umb" > "$HOME_FIX/.pi-seats-$ns/$d/trust.json"
    printf '{"stub":"%s"}\n' "$SENTINEL" > "$HOME_FIX/.pi-seats-$ns/$d/auth.json"
  done
  ( cd "$product" &&
    git init -q &&
    mkdir -p evidence && printf 'product branch evidence\n' > evidence/bench.log &&
    git add evidence/bench.log &&
    git -c user.email=selftest@local -c user.name=selftest commit -q -m base &&
    git branch fleet/bead-1 ) || { echo "selftest: could not build umbrella product git repo" >&2; exit 2; }
}

PROJ="$FIX/proj"
build_proj "$PROJ" alpha "$VERIFY"
TIP="$(git -C "$PROJ" rev-parse fleet/bead-1)"

REPLY="$FIX/reply.txt"
run() {   # runs verify.ts in the fixture; args pass through
  # BEADS_ACTOR unset on purpose: the dispatcher must set it in the spawned
  # verifier's own env by construction, not forward whatever this shell has.
  OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_REPLY_FILE="$REPLY" \
    bun "$RUN_PROJ/seats/verify.ts" "$@" 2>&1)"
  RC=$?
}
run_without_default_push() {
  OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_REPLY_FILE="$REPLY" STUB_SUPPRESS_DEFAULT_PUSH=1 \
    bun "$RUN_PROJ/seats/verify.ts" "$@" 2>&1)"
  RC=$?
}
run_stream() {  # $1 = JSONL stream file, remaining args pass through
  local stream="$1"
  shift
  OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_STREAM_FILE="$stream" \
    bun "$RUN_PROJ/seats/verify.ts" "$@" 2>&1)"
  RC=$?
}
says() { case "$OUT" in *"$1"*) return 0 ;; *) return 1 ;; esac; }
RUN_PROJ="$PROJ"
VDIR="$PROJ/seats/verdicts"
VARGV="$HOME_FIX/.pi-seats-alpha/verifier/argv.json"
VINVOKED="$HOME_FIX/.pi-seats-alpha/verifier/invoked"
VCWD="$HOME_FIX/.pi-seats-alpha/verifier/cwd.txt"

phase "installed layout — wheelhouse/crew brief is preferred without contracts/"
INST_PROJ="$FIX/installed-proj"
build_installed_proj "$INST_PROJ" installed "$VERIFY"
RUN_PROJ="$INST_PROJ"
VARGV="$HOME_FIX/.pi-seats-installed/verifier/argv.json"
INST_TIP="$(git -C "$INST_PROJ" rev-parse fleet/bead-1)"
cat > "$REPLY" <<EOF
Checked installed-layout fixture at $INST_TIP.
VERDICT: APPROVE
EOF
run bead-installed fleet/bead-1 worker-1
if [ $RC -eq 0 ]; then pass "installed layout: APPROVE exits 0 with no contracts/ directory"
else fail "installed layout: verify exited ${RC}: $OUT"; fi
if grep -q "\"--append-system-prompt\",\"$INST_PROJ/wheelhouse/crew/REVIEWER.md\"" "$VARGV" 2>/dev/null; then
  pass "installed layout: verifier brief resolves to wheelhouse/crew/REVIEWER.md"
else fail "installed layout: verifier brief was not the installed path"; fi
MISS_PROJ="$FIX/missing-brief-proj"
build_proj "$MISS_PROJ" missing "$VERIFY"
rm -rf "$MISS_PROJ/contracts" "$MISS_PROJ/wheelhouse"
RUN_PROJ="$MISS_PROJ"
run bead-missing fleet/bead-1 worker-1
if [ $RC -ne 0 ] && says "$MISS_PROJ/wheelhouse/crew/REVIEWER.md" && says "$MISS_PROJ/contracts/REVIEWER.md"; then
  pass "missing brief: STOP names both installed and template paths tried"
else fail "missing brief: STOP did not name both paths (exit $RC): $OUT"; fi
RUN_PROJ="$PROJ"
VARGV="$HOME_FIX/.pi-seats-alpha/verifier/argv.json"

phase "multi-repo umbrella layout — --repo selects the product repository"
UMB_PROJ="$FIX/umbrella"
build_umbrella_proj "$UMB_PROJ" umbrella "$VERIFY"
RUN_PROJ="$UMB_PROJ"
VARGV="$HOME_FIX/.pi-seats-umbrella/verifier/argv.json"
UMB_TIP="$(git -C "$UMB_PROJ/product" rev-parse fleet/bead-1)"
cat > "$REPLY" <<EOF
Checked product repo tip $UMB_TIP and its committed evidence.
VERDICT: APPROVE
EOF
run bead-umbrella fleet/bead-1 worker-1 --repo product --evidence evidence/bench.log
if [ $RC -eq 0 ]; then pass "umbrella layout: APPROVE exits 0 when --repo names the product repo"
else fail "umbrella layout: verify exited ${RC}: $OUT"; fi
if grep -q "branch-repo: $UMB_PROJ/product" "$UMB_PROJ/seats/verdicts/bead-umbrella.md" 2>/dev/null \
   && grep -q "evidence/bench.log — exists, .* bytes, non-empty — OK" "$UMB_PROJ/seats/verdicts/bead-umbrella.md" 2>/dev/null; then
  pass "umbrella layout: verdict records the product repo and product-relative evidence floor check"
else fail "umbrella layout: verdict did not record product repo and evidence check"; fi
run bead-umbrella-missing fleet/bead-1 worker-1 --evidence evidence/bench.log
if [ $RC -eq 1 ] && says "does not resolve" && says "$UMB_PROJ"; then
  pass "umbrella layout: omitting --repo still measures the umbrella root and refuses the product branch"
else fail "umbrella layout: missing --repo did not fail against the umbrella root (exit $RC): $OUT"; fi
RUN_PROJ="$PROJ"
VARGV="$HOME_FIX/.pi-seats-alpha/verifier/argv.json"

phase "0b. timeout — last phase and partial verifier output are retained"
OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_STALL=1 bun "$RUN_PROJ/seats/verify.ts" bead-1 fleet/bead-1 worker-1 verifier --timeout-ms 300 2>&1)"; RC=$?
if [ $RC -eq 1 ] && says "timed out after 300ms" && says "elapsed" && says "last phase: tool bash started" && says "partial output:"; then
  pass "timeout STOP names elapsed time, last tool/phase, and partial output path"
else fail "timeout STOP missing phase/elapsed/partial detail (exit $RC): $OUT"; fi
PARTIAL="$VDIR/bead-1.partial.md"
if [ -s "$PARTIAL" ] && grep -q '## seat tool-call/event log tail' "$PARTIAL" && grep -q 'tool_execution_start' "$PARTIAL" && grep -q 'cargo test' "$PARTIAL"; then
  pass "timeout keeps partial pi output and event-log tail at seats/verdicts/<bead>.partial.md"
else fail "timeout partial file missing event-log tail or streamed tool output: $(cat "$PARTIAL" 2>/dev/null)"; fi
rm -f "$PARTIAL"

phase "1. APPROVE — verdict parsed, recorded, exit 0, and what was launched"
cat > "$REPLY" <<EOF
Checked the done: diff at $TIP adds the thing the bead asks for.
\$ git show --stat fleet/bead-1
 1 file changed
VERDICT: APPROVE
EOF
run bead-1 fleet/bead-1 worker-1
if [ $RC -eq 0 ]; then pass "APPROVE exits 0"
else fail "APPROVE path exited ${RC}: $OUT"; fi
if says "VERDICT: APPROVE"; then pass "the verdict is printed for the dispatcher"
else fail "no VERDICT: APPROVE in output: $OUT"; fi
if [ -f "$VDIR/bead-1.md" ]; then pass "verdict file written to seats/verdicts/bead-1.md"
else fail "no verdict file at $VDIR/bead-1.md"; fi
if grep -q "verdict: APPROVE" "$VDIR/bead-1.md" 2>/dev/null \
   && grep -q "tip: $TIP" "$VDIR/bead-1.md" 2>/dev/null \
   && grep -q "git show --stat" "$VDIR/bead-1.md" 2>/dev/null; then
  pass "verdict file carries verdict, tip SHA, and the evidence excerpt"
else fail "verdict file is missing verdict, tip, or evidence"; fi
if grep -q "Working copy only" "$VDIR/bead-1.md" 2>/dev/null; then
  pass "verdict file names itself a working copy, not an evidence home"
else fail "verdict file does not carry the working-copy warning"; fi
if [ -f "$VARGV" ] && grep -q '"-p","--mode","json","--no-session"' "$VARGV"; then
  pass "pi was launched one-shot with streaming json: -p --mode json --no-session"
else fail "argv.json missing or pi not launched with -p --mode json --no-session: $(cat "$VARGV" 2>/dev/null)"; fi
if grep -q "\"--append-system-prompt\",\"$PROJ/contracts/REVIEWER.md\"" "$VARGV" 2>/dev/null; then
  pass "role brief injected: --append-system-prompt names contracts/REVIEWER.md"
else fail "verifier brief not passed"; fi
if grep -q '"--provider","openai","--model","stub-model-v"' "$VARGV" 2>/dev/null; then
  pass "the VERIFIER seat's provider and model pin the launch (not the author's)"
else fail "verifier provider/model from seats.json did not reach pi's argv"; fi
if grep -q "bead-1" "$VARGV" && grep -q "$TIP" "$VARGV" && grep -q "bd show bead-1" "$VARGV"; then
  pass "prompt carries the bead id, the tip SHA, and the bead-claim reference"
else fail "prompt is missing bead id, tip SHA, or bead claim"; fi
if grep -q '"BEADS_ACTOR":"verifier"' "${VARGV%argv.json}env.json" 2>/dev/null; then
  pass "the ephemeral verifier's own env carries BEADS_ACTOR=verifier, with no operator export"
else fail "verifier env.json was $(cat "${VARGV%argv.json}env.json" 2>/dev/null) — expected BEADS_ACTOR:verifier set by verify.ts itself"; fi
if ! grep -q "$PROJ/seats/bin" "${VARGV%argv.json}env.json" 2>/dev/null; then
  pass "host budget absent: verifier PATH is not rewritten to seats/bin"
else fail "host budget absent: verifier PATH unexpectedly included seats/bin: $(cat "${VARGV%argv.json}env.json" 2>/dev/null)"; fi

# --- scratch cwd: construction, not contract discipline ---------------------
# The verifier's process cwd must be A repository the branch's ref resolves
# from (so its own bare `git diff`/`git show` still work — proven by phase 1
# itself already succeeding, and by phase 8's evidence reads below, both
# unchanged from before this bead), but it must NOT be ${PROJ}: a confused or
# adversarial turn that writes to a relative path must land somewhere that
# dies with the process, not in the live checkout.
SCRATCH_CWD="$(cat "$VCWD" 2>/dev/null)"
if [ -n "$SCRATCH_CWD" ] && [ "$SCRATCH_CWD" != "$PROJ" ]; then
  pass "the verifier's cwd is NOT the project root"
else fail "the verifier's cwd was \"$SCRATCH_CWD\" — expected anything but $PROJ"; fi
case "$SCRATCH_CWD" in
  */wheelhouse-verify-*)
    pass "the verifier's cwd is the scratch worktree makeScratchCwd() creates" ;;
  *) fail "the verifier's cwd \"$SCRATCH_CWD\" does not look like a wheelhouse-verify-* scratch dir" ;;
esac
if git -C "$PROJ" worktree list | grep -qF "$SCRATCH_CWD"; then
  fail "the scratch worktree $SCRATCH_CWD is still registered after verify.ts exited — cleanup did not run"
else pass "the scratch worktree is unregistered after verify.ts exited (process-exit cleanup ran)"; fi
if [ -d "$SCRATCH_CWD" ]; then
  fail "the scratch worktree directory $SCRATCH_CWD still exists on disk after verify.ts exited"
else pass "the scratch worktree directory no longer exists on disk"; fi

cat > "$REPLY" <<EOF
Annotated approve with the GH#34 shape.
VERDICT: APPROVE at pinned $TIP; branch has since moved on origin to moved-tip, same tree
PUSH: NOT CONSIDERED trailing parser annotation
EOF
run_without_default_push bead-1-annotated fleet/bead-1 worker-1
if [ $RC -eq 0 ] && says "VERDICT: APPROVE" && grep -q "verdict: APPROVE at pinned $TIP; branch has since moved on origin to moved-tip, same tree" "$VDIR/bead-1-annotated.md" 2>/dev/null; then
  pass "annotated APPROVE verdict and trailing PUSH text parse"
else fail "annotated APPROVE/PUSH did not parse (exit $RC): $OUT file=$(cat "$VDIR/bead-1-annotated.md" 2>/dev/null)"; fi

printf 'base\n' > "$PROJ/canonical-guard.txt"
git -C "$PROJ" add canonical-guard.txt && git -C "$PROJ" -c user.email=selftest@local -c user.name=selftest commit -q -m canonical-guard
CANONICAL_TIP="$(git -C "$PROJ" rev-parse HEAD)"
git -C "$PROJ" branch -f fleet/bead-1 "$CANONICAL_TIP"
printf 'canonical dirty\n' > "$PROJ/canonical-guard.txt"
cat > "$REPLY" <<'EOF'
Attempted canonical checkout write; dispatcher should pin git to scratch.
VERDICT: APPROVE
PUSH: NOT CONSIDERED — fixture
EOF
OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_REPLY_FILE="$REPLY" STUB_CANONICAL_WRITE_REPO="$PROJ" \
  bun "$RUN_PROJ/seats/verify.ts" bead-canonical fleet/bead-1 worker-1 verifier 2>&1)"; RC=$?
ATTEMPT="$HOME_FIX/.pi-seats-alpha/verifier/canonical-write-attempt.txt"
if [ $RC -eq 0 ] && grep -q 'canonical dirty' "$PROJ/canonical-guard.txt" && grep -q "GIT_WORK_TREE=.*wheelhouse-verify" "$ATTEMPT" 2>/dev/null; then
  pass "canonical checkout git write is pinned to scratch and leaves canonical checkout unchanged"
else fail "canonical checkout changed or attempt was not reported (exit $RC): guard=$(cat "$PROJ/canonical-guard.txt" 2>/dev/null) attempt=$(cat "$ATTEMPT" 2>/dev/null) out=$OUT"; fi
git -C "$PROJ" checkout -q -- canonical-guard.txt
TIP="$CANONICAL_TIP"

cat > "$REPLY" <<EOF
Static half verified; no bench covers the docs deployable this touches.
VERDICT: APPROVE — NOT BENCHED: the docs deployable
EOF
run bead-1nb fleet/bead-1 worker-1
if [ $RC -eq 0 ]; then pass "APPROVE — NOT BENCHED still exits 0"
else fail "NOT BENCHED APPROVE exited ${RC}: $OUT"; fi
if grep -q "verdict: APPROVE — NOT BENCHED: the docs deployable" "$VDIR/bead-1nb.md" 2>/dev/null; then
  pass "the NOT BENCHED qualifier survives into the verdict record"
else fail "NOT BENCHED qualifier lost from the verdict file"; fi
if grep -q "BENCH GAP STANDING" "$VDIR/bead-1nb.md" 2>/dev/null && says "BENCH GAP STANDING"; then
  pass "NOT BENCHED without expiry/target is visible as a standing bench gap"
else fail "standing NOT BENCHED gap was silent: out=$OUT verdict=$(cat "$VDIR/bead-1nb.md" 2>/dev/null)"; fi
cat > "$REPLY" <<EOF
Static half verified; BENCH.md declares this gap expired.
VERDICT: APPROVE — NOT BENCHED: CAR app user journey; expires=2000-01-01
EOF
run bead-1nb-expired fleet/bead-1 worker-1
if [ $RC -eq 0 ] && says "BENCH GAP EXPIRED" && grep -q "BENCH GAP EXPIRED" "$VDIR/bead-1nb-expired.md" 2>/dev/null; then
  pass "expired NOT BENCHED gap passes only with an explicit gate nudge"
else fail "expired NOT BENCHED gap passed silently or failed wrong (exit $RC): $OUT verdict=$(cat "$VDIR/bead-1nb-expired.md" 2>/dev/null)"; fi

phase "1b. branch moves mid-pass — verdict stays pinned, publish waits"
MOVE_PROJ="$FIX/proj-move"
build_proj "$MOVE_PROJ" move "$VERIFY"
RUN_PROJ="$MOVE_PROJ"
VDIR="$MOVE_PROJ/seats/verdicts"
VARGV="$HOME_FIX/.pi-seats-move/verifier/argv.json"
MOVE_PIN="$(git -C "$MOVE_PROJ" rev-parse fleet/bead-1)"
cat > "$REPLY" <<'EOF'
Checked the pinned tip before considering the branch move.
VERDICT: APPROVE — at pinned tip __PINNED__; branch has since moved to __MOVED__ (1 commits appended, history unrewritten)
PUSH: NOT CONSIDERED — branch moved; re-verify at __MOVED__ before publish
EOF
OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_REPLY_FILE="$REPLY" STUB_MOVE_BRANCH_REPO="$MOVE_PROJ" STUB_MOVE_BRANCH=fleet/bead-1 \
  bun "$RUN_PROJ/seats/verify.ts" bead-move fleet/bead-1 worker-1 verifier 2>&1)"; RC=$?
MOVE_TIP="$(git -C "$MOVE_PROJ" rev-parse fleet/bead-1)"
if [ $RC -eq 0 ] && says "VERDICT: APPROVE" && says "at pinned tip $MOVE_PIN" && says "branch has since moved to $MOVE_TIP"; then
  pass "mid-pass branch move exits as the underlying APPROVE and names pinned/moved tips"
else fail "mid-pass branch move did not produce moved APPROVE (exit $RC): $OUT"; fi
if grep -q "tip: $MOVE_PIN" "$VDIR/bead-move.md" 2>/dev/null && grep -q "branch has since moved to $MOVE_TIP" "$VDIR/bead-move.md" && grep -q "push: NOT CONSIDERED — branch moved; re-verify at $MOVE_TIP before publish" "$VDIR/bead-move.md"; then
  pass "mid-pass branch move verdict file records pinned tip, move note, and NOT CONSIDERED push"
else fail "mid-pass branch move verdict file missing pinned/moved/push detail: $(cat "$VDIR/bead-move.md" 2>/dev/null)"; fi
if ! grep -q "DISCOVER" "$VDIR/bead-move.md" 2>/dev/null && ! says "DISCOVER"; then
  pass "mid-pass branch move is never rendered as DISCOVER"
else fail "mid-pass branch move leaked DISCOVER: $OUT $(cat "$VDIR/bead-move.md" 2>/dev/null)"; fi
RUN_PROJ="$PROJ"
VDIR="$PROJ/seats/verdicts"
VARGV="$HOME_FIX/.pi-seats-alpha/verifier/argv.json"

phase "1c. verifier account.authRoute=env — exported provider key is identity"
ENV_PROJ="$FIX/env-proj"
build_proj "$ENV_PROJ" env "$VERIFY"
bun -e "const fs=require('fs'); const p='$ENV_PROJ/seats/seats.json'; const j=require(p); j.seats.verifier.account.authRoute='env'; fs.rmSync('$HOME_FIX/.pi-seats-env/verifier/auth.json',{force:true}); fs.writeFileSync(p, JSON.stringify(j,null,2));"
RUN_PROJ="$ENV_PROJ"; VARGV="$HOME_FIX/.pi-seats-env/verifier/argv.json"; VDIR="$ENV_PROJ/seats/verdicts"
cat > "$REPLY" <<'EOF'
Env-route verifier checked.
VERDICT: APPROVE
EOF
OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_REPLY_FILE="$REPLY" OPENAI_API_KEY=fixture-key bun "$RUN_PROJ/seats/verify.ts" bead-env fleet/bead-1 worker-1 verifier 2>&1)"; RC=$?
if [ $RC -eq 0 ] && says "VERDICT: APPROVE"; then pass "account.authRoute=env verifier runs with exported provider env var and no auth.json"
else fail "account.authRoute=env verifier was refused (exit $RC): $OUT"; fi
RUN_PROJ="$PROJ"; VARGV="$HOME_FIX/.pi-seats-alpha/verifier/argv.json"; VDIR="$PROJ/seats/verdicts"

phase "1d. host budget — verifier one-shot prepends seats/bin only when opted in"
BUDGET_PROJ="$FIX/verify-budget-proj"
build_proj "$BUDGET_PROJ" verify-budget "$VERIFY"
mkdir -p "$BUDGET_PROJ/seats/bin"
printf '{"enabled":true}\n' > "$BUDGET_PROJ/seats/host-budget.json"
RUN_PROJ="$BUDGET_PROJ"; VARGV="$HOME_FIX/.pi-seats-verify-budget/verifier/argv.json"; VDIR="$BUDGET_PROJ/seats/verdicts"
cat > "$REPLY" <<'EOF'
Host-budget verifier checked.
VERDICT: APPROVE
EOF
run bead-1 fleet/bead-1 worker-1
if [ $RC -eq 0 ] && grep -q "$BUDGET_PROJ/seats/bin" "${VARGV%argv.json}env.json" 2>/dev/null; then
  pass "host budget enabled: verifier PATH includes this project's seats/bin"
else fail "host budget enabled: verifier PATH missing seats/bin (exit $RC): $OUT env=$(cat "${VARGV%argv.json}env.json" 2>/dev/null)"; fi
LOCK="$FIX/verify-budget.lock"
perl -MFcntl=:flock -e 'open(my $fh, ">>", $ARGV[0]) or die $!; flock($fh, LOCK_EX) or die $!; sleep 10' "$LOCK" &
LOCK_PID=$!
sleep 0.2
OUT="$(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_REPLY_FILE="$REPLY" WHEELHOUSE_BUILD_LOCK="$LOCK" bun "$RUN_PROJ/seats/verify.ts" bead-1 fleet/bead-1 worker-1 2>&1)"; RC=$?
kill "$LOCK_PID" 2>/dev/null || true
wait "$LOCK_PID" 2>/dev/null || true
if [ $RC -eq 1 ] && says "host build lock is held by another bead" && says "timeout-ms is not spent queued"; then
  pass "host budget enabled: verify refuses to start while another bead holds the build lock"
else fail "host budget lock contention was not refused before verifier spawn (exit $RC): $OUT"; fi
RUN_PROJ="$PROJ"; VARGV="$HOME_FIX/.pi-seats-alpha/verifier/argv.json"; VDIR="$PROJ/seats/verdicts"

phase "1e. mixed harness verifier one-shots — claude-code and codex use their drivers"
MIX_PROJ="$FIX/mixed-harness-verify"
build_proj "$MIX_PROJ" mixedv "$VERIFY"
cat > "$REPLY" <<'EOF'
Mixed harness verifier checked.
VERDICT: APPROVE
PUSH: NOT CONSIDERED — fixture
EOF
bun -e "const fs=require('fs'); const p='$MIX_PROJ/seats/seats.json'; const j=require(p); j.seats.verifier.harness='claude-code'; j.seats.verifier.provider='anthropic'; j.seats.verifier.model='sonnet'; j.seats.verifier.account.authRoute='oauth'; fs.writeFileSync(p, JSON.stringify(j,null,2));"
RUN_PROJ="$MIX_PROJ"; VDIR="$MIX_PROJ/seats/verdicts"; VARGV="$HOME_FIX/.pi-seats-mixedv/verifier/argv.json"
run bead-1 fleet/bead-1 worker-1
if [ $RC -eq 0 ] && [ -f "$HOME_FIX/.pi-seats-mixedv/verifier/invoked" ] && grep -q 'CLAUDE_CONFIG_DIR' "$HOME_FIX/.pi-seats-mixedv/verifier/env.json" && ! grep -q 'PI_CODING_AGENT_DIR.*pi-seats' "$HOME_FIX/.pi-seats-mixedv/verifier/env.json"; then
  pass "claude-code verifier one-shot uses the claude driver environment, not pi"
else fail "claude-code verifier one-shot did not use claude driver (rc=$RC out=$OUT env=$(cat "$HOME_FIX/.pi-seats-mixedv/verifier/env.json" 2>/dev/null))"; fi
if grep -q '"--output-format","stream-json"' "$HOME_FIX/.pi-seats-mixedv/verifier/argv.json" && grep -q '"--verbose"' "$HOME_FIX/.pi-seats-mixedv/verifier/argv.json"; then
  pass "claude-code verifier one-shot requests stream-json output with --verbose"
else fail "claude-code verifier one-shot did not request stream-json with --verbose: $(cat "$HOME_FIX/.pi-seats-mixedv/verifier/argv.json" 2>/dev/null)"; fi
bun -e "const fs=require('fs'); const p='$MIX_PROJ/seats/seats.json'; const j=require(p); j.seats.verifier.harness='codex'; j.seats.verifier.provider='openai-codex'; j.seats.verifier.model='gpt-5.5'; fs.writeFileSync(p, JSON.stringify(j,null,2));"
rm -f "$HOME_FIX/.pi-seats-mixedv/verifier/invoked" "$HOME_FIX/.pi-seats-mixedv/verifier/env.json"
run bead-1 fleet/bead-1 worker-1
if [ $RC -eq 0 ] && [ -f "$HOME_FIX/.pi-seats-mixedv/verifier/invoked" ] && grep -q 'CODEX_HOME' "$HOME_FIX/.pi-seats-mixedv/verifier/env.json" && ! grep -q 'PI_CODING_AGENT_DIR.*pi-seats' "$HOME_FIX/.pi-seats-mixedv/verifier/env.json"; then
  pass "codex verifier one-shot uses the codex driver environment, not pi"
else fail "codex verifier one-shot did not use codex driver (rc=$RC out=$OUT env=$(cat "$HOME_FIX/.pi-seats-mixedv/verifier/env.json" 2>/dev/null))"; fi
if grep -q '"--json"' "$HOME_FIX/.pi-seats-mixedv/verifier/argv.json"; then
  pass "codex verifier one-shot requests json streaming"
else fail "codex verifier one-shot did not request --json: $(cat "$HOME_FIX/.pi-seats-mixedv/verifier/argv.json" 2>/dev/null)"; fi
if grep -q 'fixture brief' "$HOME_FIX/.pi-seats-mixedv/verifier/argv.json" && grep -q -- '--skip-git-repo-check' "$HOME_FIX/.pi-seats-mixedv/verifier/argv.json" && grep -q 'approval_policy=never' "$HOME_FIX/.pi-seats-mixedv/verifier/argv.json"; then
  pass "codex verifier one-shot carries reviewer brief and measured-safe exec flags"
else fail "codex verifier one-shot missing brief or safe flags: $(cat "$HOME_FIX/.pi-seats-mixedv/verifier/argv.json" 2>/dev/null)"; fi
RUN_PROJ="$PROJ"; VARGV="$HOME_FIX/.pi-seats-alpha/verifier/argv.json"; VDIR="$PROJ/seats/verdicts"

phase "2. BOUNCE — exit 2"
rm -f "$VDIR/bead-2.md"
cat > "$REPLY" <<'EOF'
The done requires X; the diff does Y.
VERDICT: BOUNCE
EOF
run bead-2 fleet/bead-1 worker-1
if [ $RC -eq 2 ]; then pass "BOUNCE exits 2"
else fail "BOUNCE path exited $RC (want 2): $OUT"; fi
if grep -q "verdict: BOUNCE" "$VDIR/bead-2.md" 2>/dev/null; then
  pass "BOUNCE verdict recorded"
else fail "no BOUNCE verdict file"; fi

phase "3. DISCOVER — exit 3, proposal recorded, no beads filed"
rm -f "$VDIR/bead-3.md"
cat > "$REPLY" <<'EOF'
The bead asks to fix a function that no longer exists; the premise is stale.
Proposal: retarget the bead at the module that replaced it.
VERDICT: DISCOVER
EOF
run bead-3 fleet/bead-1 worker-1
if [ $RC -eq 3 ]; then pass "DISCOVER exits 3"
else fail "DISCOVER path exited $RC (want 3): $OUT"; fi
if says "DISCOVER files no beads"; then
  pass "the dispatcher says out loud that no beads were filed"
else fail "no files-no-beads line in output: $OUT"; fi
if grep -q "no beads were filed" "$VDIR/bead-3.md" 2>/dev/null \
   && grep -q "Proposal: retarget" "$VDIR/bead-3.md" 2>/dev/null; then
  pass "verdict file records the proposal for the commander"
else fail "verdict file missing the proposal or the no-beads note"; fi
# The graph is out of reach in this fixture (no bd on PATH), so a DISCOVER
# that tried to file a bead would have died loudly instead of exiting 3 —
# the clean exit above is itself the no-write evidence.

phase "4. self-approval — same account dir is a STOP before any spawn"
rm -f "$VINVOKED"
# A roster whose verifier points at the AUTHOR's directory:
cp "$PROJ/seats/seats.json" "$FIX/seats.json.good"
env HOME="$HOME_FIX" bun -e '
  const fs = require("fs");
  const f = process.argv[1];
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  j.seats.verifier.account.dir = j.seats["worker-1"].account.dir;
  fs.writeFileSync(f, JSON.stringify(j, null, 2));
' "$PROJ/seats/seats.json"
check_self_approval() {   # $1 = label
  local label="$1"
  run bead-4 fleet/bead-1 worker-1
  if [ $RC -eq 1 ] && says "SAME account directory"; then
    pass "${label}: identical account dirs refused with a STOP, exit 1"
  else fail "${label}: self-approval not refused (exit $RC): $OUT"; fi
  if [ ! -f "$HOME_FIX/.pi-seats-alpha/worker-1/invoked" ] && [ ! -f "$VINVOKED" ]; then
    pass "${label}: nothing was spawned — the stub was never invoked"
  else fail "${label}: the stub pi ran despite the identity collision"; fi
}
cat > "$REPLY" <<'EOF'
VERDICT: APPROVE
EOF
check_self_approval "self-approval"
cp "$FIX/seats.json.good" "$PROJ/seats/seats.json"
rm -f "$HOME_FIX/.pi-seats-alpha/worker-1/invoked" "$VINVOKED"

phase "5. malformed output — an error, never a judgment"
rm -f "$VDIR/bead-5.md"
cat > "$REPLY" <<'EOF'
I looked at the diff and it seems fine to me. Great work.
EOF
run bead-5 fleet/bead-1 worker-1
if [ $RC -eq 1 ] && says "no VERDICT"; then
  pass "missing VERDICT: line exits 1 with a STOP"
else fail "missing verdict not treated as error (exit $RC): $OUT"; fi
if [ ! -f "$VDIR/bead-5.md" ]; then
  pass "no verdict file written for a non-verdict"
else fail "a verdict file was written despite there being no verdict"; fi
cat > "$REPLY" <<'EOF'
Checked but omitted push authority.
VERDICT: APPROVE
EOF
run_without_default_push bead-5-missing-push fleet/bead-1 worker-1
if [ $RC -eq 1 ] && says "no PUSH"; then
  pass "missing PUSH: line exits 1 with a named STOP"
else fail "missing PUSH did not exit 1 (exit $RC): $OUT"; fi
cat > "$REPLY" <<'EOF'
Historical report quoted by the worker:
```text
VERDICT: BOUNCE
```
Fresh review of this branch passes.
VERDICT: APPROVE
EOF
run bead-5-fenced fleet/bead-1 worker-1
if [ $RC -eq 0 ] && says "VERDICT: APPROVE" && grep -q "verdict: APPROVE" "$VDIR/bead-5-fenced.md" 2>/dev/null; then
  pass "fenced VERDICT quote plus one live verdict is accepted"
else fail "fenced verdict quote was not inert (exit $RC): $OUT"; fi
node > "$FIX/final-message-only.jsonl" <<'NODE'
const reviewer = "The reviewer contract says: VERDICT: APPROVE — at pinned tip <sha>; branch has since moved to <new-tip> (<N> commits appended, history unrewritten)\nPUSH: APPROVE origin — verified: quoted only";
const final = "Tool result was a quote, not the verdict.\nVERDICT: BOUNCE — reviewed tip fixture\nPUSH: NOT CONSIDERED — fixture\n";
process.stdout.write(JSON.stringify({type:"tool_execution_result",toolName:"read",result:reviewer})+"\n");
process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:final}})+"\n");
NODE
run_stream "$FIX/final-message-only.jsonl" bead-5-tool-quote fleet/bead-1 worker-1
if [ $RC -eq 2 ] && says "VERDICT: BOUNCE" && grep -q "verdict: BOUNCE" "$VDIR/bead-5-tool-quote.md" 2>/dev/null; then
  pass "tool-result REVIEWER.md verdict quote is ignored; final assistant BOUNCE writes a verdict file"
else fail "tool-result verdict quote was not ignored (exit $RC): $OUT file=$(cat "$VDIR/bead-5-tool-quote.md" 2>/dev/null)"; fi
node > "$FIX/text-end-duplicate.jsonl" <<'NODE'
const final = "VERDICT: APPROVE\nPUSH: NOT CONSIDERED — fixture\n";
process.stdout.write(JSON.stringify({type:"text_end",text:final})+"\n");
process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:final}})+"\n");
NODE
run_stream "$FIX/text-end-duplicate.jsonl" bead-5-identical-duplicate fleet/bead-1 worker-1
if [ $RC -eq 0 ] && says "VERDICT: APPROVE" && grep -q "verdict: APPROVE" "$VDIR/bead-5-identical-duplicate.md" 2>/dev/null; then
  pass "identical verdict line in text_end and message_end is accepted once"
else fail "identical streamed duplicate verdict was not accepted once (exit $RC): $OUT"; fi
node > "$FIX/final-conflict.jsonl" <<'NODE'
const final = "VERDICT: APPROVE\nwait, actually:\nVERDICT: BOUNCE\nPUSH: NOT CONSIDERED — fixture\n";
process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:final}})+"\n");
NODE
run_stream "$FIX/final-conflict.jsonl" bead-5-final-conflict fleet/bead-1 worker-1
if [ $RC -eq 1 ] && says "2 live VERDICT: lines" && says "line 1: VERDICT: APPROVE" && says "line 3: VERDICT: BOUNCE"; then
  pass "two genuinely different verdicts in the final assistant message still STOP"
else fail "final-message conflicting verdicts did not STOP (exit $RC): $OUT"; fi
set_verifier_harness() {
  env HOME="$HOME_FIX" bun -e '
    const fs = require("fs");
    const file = process.argv[1], harness = process.argv[2];
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    if (harness === "pi") delete j.seats.verifier.harness;
    else j.seats.verifier.harness = harness;
    fs.writeFileSync(file, JSON.stringify(j, null, 2));
  ' "$PROJ/seats/seats.json" "$1"
}
for fixture in pi-message-end.jsonl claude-code-assistant.jsonl codex-item-completed-agent-message.jsonl; do
  [ -f "$REAL_FIXTURES_DIR/$fixture" ] || { echo "selftest: missing real verifier fixture: $REAL_FIXTURES_DIR/$fixture" >&2; exit 2; }
done
set_verifier_harness pi
run_stream "$REAL_FIXTURES_DIR/pi-message-end.jsonl" bead-5-recorded-pi fleet/bead-1 worker-1
if [ $RC -eq 2 ] && says "VERDICT: BOUNCE" && grep -q "verdict: BOUNCE" "$VDIR/bead-5-recorded-pi.md" 2>/dev/null; then
  pass "real pi message_end fixture yields one BOUNCE; result/turn events are not double-counted"
else fail "real pi fixture did not yield a single BOUNCE (exit $RC): $OUT file=$(cat "$VDIR/bead-5-recorded-pi.md" 2>/dev/null)"; fi
set_verifier_harness claude-code
run_stream "$REAL_FIXTURES_DIR/claude-code-assistant.jsonl" bead-5-recorded-claude fleet/bead-1 worker-1
if [ $RC -eq 2 ] && says "VERDICT: BOUNCE" && grep -q "verdict: BOUNCE" "$VDIR/bead-5-recorded-claude.md" 2>/dev/null; then
  pass "real claude-code assistant fixture yields one BOUNCE; result event is not double-counted"
else fail "real claude-code fixture did not yield a single BOUNCE (exit $RC): $OUT file=$(cat "$VDIR/bead-5-recorded-claude.md" 2>/dev/null)"; fi
set_verifier_harness codex
run_stream "$REAL_FIXTURES_DIR/codex-item-completed-agent-message.jsonl" bead-5-recorded-codex fleet/bead-1 worker-1
if [ $RC -eq 2 ] && says "VERDICT: BOUNCE" && grep -q "verdict: BOUNCE" "$VDIR/bead-5-recorded-codex.md" 2>/dev/null; then
  pass "real codex item.completed agent_message fixture yields one BOUNCE; turn.completed is not double-counted"
else fail "real codex fixture did not yield a single BOUNCE (exit $RC): $OUT file=$(cat "$VDIR/bead-5-recorded-codex.md" 2>/dev/null)"; fi
set_verifier_harness pi
cat > "$REPLY" <<'EOF'
VERDICT: APPROVE
wait, actually:
VERDICT: BOUNCE
EOF
run_without_default_push bead-5 fleet/bead-1 worker-1
if [ $RC -eq 1 ] && says "2 live VERDICT: lines" && says "line 1: VERDICT: APPROVE" && says "line 3: VERDICT: BOUNCE"; then
  pass "two conflicting live VERDICT: lines exit 1 and print both final-message candidates"
else fail "ambiguous double verdict not refused with candidates (exit $RC): $OUT"; fi
if grep -q '"type":"message_end"' "$VDIR/.raw.md" 2>/dev/null && grep -q 'VERDICT: APPROVE' "$VDIR/.raw.md" && grep -q 'VERDICT: BOUNCE' "$VDIR/.raw.md"; then
  pass "ambiguous double verdict writes raw json stdout to seats/verdicts/.raw.md before STOP"
else
  fail "ambiguous double verdict raw stdout missing json verdicts; raw was: $(cat "$VDIR/.raw.md" 2>/dev/null)"
fi
cat > "$REPLY" <<'EOF'
VERDICT: BOUNCE — NOT BENCHED: something
EOF
run bead-5 fleet/bead-1 worker-1
if [ $RC -eq 1 ] && says "APPROVE and nothing else"; then
  pass "NOT BENCHED on a non-APPROVE verdict exits 1"
else fail "NOT BENCHED on BOUNCE not refused (exit $RC): $OUT"; fi
cat > "$REPLY" <<'EOF'
VERDICT: SHIP-IT
EOF
run bead-5 fleet/bead-1 worker-1
if [ $RC -eq 1 ] && says "malformed verdict"; then
  pass "an unknown verdict value exits 1"
else fail "unknown verdict value not refused (exit $RC): $OUT"; fi
cat > "$REPLY" <<'EOF'
VERDICT: APPROVE
EOF
OUT="$(env HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_REPLY_FILE="$REPLY" STUB_EXIT=3 \
  bun "$PROJ/seats/verify.ts" bead-5 fleet/bead-1 worker-1 2>&1)"; RC=$?
if [ $RC -eq 1 ] && says "pi exited 3"; then
  pass "a failing pi exits 1 even when a VERDICT line is present"
else fail "pi failure not treated as error (exit $RC): $OUT"; fi
if ! says "account label:"; then
  pass "a verifier roster without account.label still reaches the provider-error path"
else fail "unlabeled verifier unexpectedly printed an account.label: $OUT"; fi
env HOME="$HOME_FIX" bun -e '
  const fs = require("fs");
  const f = process.argv[1];
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  j.seats.verifier.account.label = "fixture-verifier-account";
  fs.writeFileSync(f, JSON.stringify(j, null, 2));
' "$PROJ/seats/seats.json"
OUT="$(env HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_REPLY_FILE="$REPLY" STUB_EXIT=3 \
  bun "$PROJ/seats/verify.ts" bead-5-label fleet/bead-1 worker-1 2>&1)"; RC=$?
if [ $RC -eq 1 ] && says "pi exited 3" && says "account label: fixture-verifier-account"; then
  pass "provider-error stderr path includes verifier account.label when present"
else fail "provider-error path did not include verifier account.label (exit $RC): $OUT"; fi
env HOME="$HOME_FIX" bun -e '
  const fs = require("fs");
  const f = process.argv[1];
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  delete j.seats.verifier.account.label;
  fs.writeFileSync(f, JSON.stringify(j, null, 2));
' "$PROJ/seats/seats.json"

phase "6. preconditions — the STOPs that guard the spawn"
run bead-6 no-such-branch worker-1
if [ $RC -eq 1 ] && says "does not resolve"; then
  pass "a branch that does not resolve is a STOP"
else fail "missing branch not refused (exit $RC): $OUT"; fi
run bead-6 fleet/bead-1 no-such-seat
if [ $RC -eq 1 ] && says "no seat named"; then
  pass "an unknown author seat is a STOP — distinctness needs a named account"
else fail "unknown author seat not refused (exit $RC): $OUT"; fi
run bead-6 fleet/bead-1 worker-1 worker-1
if [ $RC -eq 1 ] && says 'not "verifier"'; then
  pass "naming a non-verifier seat as the verifier is a STOP"
else fail "non-verifier verifier seat not refused (exit $RC): $OUT"; fi
: > "$HOME_FIX/.pi-seats-alpha/verifier/auth.json"
run bead-6 fleet/bead-1 worker-1
if [ $RC -eq 1 ] && says "no identity"; then
  pass "a verifier seat that was never logged in is a STOP"
else fail "identity-less verifier not refused (exit $RC): $OUT"; fi
printf '{"stub":"%s"}\n' "$SENTINEL" > "$HOME_FIX/.pi-seats-alpha/verifier/auth.json"
check_bad_segment() {   # $1 = label, $2 = bead, $3 = author, $4 = expected phrase
  run "$2" fleet/bead-1 "$3"
  if [ $RC -eq 1 ] && says "$4"; then
    pass "$1 is a STOP"
  else fail "$1 not refused (exit $RC): $OUT"; fi
}
check_bad_segment "an author seat with a path separator" bead-6 "wor/ker" "invalid seat name"
check_bad_segment "an author seat of dot-dot" bead-6 ".." "invalid seat name"
check_bad_segment "an author seat with whitespace" bead-6 "wor ker" "invalid seat name"
check_bad_segment "an author seat with a quote" bead-6 'wor"ker' "invalid seat name"
check_bad_segment "an empty author seat" bead-6 "" "usage:"
check_bad_segment "a bead id with a path separator (it names the verdict file)" "bead/6" worker-1 "invalid bead id"
run bead-6 fleet/bead-1 worker-1 "veri/fier"
if [ $RC -eq 1 ] && says "invalid seat name"; then
  pass "an explicit verifier seat with a path separator is a STOP"
else fail "bad explicit verifier seat not refused (exit $RC): $OUT"; fi

phase "7. no tokens — identity never leaks into the verdict record"
if ! grep -rq "$SENTINEL" "$VDIR" 2>/dev/null; then
  pass "auth.json's content appears nowhere in seats/verdicts/"
else fail "the auth sentinel leaked into a verdict file"; fi

phase "8. evidence — artifacts the bead names gate the verdict"
# The floor checks read the TIP SHA, not any checkout (GRAPH.md's
# committed-path evidence home), so the fixtures are COMMITTED onto the
# branch under review via a throwaway worktree: a real bench log, a valid
# 1x1 PNG, a zero-byte .png, a zero-width PNG, and a text file posing as
# .png. The missing-artifact case needs no fixture at all.
EV_WT="$FIX/ev-wt"
if git -C "$PROJ" worktree add -q "$EV_WT" fleet/bead-1 2>/dev/null; then
  mkdir -p "$EV_WT/evidence"
  printf 'bench: 12 assertions, 0 failures\nPASS\n' > "$EV_WT/evidence/bench.log"
  "$NODE_BIN" -e '
    const fs = require("fs");
    const d = process.argv[1] + "/evidence";
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    fs.writeFileSync(d + "/screen.png", png);
    const zerodim = Buffer.from(png); zerodim.writeUInt32BE(0, 16);  // IHDR width = 0
    fs.writeFileSync(d + "/zerodim.png", zerodim);
    fs.writeFileSync(d + "/empty.png", Buffer.alloc(0));
    fs.writeFileSync(d + "/fake.png", "not a png at all\n");
  ' "$EV_WT"
  ( cd "$EV_WT" &&
    git add evidence &&
    git -c user.email=selftest@local -c user.name=selftest commit -q -m evidence ) \
    || fail "could not commit evidence fixtures onto fleet/bead-1"
  git -C "$PROJ" worktree remove -f "$EV_WT" 2>/dev/null
else
  fail "could not create the evidence fixture worktree"
fi

cat > "$REPLY" <<'EOF'
Opened both artifacts: the bench log records a passing run, the screenshot
shows the expected screen. Done holds.
VERDICT: APPROVE
EOF
run bead-8a fleet/bead-1 worker-1 --evidence evidence/bench.log,evidence/screen.png
if [ $RC -eq 0 ]; then pass "APPROVE over a satisfied bench log + screenshot exits 0"
else fail "satisfied heterogeneous evidence exited ${RC}: $OUT"; fi
if grep -q "## Evidence checks" "$VDIR/bead-8a.md" 2>/dev/null \
   && grep -q "evidence/bench.log — exists, .* bytes, non-empty — OK" "$VDIR/bead-8a.md" 2>/dev/null \
   && grep -q "evidence/screen.png — exists, .* bytes, PNG 1x1 — OK" "$VDIR/bead-8a.md" 2>/dev/null; then
  pass "verdict file records per-artifact checks: exists, bytes, type probe"
else fail "evidence checks missing from the verdict record"; fi
if grep -q "evidence/screen.png" "$VARGV" 2>/dev/null && grep -q "floor" "$VARGV" 2>/dev/null; then
  pass "the floor-check results reach the verifier's prompt"
else fail "evidence floor results not in the prompt argv"; fi

printf 'wheelhouse/evidence/\n' >> "$PROJ/.git/info/exclude"
mkdir -p "$PROJ/wheelhouse/evidence/disk-ok" "$PROJ/wheelhouse/evidence/disk-bare"
printf 'disk evidence retained outside git\n' > "$PROJ/wheelhouse/evidence/disk-ok/proof.txt"
( cd "$PROJ/wheelhouse/evidence/disk-ok" && shasum -a 256 proof.txt > cited-evidence.sha256 )
cat > "$REPLY" <<'EOF'
Opened disk evidence manifest; it verifies. Done holds.
VERDICT: APPROVE
EOF
run bead-8disk-ok fleet/bead-1 worker-1 --evidence wheelhouse/evidence/disk-ok
if [ $RC -eq 0 ]; then pass "APPROVE over git-excluded evidence with a verified SHA-256 manifest exits 0"
else fail "excluded manifest evidence exited ${RC}: $OUT"; fi
if grep -q "wheelhouse/evidence/disk-ok — exists, .*cited-evidence.sha256 verified 1 artifact(s).*OK (SATISFIED via excluded disk + SHA-256 manifest)" "$VDIR/bead-8disk-ok.md" 2>/dev/null; then
  pass "excluded evidence record names disk+manifest as the satisfying source"
else fail "excluded evidence record did not name disk+manifest satisfaction"; fi

cat > "$REPLY" <<'EOF'
VERDICT: APPROVE
EOF
run bead-8disk-bare fleet/bead-1 worker-1 --evidence wheelhouse/evidence/disk-bare
if [ $RC -eq 1 ] && says "no cited-evidence.sha256" && says "UNSATISFIED"; then
  pass "git-excluded evidence without a manifest is UNSATISFIED, not accepted for bare existence"
else fail "excluded bare directory was not refused (exit $RC): $OUT"; fi
run bead-8disk-missing fleet/bead-1 worker-1 --evidence wheelhouse/evidence/disk-missing
if [ $RC -eq 1 ] && says "git-excluded evidence path is absent on disk" && says "UNSATISFIED"; then
  pass "missing git-excluded evidence is UNSATISFIED with disk source named"
else fail "missing excluded evidence was not refused (exit $RC): $OUT"; fi

cat > "$REPLY" <<'EOF'
VERDICT: APPROVE
EOF
run bead-8b fleet/bead-1 worker-1 --evidence evidence/empty.png
if [ $RC -eq 1 ] && says "unsatisfied evidence" && says "EMPTY"; then
  pass "APPROVE over a zero-byte screenshot is malformed, exit 1"
else fail "zero-byte artifact APPROVE not refused (exit $RC): $OUT"; fi
run bead-8c fleet/bead-1 worker-1 --evidence evidence/nothing.png
if [ $RC -eq 1 ] && says "unsatisfied evidence" && says "MISSING at the tip SHA"; then
  pass "APPROVE over an artifact absent from the tip is malformed, exit 1"
else fail "missing artifact APPROVE not refused (exit $RC): $OUT"; fi
run bead-8d fleet/bead-1 worker-1 --evidence evidence/fake.png
if [ $RC -eq 1 ] && says "NOT a PNG"; then
  pass "a text file posing as .png is caught by the magic-byte probe"
else fail "fake .png not refused (exit $RC): $OUT"; fi
run bead-8e fleet/bead-1 worker-1 --evidence evidence/zerodim.png
if [ $RC -eq 1 ] && says "degenerate PNG (0x1)"; then
  pass "a PNG with a zero dimension is degenerate, refused"
else fail "zero-dimension PNG not refused (exit $RC): $OUT"; fi

cat > "$REPLY" <<'EOF'
The named screenshot is missing from the branch; the done cannot hold.
VERDICT: BOUNCE
EOF
run bead-8f fleet/bead-1 worker-1 --evidence evidence/nothing.png
if [ $RC -eq 2 ]; then pass "the gate blocks only APPROVE — BOUNCE over failed evidence still exits 2"
else fail "BOUNCE with unsatisfied evidence exited $RC (want 2): $OUT"; fi
if grep -q "MISSING at the tip SHA" "$VDIR/bead-8f.md" 2>/dev/null; then
  pass "the failed floor check is still recorded on a BOUNCE"
else fail "failed evidence check not recorded in the BOUNCE verdict file"; fi

cat > "$REPLY" <<'EOF'
VERDICT: APPROVE
EOF
run bead-8g fleet/bead-1 worker-1 --evidence /etc/passwd
if [ $RC -eq 1 ] && says "invalid evidence path"; then
  pass "an absolute evidence path is a STOP"
else fail "absolute evidence path not refused (exit $RC): $OUT"; fi
run bead-8g fleet/bead-1 worker-1 --evidence ../escape.png
if [ $RC -eq 1 ] && says "invalid evidence path"; then
  pass "a dot-dot evidence path is a STOP"
else fail "dot-dot evidence path not refused (exit $RC): $OUT"; fi

phase "9. canary — can these checks detect a broken verify.ts?"
# 9a: a verify.ts whose account-distinctness gate never fires
CAN_A="$FIX/can-a"
sed 's|if (authorDir === verifierDir) { // distinctness-gate|if (false) { // distinctness-gate|' \
  "$VERIFY" > "$FIX/can-a-verify.ts"
if cmp -s "$VERIFY" "$FIX/can-a-verify.ts"; then
  fail "canary: could not disarm the distinctness gate — the line no longer matches, so the canary proves nothing"
else
  build_proj "$CAN_A" can-a "$FIX/can-a-verify.ts"
  env HOME="$HOME_FIX" bun -e '
    const fs = require("fs");
    const f = process.argv[1];
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    j.seats.verifier.account.dir = j.seats["worker-1"].account.dir;
    fs.writeFileSync(f, JSON.stringify(j, null, 2));
  ' "$CAN_A/seats/seats.json"
  RUN_PROJ="$CAN_A"
  VINVOKED="$HOME_FIX/.pi-seats-can-a/verifier/invoked"
  cat > "$REPLY" <<'EOF'
VERDICT: APPROVE
EOF
  CANARY_FAILED_BEFORE=$FAILED
  check_self_approval "canary" > /dev/null 2>&1
  if [ $FAILED -gt $CANARY_FAILED_BEFORE ]; then
    FAILED=$CANARY_FAILED_BEFORE
    pass "canary: a verify.ts that lets the author verify itself is caught"
  else
    FAILED=$((CANARY_FAILED_BEFORE + 1))
    fail "canary: a verify.ts with its distinctness gate disarmed PASSED — these checks prove nothing"
  fi
fi

# 9b: a verify.ts that reports a verdict it never recorded
CAN_B="$FIX/can-b"
sed 's|^  fs.writeFileSync(verdictFile, record); // verdict-write$|  ; // verdict-write|' \
  "$VERIFY" > "$FIX/can-b-verify.ts"
if cmp -s "$VERIFY" "$FIX/can-b-verify.ts"; then
  fail "canary: could not cut the verdict write — the line no longer matches, so the canary proves nothing"
else
  build_proj "$CAN_B" can-b "$FIX/can-b-verify.ts"
  RUN_PROJ="$CAN_B"
  CB_TIP="$(git -C "$CAN_B" rev-parse fleet/bead-1)"
  cat > "$REPLY" <<'EOF'
evidence here
VERDICT: APPROVE
EOF
  run bead-1 fleet/bead-1 worker-1
  if [ $RC -eq 0 ] && [ ! -f "$CAN_B/seats/verdicts/bead-1.md" ]; then
    pass "canary: a verify.ts with its verdict write cut is caught by the file check"
  else
    fail "canary: the verdict-write sabotage did not present as phase 1 would catch it (exit $RC, file $([ -f "$CAN_B/seats/verdicts/bead-1.md" ] && echo present || echo absent))"
  fi
fi
# 9c: a verify.ts whose evidence gate never fires
CAN_C="$FIX/can-c"
sed 's|if (verdict === "APPROVE" \&\& evidenceUnsatisfied.length > 0) { // evidence-gate|if (false) { // evidence-gate|' \
  "$VERIFY" > "$FIX/can-c-verify.ts"
if cmp -s "$VERIFY" "$FIX/can-c-verify.ts"; then
  fail "canary: could not disarm the evidence gate — the line no longer matches, so the canary proves nothing"
else
  build_proj "$CAN_C" can-c "$FIX/can-c-verify.ts"
  RUN_PROJ="$CAN_C"
  cat > "$REPLY" <<'EOF'
VERDICT: APPROVE
EOF
  run bead-1 fleet/bead-1 worker-1 --evidence evidence/nothing.png
  if [ $RC -eq 0 ]; then
    pass "canary: a verify.ts that approves over missing evidence is caught by the exit-1 check"
  else
    fail "canary: the evidence-gate sabotage did not present as phase 8 would catch it (exit $RC): $OUT"
  fi
fi
RUN_PROJ="$PROJ"
VINVOKED="$HOME_FIX/.pi-seats-alpha/verifier/invoked"

phase "10. sweep — a SIGKILLed run's scratch worktree and stale SHA branch are reclaimed"
# sweepStaleScratchWorktrees() runs at the very top of main(), before argv
# is even validated, so a bare no-args invocation (an immediate usage STOP)
# exercises it as cheaply as a full round trip does.
ORPHAN_DIR="$FIX/wheelhouse-verify-999999999-orphan"
REVIEW_ORPHAN_DIR="$FIX/wheelhouse-review-999999998-orphan"
SHA_BRANCH="0123456789abcdef0123456789abcdef01234567"
mkdir -p "$ORPHAN_DIR" "$REVIEW_ORPHAN_DIR"
git -C "$PROJ" worktree add --detach "$ORPHAN_DIR" HEAD >/dev/null 2>&1
git -C "$PROJ" worktree add --detach "$REVIEW_ORPHAN_DIR" HEAD >/dev/null 2>&1
git -C "$PROJ" branch "$SHA_BRANCH" HEAD >/dev/null 2>&1
bash -c '
  pid=$$
  dir="$1/wheelhouse-verify-${pid}-live"
  mkdir -p "$dir"
  git -C "$2" worktree add --detach "$dir" HEAD >/dev/null 2>&1
  cd "$dir"
  printf "%s\n%s\n" "$pid" "$dir" > "$1/live-owner.txt"
  sleep 5
' _ "$FIX" "$PROJ" &
while [ ! -f "$FIX/live-owner.txt" ]; do sleep 0.05; done
LIVE_OWNER_PID=$(sed -n '1p' "$FIX/live-owner.txt")
LIVE_DIR=$(sed -n '2p' "$FIX/live-owner.txt")
if git -C "$PROJ" worktree list | grep -qF "$ORPHAN_DIR" \
   && git -C "$PROJ" worktree list | grep -qF "$REVIEW_ORPHAN_DIR" \
   && git -C "$PROJ" worktree list | grep -qF "$LIVE_DIR" \
   && git -C "$PROJ" show-ref --verify --quiet "refs/heads/$SHA_BRANCH"; then
  pass "planted verify/review orphan worktrees, a live scratch worktree, and a SHA-named branch"
else fail "could not plant stale scratch fixtures before sweeping"; fi

run   # no args: usage STOP, but only after sweepStaleScratchWorktrees() ran
if ! git -C "$PROJ" worktree list | grep -qF "$ORPHAN_DIR" && [ ! -d "$ORPHAN_DIR" ]; then
  pass "the orphaned verify scratch worktree (dead pid) was reclaimed"
else fail "the verify orphan survived: $(git -C "$PROJ" worktree list)"; fi
if ! git -C "$PROJ" worktree list | grep -qF "$REVIEW_ORPHAN_DIR" && [ ! -d "$REVIEW_ORPHAN_DIR" ]; then
  pass "the orphaned review scratch worktree (dead pid) was reclaimed"
else fail "the review orphan survived: $(git -C "$PROJ" worktree list)"; fi
if ! git -C "$PROJ" show-ref --verify --quiet "refs/heads/$SHA_BRANCH"; then
  pass "the stale 40-hex local branch was reclaimed"
else fail "the stale SHA-named branch survived: $(git -C "$PROJ" branch --list "$SHA_BRANCH")"; fi
if git -C "$PROJ" worktree list | grep -qF "$LIVE_DIR" && [ -d "$LIVE_DIR" ]; then
  pass "the live scratch worktree (real running pid) was spared"
else fail "the live worktree was swept even though its owner pid is still alive"; fi

kill "$LIVE_OWNER_PID" 2>/dev/null
i=0; while kill -0 "$LIVE_OWNER_PID" 2>/dev/null && [ $i -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
run   # a second sweep pass, now that the "live" owner has actually exited
if ! git -C "$PROJ" worktree list | grep -qF "$LIVE_DIR" && [ ! -d "$LIVE_DIR" ]; then
  pass "once its owner pid actually exits, a later sweep reclaims that worktree too"
else fail "the formerly-live worktree was not reclaimed after its owner pid died: $(git -C "$PROJ" worktree list)"; fi

phase "10b. killed one-shot — reaper leaves no scratch worktree or SHA branch"
KILL_PROJ="$FIX/proj-kill"
build_proj "$KILL_PROJ" kill "$VERIFY"
RUN_PROJ="$KILL_PROJ"; VDIR="$KILL_PROJ/seats/verdicts"; VARGV="$HOME_FIX/.pi-seats-kill/verifier/argv.json"
KILL_SHA_BRANCH="89abcdef0123456789abcdef0123456789abcdef"
git -C "$KILL_PROJ" branch "$KILL_SHA_BRANCH" HEAD >/dev/null 2>&1
OUT_FILE="$FIX/killed-verify.out"
(env -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_STALL=1 bun "$RUN_PROJ/seats/verify.ts" bead-kill fleet/bead-1 worker-1 verifier --timeout-ms 30000 >"$OUT_FILE" 2>&1) &
KILLED_DISPATCHER_PID=$!
KILLED_DIR=""
for _ in $(seq 1 100); do
  KILLED_DIR="$(git -C "$KILL_PROJ" worktree list --porcelain 2>/dev/null | awk '/^worktree /{p=substr($0,10); n=p; sub(/^.*\//,"",n); if (n ~ /^wheelhouse-verify-[0-9]+-/) print p}' | head -n 1 || true)"
  [ -n "$KILLED_DIR" ] && break
  sleep 0.05
done
if [ -n "$KILLED_DIR" ]; then pass "killed one-shot fixture reached a registered scratch worktree"
else fail "killed one-shot fixture never registered a scratch worktree: $(cat "$OUT_FILE" 2>/dev/null)"; fi
kill -9 "$KILLED_DISPATCHER_PID" 2>/dev/null || true
wait "$KILLED_DISPATCHER_PID" 2>/dev/null || true
PI_PID_FILE="$HOME_FIX/.pi-seats-kill/verifier/pi-pid.txt"
if [ -s "$PI_PID_FILE" ]; then kill "$(cat "$PI_PID_FILE")" 2>/dev/null || true; fi
run   # sweep the killed run's scratch worktree and stale SHA branch
if [ -n "$KILLED_DIR" ] && ! git -C "$KILL_PROJ" worktree list | grep -qF "$KILLED_DIR" && [ ! -d "$KILLED_DIR" ]; then
  pass "killed one-shot scratch worktree was reclaimed by the reaper pass"
else fail "killed one-shot scratch survived: dir=$KILLED_DIR list=$(git -C "$KILL_PROJ" worktree list)"; fi
if ! git -C "$KILL_PROJ" show-ref --verify --quiet "refs/heads/$KILL_SHA_BRANCH"; then
  pass "killed one-shot reaper pass removed the stale SHA-named branch"
else fail "killed one-shot stale SHA branch survived"; fi
RUN_PROJ="$PROJ"; VDIR="$PROJ/seats/verdicts"; VARGV="$HOME_FIX/.pi-seats-alpha/verifier/argv.json"

phase "11. real pi — one smoke leg through the actual binary (SKIP-able)"
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
  HOME_SAVE="$HOME_FIX"; HOME_FIX="$RHOME"
  build_proj "$RPROJ" real "$VERIFY"
  HOME_FIX="$HOME_SAVE"
  # The smoke brief scripts the reply, so one trivial model turn exercises
  # spawn -> parse -> record against the real binary without a real review.
  cat > "$RPROJ/contracts/REVIEWER.md" <<'EOF'
SMOKE TEST. Ignore the task in the prompt. Reply with exactly these two
lines and nothing else, using no tools:
VERDICT: APPROVE
PUSH:    NOT CONSIDERED
EOF
  # Borrow the real login into the verifier seat only; it dies with the fixture.
  RSEAT="$RHOME/.pi-seats-real/verifier"
  cp "$REAL_AUTH" "$RSEAT/auth.json" && chmod 600 "$RSEAT/auth.json"
  [ -f "$HOME/.pi/agent/settings.json" ] && cp "$HOME/.pi/agent/settings.json" "$RSEAT/settings.json"
  # No --provider/--model pin by default: whatever your login can actually
  # run. When the working login is NOT pi's default provider, pin both
  # (always together — see the roster gotcha in README.md):
  #   WHEELHOUSE_REAL_PI_PROVIDER=... WHEELHOUSE_REAL_PI_MODEL=...
  env HOME="$RHOME" bun -e '
    const fs = require("fs");
    const f = process.argv[1];
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    const p = process.env.WHEELHOUSE_REAL_PI_PROVIDER, m = process.env.WHEELHOUSE_REAL_PI_MODEL;
    if (p && m) { j.seats.verifier.provider = p; j.seats.verifier.model = m; }
    else { delete j.seats.verifier.provider; delete j.seats.verifier.model; }
    fs.writeFileSync(f, JSON.stringify(j, null, 2));
  ' "$RPROJ/seats/seats.json"
  REAL_PATH="$(dirname "$REAL_PI"):$(dirname "$(command -v bun)"):$(dirname "$GIT_BIN"):/usr/bin:/bin"
  OUT="$(env HOME="$RHOME" PATH="$REAL_PATH" WHEELHOUSE_VERIFY_TIMEOUT_MS=180000 \
    bun "$RPROJ/seats/verify.ts" smoke-1 fleet/bead-1 worker-1 2>&1)"; RC=$?
  if [ $RC -eq 0 ] && says "VERDICT: APPROVE"; then
    pass "real: one-shot spawn/parse/record round-trips through the real pi"
  else fail "real: smoke leg exited ${RC}: $OUT"; fi
  if grep -q "verdict: APPROVE" "$RPROJ/seats/verdicts/smoke-1.md" 2>/dev/null; then
    pass "real: verdict file recorded"
  else fail "real: no verdict file from the real leg"; fi
  # The hermetic no-leak phase proves the rule with a sentinel; the real leg
  # must hold the same line for the REAL credential, before the fixture (and
  # the copied auth.json) is deleted: no string value from auth.json may
  # appear in the verdict record.
  AUTH_LEAK=0
  while IFS= read -r tok; do
    [ -n "$tok" ] || continue
    if grep -rqF -- "$tok" "$RPROJ/seats/verdicts/" 2>/dev/null; then
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
    pass "real: no auth material in the verdict record before fixture deletion"
  else fail "real: a value from the borrowed auth.json appears in seats/verdicts/"; fi
fi

printf '\n'
if [ $FAILED -eq 0 ]; then
  echo "verify.ts works on this machine."
  exit 0
fi
echo "$FAILED check(s) failed."
echo "If the failures are in phases 1-8 or the real leg, verify.ts broke or its"
echo "output wording moved. If a failure is in the canary, fix this test first."
exit 1
