#!/usr/bin/env bash
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
# whose VERIFIER.md brief is a scripted-reply instruction, so one trivial
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
BRIEFS="$(cd "$(dirname "$VERIFY")" && pwd)/briefs.ts"
[ -f "$VERIFY" ] || { echo "selftest: not found: $VERIFY" >&2; exit 2; }
[ -f "$BRIEFS" ] || { echo "selftest: not found: $BRIEFS" >&2; exit 2; }
command -v bun >/dev/null 2>&1 || { echo "selftest: bun is required to run verify.ts" >&2; exit 2; }
NODE_BIN="$(command -v node)" || { echo "selftest: node is required for the stub pi" >&2; exit 2; }
GIT_BIN="$(command -v git)" || { echo "selftest: git is required" >&2; exit 2; }
REAL_PI="$(command -v pi || true)"

FAILED=0
FIX=""

pass() { printf '  ok    %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; FAILED=$((FAILED + 1)); }
skip() { printf '  SKIP  %s\n' "$*"; }
phase(){ printf '\n%s\n' "$*"; }

cleanup() { [ -n "$FIX" ] && rm -rf "$FIX"; return 0; }
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
RUN_PATH="$BIN:$(dirname "$(command -v bun)"):$(dirname "$NODE_BIN"):$(dirname "$GIT_BIN"):/usr/bin:/bin"

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
// The dispatcher sets our cwd by construction (a scratch worktree), not by
// telling us in a prompt to stay off the live checkout. Recording it here
// lets the selftest see what the OS-level cwd actually was.
fs.writeFileSync(path.join(agentDir, "cwd.txt"), process.cwd());
const reply = process.env.STUB_REPLY_FILE;
if (reply) process.stdout.write(fs.readFileSync(reply, "utf8"));
process.exit(Number(process.env.STUB_EXIT || 0));
STUB
chmod +x "$BIN/pi"
[ -x "$BIN/pi" ] || { echo "selftest: fixture stub pi was not created" >&2; exit 2; }

# A fixture project: verify.ts expects to live at <root>/seats/verify.ts with
# the brief at <root>/contracts/VERIFIER.md, and the root to be a git repo
# holding the branch under review.
SENTINEL='SENTINEL-TOKEN-9c2e'
build_proj() {   # $1 = project dir, $2 = seat namespace, $3 = verify.ts source
  local proj="$1" ns="$2" src="$3" d
  mkdir -p "$proj/seats" "$proj/contracts"
  cp "$src" "$proj/seats/verify.ts"
  cp "$BRIEFS" "$proj/seats/briefs.ts"
  printf '# Crew: Verifier\n\nfixture brief — the stub never reads it, the argv check does.\n' \
    > "$proj/contracts/VERIFIER.md"
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
  printf '# Crew: Verifier\n\ninstalled-layout verifier brief.\n' > "$proj/wheelhouse/crew/VERIFIER.md"
}

build_umbrella_proj() {   # $1 = umbrella dir, $2 = seat namespace, $3 = verify.ts source
  local umb="$1" ns="$2" src="$3" product="$1/product"
  mkdir -p "$umb/seats" "$umb/contracts" "$product"
  cp "$src" "$umb/seats/verify.ts"
  cp "$BRIEFS" "$umb/seats/briefs.ts"
  printf '# Crew: Verifier\n\numbrella verifier brief.\n' > "$umb/contracts/VERIFIER.md"
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
  OUT="$(env HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_REPLY_FILE="$REPLY" \
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
else fail "installed layout: verify exited $RC: $OUT"; fi
if grep -q "\"--append-system-prompt\",\"$INST_PROJ/wheelhouse/crew/VERIFIER.md\"" "$VARGV" 2>/dev/null; then
  pass "installed layout: verifier brief resolves to wheelhouse/crew/VERIFIER.md"
else fail "installed layout: verifier brief was not the installed path"; fi
MISS_PROJ="$FIX/missing-brief-proj"
build_proj "$MISS_PROJ" missing "$VERIFY"
rm -rf "$MISS_PROJ/contracts" "$MISS_PROJ/wheelhouse"
RUN_PROJ="$MISS_PROJ"
run bead-missing fleet/bead-1 worker-1
if [ $RC -ne 0 ] && says "$MISS_PROJ/wheelhouse/crew/VERIFIER.md" && says "$MISS_PROJ/contracts/VERIFIER.md"; then
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
else fail "umbrella layout: verify exited $RC: $OUT"; fi
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

phase "1. APPROVE — verdict parsed, recorded, exit 0, and what was launched"
cat > "$REPLY" <<EOF
Checked the done: diff at $TIP adds the thing the bead asks for.
\$ git show --stat fleet/bead-1
 1 file changed
VERDICT: APPROVE
EOF
run bead-1 fleet/bead-1 worker-1
if [ $RC -eq 0 ]; then pass "APPROVE exits 0"
else fail "APPROVE path exited $RC: $OUT"; fi
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
if [ -f "$VARGV" ] && grep -q '"-p","--no-session"' "$VARGV"; then
  pass "pi was launched one-shot: -p --no-session"
else fail "argv.json missing or pi not launched with -p --no-session"; fi
if grep -q "\"--append-system-prompt\",\"$PROJ/contracts/VERIFIER.md\"" "$VARGV" 2>/dev/null; then
  pass "role brief injected: --append-system-prompt names contracts/VERIFIER.md"
else fail "verifier brief not passed"; fi
if grep -q '"--provider","openai","--model","stub-model-v"' "$VARGV" 2>/dev/null; then
  pass "the VERIFIER seat's provider and model pin the launch (not the author's)"
else fail "verifier provider/model from seats.json did not reach pi's argv"; fi
if grep -q "bead-1" "$VARGV" && grep -q "$TIP" "$VARGV" && grep -q "bd show bead-1" "$VARGV"; then
  pass "prompt carries the bead id, the tip SHA, and the bead-claim reference"
else fail "prompt is missing bead id, tip SHA, or bead claim"; fi

# --- scratch cwd: construction, not contract discipline ---------------------
# The verifier's process cwd must be A repository the branch's ref resolves
# from (so its own bare `git diff`/`git show` still work — proven by phase 1
# itself already succeeding, and by phase 8's evidence reads below, both
# unchanged from before this bead), but it must NOT be $PROJ: a confused or
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
Static half verified; no bench covers the docs deployable this touches.
VERDICT: APPROVE — NOT BENCHED: the docs deployable
EOF
run bead-1nb fleet/bead-1 worker-1
if [ $RC -eq 0 ]; then pass "APPROVE — NOT BENCHED still exits 0"
else fail "NOT BENCHED APPROVE exited $RC: $OUT"; fi
if grep -q "verdict: APPROVE — NOT BENCHED: the docs deployable" "$VDIR/bead-1nb.md" 2>/dev/null; then
  pass "the NOT BENCHED qualifier survives into the verdict record"
else fail "NOT BENCHED qualifier lost from the verdict file"; fi

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
    pass "$label: identical account dirs refused with a STOP, exit 1"
  else fail "$label: self-approval not refused (exit $RC): $OUT"; fi
  if [ ! -f "$HOME_FIX/.pi-seats-alpha/worker-1/invoked" ] && [ ! -f "$VINVOKED" ]; then
    pass "$label: nothing was spawned — the stub was never invoked"
  else fail "$label: the stub pi ran despite the identity collision"; fi
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
VERDICT: APPROVE
wait, actually:
VERDICT: BOUNCE
EOF
run bead-5 fleet/bead-1 worker-1
if [ $RC -eq 1 ] && says "2 VERDICT: lines"; then
  pass "two conflicting VERDICT: lines exit 1 rather than picking one"
else fail "ambiguous double verdict not refused (exit $RC): $OUT"; fi
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
else fail "satisfied heterogeneous evidence exited $RC: $OUT"; fi
if grep -q "## Evidence checks" "$VDIR/bead-8a.md" 2>/dev/null \
   && grep -q "evidence/bench.log — exists, .* bytes, non-empty — OK" "$VDIR/bead-8a.md" 2>/dev/null \
   && grep -q "evidence/screen.png — exists, .* bytes, PNG 1x1 — OK" "$VDIR/bead-8a.md" 2>/dev/null; then
  pass "verdict file records per-artifact checks: exists, bytes, type probe"
else fail "evidence checks missing from the verdict record"; fi
if grep -q "evidence/screen.png" "$VARGV" 2>/dev/null && grep -q "floor" "$VARGV" 2>/dev/null; then
  pass "the floor-check results reach the verifier's prompt"
else fail "evidence floor results not in the prompt argv"; fi

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

phase "10. sweep — a SIGKILLed run's scratch worktree is reclaimed, a live one is spared"
# sweepStaleScratchWorktrees() runs at the very top of main(), before argv
# is even validated, so a bare no-args invocation (an immediate usage STOP)
# exercises it as cheaply as a full round trip does.
ORPHAN_DIR="$FIX/wheelhouse-verify-999999999-orphan"
mkdir -p "$ORPHAN_DIR"
git -C "$PROJ" worktree add --detach "$ORPHAN_DIR" HEAD >/dev/null 2>&1
sleep 5 & LIVE_OWNER_PID=$!
LIVE_DIR="$FIX/wheelhouse-verify-${LIVE_OWNER_PID}-live"
mkdir -p "$LIVE_DIR"
git -C "$PROJ" worktree add --detach "$LIVE_DIR" HEAD >/dev/null 2>&1
if git -C "$PROJ" worktree list | grep -qF "$ORPHAN_DIR" && git -C "$PROJ" worktree list | grep -qF "$LIVE_DIR"; then
  pass "both a planted orphan (dead pid) and a planted live (real pid) scratch worktree are registered"
else fail "could not plant both test scratch worktrees before sweeping"; fi

run   # no args: usage STOP, but only after sweepStaleScratchWorktrees() ran
if ! git -C "$PROJ" worktree list | grep -qF "$ORPHAN_DIR" && [ ! -d "$ORPHAN_DIR" ]; then
  pass "the orphaned scratch worktree (dead pid) was reclaimed: unregistered and removed from disk"
else fail "the orphan was NOT reclaimed — still registered or still on disk: $(git -C "$PROJ" worktree list)"; fi
if git -C "$PROJ" worktree list | grep -qF "$LIVE_DIR" && [ -d "$LIVE_DIR" ]; then
  pass "the live scratch worktree (real running pid) was spared — still registered and on disk"
else fail "the live worktree was swept even though its owner pid is still alive"; fi

kill "$LIVE_OWNER_PID" 2>/dev/null
i=0; while kill -0 "$LIVE_OWNER_PID" 2>/dev/null && [ $i -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
run   # a second sweep pass, now that the "live" owner has actually exited
if ! git -C "$PROJ" worktree list | grep -qF "$LIVE_DIR" && [ ! -d "$LIVE_DIR" ]; then
  pass "once its owner pid actually exits, a later sweep reclaims that worktree too"
else fail "the formerly-live worktree was not reclaimed after its owner pid died: $(git -C "$PROJ" worktree list)"; fi

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
  cat > "$RPROJ/contracts/VERIFIER.md" <<'EOF'
SMOKE TEST. Ignore the task in the prompt. Reply with exactly this single
line and nothing else, using no tools:
VERDICT: APPROVE
EOF
  # Borrow the real login into the VERIFIER seat only; it dies with the fixture.
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
  else fail "real: smoke leg exited $RC: $OUT"; fi
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
