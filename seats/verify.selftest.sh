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
# a reviewer seat resolving to the SAME account directory must be a STOP
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
READINESS_DRIVER="${WHEELHOUSE_TEST_VERIFY_READINESS_DRIVER:-$(dirname "$SELFTEST_LIB")/fixtures/verify-readiness.ts}"
BRIEFS="$VERIFY_DIR/briefs.ts"
HARNESS="$VERIFY_DIR/harness.ts"
FINAL_ASSISTANT="$VERIFY_DIR/final-assistant-message.ts"
HOST_BUDGET_TS="$VERIFY_DIR/host-budget.ts"
HERALD="$VERIFY_DIR/herald.ts"
REAL_FIXTURES_DIR="$VERIFY_DIR/fixtures/verify-real"
EXPECTED_REAL_FIXTURES="pi-v3-message-end.jsonl claude-code-2.1.278-assistant.jsonl codex-0.144.0-item-completed-agent-message.jsonl"
[ -f "$VERIFY" ] || { echo "selftest: not found: $VERIFY" >&2; exit 2; }
[ -f "$HARNESS" ] || { echo "selftest: not found: $HARNESS" >&2; exit 2; }
[ -f "$FINAL_ASSISTANT" ] || { echo "selftest: not found: $FINAL_ASSISTANT" >&2; exit 2; }
[ -f "$BRIEFS" ] || { echo "selftest: not found: $BRIEFS" >&2; exit 2; }
[ -f "$HERALD" ] || { echo "selftest: not found: $HERALD" >&2; exit 2; }
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

cleanup() {
  selftest_cleanup_fixture_processes "${FIX:-}" "${SOCK:-}"
  if [ -n "$FIX" ] && [ -e "$FIX" ]; then
    chmod -R u+w "$FIX" 2>/dev/null || true
    selftest_remove_fixture_dir "$FIX"
  fi
  return 0
}
selftest_install_cleanup_traps cleanup

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
selftest_sweep_stale_fixtures "$FIX_PREFIX" || exit 2

FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/$FIX_PREFIX.$$.XXXXXX" "$FIX_PREFIX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
FIX="$(cd "$FIX" && pwd -P)"
# Nested reviews run only tiny tracked fixture suites, not the host inventory.
export WHEELHOUSE_SELFTEST_SWEEP_LOCK="$FIX/fixture-sweep.lock"
HOME_FIX="$FIX/home"
BIN="$FIX/bin"
mkdir -p "$HOME_FIX" "$BIN"
RUN_PATH="$BIN:$PATH" # Keep fixture mocks before inherited host-budget shims.

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
if (process.env.WHEELHOUSE_TEST_CHILD_LEDGER) fs.appendFileSync(process.env.WHEELHOUSE_TEST_CHILD_LEDGER, JSON.stringify({event:"model",pid:process.pid}) + "\n");
// The dispatcher must set BEADS_ACTOR in OUR env by construction (adapter.ts's
// beadsActorFor mirrored here for the reviewer), not rely on an operator
// export reaching this one-shot process.
fs.writeFileSync(path.join(agentDir, "env.json"), JSON.stringify({ BEADS_ACTOR: process.env.BEADS_ACTOR ?? null, PATH: process.env.PATH ?? null, WHEELHOUSE_ROOT: process.env.WHEELHOUSE_ROOT ?? null, WHEELHOUSE_REAL_BD: process.env.WHEELHOUSE_REAL_BD ?? null, GIT_DIR: process.env.GIT_DIR ?? null, GIT_WORK_TREE: process.env.GIT_WORK_TREE ?? null, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE ?? null }));
if (process.env.STUB_GIT_INIT_REPO) {
  const cp = require("child_process");
  const repo = process.env.STUB_GIT_INIT_REPO;
  const cleanEnv = { ...process.env };
  delete cleanEnv.GIT_DIR; delete cleanEnv.GIT_WORK_TREE; delete cleanEnv.GIT_INDEX_FILE;
  const readWorktree = () => {
    const r = cp.spawnSync("git", ["-C", repo, "config", "--get", "core.worktree"], { encoding: "utf8", env: cleanEnv });
    return r.status === 0 ? r.stdout.trim() : "";
  };
  const before = readWorktree();
  const fixture = path.join(agentDir, "git-init-fixture");
  fs.mkdirSync(fixture, { recursive: true });
  const init = cp.spawnSync("git", ["init", "-q", "-b", "main"], { cwd: fixture, encoding: "utf8", env: process.env });
  const after = readWorktree();
  fs.writeFileSync(path.join(agentDir, "git-init-check.json"), JSON.stringify({ before, after, initStatus: init.status, initStderr: init.stderr ?? "", gitDir: process.env.GIT_DIR ?? null, gitWorkTree: process.env.GIT_WORK_TREE ?? null }, null, 2));
}
if (process.env.STUB_CLOBBER_CORE_WORKTREE_REPO) {
  const cp = require("child_process");
  const cleanEnv = { ...process.env };
  delete cleanEnv.GIT_DIR; delete cleanEnv.GIT_WORK_TREE; delete cleanEnv.GIT_INDEX_FILE;
  cp.spawnSync("git", ["-C", process.env.STUB_CLOBBER_CORE_WORKTREE_REPO, "config", "--local", "core.worktree", process.cwd()], { env: cleanEnv });
  fs.writeFileSync(path.join(agentDir, "core-worktree-clobber.txt"), process.cwd());
}
// The dispatcher sets our cwd by construction (a scratch worktree), not by
// telling us in a prompt to stay off the live checkout. Recording it here
// lets the selftest see what the OS-level cwd actually was.
fs.writeFileSync(path.join(agentDir, "cwd.txt"), process.cwd());
// Readiness is out-of-band: it must not count as reviewer stdout/stderr.
const watchdogDir = process.env.WHEELHOUSE_TEST_WATCHDOG_DIR;
if (watchdogDir) {
  fs.writeFileSync(path.join(watchdogDir, "ready"), JSON.stringify({pid:process.pid}));
  while (!fs.existsSync(path.join(watchdogDir, "release"))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  if (process.env.STUB_TEST_EMIT_NOTHING === "eof") process.exit(0);
  if (process.env.STUB_TEST_EMIT_NOTHING === "silent") {
    fs.writeFileSync(path.join(watchdogDir, "silent"), "entered\n");
    setInterval(() => {}, 1000);
    return;
  }
}
if (process.env.STUB_RUN_BENCH === "1") {
  const cp = require("child_process");
  const outDir = path.join(process.cwd(), "bench-out");
  fs.mkdirSync(outDir, { recursive: true });
  const bench = path.join(process.env.WHEELHOUSE_ROOT || "", "wheelhouse", "crew", "bench.sh");
  const res = cp.spawnSync(bench, ["artifact-fixture", outDir], { encoding: "utf8" });
  const rc = res.error && res.error.code === "ENOENT" ? 127 : (res.status ?? 1);
  fs.writeFileSync(path.join(agentDir, "bench-run.json"), JSON.stringify({ bench, rc, stdout: res.stdout ?? "", stderr: res.stderr ?? "", error: res.error?.message ?? null }, null, 2));
  const text = `bench rc=${rc}\nVERDICT: ${rc === 127 ? "BOUNCE" : "APPROVE"}\nPUSH: NOT CONSIDERED\n`;
  const wantsJson = process.argv.includes("--mode") && process.argv[process.argv.indexOf("--mode") + 1] === "json";
  process.stdout.write(wantsJson ? JSON.stringify({type:"message_end",message:{role:"assistant",content:text}})+"\n" : text);
  process.exit(0);
}
if (process.env.STUB_SOURCE_CHECK === "1") {
  const prompt = process.argv[process.argv.length - 1] || "";
  const match = prompt.match(/mounted read-only at (\S+)/);
  const mounted = match?.[1] || "";
  let readable = false, writeFailed = false, undeclaredAbsent = false, detail = "";
  try {
    readable = fs.readFileSync(path.join(mounted, "allowed.txt"), "utf8").includes("allowed sibling source");
  } catch (e) { detail += `read failed: ${e.message}\n`; }
  try {
    fs.writeFileSync(path.join(mounted, "write-attempt.txt"), "write should fail\n");
  } catch { writeFailed = true; }
  undeclaredAbsent = !prompt.includes("unlisted-sibling") && !fs.existsSync(path.join(path.dirname(mounted), "unlisted-sibling"));
  fs.writeFileSync(path.join(agentDir, "source-check.txt"), JSON.stringify({ mounted, readable, writeFailed, undeclaredAbsent, promptHasSourceSection: prompt.includes("Read-only source snapshots") }, null, 2));
  if (!readable || !writeFailed || !undeclaredAbsent) {
    process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:`source check failed\nVERDICT: BOUNCE\nPUSH: NOT CONSIDERED\n`}})+"\n");
    process.exit(0);
  }
}
if (process.env.STUB_CANONICAL_WRITE_REPO) {
  const cp = require("child_process");
  const repo = process.env.STUB_CANONICAL_WRITE_REPO;
  let status = "not-run";
  try {
    cp.execFileSync("git", ["checkout", "--", "canonical-guard.txt"], { env: process.env, stdio: "pipe" });
    status = "ok";
  } catch (e) {
    status = `failed:${e.status ?? e.code ?? "unknown"}`;
  }
  fs.writeFileSync(path.join(agentDir, "canonical-write-attempt.txt"), `repo=${repo}\nstatus=${status}\ncwd=${process.cwd()}\nGIT_WORK_TREE=${process.env.GIT_WORK_TREE ?? ""}\n`);
}
if (process.env.STUB_RUNTIME_GREP_CHECK === "1") {
  const cp = require("child_process");
  const started = Date.now();
  const grep = cp.spawnSync("grep", ["-R", "--", "wheelhouse-selftest-never-match", "seats"], { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const elapsedMs = Date.now() - started;
  const prompt = process.argv[process.argv.length - 1] || "";
  fs.writeFileSync(path.join(agentDir, "runtime-grep-check.txt"), JSON.stringify({
    cwd: process.cwd(),
    elapsedMs,
    status: grep.status,
    signal: grep.signal,
    stderr: grep.stderr,
    promptNamesRuntimeExcludes: prompt.includes("seats/logs") && prompt.includes("seats/verdicts/*.partial*")
  }, null, 2));
}
if (process.env.STUB_BD_READONLY_CHECK === "1") {
  const cp = require("child_process");
  const readonlyInstall = path.join(path.dirname(process.cwd()), "readonly-install");
  fs.mkdirSync(path.join(readonlyInstall, ".beads"), { recursive: true });
  const cases = [
    ["show", ["show", "bead-1"]],
    ["comments", ["comments", "bead-1"]],
    ["comment", ["comment", "bead-1", "--stdin"]],
    ["update", ["update", "bead-1", "--add-label", "needs-review"]],
    ["actor-close", ["--actor", "x", "close", "bead-1"]],
  ].map(([name, args]) => {
    const r = cp.spawnSync("bd", args, { cwd: readonlyInstall, input: "body\n", encoding: "utf8" });
    return { name, status: r.status, stdout: r.stdout, stderr: r.stderr };
  });
  fs.writeFileSync(path.join(agentDir, "bd-readonly-check.json"), JSON.stringify(cases, null, 2));
}
if (process.env.STUB_SWEEP_PROMPT_CHECK === "1") {
  const prompt = process.argv[process.argv.length - 1] || "";
  const rc = (prompt.match(/^- rc: (\d+)/m) || [])[1] || "";
  const log = (prompt.match(/^- log: (.+)$/m) || [])[1] || "";
  let logText = "", ok = false;
  try { logText = fs.readFileSync(log, "utf8"); ok = rc === "0" && logText.includes("fixture sweep PASS") && logText.includes("scratch bd create ok"); } catch (e) { logText = `read failed: ${e.message}`; }
  fs.writeFileSync(path.join(agentDir, "sweep-prompt-check.json"), JSON.stringify({ rc, log, ok, logText }, null, 2));
  const cp = require("child_process");
  const readonly = cp.spawnSync("bd", ["create", "reviewer must not write"], { encoding: "utf8" });
  if (!log) {
    const attempted = cp.spawnSync("bash", ["seats/selftest-sweep.sh"], { timeout: 150, encoding: "utf8" });
    process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:`full sweep unproven: reviewer command limit ${attempted.error?.code || attempted.status}\nVERDICT: ${process.env.STUB_SWEEP_FORCE_APPROVE === "1" ? "APPROVE" : "BOUNCE"}\nPUSH: NOT CONSIDERED\n`}})+"\n");
    process.exit(0);
  }
  const verdict = ok && readonly.status !== 0 ? "APPROVE" : "BOUNCE";
  if (process.env.STUB_SWEEP_DELETE_LOG === "1" && log) fs.unlinkSync(log);
  const citation = process.env.STUB_SWEEP_OMIT_CITATION === "1" ? "sweep omitted" : `sweep evidence rc=${rc} log=${log}`;
  process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:`${citation}\nVERDICT: ${process.env.STUB_SWEEP_VERDICT || (process.env.STUB_SWEEP_FORCE_APPROVE === "1" ? "APPROVE" : verdict)}\nPUSH: NOT CONSIDERED\n`}})+"\n");
  process.exit(0);
}
if (process.env.STUB_BD_READONLY_SCOPE_CHECK === "1") {
  const cp = require("child_process");
  const scratchGraph = path.join(process.cwd(), "bd-scratch");
  const siblingInstall = path.join(path.dirname(process.cwd()), "sibling-install");
  const arbitraryCwd = path.join(path.dirname(process.cwd()), "arbitrary-cwd");
  fs.mkdirSync(scratchGraph, { recursive: true });
  fs.mkdirSync(path.join(siblingInstall, ".beads"), { recursive: true });
  fs.mkdirSync(arbitraryCwd, { recursive: true });
  const run = (name, cwd, args, env = {}) => {
    const r = cp.spawnSync("bd", args, { cwd, env: { ...process.env, ...env }, input: "body\n", encoding: "utf8" });
    return { name, cwd, args, status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const cases = [
    run("scratch-create", scratchGraph, ["create", "scratch bead"]),
    run("scratch-c-redirect", scratchGraph, ["-C", siblingInstall, "create", "redirect bead"]),
    run("scratch-directory-redirect", scratchGraph, ["--directory", siblingInstall, "create", "redirect bead"]),
    run("scratch-global", scratchGraph, ["--global", "create", "global bead"]),
    run("scratch-beads-dir-outside", scratchGraph, ["create", "override bead"], { BEADS_DIR: path.join(siblingInstall, ".beads") }),
    run("scratch-db-override", scratchGraph, ["--db", path.join(siblingInstall, ".beads", "beads.db"), "create", "override bead"]),
    run("scratch-database-override", scratchGraph, ["--database", "other_database", "create", "override bead"]),
    run("arbitrary-create", arbitraryCwd, ["create", "arbitrary bead"]),
  ];
  fs.writeFileSync(path.join(agentDir, "bd-readonly-scope-check.json"), JSON.stringify(cases, null, 2));
}
const reply = process.env.STUB_REPLY_FILE;
let text = reply ? fs.readFileSync(reply, "utf8") : "";
if (process.env.STUB_MUTATE_BATCH_LOG) {
  const file = process.env.STUB_MUTATE_BATCH_LOG;
  const before = fs.readFileSync(file, "utf8");
  const after = before.replace(/\nelapsedMs=(\d+)\n$/, (_, n) => `\nelapsedMs=${Number(n)+1}\n`);
  if (after === before) throw new Error("batch mutation fixture footer changed");
  fs.writeFileSync(file, after);
}
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
if (process.env.STUB_SILENT === "1") {
  if (watchdogDir) fs.writeFileSync(path.join(watchdogDir, "silent"), "entered\n");
  setInterval(() => {}, 1000); // Remain silent until the explicitly fired watchdog stops us.
} else if (process.env.STUB_STALL === "1") {
  // Match real pi behavior: without --mode json, a stalled one-shot emits no
  // JSON events before timeout, so this selftest catches a missing stream flag.
  if (streamRequested) {
    process.stdout.write(JSON.stringify({type:"tool_execution_start",toolName:"bash",args:{cmd:"cargo test"}})+"\n");
  }
  setInterval(() => {}, 1000); // Held until the watchdog, not a finite lease.
} else if (process.env.STUB_STALL_AFTER_TOOL_END === "1") {
  if (streamRequested) {
    process.stdout.write(JSON.stringify({type:"tool_execution_start",toolName:"bash",args:{cmd:"cargo test"}})+"\n");
    process.stdout.write(JSON.stringify({type:"tool_execution_end",toolName:"bash",exitCode:0})+"\n");
  }
  setInterval(() => {}, 1000); // Held until the watchdog, not a finite lease.
} else if (process.env.STUB_PI_QUOTED_VERDICT_MIDRUN === "1") {
  process.on("SIGTERM", () => process.exit(143));
  if (!process.env.STUB_SUPPRESS_DEFAULT_PUSH && text && !/^PUSH:/m.test(text)) text += "PUSH:    NOT CONSIDERED\n";
  const write = (obj) => process.stdout.write(JSON.stringify(obj)+"\n");
  if (streamRequested) {
    write({type:"message_end",message:{role:"assistant",content:"Prior reviewer output quoted for context:\nVERDICT: BOUNCE\nPUSH: NOT CONSIDERED\nStill investigating."}});
    write({type:"turn_end",message:{role:"assistant"}});
    setTimeout(() => write({type:"tool_execution_start",toolName:"bash",args:{cmd:"continue review"}}), 100);
    setTimeout(() => write({type:"tool_execution_end",toolName:"bash",exitCode:0}), 180);
    setTimeout(() => write({type:"message_end",message:{role:"assistant",content:text}}), 260);
    setTimeout(() => write({type:"agent_end"}), 280);
    setTimeout(() => process.exit(Number(process.env.STUB_EXIT || 0)), 500);
  } else {
    process.stdout.write(text);
    process.exit(Number(process.env.STUB_EXIT || 0));
  }
} else if (process.env.STUB_HANG_CHILD_AFTER_RESULT === "1") {
  if (!process.env.STUB_SUPPRESS_DEFAULT_PUSH && text && !/^PUSH:/m.test(text)) text += "PUSH:    NOT CONSIDERED\n";
  const cp = require("child_process");
  const child = cp.spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], { stdio: ["ignore", "inherit", "inherit"] });
  fs.writeFileSync(path.join(agentDir, "hanging-child-pid.txt"), String(child.pid));
  if (streamRequested) {
    process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:text}})+"\n");
    process.stdout.write(JSON.stringify({type:"agent_end"})+"\n");
  } else process.stdout.write(text);
  process.exit(0);
} else if (process.env.STUB_SLOW_TOOL_OUTPUT === "1" || process.env.STUB_LONG_TOOL_PROGRESS === "1") {
  if (!process.env.STUB_SUPPRESS_DEFAULT_PUSH && text && !/^PUSH:/m.test(text)) text += "PUSH:    NOT CONSIDERED\n";
  const write = (obj) => fs.writeSync(1, JSON.stringify(obj)+"\n");
  if (streamRequested) {
    write({type:"tool_execution_start",toolName:"bash",args:{cmd:"slow selftest"}});
    if (process.env.STUB_LONG_TOOL_PROGRESS === "1" && watchdogDir) {
      const ack = n => { while (!fs.existsSync(path.join(watchdogDir, `progress-ack-${n}`))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); };
      ack(1); // The start record above must actually reach collect().
      for (let i = 1; i <= 6; i++) {
        fs.writeSync(1, JSON.stringify({type:"tool_execution_update",toolName:"bash",output:`still running ${i}`})+"\n"); ack(i+1);
      }
      fs.writeSync(1, JSON.stringify({type:"tool_execution_end",toolName:"bash",exitCode:0})+"\n"); ack(8);
      fs.writeSync(1, JSON.stringify({type:"message_end",message:{role:"assistant",content:text}})+"\n"); ack(9);
      process.exit(Number(process.env.STUB_EXIT || 0));
    } else if (process.env.STUB_LONG_TOOL_PROGRESS === "1") {
      for (let i = 1; i <= 6; i++) setTimeout(() => write({type:"tool_execution_update",toolName:"bash",output:`still running ${i}`}), i * 100);
      setTimeout(() => write({type:"tool_execution_end",toolName:"bash",exitCode:0}), 700);
      setTimeout(() => { write({type:"message_end",message:{role:"assistant",content:text}}); process.exit(Number(process.env.STUB_EXIT || 0)); }, 760);
    } else {
      // Optional idle gap is a causal regression stimulus, never host load.
      const gap = Number(process.env.WHEELHOUSE_VERIFY_TEST_IDLE_GAP_MS || 0);
      setTimeout(() => write({type:"tool_execution_update",toolName:"bash",output:"still running 1"}), gap + 80);
      setTimeout(() => write({type:"tool_execution_update",toolName:"bash",output:"still running 2"}), gap + 160);
      setTimeout(() => write({type:"tool_execution_end",toolName:"bash",exitCode:0}), gap + 240);
      setTimeout(() => { write({type:"message_end",message:{role:"assistant",content:text}}); process.exit(Number(process.env.STUB_EXIT || 0)); }, gap + 320);
    }
  } else {
    process.stdout.write(text);
    process.exit(Number(process.env.STUB_EXIT || 0));
  }
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
fs.writeFileSync(path.join(agentDir, "env.json"), JSON.stringify({ BEADS_ACTOR: process.env.BEADS_ACTOR ?? null, PATH: process.env.PATH ?? null, WHEELHOUSE_ROOT: process.env.WHEELHOUSE_ROOT ?? null, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR ?? null }));
fs.writeFileSync(path.join(agentDir, "cwd.txt"), process.cwd());
const reply = process.env.STUB_REPLY_FILE;
const text = reply ? fs.readFileSync(reply, "utf8") : "";
if (process.env.STUB_STREAM_FILE) {
  process.stdout.write(fs.readFileSync(process.env.STUB_STREAM_FILE, "utf8"));
  process.exit(Number(process.env.STUB_EXIT || 0));
}
const streamRequested = process.argv.includes("--output-format") && process.argv[process.argv.indexOf("--output-format") + 1] === "stream-json";
if (process.env.STUB_CLAUDE_QUOTED_VERDICT_MIDRUN === "1" && streamRequested) {
  process.on("SIGTERM", () => process.exit(143));
  const quoted = "Prior reviewer output quoted for context:\nVERDICT: BOUNCE\nPUSH: NOT CONSIDERED\nStill investigating.";
  process.stdout.write(JSON.stringify({type:"assistant",message:{role:"assistant",content:[{type:"text",text:quoted}]}})+"\n");
  setTimeout(() => process.stdout.write(JSON.stringify({type:"assistant",message:{role:"assistant",content:[{type:"text",text}]}})+"\n"), 250);
  setTimeout(() => { process.stdout.write(JSON.stringify({type:"result",subtype:"success",result:text})+"\n"); process.exit(Number(process.env.STUB_EXIT || "0")); }, 350);
} else if (streamRequested) {
  process.stdout.write(JSON.stringify({type:"assistant",message:{role:"assistant",content:[{type:"text",text}]}})+"\n");
  process.stdout.write(JSON.stringify({type:"result",subtype:"success",result:text})+"\n");
} else process.stdout.write(text);
if (process.env.STUB_CLAUDE_QUOTED_VERDICT_MIDRUN !== "1") process.exit(Number(process.env.STUB_EXIT || "0"));
STUB
cat > "$BIN/codex" <<'STUB'
#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const agentDir = process.env.CODEX_HOME;
if (!agentDir) { process.stderr.write("stub codex: no CODEX_HOME\n"); process.exit(1); }
fs.mkdirSync(agentDir, { recursive: true });
fs.writeFileSync(path.join(agentDir, "argv.json"), JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(path.join(agentDir, "invoked"), "");
fs.writeFileSync(path.join(agentDir, "env.json"), JSON.stringify({ BEADS_ACTOR: process.env.BEADS_ACTOR ?? null, PATH: process.env.PATH ?? null, WHEELHOUSE_ROOT: process.env.WHEELHOUSE_ROOT ?? null, CODEX_HOME: process.env.CODEX_HOME ?? null, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR ?? null }));
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
cat > "$BIN/bd" <<'STUB'
#!/usr/bin/env bash
set -u
readonly=0
while true; do
  case "${1:-}" in
    --readonly) readonly=1; shift; continue ;;
    -C|--directory) cd "$2"; shift 2; continue ;;
    --directory=*) cd "${1#--directory=}"; shift; continue ;;
    --actor|--db|--database) shift 2; continue ;;
    --db=*|--database=*) shift; continue ;;
    --global) shift; continue ;;
  esac
  break
done
verb="${1:-}"
case "$verb" in
  metrics)
    [ "${2:-}" = off ] || exit 1
    exit 0 ;;
  show)
    [ "${STUB_BD_SHOW_FAIL:-0}" != 1 ] || { echo 'fixture bd show unavailable' >&2; exit 1; }
    if [ -n "${STUB_BD_SHOW_FILE:-}" ] && [ -f "$STUB_BD_SHOW_FILE" ]; then cat "$STUB_BD_SHOW_FILE"; else printf 'fixture bead\n'; fi
    exit 0 ;;
  comments)
    [ "${STUB_BD_COMMENTS_FAIL:-0}" != 1 ] || { echo 'fixture bd comments unavailable' >&2; exit 1; }
    if [ -n "${STUB_BD_COMMENTS_FILE:-}" ]; then cat "$STUB_BD_COMMENTS_FILE"; else printf 'fixture comments\n'; fi
    exit 0 ;;
  where)
    node -e 'console.log(JSON.stringify({path:require("fs").realpathSync(".beads")}))'; exit $? ;;
  init)
    if [ "$readonly" = 1 ]; then printf "operation '%s' is not allowed in read-only mode\n" "$verb" >&2; exit 1; fi
    mkdir -p .beads; printf 'fixture graph\n' > .beads/fixture; exit 0 ;;
  create)
    if [ "$readonly" = 1 ]; then printf "operation '%s' is not allowed in read-only mode\n" "$verb" >&2; exit 1; fi
    [ -d .beads ] || { printf 'no beads database found\n' >&2; exit 1; }
    printf '{"id":"fixture-bead"}\n'; exit 0 ;;
  comment|update|close)
    if [ "$readonly" = 1 ]; then printf "operation '%s' is not allowed in read-only mode\n" "$verb" >&2; exit 1; fi
    printf 'write allowed unexpectedly\n' >&2; exit 0 ;;
  *) exit 1 ;;
esac
STUB
chmod +x "$BIN/bd"
[ -x "$BIN/pi" ] || { echo "selftest: fixture stub pi was not created" >&2; exit 2; }

# A fixture project: verify.ts expects to live at <root>/seats/verify.ts with
# the brief at <root>/contracts/REVIEWER.md, and the root to be a git repo
# holding the branch under review.
SENTINEL='SENTINEL-TOKEN-9c2e'
build_sweep_fixture() {   # real runner, one tiny tracked fixture suite
  local proj="$1"
  cp -f "$VERIFY_DIR/selftest-sweep.sh" "$proj/seats/selftest-sweep.sh" || exit 2
  printf 'fixture.selftest.sh\n' > "$proj/seats/selftest-core.list"
  cat > "$proj/seats/fixture.selftest.sh" <<'SH'
#!/usr/bin/env bash
set -eu
bd create 'sweep scratch bead' --json >/dev/null
printf 'scratch bd create ok\nfixture sweep PASS\n'
SH
}
build_proj() {   # $1 = project dir, $2 = seat namespace, $3 = verify.ts source
  local proj="$1" ns="$2" src="$3" d
  mkdir -p "$proj/seats" "$proj/contracts"
  selftest_copy_seat_runtime "$proj" "$VERIFY_DIR"
  cp "$src" "$proj/seats/verify.ts"
  printf '# Crew: Reviewer\n\nfixture brief — the stub never reads it, the argv check does.\n' \
    > "$proj/contracts/REVIEWER.md"
  printf 'tracked fixture seat file\n' > "$proj/seats/README.md"
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
    "reviewer": {
      "role": "reviewer",
      "provider": "openai",
      "model": "stub-model-v",
      "account": { "dir": "~/.pi-seats-$ns/reviewer" }
    }
  }
}
EOF
  for d in worker-1 reviewer; do
    mkdir -p "$HOME_FIX/.pi-seats-$ns/$d"
    printf '{\n  "%s": true\n}\n' "$proj" > "$HOME_FIX/.pi-seats-$ns/$d/trust.json"
    printf '{"stub":"%s"}\n' "$SENTINEL" > "$HOME_FIX/.pi-seats-$ns/$d/auth.json"
  done
  build_sweep_fixture "$proj"
  ( cd "$proj" &&
    git init -q -b main &&
    git add seats/README.md seats/selftest-core.list seats/selftest-sweep.sh seats/selftest-sweep-lock.ts seats/python-invocations.ts seats/fixture.selftest.sh &&
    git -c user.email=selftest@local -c user.name=selftest commit -q -m base &&
    git branch fleet/bead-1 ) || { echo "selftest: could not build fixture git repo" >&2; exit 2; }
}

build_installed_proj() {   # $1 = project dir, $2 = seat namespace, $3 = verify.ts source
  local proj="$1" ns="$2" src="$3"
  build_proj "$proj" "$ns" "$src"
  rm -rf "$proj/contracts"
  mkdir -p "$proj/wheelhouse/fleet" "$proj/wheelhouse/crew"
  printf '# Crew: Reviewer\n\ninstalled-layout reviewer brief.\n' > "$proj/wheelhouse/crew/REVIEWER.md"
  cat > "$proj/wheelhouse/crew/bench.sh" <<'BENCH'
#!/usr/bin/env bash
set -eu
artifact="${1:-}"; out="${2:-}"
printf 'machine-local bench ran: artifact=%s out=%s\n' "$artifact" "$out"
scratch="$out/bd-fixture"
mkdir -p "$scratch"
real_bd="${WHEELHOUSE_REAL_BD:-}"
[ -n "$real_bd" ] || { echo "WHEELHOUSE_REAL_BD is not set" >&2; exit 1; }
[ -x "$real_bd" ] || { echo "WHEELHOUSE_REAL_BD is not executable: $real_bd" >&2; exit 1; }
(
  cd "$scratch"
  "$real_bd" init --skip-agents >/dev/null
  BEADS_DIR="$scratch/.beads" "$real_bd" create 'bench scratch bead' --json >/dev/null
)
exit 42
BENCH
  chmod +x "$proj/wheelhouse/crew/bench.sh"
  printf 'wheelhouse/\n' >> "$proj/.git/info/exclude"
}

build_umbrella_proj() {   # $1 = umbrella dir, $2 = seat namespace, $3 = verify.ts source
  local umb="$1" ns="$2" src="$3" product="$1/product"
  mkdir -p "$umb/seats" "$umb/contracts" "$umb/wheelhouse" "$product"
  selftest_copy_seat_runtime "$umb" "$VERIFY_DIR"
  cp "$src" "$umb/seats/verify.ts"
  printf '# Crew: Reviewer\n\numbrella reviewer brief.\n' > "$umb/contracts/REVIEWER.md"
  printf 'product-repo=product\n' > "$umb/wheelhouse/.template-source"
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
    "reviewer": {
      "role": "reviewer",
      "provider": "openai",
      "model": "stub-model-v",
      "account": { "dir": "~/.pi-seats-$ns/reviewer" }
    }
  }
}
EOF
  for d in worker-1 reviewer; do
    mkdir -p "$HOME_FIX/.pi-seats-$ns/$d"
    printf '{\n  "%s": true\n}\n' "$umb" > "$HOME_FIX/.pi-seats-$ns/$d/trust.json"
    printf '{"stub":"%s"}\n' "$SENTINEL" > "$HOME_FIX/.pi-seats-$ns/$d/auth.json"
  done
  build_sweep_fixture "$umb"
  ( cd "$umb" &&
    git init -q -b main &&
    git add seats/selftest-core.list seats/selftest-sweep.sh seats/selftest-sweep-lock.ts seats/python-invocations.ts seats/fixture.selftest.sh &&
    git -c user.email=selftest@local -c user.name=selftest commit -q -m umbrella-base ) || { echo "selftest: could not build umbrella git repo" >&2; exit 2; }
  mkdir -p "$product/seats"
  selftest_copy_seat_runtime "$product" "$VERIFY_DIR"
  build_sweep_fixture "$product"
  ( cd "$product" &&
    git init -q -b main &&
    mkdir -p evidence && printf 'product branch evidence\n' > evidence/bench.log &&
    git add evidence/bench.log seats/selftest-core.list seats/selftest-sweep.sh seats/selftest-sweep-lock.ts seats/python-invocations.ts seats/fixture.selftest.sh &&
    git -c user.email=selftest@local -c user.name=selftest commit -q -m base &&
    git branch fleet/bead-1 ) || { echo "selftest: could not build umbrella product git repo" >&2; exit 2; }
}

PROJ="$FIX/proj"
build_proj "$PROJ" alpha "$VERIFY"
TIP="$(git -C "$PROJ" rev-parse fleet/bead-1)"

REPLY="$FIX/reply.txt"
core_worktree_snapshot() { local out rc; out="$(git -C "$1" config --local --get core.worktree 2>&1)"; rc=$?; printf 'rc=%s\n%s\n' "$rc" "$out"; }
run() {   # runs verify.ts in the fixture; args pass through
  # BEADS_ACTOR unset on purpose: the dispatcher must set it in the spawned
  # reviewer's own env by construction, not forward whatever this shell has.
  OUT="$(env -u WHEELHOUSE_VERIFY_TIMEOUT_MS -u WHEELHOUSE_VERIFY_FIRST_OUTPUT_TIMEOUT_MS -u WHEELHOUSE_VERIFY_NO_EVENT_TIMEOUT_MS -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_REPLY_FILE="$REPLY" \
    bun "$RUN_PROJ/seats/verify.ts" "$@" 2>&1)"
  RC=$?
}
run_without_default_push() {
  OUT="$(env -u WHEELHOUSE_VERIFY_TIMEOUT_MS -u WHEELHOUSE_VERIFY_FIRST_OUTPUT_TIMEOUT_MS -u WHEELHOUSE_VERIFY_NO_EVENT_TIMEOUT_MS -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_REPLY_FILE="$REPLY" STUB_SUPPRESS_DEFAULT_PUSH=1 \
    bun "$RUN_PROJ/seats/verify.ts" "$@" 2>&1)"
  RC=$?
}
run_stream() {  # $1 = JSONL stream file, remaining args pass through
  local stream="$1"
  shift
  OUT="$(env -u WHEELHOUSE_VERIFY_TIMEOUT_MS -u WHEELHOUSE_VERIFY_FIRST_OUTPUT_TIMEOUT_MS -u WHEELHOUSE_VERIFY_NO_EVENT_TIMEOUT_MS -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_STREAM_FILE="$stream" \
    bun "$RUN_PROJ/seats/verify.ts" "$@" 2>&1)"
  RC=$?
}
run_with_bd_show() {  # $1 = bd-show file, remaining args pass through
  local bdfile="$1"
  shift
  OUT="$(env -u WHEELHOUSE_VERIFY_TIMEOUT_MS -u WHEELHOUSE_VERIFY_FIRST_OUTPUT_TIMEOUT_MS -u WHEELHOUSE_VERIFY_NO_EVENT_TIMEOUT_MS -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_REPLY_FILE="$REPLY" STUB_BD_SHOW_FILE="$bdfile" \
    bun "$RUN_PROJ/seats/verify.ts" "$@" 2>&1)"
  RC=$?
}
run_source_check() {  # $1 = bd-show file, remaining args pass through
  local bdfile="$1"
  shift
  OUT="$(env -u WHEELHOUSE_VERIFY_TIMEOUT_MS -u WHEELHOUSE_VERIFY_FIRST_OUTPUT_TIMEOUT_MS -u WHEELHOUSE_VERIFY_NO_EVENT_TIMEOUT_MS -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_REPLY_FILE="$REPLY" STUB_BD_SHOW_FILE="$bdfile" STUB_SOURCE_CHECK=1 \
    bun "$RUN_PROJ/seats/verify.ts" "$@" 2>&1)"
  RC=$?
}
run_runtime_grep_check() {
  OUT="$(env -u WHEELHOUSE_VERIFY_TIMEOUT_MS -u WHEELHOUSE_VERIFY_FIRST_OUTPUT_TIMEOUT_MS -u WHEELHOUSE_VERIFY_NO_EVENT_TIMEOUT_MS -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_REPLY_FILE="$REPLY" STUB_RUNTIME_GREP_CHECK=1 \
    bun "$RUN_PROJ/seats/verify.ts" "$@" 2>&1)"
  RC=$?
}
run_bench_check() {  # args pass through to verify.ts
  OUT="$(env -u WHEELHOUSE_VERIFY_TIMEOUT_MS -u WHEELHOUSE_VERIFY_FIRST_OUTPUT_TIMEOUT_MS -u WHEELHOUSE_VERIFY_NO_EVENT_TIMEOUT_MS -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_RUN_BENCH=1 \
    bun "$RUN_PROJ/seats/verify.ts" "$@" 2>&1)"
  RC=$?
}
run_sweep_prompt_check() {  # $1 = bd-show file, remaining args pass through
  local bdfile="$1"
  shift
  WATCHDOG_DIR="$(mktemp -d "$FIX/sweep-readiness.XXXXXX")"
  OUT="$(env -u WHEELHOUSE_VERIFY_TIMEOUT_MS -u WHEELHOUSE_VERIFY_FIRST_OUTPUT_TIMEOUT_MS -u WHEELHOUSE_VERIFY_NO_EVENT_TIMEOUT_MS -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_BD_SHOW_FILE="$bdfile" STUB_SWEEP_PROMPT_CHECK=1 \
    bun "$READINESS_DRIVER" "$RUN_PROJ/seats/verify.ts" "$WATCHDOG_DIR" ready "$@" 2>&1)"
  RC=$?
}
says() { case "$OUT" in *"$1"*) return 0 ;; *) return 1 ;; esac; }
RUN_PROJ="$PROJ"
VDIR="$PROJ/seats/verdicts"
VARGV="$HOME_FIX/.pi-seats-alpha/reviewer/argv.json"
VINVOKED="$HOME_FIX/.pi-seats-alpha/reviewer/invoked"
VCWD="$HOME_FIX/.pi-seats-alpha/reviewer/cwd.txt"

phase "fixture containment — exclusive H4 publication and bounded release wait"
BOUNDS_DIR="$(mktemp -d "$FIX/holder-bounds.XXXXXX")"
if bun "$READINESS_DRIVER" "$VERIFY" "$BOUNDS_DIR" holder-bounds; then
  pass "H4 real-helper fixture refuses occupied locks and fails a missing-release waiter (native exits 1/124)"
else fail "H4 fixture publication/bounded waiter regression"; fi

phase "verifier gate STOP reaches the dispatch inbox"
if [ -f "$PROJ/seats/inbox.jsonl" ]; then BEFORE_INBOX_LINES="$(wc -l < "$PROJ/seats/inbox.jsonl" | tr -d ' ')"; else BEFORE_INBOX_LINES=0; fi
run bead-no-branch fleet/does-not-exist worker-1
if [ -f "$PROJ/seats/inbox.jsonl" ]; then AFTER_INBOX_LINES="$(wc -l < "$PROJ/seats/inbox.jsonl" | tr -d ' ')"; else AFTER_INBOX_LINES=0; fi
DRAIN_STOP="$FIX/drain-stop.jsonl"
bun "$PROJ/seats/herald.ts" --drain > "$DRAIN_STOP"
if [ $RC -ne 0 ] && [ $((AFTER_INBOX_LINES - BEFORE_INBOX_LINES)) -eq 1 ] \
  && grep -q '"seat":"verifier-gate"' "$DRAIN_STOP" \
  && grep -q '"class":"distress"' "$DRAIN_STOP" \
  && grep -q 'branch \\"fleet/does-not-exist\\" does not resolve' "$DRAIN_STOP"; then
  pass "nonexistent branch STOP appends one verifier-gate distress row and herald --drain returns it"
else
  fail "nonexistent branch STOP did not produce one drainable inbox row (rc=$RC before=$BEFORE_INBOX_LINES after=$AFTER_INBOX_LINES out=$OUT drain=$(cat "$DRAIN_STOP" 2>/dev/null || true))"
fi
rm -f "$PROJ/seats/inbox.jsonl" "$PROJ/seats/inbox.cursor" "$PROJ/seats/inbox.seen.json"

phase "pool reviewer routing — shared author subscription is skipped"
cp "$PROJ/seats/seats.json" "$FIX/seats-json.before-pool"
bun - "$PROJ/seats/seats.json" <<'TS'
import fs from "node:fs";
const p=process.argv[2],j=JSON.parse(fs.readFileSync(p,"utf8"));
delete j.seats.reviewer; fs.writeFileSync(p,JSON.stringify(j,null,2));
TS
mkdir -p "$HOME_FIX/.pi-seats-proj/pool/rv1" "$HOME_FIX/.pi-seats-proj/pool/rv2"
printf '{"stub":"%s"}\n' "$SENTINEL" > "$HOME_FIX/.pi-seats-proj/pool/rv1/auth.json"
printf '{"stub":"%s"}\n' "$SENTINEL" > "$HOME_FIX/.pi-seats-proj/pool/rv2/auth.json"
cat > "$PROJ/seats/pool.json" <<'JSON'
{"version":1,"entries":{"rv1":{"harness":"pi","provider":"openai","models":["stub-model-rv1"],"account":{"dir":"~/.pi-seats-proj/pool/rv1","authRoute":"oauth"}},"rv2":{"harness":"pi","provider":"openai","models":["stub-model-rv2"],"account":{"dir":"~/.pi-seats-proj/pool/rv2","authRoute":"oauth"}}},"roles":{"reviewers":{"min":0,"max":2,"entries":["rv1","rv2"],"model":{"rv1":"stub-model-rv1","rv2":"stub-model-rv2"}}}}
JSON
cat > "$PROJ/seats/staffing.json" <<'JSON'
{"version":1,"seats":{"reviewer-rv1":{"role":"reviewer","entry":"rv1","addedAt":"2026-01-01T00:00:00Z"},"reviewer-rv2":{"role":"reviewer","entry":"rv2","addedAt":"2026-01-01T00:00:00Z"}},"rateLimited":{}}
JSON
cat > "$PROJ/seats/state.json" <<'JSON'
{"seats":{"author-state":{"accountDir":"~/.pi-seats-proj/pool/rv1"}}}
JSON
cat > "$REPLY" <<EOF
Reviewer pool routing fixture.
VERDICT: APPROVE
EOF
RUN_PROJ="$PROJ"; VARGV="$HOME_FIX/.pi-seats-proj/pool/rv2/argv.json"
run bead-pool-route fleet/bead-1 author-state
if [ $RC -eq 0 ] && [ -f "$VARGV" ] && grep -q 'stub-model-rv2' "$VARGV" && [ ! -f "$HOME_FIX/.pi-seats-proj/pool/rv1/argv.json" ]; then pass "pool reviewer routing skips staffed reviewer sharing author subscription and picks the other"; else fail "pool reviewer route failed rc=$RC out=$OUT rv1=$(cat "$HOME_FIX/.pi-seats-proj/pool/rv1/argv.json" 2>/dev/null) rv2=$(cat "$VARGV" 2>/dev/null)"; fi
rm -f "$VARGV" "$HOME_FIX/.pi-seats-proj/pool/rv1/argv.json"
cat > "$PROJ/seats/pool.json" <<'JSON'
{"version":1,"entries":{"rv2":{"harness":"pi","provider":"openai","models":["stub-model-rv2"],"account":{"dir":"~/.pi-seats-proj/pool/rv2","authRoute":"oauth"}}},"roles":{"reviewers":{"min":0,"max":1,"entries":["rv2"],"model":"stub-model-rv2"}}}
JSON
cat > "$PROJ/seats/staffing.json" <<'JSON'
{"version":1,"seats":{"reviewer-rv2":{"role":"reviewer","entry":"rv2","addedAt":"2026-01-01T00:00:00Z"}},"rateLimited":{}}
JSON
cat > "$PROJ/seats/state.json" <<'JSON'
{"seats":{"author-state":{"accountDir":"~/.pi-seats-proj/pool/rv2"}}}
JSON
run bead-pool-all-share fleet/bead-1 author-state
if [ $RC -ne 0 ] && says "SAME account directory" && says "waiting for a reviewer"; then pass "pool reviewer routing STOPs with waiting wording when every reviewer shares author subscription"; else fail "all-shared reviewer STOP failed rc=$RC out=$OUT"; fi
run bead-pool-explicit-same fleet/bead-1 author-state reviewer-rv2
if [ $RC -eq 1 ] && says "SAME account directory"; then pass "pool-present explicit reviewer still runs the disk distinctness STOP before spawn"; else fail "pool explicit distinctness STOP failed rc=$RC out=$OUT"; fi
mkdir -p "$PROJ/seats/run"; (cd "$FIX"; "$NODE_BIN" -e 'setInterval(()=>{},1000)') & BUSY_RV2=$!; printf '{"pid":%s,"bead":"other"}\n' "$BUSY_RV2" > "$PROJ/seats/run/verify.reviewer-rv2.json"
cat > "$PROJ/seats/state.json" <<'JSON'
{"seats":{"author-state":{"accountDir":"~/.pi-seats-proj/pool/rv1"}}}
JSON
run bead-pool-all-busy fleet/bead-1 author-state
kill "$BUSY_RV2" 2>/dev/null || true
if [ $RC -eq 4 ] && says "all eligible reviewer seats busy"; then pass "pool reviewer routing retry-exits when all distinct reviewers are busy"; else fail "all-busy reviewer retry failed rc=$RC out=$OUT"; fi
rm -f "$PROJ/seats/run/verify.reviewer-rv2.json"
mv "$FIX/seats-json.before-pool" "$PROJ/seats/seats.json"; rm -f "$PROJ/seats/pool.json" "$PROJ/seats/staffing.json" "$PROJ/seats/state.json"

phase "shadow reviewers — selection and scoped per-outage promotion"
SHADOW_PROJ="$FIX/shadow-proj"
build_proj "$SHADOW_PROJ" shadow "$VERIFY"
if HOME="$HOME_FIX" PATH="$RUN_PATH" bun "$HERE/fixtures/reviewer-shadow.ts" "$SHADOW_PROJ" "$HOME_FIX"; then
  pass "shadow reviewer cases and pinned fix-removal controls"
else fail "shadow reviewer regression"; fi
if [ "${WHEELHOUSE_TEST_VERIFY_SHADOW_ONLY:-0}" = 1 ]; then
  printf 'verify shadow-focused selftest: failures=%s\n' "$FAILED"
  [ "$FAILED" -eq 0 ]; exit $?
fi

phase "installed layout — wheelhouse/crew brief is preferred without contracts/"
INST_PROJ="$FIX/installed-proj"
build_installed_proj "$INST_PROJ" installed "$VERIFY"
RUN_PROJ="$INST_PROJ"
VARGV="$HOME_FIX/.pi-seats-installed/reviewer/argv.json"
INST_TIP="$(git -C "$INST_PROJ" rev-parse fleet/bead-1)"
cat > "$REPLY" <<EOF
Checked installed-layout fixture at $INST_TIP.
VERDICT: APPROVE
EOF
run bead-installed fleet/bead-1 worker-1
if [ $RC -eq 0 ]; then pass "installed layout: APPROVE exits 0 with no contracts/ directory"
else fail "installed layout: verify exited ${RC}: $OUT"; fi
if grep -q "\"--append-system-prompt\",\"$INST_PROJ/wheelhouse/crew/REVIEWER.md\"" "$VARGV" 2>/dev/null; then
  pass "installed layout: reviewer brief resolves to wheelhouse/crew/REVIEWER.md"
else fail "installed layout: reviewer brief was not the installed path"; fi
if git -C "$INST_PROJ" check-ignore -q wheelhouse/crew/bench.sh; then
  pass "installed layout: wheelhouse/ is machine-local and excluded from the branch worktree"
else fail "installed layout: wheelhouse/crew/bench.sh was not excluded by .git/info/exclude"; fi
run_bench_check bead-installed-bench fleet/bead-1 worker-1
BENCH_RUN="$HOME_FIX/.pi-seats-installed/reviewer/bench-run.json"
if [ $RC -eq 0 ] && grep -q '"WHEELHOUSE_ROOT":"'"$INST_PROJ" "$HOME_FIX/.pi-seats-installed/reviewer/env.json" 2>/dev/null \
  && grep -q '"rc": 42' "$BENCH_RUN" 2>/dev/null \
  && ! grep -q '"rc": 127' "$BENCH_RUN" 2>/dev/null; then
  pass "installed-layout stub bench receives WHEELHOUSE_REAL_BD and writes only its scratch BEADS_DIR graph"
else fail "installed layout: machine-local bench did not run with writable scratch bd graph via WHEELHOUSE_ROOT (exit $RC): $OUT env=$(cat "$HOME_FIX/.pi-seats-installed/reviewer/env.json" 2>/dev/null) bench=$(cat "$BENCH_RUN" 2>/dev/null)"; fi

phase "0a1. required core/full tier selection and receipt gates"
if bun "$HERE/fixtures/verify-tiers.ts" "$VERIFY_DIR" "$FIX" "$PROJ" "$HOME_FIX" "$RUN_PATH"; then
  pass "tier selection, CLI receipts, core/full batch coverage and sensitive removal controls"
else fail "core/full review tier regression"; fi

phase "0a2. dispatcher-owned full sweep evidence for reviewer"
SWEEP_PROJ="$FIX/sweep-proj"
build_proj "$SWEEP_PROJ" sweep "$VERIFY"
# Keep the slowed-only inventory used by the batch-validation repository.
git -C "$SWEEP_PROJ" rm -q seats/fixture.selftest.sh || exit 2
# Real bd 1.2.2 may redirect a linked-worktree init to its shared ancestor;
# keep graph setup in an independent primary repo with consistent cwd/PWD.
SWEEP_BIN="$FIX/sweep-bin"; mkdir -p "$SWEEP_BIN"
export STUB_SWEEP_BASE_BD="$BIN/bd" STUB_SWEEP_PWD_MARKER="$FIX/sweep-pwd.json"
cat > "$SWEEP_BIN/bd" <<'JS'
#!/usr/bin/env node
const fs=require('fs'),cp=require('child_process');
if(process.argv[2]==='where') {
  console.log(JSON.stringify({path:fs.realpathSync(require('path').join(process.cwd(),'.beads'))})); process.exit(0);
}
if(process.argv[2]==='init') {
  if(process.env.STUB_SWEEP_INIT_FAIL==='1') { console.error('fixture sweep graph init failure'); process.exit(73); }
  const cwd=fs.realpathSync(process.cwd()),pwd=process.env.PWD ? fs.realpathSync(process.env.PWD) : '';
  const primary=fs.statSync(require('path').join(cwd,'.git')).isDirectory();
  if(pwd!==cwd || !primary) { console.error('scratch bd init requires an isolated primary repo and consistent PWD'); process.exit(73); }
  fs.writeFileSync(process.env.STUB_SWEEP_PWD_MARKER,JSON.stringify({cwd,pwd,primary}));
}
const r=cp.spawnSync(process.env.STUB_SWEEP_BASE_BD,process.argv.slice(2),{stdio:'inherit',env:process.env});
if(r.status===0 && process.argv[2]==='init' && process.env.STUB_SWEEP_MUTATE_SETUP==='1') {
  cp.execFileSync('git',['-c','user.name=selftest','-c','user.email=selftest@local','commit','--allow-empty','-qm','bad sweep setup'],{cwd:require('path').dirname(process.cwd())});
}
process.exit(r.status ?? 1);
JS
chmod +x "$SWEEP_BIN/bd"
SWEEP_SAVED_RUN_PATH="$RUN_PATH"; RUN_PATH="$SWEEP_BIN:$RUN_PATH"
cp -f "$VERIFY_DIR/selftest-sweep.sh" "$SWEEP_PROJ/seats/selftest-sweep.sh"
cp -f "$VERIFY_DIR/python-invocations.ts" "$SWEEP_PROJ/seats/python-invocations.ts" || exit 2
cat > "$SWEEP_PROJ/seats/slowed.selftest.sh" <<'SH'
#!/usr/bin/env bash
set -eu
sleep 2
[ -n "${WHEELHOUSE_REAL_BD:-}" ] || { echo 'missing WHEELHOUSE_REAL_BD'; exit 8; }
printf 'sweep cwd tip=%s\n' "$(git rev-parse HEAD)"
bd create 'sweep scratch bead' --json >/dev/null
printf 'scratch bd create ok\n'
printf 'fixture sweep PASS\n'
if [ -n "${STUB_REFUSAL_SWEEP_LEDGER:-}" ]; then
  git rev-parse HEAD >> "$STUB_REFUSAL_SWEEP_LEDGER"
fi
if [ "${SWEEP_FIXTURE_MOVE_TIP:-0}" = 1 ]; then
  git -c user.name=selftest -c user.email=selftest@local commit --allow-empty -qm 'bad suite mutation'
fi
exit "${SWEEP_FIXTURE_RC:-0}"
SH
chmod +x "$SWEEP_PROJ/seats/selftest-sweep.sh"
# Detached evidence runs only committed files: include both runner companions.
printf 'slowed.selftest.sh\n' > "$SWEEP_PROJ/seats/selftest-core.list"
git -C "$SWEEP_PROJ" add seats/selftest-core.list seats/selftest-sweep.sh seats/selftest-sweep-lock.ts seats/python-invocations.ts seats/slowed.selftest.sh
git -C "$SWEEP_PROJ" -c user.email=selftest@local -c user.name=selftest commit -q -m sweep-fixture
git -C "$SWEEP_PROJ" branch -f fleet/bead-1 HEAD
SWEEP_TIP="$(git -C "$SWEEP_PROJ" rev-parse fleet/bead-1)"
SWEEP_BD_SHOW="$FIX/sweep-bd-show.txt"
cat > "$SWEEP_BD_SHOW" <<'EOF'
○ bead-sweep [task]

DESCRIPTION

  ## Done

  The full seats/*.selftest.sh sweep passes.
EOF
RUN_PROJ="$SWEEP_PROJ"
VARGV="$HOME_FIX/.pi-seats-sweep/reviewer/argv.json"
SWEEP_LOCK="$FIX/review-sweep.lock"
phase "0a3. refused output and one in-invocation corrective attempt"
if env -u WHEELHOUSE_VERIFY_TIMEOUT_MS -u WHEELHOUSE_VERIFY_FIRST_OUTPUT_TIMEOUT_MS -u WHEELHOUSE_VERIFY_NO_EVENT_TIMEOUT_MS -u BEADS_ACTOR \
  HOME="$HOME_FIX" PATH="$RUN_PATH" bun "$VERIFY_DIR/fixtures/verify-refusal.ts" \
  "$SWEEP_PROJ/seats/verify.ts" "$SWEEP_PROJ" "$FIX/refusal-tests" "$SWEEP_BD_SHOW" "$SWEEP_LOCK"; then
  pass "all harnesses retain refusals, admit no premature verdict, bound retry, and reuse the completed sweep"
else fail "refusal/restatement regression failed"; fi
if [ "${WHEELHOUSE_VERIFY_REFUSAL_ONLY:-0}" = 1 ]; then
  [ "$FAILED" = 0 ] || { printf 'verify.selftest: FAIL (%s failures in refusal subset)\n' "$FAILED"; exit 1; }
  printf 'verify.selftest: PASS (refusal subset)\n'
  exit 0
fi
phase "0a2b. every review needs a dispatcher receipt"
check_dispatcher_receipts() {
  local variant="$1" before="$FAILED" style outcome proposed incomplete_bead
  SWEEP_GENERIC_CLAIM="$FIX/implicit-sweep-claim.txt"
  for style in lock-recovery state-writes process-isolation; do
    case "$style" in
      lock-recovery) outcome='The lock selftest passes and never steals a live owner.' ;;
      state-writes) outcome='The adapter recovers an abandoned empty state.lock and preserves live owners.' ;;
      process-isolation) outcome='The no-pi-spawned assertion counts only processes the test itself could have started.' ;;
    esac
    printf 'Trace: %s regression\n\nIntent:\nCheck the claimed behavior independently.\n\nOutcomes:\n- O1 %s\n  consumer: machine — fixture runner\n  surface: fixture state and process records\n  check: run — inspect the claimed behavior\n' "$style" "$outcome" > "$SWEEP_GENERIC_CLAIM"
    WHEELHOUSE_SELFTEST_SWEEP_LOCK="$SWEEP_LOCK" STUB_SWEEP_FORCE_APPROVE=1 run_sweep_prompt_check "$SWEEP_GENERIC_CLAIM" "bead-implicit-$style" fleet/bead-1 worker-1
    if [ "$RC" = 0 ] && [ -f "$SWEEP_PROJ/seats/verdicts/bead-implicit-$style.md" ] && grep -q '## Dispatcher full-sweep result' "$SWEEP_PROJ/seats/verdicts/bead-implicit-$style.md" && grep -q 'sweep evidence rc=0 log=' "$SWEEP_PROJ/seats/verdicts/bead-implicit-$style.md"; then
      pass "$style claim without sweep keywords still gets a dispatcher receipt"
    else fail "$style claim bypassed dispatcher sweep rc=$RC out=$OUT"; fi
  done
  WHEELHOUSE_SELFTEST_SWEEP_LOCK="$SWEEP_LOCK" STUB_BD_SHOW_FAIL=1 STUB_SWEEP_FORCE_APPROVE=1 run_sweep_prompt_check "$SWEEP_GENERIC_CLAIM" bead-implicit-show-failed fleet/bead-1 worker-1
  if [ "$RC" = 0 ] && [ -f "$SWEEP_PROJ/seats/verdicts/bead-implicit-show-failed.md" ] && grep -q '## Dispatcher full-sweep result' "$SWEEP_PROJ/seats/verdicts/bead-implicit-show-failed.md"; then
    pass "unavailable bead text does not skip the dispatcher sweep"
  else fail "unavailable bead text bypassed sweep rc=$RC out=$OUT"; fi
  WHEELHOUSE_SELFTEST_SWEEP_LOCK="$SWEEP_LOCK" SWEEP_FIXTURE_RC=7 STUB_SWEEP_FORCE_APPROVE=1 run_sweep_prompt_check "$SWEEP_GENERIC_CLAIM" bead-implicit-failed fleet/bead-1 worker-1
  if [ "$RC" = 1 ] && says 'APPROVE with failed full sweep' && [ ! -f "$SWEEP_PROJ/seats/verdicts/bead-implicit-failed.md" ]; then
    pass "failed dispatcher sweep blocks APPROVE even without sweep keywords"
  else fail "failed implicit sweep approved rc=$RC out=$OUT"; fi
  WHEELHOUSE_SELFTEST_SWEEP_LOCK="$SWEEP_LOCK" STUB_SWEEP_INIT_FAIL=1 STUB_SWEEP_FORCE_APPROVE=1 run_sweep_prompt_check "$SWEEP_GENERIC_CLAIM" bead-implicit-init-failed fleet/bead-1 worker-1
  if [ "$RC" = 1 ] && says 'fixture sweep graph init failure' && [ ! -f "$SWEEP_PROJ/seats/verdicts/bead-implicit-init-failed.md" ]; then
    pass "dispatcher setup error is named and blocks APPROVE for an implicit claim"
  else fail "sweep setup error swallowed rc=$RC out=$OUT"; fi
  WHEELHOUSE_SELFTEST_SWEEP_LOCK="$SWEEP_LOCK" STUB_SWEEP_DELETE_LOG=1 STUB_SWEEP_FORCE_APPROVE=1 run_sweep_prompt_check "$SWEEP_GENERIC_CLAIM" bead-implicit-log-missing fleet/bead-1 worker-1
  if [ "$RC" = 1 ] && says 'cannot record APPROVE without a dispatcher full-sweep result' && [ ! -f "$SWEEP_PROJ/seats/verdicts/bead-implicit-log-missing.md" ]; then
    pass "missing retained dispatcher receipt blocks APPROVE"
  else fail "missing dispatcher log accepted rc=$RC out=$OUT"; fi
  for proposed in BOUNCE DISCOVER; do
    incomplete_bead="bead-implicit-init-$proposed"
    WHEELHOUSE_SELFTEST_SWEEP_LOCK="$SWEEP_LOCK" STUB_SWEEP_INIT_FAIL=1 STUB_SWEEP_VERDICT="$proposed" run_sweep_prompt_check "$SWEEP_GENERIC_CLAIM" "$incomplete_bead" fleet/bead-1 worker-1
    if [ "$RC" = 1 ] && says 'INCOMPLETE review:' && says 'fixture sweep graph init failure' && [ ! -f "$SWEEP_PROJ/seats/verdicts/$incomplete_bead.md" ] && bun - "$SWEEP_PROJ/seats/inbox.jsonl" "$incomplete_bead" <<'JS'
import fs from 'node:fs';import assert from 'node:assert/strict';
const rows=fs.readFileSync(process.argv[2],'utf8').trim().split('\n').map(s=>JSON.parse(s)).filter(r=>r.title===`verifier gate STOP — ${process.argv[3]}`);
assert.equal(rows.length,1);assert.equal(rows[0].class,'distress');assert.equal(rows[0].state,'failed');assert.match(rows[0].detail,/INCOMPLETE review:.*fixture sweep graph init failure/);
JS
    then pass "setup failure records an incomplete review even when reviewer proposes $proposed";
    else fail "setup failure recorded $proposed instead of incomplete (rc=$RC out=$OUT)"; fi
  done
  SWEEP_BAD_LOCK="$FIX/refused-review-sweep-$variant.lock"
  mkdir "$SWEEP_BAD_LOCK"
  WHEELHOUSE_SELFTEST_SWEEP_LOCK="$SWEEP_BAD_LOCK" STUB_SWEEP_VERDICT=BOUNCE run_sweep_prompt_check "$SWEEP_GENERIC_CLAIM" bead-implicit-lock-refused fleet/bead-1 worker-1
  if [ "$RC" = 1 ] && says 'INCOMPLETE review:' && says 'lock helper failed (exit 2)' && [ ! -f "$SWEEP_PROJ/seats/verdicts/bead-implicit-lock-refused.md" ] && [ -d "$SWEEP_BAD_LOCK" ] && bun - "$SWEEP_PROJ/seats/inbox.jsonl" <<'JS'
import fs from 'node:fs';import assert from 'node:assert/strict';
const rows=fs.readFileSync(process.argv[2],'utf8').trim().split('\n').map(s=>JSON.parse(s)).filter(r=>r.title==='verifier gate STOP — bead-implicit-lock-refused');
assert.equal(rows.length,1);assert.equal(rows[0].class,'distress');assert.equal(rows[0].state,'failed');assert.match(rows[0].detail,/INCOMPLETE review:.*lock helper failed \(exit 2\)/);
JS
  then pass 'runner lock refusal records an incomplete review with its reason, not BOUNCE';
  else fail "runner lock refusal recorded a completed review (rc=$RC out=$OUT)"; fi
  NO_SUITE_PROJ="$FIX/no-suite-proj-$variant"
  build_proj "$NO_SUITE_PROJ" "nosuite-$variant" "$VERIFY"
  ( cd "$NO_SUITE_PROJ" && git rm -q seats/fixture.selftest.sh && git -c user.email=selftest@local -c user.name=selftest commit -q -m no-suite && git branch -f fleet/bead-1 HEAD ) || exit 2
  RUN_PROJ="$NO_SUITE_PROJ"
  WHEELHOUSE_SELFTEST_SWEEP_LOCK="$SWEEP_LOCK" STUB_SWEEP_VERDICT=BOUNCE run_sweep_prompt_check "$SWEEP_GENERIC_CLAIM" bead-no-suite fleet/bead-1 worker-1
  if [ "$RC" = 1 ] && says 'INCOMPLETE review:' && says 'no runnable seats/*.selftest.sh suites' && [ ! -f "$NO_SUITE_PROJ/seats/verdicts/bead-no-suite.md" ]; then
    pass 'branch without runnable suites is incomplete, not a completed BOUNCE';
  else fail "empty suite inventory recorded a completed review (rc=$RC out=$OUT)"; fi
  NO_RUNNER_PROJ="$FIX/no-runner-proj-$variant"
  build_proj "$NO_RUNNER_PROJ" "no-runner-$variant" "$VERIFY"
  git -C "$NO_RUNNER_PROJ" rm -q seats/selftest-sweep.sh seats/fixture.selftest.sh
  git -C "$NO_RUNNER_PROJ" -c user.email=selftest@local -c user.name=selftest commit -q -m no-runner
  git -C "$NO_RUNNER_PROJ" branch -f fleet/bead-1 HEAD
  RUN_PROJ="$NO_RUNNER_PROJ"
  run_with_bd_show "$SWEEP_GENERIC_CLAIM" bead-no-runner fleet/bead-1 worker-1
  if [ "$RC" = 1 ] && says 'reviewed tip has no seats/selftest-sweep.sh runner' && [ ! -f "$NO_RUNNER_PROJ/seats/verdicts/bead-no-runner.md" ]; then
    pass "branch without a sweep runner is explicitly incomplete, never APPROVE"
  else fail "missing branch runner approved rc=$RC out=$OUT"; fi
  RUN_PROJ="$SWEEP_PROJ"
  [ "$FAILED" = "$before" ]
}
check_dispatcher_receipts fixed || true
# Same assertions against an owned fix-removed copy, in this one suite run.
# Restore the wording skip and remove only the new receipt/incomplete guards.
RECEIPT_CONTROL="$FIX/receipt-control.ts"
bun - "$VERIFY" "$RECEIPT_CONTROL" <<'JS' || exit 2
import fs from 'node:fs';import assert from 'node:assert/strict';
let s=fs.readFileSync(process.argv[2],'utf8');
const call='await runDispatcherFullSweep(repoRoot, tip, realBd, basePath, selectedTier);';
assert.equal(s.split(call).length,2);
s=s.replace(call,'(claimRequiresSweepCitation(claim) ? await runDispatcherFullSweep(repoRoot, tip, realBd, basePath, selectedTier) : {required:false,rc:null,logPath:null,elapsedMs:0,tip});');
const start=s.indexOf('      // Setup/spawn/pinning failures are not completed BOUNCE/DISCOVER');
const end=s.indexOf('      if (sweep.logPath && requireSweepCitation)',start);
assert(start>0 && end>start);s=s.slice(0,start)+s.slice(end);
fs.writeFileSync(process.argv[3],s);
JS
SAVED_SWEEP_PROJ="$SWEEP_PROJ"; SAVED_VERIFY="$VERIFY"
SWEEP_PROJ="$FIX/sweep-control-proj"
build_proj "$SWEEP_PROJ" sweep-control "$RECEIPT_CONTROL"
RUN_PROJ="$SWEEP_PROJ"; VERIFY="$RECEIPT_CONTROL"
( check_dispatcher_receipts removed ) > "$FIX/receipt-control.out" 2> "$FIX/receipt-control.err"
CONTROL_RC=$?
SWEEP_PROJ="$SAVED_SWEEP_PROJ"; RUN_PROJ="$SWEEP_PROJ"; VERIFY="$SAVED_VERIFY"
if [ "$CONTROL_RC" = 1 ] && [ ! -s "$FIX/receipt-control.err" ] && node - "$FIX/receipt-control.out" <<'JS'
const fs=require('fs'),assert=require('assert/strict'),s=fs.readFileSync(process.argv[2],'utf8');
const failed=s.split('\n').filter(line=>line.startsWith('  FAIL  '));
assert.equal(failed.length,12,s);
for(const phrase of ['lock-recovery claim bypassed','state-writes claim bypassed','process-isolation claim bypassed','unavailable bead text bypassed','failed implicit sweep approved','sweep setup error swallowed','missing dispatcher log accepted','setup failure recorded BOUNCE','setup failure recorded DISCOVER','runner lock refusal recorded a completed review','empty suite inventory recorded a completed review','missing branch runner approved']) assert(failed.some(line=>line.includes(phrase)),phrase);
JS
then
  node - "$FIX/receipt-control.out" <<'JS'
const fs=require('fs');for(const line of fs.readFileSync(process.argv[2],'utf8').split('\n').filter(line=>line.startsWith('  FAIL  '))) console.log('CONTROL (fix removed) '+line.trim());
JS
  pass "fix-removed wording skip and receipt guards fail all 12 dispatcher regressions (exit 1)";
else fail "receipt regression negative control was insensitive (exit $CONTROL_RC): $(cat "$FIX/receipt-control.out" "$FIX/receipt-control.err")"; fi
# First reproduce the old dispatch path: no precomputed evidence, model tool
# budget 150ms, slowed suite 2s. The runner's TERM trap cleans its suite group.
# Disable only the dispatcher sweep in a fixture copy to exercise old behavior.
cp -f "$SWEEP_PROJ/seats/verify.ts" "$FIX/verify-with-sweep.ts"
bun -e 'import fs from "node:fs";const p=process.argv[1],s=fs.readFileSync(p,"utf8"),a="const sweep = batchSweepArg ? readBatchSweep(repoRoot, tip, batchSweepArg, selectedTier) : await runDispatcherFullSweep(repoRoot, tip, realBd, basePath, selectedTier);";if(s.split(a).length!==2)throw new Error("sweep fixture anchor changed");fs.writeFileSync(p,s.replace(a,"const sweep = {required:false,rc:null,logPath:null,elapsedMs:0,tip};"));' "$SWEEP_PROJ/seats/verify.ts"
WHEELHOUSE_SELFTEST_SWEEP_LOCK="$FIX/review-sweep-old.lock" run_sweep_prompt_check "$SWEEP_BD_SHOW" bead-sweep-old fleet/bead-1 worker-1
if [ $RC -eq 2 ] && grep -q 'full sweep unproven: reviewer command limit' "$SWEEP_PROJ/seats/verdicts/bead-sweep-old.md"; then pass "reproduction: slowed sweep exceeds reviewer command limit without dispatcher evidence"; else fail "old sweep was not unproven rc=$RC out=$OUT"; fi
WHEELHOUSE_SELFTEST_SWEEP_LOCK="$SWEEP_LOCK" STUB_SWEEP_FORCE_APPROVE=1 run_sweep_prompt_check "$SWEEP_GENERIC_CLAIM" bead-sweep-bypassed fleet/bead-1 worker-1
if [ "$RC" = 1 ] && says 'cannot record APPROVE without a dispatcher full-sweep result' && [ ! -f "$SWEEP_PROJ/seats/verdicts/bead-sweep-bypassed.md" ]; then
  pass "a bypassed dispatcher call cannot record APPROVE"
else fail "bypassed dispatcher result approved rc=$RC out=$OUT"; fi
# The same bypass with only the final APPROVE guard removed must accept it:
# this proves the independent finalization guard, not merely execution policy.
bun - "$SWEEP_PROJ/seats/verify.ts" <<'JS' || exit 2
import fs from 'node:fs';import assert from 'node:assert/strict';
const p=process.argv[2],s=fs.readFileSync(p,'utf8'),start=s.indexOf('      // Fail closed before publishing authority'),end=s.indexOf('      if (sweep.logPath && requireSweepCitation)',start);
assert(start>0 && end>start);fs.writeFileSync(p,s.slice(0,start)+s.slice(end));
JS
WHEELHOUSE_SELFTEST_SWEEP_LOCK="$SWEEP_LOCK" STUB_SWEEP_FORCE_APPROVE=1 run_sweep_prompt_check "$SWEEP_GENERIC_CLAIM" bead-sweep-bypass-control fleet/bead-1 worker-1
if [ "$RC" = 0 ] && grep -q '^- verdict: APPROVE$' "$SWEEP_PROJ/seats/verdicts/bead-sweep-bypass-control.md"; then
  pass "fix-removed final APPROVE guard exposes the bypass (unsafe fixture exit 0)"
else fail "APPROVE receipt guard negative control was insensitive rc=$RC out=$OUT"; fi
cp -f "$FIX/verify-with-sweep.ts" "$SWEEP_PROJ/seats/verify.ts"
# Hold H4 until the dispatcher log proves it waited, before reviewer readiness.
# The controller then releases the fixture holder. No elapsed-time comparison.
# The readiness driver owns AND joins its H4 holder, including early-exit paths.
WHEELHOUSE_SELFTEST_SWEEP_LOCK="$SWEEP_LOCK" STUB_TEST_HOLD_H4=1 run_sweep_prompt_check "$SWEEP_BD_SHOW" bead-sweep fleet/bead-1 worker-1
SWEEP_CHECK="$HOME_FIX/.pi-seats-sweep/reviewer/sweep-prompt-check.json"
SWEEP_LOG="$(node -e 'console.log(require(process.argv[1]).log)' "$SWEEP_CHECK")"
if [ $RC -eq 0 ] && says "VERDICT: APPROVE" && grep -q '"ok": true' "$SWEEP_CHECK" && grep -q "sweep evidence rc=0 log=" "$SWEEP_PROJ/seats/verdicts/bead-sweep.md" && grep -q "sweep cwd tip=$SWEEP_TIP" "$SWEEP_LOG" && grep -q 'waiting for host-wide lock' "$SWEEP_LOG"; then
  BATCH_SEED_LOG="$SWEEP_LOG"
  pass "full-sweep done: exact tip, H4 wait outside model limit, scratch bd, reviewer cites rc/log"
else fail "full-sweep dispatcher evidence failed rc=$RC out=$OUT check=$(cat "$SWEEP_CHECK" 2>/dev/null)"; fi
if [ -f "$WATCHDOG_DIR/holder-wait-observed" ] && [ -f "$WATCHDOG_DIR/readiness-observed" ] && [ -f "$WATCHDOG_DIR/output" ]; then
  pass "sweep evidence waits for H4 and fixture readiness without a wall-clock verdict"
else fail "sweep/readiness handshake was not observed"; fi
# The readiness regression runs this real suite through its killed fixture leg.
if [ "${WHEELHOUSE_VERIFY_EXIT_BEFORE_READY_ONLY:-0}" = 1 ]; then
  [ "$FAILED" = 0 ] || { printf 'verify.selftest: FAIL (%s failures in early-exit subset)\n' "$FAILED"; exit 1; }
  printf 'verify.selftest: PASS (early-exit subset)\n'; exit 0
fi
for NO_OUTPUT_MODE in eof silent; do
  WHEELHOUSE_SELFTEST_SWEEP_LOCK="$SWEEP_LOCK" STUB_TEST_EMIT_NOTHING="$NO_OUTPUT_MODE" run_sweep_prompt_check "$SWEEP_BD_SHOW" "bead-sweep-no-output-$NO_OUTPUT_MODE" fleet/bead-1 worker-1
  if [ "$RC" = 1 ] && { says 'reviewer emitted no VERDICT:' || says 'first-output deadline'; } && [ -f "$WATCHDOG_DIR/readiness-observed" ] && [ ! -e "$WATCHDOG_DIR/output" ]; then
    pass "sweep evidence still refuses a ready reviewer that emits nothing ($NO_OUTPUT_MODE)"
  else fail "empty ready reviewer was accepted ($NO_OUTPUT_MODE rc=$RC out=$OUT)"; fi
done
if [ -f "$STUB_SWEEP_PWD_MARKER" ] && node -e 'const r=require(process.argv[1]); if(!r.primary || r.cwd!==r.pwd || require("path").basename(r.cwd)!==".wheelhouse-sweep-graph") process.exit(1)' "$STUB_SWEEP_PWD_MARKER"; then
  pass "sweep graph init uses an independent primary repo and bound logical PWD"
else fail "sweep graph init was not isolated from the reviewed repository"; fi
WHEELHOUSE_SELFTEST_SWEEP_LOCK="$SWEEP_LOCK" STUB_SWEEP_OMIT_CITATION=1 run_sweep_prompt_check "$SWEEP_BD_SHOW" bead-sweep-omit fleet/bead-1 worker-1
[ $RC -eq 1 ] && says 'must cite full-sweep' && pass "full-sweep verdict without rc/log citation is refused" || fail "missing citation accepted rc=$RC out=$OUT"
WHEELHOUSE_SELFTEST_SWEEP_LOCK="$SWEEP_LOCK" SWEEP_FIXTURE_RC=7 STUB_SWEEP_FORCE_APPROVE=1 run_sweep_prompt_check "$SWEEP_BD_SHOW" bead-sweep-failed fleet/bead-1 worker-1
[ $RC -eq 1 ] && says 'APPROVE with failed full sweep' && pass "failed full sweep cannot be approved" || fail "failed sweep approved rc=$RC out=$OUT"
WHEELHOUSE_SELFTEST_SWEEP_LOCK="$SWEEP_LOCK" STUB_SWEEP_MUTATE_SETUP=1 STUB_SWEEP_FORCE_APPROVE=1 run_sweep_prompt_check "$SWEEP_BD_SHOW" bead-sweep-setup-moved fleet/bead-1 worker-1
SWEEP_LOG="$(node -e 'console.log(require(process.argv[1]).log)' "$SWEEP_CHECK")"
if [ $RC -eq 1 ] && says 'APPROVE with failed full sweep' && grep -q 'changed reviewed tip' "$SWEEP_LOG"; then
  pass "sweep setup cannot commit past the pinned reviewed tip"
else fail "setup mutation of reviewed tip accepted rc=$RC out=$OUT"; fi
WHEELHOUSE_SELFTEST_SWEEP_LOCK="$SWEEP_LOCK" SWEEP_FIXTURE_MOVE_TIP=1 STUB_SWEEP_FORCE_APPROVE=1 run_sweep_prompt_check "$SWEEP_BD_SHOW" bead-sweep-final-moved fleet/bead-1 worker-1
SWEEP_LOG="$(node -e 'console.log(require(process.argv[1]).log)' "$SWEEP_CHECK")"
if [ $RC -eq 1 ] && says 'APPROVE with failed full sweep' && grep -q 'changed reviewed tip' "$SWEEP_LOG"; then
  pass "sweep suites cannot move the pinned reviewed tip"
else fail "suite mutation of reviewed tip accepted rc=$RC out=$OUT"; fi
RUN_PATH="$SWEEP_SAVED_RUN_PATH"
unset STUB_SWEEP_BASE_BD STUB_SWEEP_PWD_MARKER
if [ "${WHEELHOUSE_VERIFY_SWEEP_ONLY:-0}" = 1 ]; then
  [ "$FAILED" = 0 ] || { printf 'verify.selftest: FAIL (%s failures in sweep-readiness subset)\n' "$FAILED"; exit 1; }
  printf 'verify.selftest: PASS (sweep-readiness subset)\n'
  exit 0
fi
phase "0a3. one captured passing batch sweep — validation and CLI reuse"
if [ -n "${BATCH_SEED_LOG:-}" ] && [ -s "$BATCH_SEED_LOG" ]; then
  if bun "$HERE/fixtures/verify-batch-sweep.ts" "$VERIFY_DIR" "$FIX" "$BATCH_SEED_LOG" "$SWEEP_TIP"; then pass "batch validator accepts descendant and refuses every unsafe fixture"
  else fail "batch validator regression"; fi
  git -C "$SWEEP_PROJ" update-ref refs/heads/main "$SWEEP_TIP" || exit 2
  git -C "$SWEEP_PROJ" branch fleet/batch-reviewed "$SWEEP_TIP^" || exit 2
  BATCH_REVIEWED="$(git -C "$SWEEP_PROJ" rev-parse fleet/batch-reviewed)"
  BATCH_INVOKED="$HOME_FIX/.pi-seats-sweep/reviewer/invoked"
  RUN_PROJ="$SWEEP_PROJ"
  printf 'Batch evidence rc=0 log=%s\nVERDICT: APPROVE\n' "$BATCH_SEED_LOG" > "$REPLY"
  WHEELHOUSE_SELFTEST_SWEEP_LOCK="$FIX/batch-never-run.lock" run_with_bd_show "$SWEEP_BD_SHOW" bead-batch-accept fleet/batch-reviewed worker-1 reviewer --batch-sweep "$BATCH_SEED_LOG"
  if [ "$RC" = 0 ] && says 'VERDICT: APPROVE' && grep -q -- "- batch-tip: $SWEEP_TIP" "$SWEEP_PROJ/seats/verdicts/bead-batch-accept.md" && grep -q -- "- tip: $BATCH_REVIEWED" "$SWEEP_PROJ/seats/verdicts/bead-batch-accept.md" && grep -Fq -- "- log: $BATCH_SEED_LOG" "$SWEEP_PROJ/seats/verdicts/bead-batch-accept.md"; then
    pass "batch CLI reuses one real passing descendant sweep and records batch/reviewed tip and log"
  else fail "batch CLI acceptance/record failed rc=$RC out=$OUT"; fi
  if bun - "$BATCH_SEED_LOG" "$SWEEP_PROJ/seats/verdicts/bead-batch-accept.md" "$VARGV" <<'JS'
import fs from 'node:fs';import assert from 'node:assert/strict';
const [log,record,argv]=process.argv.slice(2),text=fs.readFileSync(log,'utf8'),receipt=fs.readFileSync(record,'utf8'),prompt=JSON.stringify(JSON.parse(fs.readFileSync(argv,'utf8')));
const seconds=/selftest-sweep: PASS .*\/slowed.selftest.sh elapsed=([0-9]+)s/.exec(text);assert(seconds);
const footer=/^selftest-sweep: PASS \(1 suite\(s\), [0-9]+s\)$/m.exec(text);assert(footer);
for(const output of [receipt,prompt])for(const expected of ['selftest-sweep: tier=full suites=1',footer[0],`slowed.selftest.sh: ${seconds[1]}s`])assert(output.includes(expected),expected);
JS
  then pass 'timed batch prompt and verdict receipt include tier, total and slowest-suite seconds'
  else fail 'batch prompt/receipt lost timing metadata'; fi
  rm -f "$BATCH_INVOKED"
  BATCH_OLD="$FIX/batch-old-shape.log"
  bun - "$BATCH_SEED_LOG" "$BATCH_OLD" <<'JS'
import fs from 'node:fs';
const text=fs.readFileSync(process.argv[2],'utf8').replace(/^selftest-sweep: tier=full suites=[0-9]+\n/m,'').replace(/ elapsed=[0-9]+s$/gm,'').replace(/(suite\(s\)), [0-9]+s\)/g,'$1)');fs.writeFileSync(process.argv[3],text);
JS
  WHEELHOUSE_SELFTEST_SWEEP_LOCK="$FIX/batch-never-run.lock" run_with_bd_show "$SWEEP_BD_SHOW" bead-batch-old fleet/batch-reviewed worker-1 reviewer --batch-sweep "$BATCH_OLD"
  if [ "$RC" = 1 ] && says 'batch sweep refused' && [ ! -e "$BATCH_INVOKED" ]; then pass 'old timing-free batch envelope STOPs before reviewer spawn'
  else fail "old batch shape accepted or spawned reviewer rc=$RC out=$OUT"; fi
  WHEELHOUSE_SELFTEST_SWEEP_LOCK="$FIX/batch-never-run.lock" run_with_bd_show "$SWEEP_BD_SHOW" bead-batch-missing fleet/batch-reviewed worker-1 reviewer --batch-sweep "$FIX/no-batch-log"
  if [ "$RC" = 1 ] && says 'batch sweep refused' && [ ! -e "$BATCH_INVOKED" ]; then pass "invalid batch flag STOPs before reviewer spawn, never falls back to a sweep"
  else fail "invalid batch flag spawned or fell back rc=$RC out=$OUT"; fi
  run_with_bd_show "$SWEEP_BD_SHOW" bead-batch-noarg fleet/batch-reviewed worker-1 reviewer --batch-sweep
  if [ "$RC" = 1 ] && says '--batch-sweep requires'; then pass "batch flag without a log argument is refused"
  else fail "batch flag accepted no argument rc=$RC out=$OUT"; fi
  run_with_bd_show "$SWEEP_BD_SHOW" bead-batch-duplicate fleet/batch-reviewed worker-1 reviewer --batch-sweep "$BATCH_SEED_LOG" --batch-sweep "$BATCH_SEED_LOG"
  if [ "$RC" = 1 ] && says 'may be supplied only once'; then pass "duplicate batch flag is refused"
  else fail "duplicate batch flag accepted rc=$RC out=$OUT"; fi
  BATCH_MUTATING="$FIX/batch-mutating.log"; cp -f "$BATCH_SEED_LOG" "$BATCH_MUTATING"
  printf 'Batch evidence rc=0 log=%s\nVERDICT: APPROVE\n' "$BATCH_MUTATING" > "$REPLY"
  STUB_MUTATE_BATCH_LOG="$BATCH_MUTATING" WHEELHOUSE_SELFTEST_SWEEP_LOCK="$FIX/batch-never-run.lock" run_with_bd_show "$SWEEP_BD_SHOW" bead-batch-mutated fleet/batch-reviewed worker-1 reviewer --batch-sweep "$BATCH_MUTATING"
  if [ "$RC" = 1 ] && says 'batch sweep log changed during review'; then pass "batch log is revalidated and byte-fingerprinted after reviewer exit"
  else fail "changed batch log accepted rc=$RC out=$OUT"; fi
  printf 'Batch evidence rc=0 log=%s\nVERDICT: APPROVE\n' "$BATCH_SEED_LOG" > "$REPLY"
  STUB_MOVE_BRANCH_REPO="$SWEEP_PROJ" STUB_MOVE_BRANCH=main WHEELHOUSE_SELFTEST_SWEEP_LOCK="$FIX/batch-never-run.lock" run_with_bd_show "$SWEEP_BD_SHOW" bead-batch-main-moved fleet/batch-reviewed worker-1 reviewer --batch-sweep "$BATCH_SEED_LOG"
  if [ "$RC" = 1 ] && says 'first-parent chain does not reach current main'; then pass "batch cannot outlive a main move outside its first-parent chain"
  else fail "main moved outside batch but reuse accepted rc=$RC out=$OUT"; fi
  git -C "$SWEEP_PROJ" reset --hard "$SWEEP_TIP" >/dev/null || exit 2
  printf 'Missing batch citation.\nVERDICT: APPROVE\n' > "$REPLY"
  WHEELHOUSE_SELFTEST_SWEEP_LOCK="$FIX/batch-never-run.lock" run_with_bd_show "$SWEEP_BD_SHOW" bead-batch-citation fleet/batch-reviewed worker-1 reviewer --batch-sweep "$BATCH_SEED_LOG"
  if [ "$RC" = 1 ] && says 'must cite full-sweep'; then pass "batch reuse retains the final evidence rc/log citation gate"
  else fail "batch citation omitted but accepted rc=$RC out=$OUT"; fi
else fail "no actual passing fixture sweep capture for batch tests"; fi
RUN_PROJ="$INST_PROJ"
VARGV="$HOME_FIX/.pi-seats-installed/reviewer/argv.json"
MISS_PROJ="$FIX/missing-brief-proj"
build_proj "$MISS_PROJ" missing "$VERIFY"
rm -rf "$MISS_PROJ/contracts" "$MISS_PROJ/wheelhouse"
RUN_PROJ="$MISS_PROJ"
run bead-missing fleet/bead-1 worker-1
if [ $RC -ne 0 ] && says "$MISS_PROJ/wheelhouse/crew/REVIEWER.md" && says "$MISS_PROJ/contracts/REVIEWER.md"; then
  pass "missing brief: STOP names both installed and template paths tried"
else fail "missing brief: STOP did not name both paths (exit $RC): $OUT"; fi
RUN_PROJ="$PROJ"
VARGV="$HOME_FIX/.pi-seats-alpha/reviewer/argv.json"

phase "multi-repo umbrella layout — --repo selects the product repository"
UMB_PROJ="$FIX/umbrella"
build_umbrella_proj "$UMB_PROJ" umbrella "$VERIFY"
RUN_PROJ="$UMB_PROJ"
VARGV="$HOME_FIX/.pi-seats-umbrella/reviewer/argv.json"
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
run bead-umbrella-default fleet/bead-1 worker-1 --evidence evidence/bench.log
if [ $RC -eq 0 ]; then pass "umbrella layout: omitting --repo defaults to .template-source product-repo"
else fail "umbrella layout: missing --repo did not use product-repo default (exit $RC): $OUT"; fi
if grep -q "branch-repo: $UMB_PROJ/product" "$UMB_PROJ/seats/verdicts/bead-umbrella-default.md" 2>/dev/null \
   && grep -q "evidence/bench.log — exists, .* bytes, non-empty — OK" "$UMB_PROJ/seats/verdicts/bead-umbrella-default.md" 2>/dev/null; then
  pass "umbrella layout: default repo records the product repo and product-relative evidence floor check"
else fail "umbrella layout: default repo verdict did not record product repo and evidence check"; fi
( cd "$UMB_PROJ" &&
  git checkout -q -b fleet/bead-ambiguous &&
  printf 'umbrella branch work\n' > umbrella-work.txt &&
  git add umbrella-work.txt &&
  git -c user.email=selftest@local -c user.name=selftest commit -q -m umbrella-work ) || { echo "selftest: could not build ambiguous umbrella branch" >&2; exit 2; }
( cd "$UMB_PROJ/product" && git branch fleet/bead-ambiguous ) || { echo "selftest: could not build ambiguous product branch" >&2; exit 2; }
UMB_AMBIG_TIP="$(git -C "$UMB_PROJ" rev-parse fleet/bead-ambiguous)"
PROD_AMBIG_TIP="$(git -C "$UMB_PROJ/product" rev-parse fleet/bead-ambiguous)"
BD_UMBRELLA_REPO="$FIX/bd-umbrella-repo.txt"
cat > "$BD_UMBRELLA_REPO" <<EOF
fixture ambiguous repo bead

DESCRIPTION

  Repo: UMBRELLA
EOF
cat > "$REPLY" <<EOF
Checked umbrella repo tip $UMB_AMBIG_TIP, not product tip $PROD_AMBIG_TIP.
VERDICT: APPROVE
EOF
run_with_bd_show "$BD_UMBRELLA_REPO" bead-umbrella-ambiguous fleet/bead-ambiguous worker-1
if [ $RC -eq 0 ] && grep -q "branch-repo: $UMB_PROJ" "$UMB_PROJ/seats/verdicts/bead-umbrella-ambiguous.md" 2>/dev/null \
   && grep -q "tip: $UMB_AMBIG_TIP" "$UMB_PROJ/seats/verdicts/bead-umbrella-ambiguous.md" 2>/dev/null \
   && ! grep -q "tip: $PROD_AMBIG_TIP" "$UMB_PROJ/seats/verdicts/bead-umbrella-ambiguous.md" 2>/dev/null; then
  pass "umbrella layout: Repo: UMBRELLA pins the umbrella branch when the same branch exists in product"
else fail "umbrella layout: Repo: UMBRELLA did not pin umbrella branch (exit $RC): $OUT verdict=$(cat "$UMB_PROJ/seats/verdicts/bead-umbrella-ambiguous.md" 2>/dev/null)"; fi
RUN_PROJ="$PROJ"
VARGV="$HOME_FIX/.pi-seats-alpha/reviewer/argv.json"

phase "0b. bead-declared read-only source snapshots expose only named sibling source"
ALLOWED_SIB="$FIX/allowed-sibling"
UNLISTED_SIB="$FIX/unlisted-sibling"
mkdir -p "$ALLOWED_SIB" "$UNLISTED_SIB"
printf 'allowed sibling source\n' > "$ALLOWED_SIB/allowed.txt"
printf 'unlisted sibling source\n' > "$UNLISTED_SIB/secret.txt"
BD_SOURCE="$FIX/bd-source.txt"
cat > "$BD_SOURCE" <<EOF
wheelhouse-source [BUG]

DESCRIPTION

  Done depends on a sibling repo.

  Read-only source paths:
  - $ALLOWED_SIB
EOF
cat > "$REPLY" <<'EOF'
Read the mounted source snapshot and confirmed writes fail.
VERDICT: APPROVE
EOF
VERIFY_RO_TMP="$FIX/verify-ro-tmp"; mkdir -p "$VERIFY_RO_TMP"
TMPDIR="$VERIFY_RO_TMP" run_source_check "$BD_SOURCE" bead-source fleet/bead-1 worker-1 reviewer
SOURCE_CHECK="$HOME_FIX/.pi-seats-alpha/reviewer/source-check.txt"
if [ $RC -eq 0 ] && grep -q '"readable": true' "$SOURCE_CHECK" 2>/dev/null && grep -q '"writeFailed": true' "$SOURCE_CHECK" 2>/dev/null; then
  pass "source snapshots: reviewer can read the bead-declared sibling and writes to the mounted copy fail"
else fail "source snapshots: read/write assertion failed (exit $RC): $OUT check=$(cat "$SOURCE_CHECK" 2>/dev/null)"; fi
if ! find "$VERIFY_RO_TMP" -path '*/.wheelhouse-verify-sources*' -exec test ! -w '{}' \; -print -quit | grep >/dev/null .; then
  pass "source snapshots: cleanup restores/removes read-only snapshot trees"
else
  chmod -R u+w "$VERIFY_RO_TMP" 2>/dev/null || true
  fail "source snapshots: read-only snapshot tree left under TMPDIR: $(find "$VERIFY_RO_TMP" -path '*/.wheelhouse-verify-sources*' -print 2>/dev/null | sed -n '1,5p')"
fi
if grep -q '"undeclaredAbsent": true' "$SOURCE_CHECK" 2>/dev/null; then
  pass "source snapshots: undeclared sibling source is not mounted or named"
else fail "source snapshots: undeclared sibling source was reachable or named: $(cat "$SOURCE_CHECK" 2>/dev/null)"; fi
if grep -q 'Read-only source snapshots' "$PROJ/seats/verdicts/bead-source.md" 2>/dev/null && grep -q 'allowed-sibling' "$PROJ/seats/verdicts/bead-source.md" 2>/dev/null; then
  pass "source snapshots: verdict record names the mounted read-only source snapshot"
else fail "source snapshots: verdict record did not name source snapshot"; fi

phase "0c. timeout — last phase and partial reviewer output are retained"
RC=0; OUT="$(env -u WHEELHOUSE_VERIFY_TIMEOUT_MS -u WHEELHOUSE_VERIFY_FIRST_OUTPUT_TIMEOUT_MS -u WHEELHOUSE_VERIFY_NO_EVENT_TIMEOUT_MS -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_STALL=1 bun "$RUN_PROJ/seats/verify.ts" bead-1 fleet/bead-1 worker-1 reviewer --timeout-ms 1500 2>&1)" || RC=$?
if [ $RC -eq 1 ] && says "timed out after 1500ms" && says "elapsed" && says "last phase: tool bash started" && says "partial output:"; then
  pass "timeout STOP names elapsed time, last tool/phase, and partial output path"
else fail "timeout STOP missing phase/elapsed/partial detail (exit $RC): $OUT"; fi
PARTIAL="$VDIR/bead-1.partial.md"
if [ -s "$PARTIAL" ] && grep -q '## seat tool-call/event log tail' "$PARTIAL" && grep -q 'tool_execution_start' "$PARTIAL" && grep -q 'cargo test' "$PARTIAL"; then
  pass "timeout keeps partial pi output and event-log tail at seats/verdicts/<bead>.partial.md"
else fail "timeout partial file missing event-log tail or streamed tool output: $(cat "$PARTIAL" 2>/dev/null)"; fi
if [ ! -e "$RUN_PROJ/seats/run/verify.reviewer.json" ]; then
  pass "timeout path removes reviewer live marker"
else fail "timeout path left reviewer live marker: $(cat "$RUN_PROJ/seats/run/verify.reviewer.json" 2>/dev/null)"; fi
rm -f "$PARTIAL"
RC=0; OUT="$(env -u WHEELHOUSE_VERIFY_TIMEOUT_MS -u WHEELHOUSE_VERIFY_FIRST_OUTPUT_TIMEOUT_MS -u WHEELHOUSE_VERIFY_NO_EVENT_TIMEOUT_MS -u BEADS_ACTOR WHEELHOUSE_VERIFY_TIMEOUT_MS=1800000 HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_STALL=1 bun "$RUN_PROJ/seats/verify.ts" bead-timeout-env fleet/bead-1 worker-1 reviewer --timeout-ms 1500 2>&1)" || RC=$?
if [ $RC -eq 1 ] && says "timed out after 1500ms" && says "last phase: tool bash started"; then
  pass "explicit --timeout-ms beats WHEELHOUSE_VERIFY_TIMEOUT_MS for phase 0c"
else fail "explicit timeout did not beat WHEELHOUSE_VERIFY_TIMEOUT_MS (exit $RC): $OUT"; fi
rm -f "$VDIR/bead-timeout-env.partial.md"
OUT="$(env -u WHEELHOUSE_VERIFY_TIMEOUT_MS -u WHEELHOUSE_VERIFY_FIRST_OUTPUT_TIMEOUT_MS -u WHEELHOUSE_VERIFY_NO_EVENT_TIMEOUT_MS -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_STALL_AFTER_TOOL_END=1 bun "$RUN_PROJ/seats/verify.ts" bead-stalled fleet/bead-1 worker-1 reviewer --timeout-ms 5000 --no-event-timeout-ms 300 2>&1)"; RC=$?
if [ $RC -eq 1 ] && says "model stalled after 300ms" && says "last event: tool_execution_end" && says "no-event watchdog" && says "partial output:"; then
  pass "no-event watchdog STOPs a reviewer that goes silent after a tool event"
else fail "no-event watchdog did not stop the post-tool stall with last event detail (exit $RC): $OUT"; fi
STALL_PARTIAL="$VDIR/bead-stalled.partial.md"
if [ -s "$STALL_PARTIAL" ] && grep -q 'tool_execution_end' "$STALL_PARTIAL" && grep -q 'last_phase: tool_execution_end' "$STALL_PARTIAL"; then
  pass "no-event watchdog keeps partial output and the last streamed event"
else fail "no-event partial output missing last event detail: $(cat "$STALL_PARTIAL" 2>/dev/null)"; fi
rm -f "$STALL_PARTIAL"
cat > "$REPLY" <<EOF
Slow selftest produced output until it finished.
VERDICT: APPROVE
EOF
# Ten-minute quiet budgets on integration legs that must NOT trip. The small
# 150/300ms progress semantics are proved below with acknowledged virtual time,
# while native 1500/300ms silence legs above must still actually fire.
OUT="$(env -u WHEELHOUSE_VERIFY_TIMEOUT_MS -u WHEELHOUSE_VERIFY_FIRST_OUTPUT_TIMEOUT_MS -u WHEELHOUSE_VERIFY_NO_EVENT_TIMEOUT_MS -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_REPLY_FILE="$REPLY" STUB_SLOW_TOOL_OUTPUT=1 bun "$RUN_PROJ/seats/verify.ts" bead-slow-tool fleet/bead-1 worker-1 reviewer --timeout-ms 600000 --no-event-timeout-ms 600000 2>&1)"; RC=$?
if [ $RC -eq 0 ] && says "VERDICT: APPROVE"; then
  pass "no-event watchdog does not trip while a long-running tool keeps streaming output"
else fail "no-event watchdog tripped on a still-streaming tool (exit $RC): $OUT"; fi
cat > "$REPLY" <<'EOF'
Reviewer wrote the final machine lines before a background child inherited stdout.
VERDICT: APPROVE
PUSH: NOT CONSIDERED
EOF
OUT="$(env -u WHEELHOUSE_VERIFY_TIMEOUT_MS -u WHEELHOUSE_VERIFY_FIRST_OUTPUT_TIMEOUT_MS -u WHEELHOUSE_VERIFY_NO_EVENT_TIMEOUT_MS -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_REPLY_FILE="$REPLY" STUB_HANG_CHILD_AFTER_RESULT=1 bun "$RUN_PROJ/seats/verify.ts" bead-post-result-hang fleet/bead-1 worker-1 reviewer --timeout-ms 600000 --no-event-timeout-ms 600000 2>&1)"; RC=$?
HANG_CHILD_PID="$(cat "$HOME_FIX/.pi-seats-alpha/reviewer/hanging-child-pid.txt" 2>/dev/null || true)"
if [ $RC -eq 0 ] && says "VERDICT: APPROVE" && grep -q 'VERDICT: APPROVE' "$VDIR/bead-post-result-hang.md" 2>/dev/null; then
  pass "post-result background child cannot keep verify open after final VERDICT/PUSH lines"
else fail "post-result background child kept verify open or verdict was not recorded (exit $RC child=$HANG_CHILD_PID): $OUT"; fi
if [ -n "$HANG_CHILD_PID" ]; then
  for _ in $(seq 1 3000); do kill -0 "$HANG_CHILD_PID" 2>/dev/null || break; sleep 0.1; done
fi
if [ -z "$HANG_CHILD_PID" ] || ! kill -0 "$HANG_CHILD_PID" 2>/dev/null; then
  pass "post-result background child process group is reaped"
else
  kill "$HANG_CHILD_PID" 2>/dev/null || true
  fail "post-result background child survived reviewer cleanup (pid=$HANG_CHILD_PID)"
fi
cat > "$REPLY" <<'EOF'
Finished after quoting the previous review without being reaped mid-run.
VERDICT: APPROVE
PUSH: NOT CONSIDERED
EOF
OUT="$(env -u WHEELHOUSE_VERIFY_TIMEOUT_MS -u WHEELHOUSE_VERIFY_FIRST_OUTPUT_TIMEOUT_MS -u WHEELHOUSE_VERIFY_NO_EVENT_TIMEOUT_MS -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_REPLY_FILE="$REPLY" STUB_PI_QUOTED_VERDICT_MIDRUN=1 bun "$RUN_PROJ/seats/verify.ts" bead-pi-quoted-verdict fleet/bead-1 worker-1 reviewer --no-event-timeout-ms 600000 2>&1)"; RC=$?
if [ $RC -eq 0 ] && says "VERDICT: APPROVE" && ! says "exited 143" && grep -q 'VERDICT: APPROVE' "$VDIR/bead-pi-quoted-verdict.md" 2>/dev/null; then
  pass "pi quoted mid-run verdict is not reaped before agent_end"
else fail "pi quoted mid-run verdict was killed or failed (exit $RC): $OUT"; fi
WATCHDOG_DIR="$(mktemp -d "$FIX/progress-clock.XXXXXX")"
OUT="$(env -u WHEELHOUSE_VERIFY_TIMEOUT_MS -u WHEELHOUSE_VERIFY_FIRST_OUTPUT_TIMEOUT_MS -u WHEELHOUSE_VERIFY_NO_EVENT_TIMEOUT_MS -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_REPLY_FILE="$REPLY" STUB_LONG_TOOL_PROGRESS=1 bun "$READINESS_DRIVER" "$RUN_PROJ/seats/verify.ts" "$WATCHDOG_DIR" progress bead-progress-past-total fleet/bead-1 worker-1 reviewer --timeout-ms 300 --no-event-timeout-ms 150 2>&1)"; RC=$?
if [ $RC -eq 0 ] && says "VERDICT: APPROVE" && [ -s "$WATCHDOG_DIR/progress-proof" ]; then
  pass "tool progress beyond total timeout reaches a verdict instead of being killed: $(<"$WATCHDOG_DIR/progress-proof")"
else fail "tool progress beyond total timeout was killed before verdict (exit $RC): $OUT"; fi
WATCHDOG_DIR="$(mktemp -d "$FIX/silent-readiness.XXXXXX")"
OUT="$(env -u WHEELHOUSE_VERIFY_TIMEOUT_MS -u WHEELHOUSE_VERIFY_FIRST_OUTPUT_TIMEOUT_MS -u WHEELHOUSE_VERIFY_NO_EVENT_TIMEOUT_MS -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_SILENT=1 bun "$READINESS_DRIVER" "$RUN_PROJ/seats/verify.ts" "$WATCHDOG_DIR" silent bead-silent fleet/bead-1 worker-1 reviewer 2>&1)"; RC=$?
if [ $RC -eq 1 ] && [ -f "$WATCHDOG_DIR/expired-first" ] && says "reviewer emitted no stdout/stderr within" && says "first-output deadline" && says "--first-output-timeout-ms"; then
  pass "silent reviewer stops on the first-output deadline with an actionable reason"
else fail "silent reviewer did not stop on first-output deadline (exit $RC): $OUT"; fi
SILENT_PARTIAL="$VDIR/bead-silent.partial.md"
if [ -s "$SILENT_PARTIAL" ] && grep -q 'last_phase: spawned reviewer; waiting for output' "$SILENT_PARTIAL"; then
  pass "silent reviewer first-output STOP retains a partial output record"
else fail "silent reviewer partial output missing: $(cat "$SILENT_PARTIAL" 2>/dev/null)"; fi
rm -f "$SILENT_PARTIAL"

phase "1. APPROVE — verdict parsed, recorded, exit 0, and what was launched"
mkdir -p "$PROJ/wheelhouse"
cat > "$PROJ/wheelhouse/INTEGRATOR.md" <<'EOF'
# The Integrator

## This project

### Push authority and its scope
Fixture standing authority: reviewers may approve pushing origin for this install when evidence supports it.

### Reserved list (principal-only, per action)
Fixture reserved: releases/tags only.
EOF
cat > "$REPLY" <<EOF
Checked the done: diff at $TIP adds the thing the bead asks for.
\$ git show --stat fleet/bead-1
 1 file changed
VERDICT: APPROVE
EOF
CORE_WORKTREE_BEFORE="$(core_worktree_snapshot "$PROJ")"
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
else fail "reviewer brief not passed"; fi
if grep -q '"--provider","openai","--model","stub-model-v"' "$VARGV" 2>/dev/null; then
  pass "the REVIEWER seat's provider and model pin the launch (not the author's)"
else fail "reviewer provider/model from seats.json did not reach pi's argv"; fi
if grep -q "bead-1" "$VARGV" && grep -q "$TIP" "$VARGV" && grep -q "bd show bead-1" "$VARGV"; then
  pass "prompt carries the bead id, the tip SHA, and the bead-claim reference"
else fail "prompt is missing bead id, tip SHA, or bead claim"; fi
if node - "$VARGV" <<'NODE'
const fs = require('fs');
const argv = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const prompt = argv[argv.length - 1] || '';
if (!prompt.includes('exactly one plain-text VERDICT line and exactly one plain-text PUSH line')) process.exit(1);
if (!prompt.includes('never inside a Markdown code fence')) process.exit(1);
if (!prompt.includes('Fenced VERDICT: or PUSH: lines are ignored and make the gate STOP.')) process.exit(1);
if (!/^VERDICT: APPROVE \| BOUNCE \| DISCOVER$/m.test(prompt)) process.exit(1);
if (!/^PUSH: APPROVE <remote> — verified: <what you checked> \| HOLD — <why> \| NOT CONSIDERED \[<why>\]$/m.test(prompt)) process.exit(1);
NODE
then pass "prompt closes with unfenced plain-text VERDICT/PUSH instructions"; else fail "prompt does not clearly forbid fenced verdict lines: $(cat "$VARGV" 2>/dev/null)"; fi
if node - "$VARGV" <<'NODE'
const fs = require('fs');
const argv = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const prompt = argv[argv.length - 1] || '';
if (!prompt.includes('Install push authority for this reviewer run')) process.exit(1);
if (!prompt.includes('### Push authority and its scope')) process.exit(1);
if (!prompt.includes('Fixture standing authority: reviewers may approve pushing origin')) process.exit(1);
if (!prompt.includes('### Reserved list (principal-only, per action)')) process.exit(1);
if (!prompt.includes('Fixture reserved: releases/tags only')) process.exit(1);
NODE
then pass "prompt carries install push authority and reserved-list excerpts"; else fail "prompt is missing install push authority excerpts: $(cat "$VARGV" 2>/dev/null)"; fi
if node - "$VARGV" <<'NODE'
const fs = require('fs');
const argv = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const prompt = argv[argv.length - 1] || '';
if (!prompt.includes('Interview-mode bench is unavailable inside this reviewer sandbox')) process.exit(1);
if (!prompt.includes('do not run bench.sh --mode interview')) process.exit(1);
if (!prompt.includes('route those claims to named non-author seat reviewer')) process.exit(1);
if (!prompt.includes('distinct from author seat worker-1')) process.exit(1);
NODE
then pass "prompt routes unavailable interview-mode claims to a named non-author seat"; else fail "prompt is missing interview-mode routing instructions: $(cat "$VARGV" 2>/dev/null)"; fi
if grep -q '"BEADS_ACTOR":"reviewer"' "${VARGV%argv.json}env.json" 2>/dev/null; then
  pass "the ephemeral reviewer's own env carries BEADS_ACTOR=reviewer, with no operator export"
else fail "reviewer env.json was $(cat "${VARGV%argv.json}env.json" 2>/dev/null) — expected BEADS_ACTOR:reviewer set by verify.ts itself"; fi
if selftest_capture_lacks "${VARGV%argv.json}env.json" -q -- "$PROJ/seats/bin"; then
  pass "host budget absent: reviewer PATH is not rewritten to seats/bin"
else fail "host budget absent: reviewer PATH unexpectedly included seats/bin: $(cat "${VARGV%argv.json}env.json" 2>/dev/null)"; fi
cat > "$REPLY" <<EOF
Checked readonly bd shim.
VERDICT: APPROVE
EOF
RC=0; OUT="$(env -u WHEELHOUSE_VERIFY_TIMEOUT_MS -u WHEELHOUSE_VERIFY_FIRST_OUTPUT_TIMEOUT_MS -u WHEELHOUSE_VERIFY_NO_EVENT_TIMEOUT_MS -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_BD_READONLY_CHECK=1 STUB_REPLY_FILE="$REPLY" bun "$RUN_PROJ/seats/verify.ts" bead-bd-ro fleet/bead-1 worker-1 2>&1)" || RC=$?
BD_RO_CHECK="${VARGV%argv.json}bd-readonly-check.json"
if [ $RC -eq 0 ] && node - "$BD_RO_CHECK" <<'NODE'
const fs = require('fs');
const rows = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const by = Object.fromEntries(rows.map(r => [r.name, r]));
if (by.show.status !== 0 || by.comments.status !== 0) process.exit(1);
for (const k of ['comment', 'update', 'actor-close']) {
  if (by[k].status === 0) process.exit(1);
  if (!/not allowed in read-only mode/.test(`${by[k].stdout}\n${by[k].stderr}`)) process.exit(1);
}
NODE
then pass "reviewer one-shot bd is read-only: show/comments work, comment/update/--actor close fail"
else fail "reviewer bd readonly shim failed (rc=$RC out=$OUT check=$(cat "$BD_RO_CHECK" 2>/dev/null))"; fi
cat > "$REPLY" <<EOF
Checked readonly bd shim scope.
VERDICT: APPROVE
EOF
RC=0; OUT="$(env -u WHEELHOUSE_VERIFY_TIMEOUT_MS -u WHEELHOUSE_VERIFY_FIRST_OUTPUT_TIMEOUT_MS -u WHEELHOUSE_VERIFY_NO_EVENT_TIMEOUT_MS -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_BD_READONLY_SCOPE_CHECK=1 STUB_REPLY_FILE="$REPLY" bun "$RUN_PROJ/seats/verify.ts" bead-bd-scope fleet/bead-1 worker-1 2>&1)" || RC=$?
BD_SCOPE_CHECK="${VARGV%argv.json}bd-readonly-scope-check.json"
if [ $RC -eq 0 ] && node - "$BD_SCOPE_CHECK" <<'NODE'
const fs = require('fs');
const rows = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const by = Object.fromEntries(rows.map(r => [r.name, r]));
for (const k of ['scratch-create', 'scratch-c-redirect', 'scratch-directory-redirect', 'scratch-global', 'scratch-beads-dir-outside', 'scratch-db-override', 'scratch-database-override', 'arbitrary-create']) {
  if (!by[k]) process.exit(1);
  if (by[k].status === 0) process.exit(1);
  if (!/not allowed in read-only mode/.test(`${by[k].stdout}\n${by[k].stderr}`)) process.exit(1);
}
NODE
then pass "reviewer bd shim is read-only for scratch cwd, -C/--directory, --global, --db/--database, BEADS_DIR, and arbitrary cwd"
else fail "reviewer bd readonly scope failed (rc=$RC out=$OUT check=$(cat "$BD_SCOPE_CHECK" 2>/dev/null))"; fi

# --- scratch cwd: construction, not contract discipline ---------------------
# The reviewer's process cwd must be A repository the branch's ref resolves
# from (so its own bare `git diff`/`git show` still work — proven by phase 1
# itself already succeeding, and by phase 8's evidence reads below, both
# unchanged from before this bead), but it must NOT be ${PROJ}: a confused or
# adversarial turn that writes to a relative path must land somewhere that
# dies with the process, not in the live checkout.
SCRATCH_CWD="$(cat "$VCWD" 2>/dev/null)"
if [ -n "$SCRATCH_CWD" ] && [ "$SCRATCH_CWD" != "$PROJ" ]; then
  pass "the reviewer's cwd is NOT the project root"
else fail "the reviewer's cwd was \"$SCRATCH_CWD\" — expected anything but $PROJ"; fi
case "$SCRATCH_CWD" in
  */wheelhouse-verify-*)
    pass "the reviewer's cwd is the scratch worktree makeScratchCwd() creates" ;;
  *) fail "the reviewer's cwd \"$SCRATCH_CWD\" does not look like a wheelhouse-verify-* scratch dir" ;;
esac
if git -C "$PROJ" worktree list | grep -F >/dev/null "$SCRATCH_CWD"; then
  fail "the scratch worktree $SCRATCH_CWD is still registered after verify.ts exited — cleanup did not run"
else pass "the scratch worktree is unregistered after verify.ts exited (process-exit cleanup ran)"; fi
if [ -d "$SCRATCH_CWD" ]; then
  fail "the scratch worktree directory $SCRATCH_CWD still exists on disk after verify.ts exited"
else pass "the scratch worktree directory no longer exists on disk"; fi
if [ "$(core_worktree_snapshot "$PROJ")" = "$CORE_WORKTREE_BEFORE" ]; then
  pass "normal verify run leaves product repo core.worktree byte-identical"
else fail "normal verify changed core.worktree: before=$CORE_WORKTREE_BEFORE after=$(core_worktree_snapshot "$PROJ")"; fi

mkdir -p "$PROJ/seats/logs"
perl -e 'print "large runtime log line without the probe token\n" x 200000' > "$PROJ/seats/logs/large.log"
cat > "$REPLY" <<EOF
Runtime grep fixture checked.
VERDICT: APPROVE
PUSH: NOT CONSIDERED — fixture
EOF
run_runtime_grep_check bead-runtime-grep fleet/bead-1 worker-1
RUNTIME_GREP_CHECK="$HOME_FIX/.pi-seats-alpha/reviewer/runtime-grep-check.txt"
if [ $RC -eq 0 ] && grep -q '"status": 1' "$RUNTIME_GREP_CHECK" 2>/dev/null && grep -q '"promptNamesRuntimeExcludes": true' "$RUNTIME_GREP_CHECK" 2>/dev/null; then
  pass "large live seats/logs is outside the reviewer grep path and the prompt names runtime grep exclusions"
else fail "runtime grep path check failed (exit $RC): out=$OUT check=$(cat "$RUNTIME_GREP_CHECK" 2>/dev/null)"; fi

cat > "$REPLY" <<EOF
Annotated approve with the GH#34 shape.
VERDICT: APPROVE at pinned $TIP; branch has since moved on origin to moved-tip, same tree
PUSH: NOT CONSIDERED trailing parser annotation
EOF
run_without_default_push bead-1-annotated fleet/bead-1 worker-1
if [ $RC -eq 0 ] && says "VERDICT: APPROVE" && grep -q "verdict: APPROVE at pinned $TIP; branch has since moved on origin to moved-tip, same tree" "$VDIR/bead-1-annotated.md" 2>/dev/null; then
  pass "annotated APPROVE verdict and trailing PUSH text parse"
else fail "annotated APPROVE/PUSH did not parse (exit $RC): $OUT file=$(cat "$VDIR/bead-1-annotated.md" 2>/dev/null)"; fi

cat > "$REPLY" <<'EOF'
Push line with remote detail after the remote name.
VERDICT: APPROVE
PUSH: APPROVE origin (github.com/morebetterltd/wheelhouse, main) — verified: base..tip is one commit; tip matches reviewed SHA; added lines scanned
EOF
run_without_default_push bead-push-detail fleet/bead-1 worker-1
if [ $RC -eq 0 ] && grep -q 'push: APPROVE origin (github.com/morebetterltd/wheelhouse, main) — verified:' "$VDIR/bead-push-detail.md" 2>/dev/null; then
  pass "PUSH APPROVE parser accepts parenthetical remote detail before verified dash"
else fail "PUSH APPROVE parser rejected parenthetical remote detail (exit $RC): $OUT file=$(cat "$VDIR/bead-push-detail.md" 2>/dev/null)"; fi

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
OUT="$(env -u WHEELHOUSE_VERIFY_TIMEOUT_MS -u WHEELHOUSE_VERIFY_FIRST_OUTPUT_TIMEOUT_MS -u WHEELHOUSE_VERIFY_NO_EVENT_TIMEOUT_MS -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_REPLY_FILE="$REPLY" STUB_CANONICAL_WRITE_REPO="$PROJ" \
  bun "$RUN_PROJ/seats/verify.ts" bead-canonical fleet/bead-1 worker-1 reviewer 2>&1)"; RC=$?
ATTEMPT="$HOME_FIX/.pi-seats-alpha/reviewer/canonical-write-attempt.txt"
if [ $RC -eq 0 ] && grep -q 'canonical dirty' "$PROJ/canonical-guard.txt" && grep -q "cwd=.*wheelhouse-verify" "$ATTEMPT" 2>/dev/null && grep -q "GIT_WORK_TREE=$" "$ATTEMPT" 2>/dev/null; then
  pass "bare checkout git write runs from scratch cwd without exported GIT_WORK_TREE and leaves canonical checkout unchanged"
else fail "canonical checkout changed or attempt was not reported (exit $RC): guard=$(cat "$PROJ/canonical-guard.txt" 2>/dev/null) attempt=$(cat "$ATTEMPT" 2>/dev/null) out=$OUT"; fi
git -C "$PROJ" checkout -q -- canonical-guard.txt
TIP="$CANONICAL_TIP"

cat > "$REPLY" <<'EOF'
Ran git init in a fixture directory; dispatcher must not leak GIT_DIR/GIT_WORK_TREE.
VERDICT: APPROVE
PUSH: NOT CONSIDERED — fixture
EOF
OUT="$(env -u WHEELHOUSE_VERIFY_TIMEOUT_MS -u WHEELHOUSE_VERIFY_FIRST_OUTPUT_TIMEOUT_MS -u WHEELHOUSE_VERIFY_NO_EVENT_TIMEOUT_MS -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_REPLY_FILE="$REPLY" STUB_GIT_INIT_REPO="$PROJ" \
  bun "$RUN_PROJ/seats/verify.ts" bead-git-init fleet/bead-1 worker-1 reviewer 2>&1)"; RC=$?
GIT_INIT_CHECK="$HOME_FIX/.pi-seats-alpha/reviewer/git-init-check.json"
if [ $RC -eq 0 ] && grep -q '"before": ""' "$GIT_INIT_CHECK" 2>/dev/null \
  && grep -q '"after": ""' "$GIT_INIT_CHECK" 2>/dev/null \
  && grep -q '"gitDir": null' "$GIT_INIT_CHECK" 2>/dev/null \
  && grep -q '"gitWorkTree": null' "$GIT_INIT_CHECK" 2>/dev/null; then
  pass "reviewer git init fixture leaves live repo config unchanged and receives no GIT_DIR/GIT_WORK_TREE"
else fail "reviewer git init fixture leaked git env or changed live config (exit $RC): check=$(cat "$GIT_INIT_CHECK" 2>/dev/null) out=$OUT"; fi

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
VARGV="$HOME_FIX/.pi-seats-move/reviewer/argv.json"
MOVE_PIN="$(git -C "$MOVE_PROJ" rev-parse fleet/bead-1)"
cat > "$REPLY" <<'EOF'
Checked the pinned tip before considering the branch move.
VERDICT: APPROVE — at pinned tip __PINNED__; branch has since moved to __MOVED__ (1 commits appended, history unrewritten)
PUSH: NOT CONSIDERED — branch moved; re-verify at __MOVED__ before publish
EOF
OUT="$(env -u WHEELHOUSE_VERIFY_TIMEOUT_MS -u WHEELHOUSE_VERIFY_FIRST_OUTPUT_TIMEOUT_MS -u WHEELHOUSE_VERIFY_NO_EVENT_TIMEOUT_MS -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_REPLY_FILE="$REPLY" STUB_MOVE_BRANCH_REPO="$MOVE_PROJ" STUB_MOVE_BRANCH=fleet/bead-1 \
  bun "$RUN_PROJ/seats/verify.ts" bead-move fleet/bead-1 worker-1 reviewer 2>&1)"; RC=$?
MOVE_TIP="$(git -C "$MOVE_PROJ" rev-parse fleet/bead-1)"
if [ $RC -eq 0 ] && says "VERDICT: APPROVE" && says "at pinned tip $MOVE_PIN" && says "branch has since moved to $MOVE_TIP"; then
  pass "mid-pass branch move exits as the underlying APPROVE and names pinned/moved tips"
else fail "mid-pass branch move did not produce moved APPROVE (exit $RC): $OUT"; fi
if grep -q "tip: $MOVE_PIN" "$VDIR/bead-move.md" 2>/dev/null && grep -q "branch has since moved to $MOVE_TIP" "$VDIR/bead-move.md" && grep -q "push: NOT CONSIDERED — branch moved; re-verify at $MOVE_TIP before publish" "$VDIR/bead-move.md"; then
  pass "mid-pass branch move verdict file records pinned tip, move note, and NOT CONSIDERED push"
else fail "mid-pass branch move verdict file missing pinned/moved/push detail: $(cat "$VDIR/bead-move.md" 2>/dev/null)"; fi
if selftest_capture_lacks "$VDIR/bead-move.md" -q -- "DISCOVER" && ! says "DISCOVER"; then
  pass "mid-pass branch move is never rendered as DISCOVER"
else fail "mid-pass branch move leaked DISCOVER: $OUT $(cat "$VDIR/bead-move.md" 2>/dev/null)"; fi
RUN_PROJ="$PROJ"
VDIR="$PROJ/seats/verdicts"
VARGV="$HOME_FIX/.pi-seats-alpha/reviewer/argv.json"

phase "1c. reviewer account.authRoute=env — exported provider key is identity"
ENV_PROJ="$FIX/env-proj"
build_proj "$ENV_PROJ" env "$VERIFY"
bun -e "import fs from 'node:fs'; const p='$ENV_PROJ/seats/seats.json'; const j=JSON.parse(fs.readFileSync(p,'utf8')); j.seats.reviewer.account.authRoute='env'; fs.rmSync('$HOME_FIX/.pi-seats-env/reviewer/auth.json',{force:true}); fs.writeFileSync(p, JSON.stringify(j,null,2));"
RUN_PROJ="$ENV_PROJ"; VARGV="$HOME_FIX/.pi-seats-env/reviewer/argv.json"; VDIR="$ENV_PROJ/seats/verdicts"
cat > "$REPLY" <<'EOF'
Env-route reviewer checked.
VERDICT: APPROVE
EOF
RC=0; OUT="$(env -u WHEELHOUSE_VERIFY_TIMEOUT_MS -u WHEELHOUSE_VERIFY_FIRST_OUTPUT_TIMEOUT_MS -u WHEELHOUSE_VERIFY_NO_EVENT_TIMEOUT_MS -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_REPLY_FILE="$REPLY" OPENAI_API_KEY=fixture-key bun "$RUN_PROJ/seats/verify.ts" bead-env fleet/bead-1 worker-1 reviewer 2>&1)" || RC=$?
if [ $RC -eq 0 ] && says "VERDICT: APPROVE"; then pass "account.authRoute=env reviewer runs with exported provider env var and no auth.json"
else fail "account.authRoute=env reviewer was refused (exit $RC): $OUT"; fi
RUN_PROJ="$PROJ"; VARGV="$HOME_FIX/.pi-seats-alpha/reviewer/argv.json"; VDIR="$PROJ/seats/verdicts"

phase "1d. host budget — reviewer one-shot prepends seats/bin only when opted in"
BUDGET_PROJ="$FIX/verify-budget-proj"
build_proj "$BUDGET_PROJ" verify-budget "$VERIFY"
mkdir -p "$BUDGET_PROJ/seats/bin"
printf '{"enabled":true}\n' > "$BUDGET_PROJ/seats/host-budget.json"
RUN_PROJ="$BUDGET_PROJ"; VARGV="$HOME_FIX/.pi-seats-verify-budget/reviewer/argv.json"; VDIR="$BUDGET_PROJ/seats/verdicts"
cat > "$REPLY" <<'EOF'
Host-budget reviewer checked.
VERDICT: APPROVE
EOF
run bead-1 fleet/bead-1 worker-1
if [ $RC -eq 0 ] && grep -q "$BUDGET_PROJ/seats/bin" "${VARGV%argv.json}env.json" 2>/dev/null; then
  pass "host budget enabled: reviewer PATH includes this project's seats/bin"
else fail "host budget enabled: reviewer PATH missing seats/bin (exit $RC): $OUT env=$(cat "${VARGV%argv.json}env.json" 2>/dev/null)"; fi
LOCK="$FIX/verify-budget.lock"
LOCK_READY="$FIX/verify-budget.ready"
LOCK_RELEASE="$FIX/verify-budget.release"
mkfifo "$LOCK_RELEASE"
exec 7<> "$LOCK_RELEASE"
perl -MFcntl=:flock -e 'open(my $fh, ">>", $ARGV[0]) or die $!; flock($fh, LOCK_EX) or die $!; open(my $ready, ">", $ARGV[1]) or die $!; print $ready "held\n"; close($ready); open(my $release, "<", $ARGV[2]) or die $!; scalar(<$release>);' "$LOCK" "$LOCK_READY" "$LOCK_RELEASE" 7>&- &
LOCK_PID=$!
LOCK_DEADLINE=$((SECONDS+300))
while [ ! -s "$LOCK_READY" ] && kill -0 "$LOCK_PID" 2>/dev/null && [ "$SECONDS" -lt "$LOCK_DEADLINE" ]; do sleep 0.05; done
[ -s "$LOCK_READY" ] || fail "host-budget fixture never published its held-flock acknowledgement"
RC=0; OUT="$(env -u WHEELHOUSE_VERIFY_TIMEOUT_MS -u WHEELHOUSE_VERIFY_FIRST_OUTPUT_TIMEOUT_MS -u WHEELHOUSE_VERIFY_NO_EVENT_TIMEOUT_MS -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_REPLY_FILE="$REPLY" WHEELHOUSE_BUILD_LOCK="$LOCK" bun "$RUN_PROJ/seats/verify.ts" bead-1 fleet/bead-1 worker-1 2>&1)" || RC=$?
printf 'release\n' >&7
exec 7>&-
wait "$LOCK_PID" 2>/dev/null || true
if [ $RC -eq 1 ] && says "host build lock is held by another bead" && says "timeout-ms is not spent queued"; then
  pass "host budget enabled: verify refuses to start while another bead holds the build lock"
else fail "host budget lock contention was not refused before reviewer spawn (exit $RC): $OUT"; fi
RUN_PROJ="$PROJ"; VARGV="$HOME_FIX/.pi-seats-alpha/reviewer/argv.json"; VDIR="$PROJ/seats/verdicts"

phase "1e. mixed harness reviewer one-shots — claude-code and codex use their drivers"
MIX_PROJ="$FIX/mixed-harness-verify"
build_proj "$MIX_PROJ" mixedv "$VERIFY"
cat > "$REPLY" <<'EOF'
Mixed harness reviewer checked.
VERDICT: APPROVE
PUSH: NOT CONSIDERED — fixture
EOF
bun -e "import fs from 'node:fs'; const p='$MIX_PROJ/seats/seats.json'; const j=JSON.parse(fs.readFileSync(p,'utf8')); j.seats.reviewer.harness='claude-code'; j.seats.reviewer.provider='anthropic'; j.seats.reviewer.model='sonnet'; j.seats.reviewer.account.authRoute='oauth'; fs.writeFileSync(p, JSON.stringify(j,null,2));"
printf '{"oauthAccount":{"email":"reviewer@example.test","accessToken":"fixture-token"}}\n' > "$HOME_FIX/.pi-seats-mixedv/reviewer/.claude.json"
RUN_PROJ="$MIX_PROJ"; VDIR="$MIX_PROJ/seats/verdicts"; VARGV="$HOME_FIX/.pi-seats-mixedv/reviewer/argv.json"
run bead-1 fleet/bead-1 worker-1
if [ $RC -eq 0 ] && [ -f "$HOME_FIX/.pi-seats-mixedv/reviewer/invoked" ] && grep -q 'CLAUDE_CONFIG_DIR' "$HOME_FIX/.pi-seats-mixedv/reviewer/env.json" && ! grep -q 'PI_CODING_AGENT_DIR.*pi-seats' "$HOME_FIX/.pi-seats-mixedv/reviewer/env.json"; then
  pass "claude-code reviewer one-shot uses the claude driver environment, not pi"
else fail "claude-code reviewer one-shot did not use claude driver (rc=$RC out=$OUT env=$(cat "$HOME_FIX/.pi-seats-mixedv/reviewer/env.json" 2>/dev/null))"; fi
if grep -q '"--output-format","stream-json"' "$HOME_FIX/.pi-seats-mixedv/reviewer/argv.json" && grep -q '"--verbose"' "$HOME_FIX/.pi-seats-mixedv/reviewer/argv.json"; then
  pass "claude-code reviewer one-shot requests stream-json output with --verbose"
else fail "claude-code reviewer one-shot did not request stream-json with --verbose: $(cat "$HOME_FIX/.pi-seats-mixedv/reviewer/argv.json" 2>/dev/null)"; fi
if grep -q 'fixture brief' "$HOME_FIX/.pi-seats-mixedv/reviewer/argv.json" && ! grep -q 'contracts/REVIEWER.md' "$HOME_FIX/.pi-seats-mixedv/reviewer/argv.json"; then
  pass "claude-code reviewer one-shot carries reviewer brief text, not the path"
else fail "claude-code reviewer one-shot carried path or missed brief text: $(cat "$HOME_FIX/.pi-seats-mixedv/reviewer/argv.json" 2>/dev/null)"; fi
if selftest_capture_lacks "$HOME_FIX/.pi-seats-mixedv/reviewer/argv.json" -q -- 'permission-mode\|allowed-tools\|disallowed-tools'; then
  pass "claude-code reviewer one-shot omits tool permission flags when the seat has no tool lists"
else fail "claude-code reviewer one-shot unexpectedly carried tool permission flags: $(cat "$HOME_FIX/.pi-seats-mixedv/reviewer/argv.json" 2>/dev/null)"; fi
cat > "$REPLY" <<'EOF'
Finished after quoting the previous review without being reaped mid-run.
VERDICT: APPROVE
PUSH: NOT CONSIDERED — fixture
EOF
rm -f "$HOME_FIX/.pi-seats-mixedv/reviewer/invoked" "$HOME_FIX/.pi-seats-mixedv/reviewer/argv.json"
OUT="$(env -u WHEELHOUSE_VERIFY_TIMEOUT_MS -u WHEELHOUSE_VERIFY_FIRST_OUTPUT_TIMEOUT_MS -u WHEELHOUSE_VERIFY_NO_EVENT_TIMEOUT_MS -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_REPLY_FILE="$REPLY" STUB_CLAUDE_QUOTED_VERDICT_MIDRUN=1 bun "$RUN_PROJ/seats/verify.ts" bead-quoted-verdict fleet/bead-1 worker-1 reviewer --no-event-timeout-ms 600000 2>&1)"; RC=$?
if [ $RC -eq 0 ] && says "VERDICT: APPROVE" && ! says "exited 143"; then
  pass "claude-code quoted mid-run verdict is not reaped before the final result event"
else fail "claude-code quoted mid-run verdict was killed or failed (exit $RC): $OUT"; fi
cat > "$REPLY" <<'EOF'
Mixed harness reviewer checked.
VERDICT: APPROVE
PUSH: NOT CONSIDERED — fixture
EOF
bun -e "import fs from 'node:fs'; const p='$MIX_PROJ/seats/seats.json'; const j=JSON.parse(fs.readFileSync(p,'utf8')); j.seats.reviewer.allowedTools='Bash(git status:*),Bash(bun test:*)'; j.seats.reviewer.disallowedTools='Bash(rm -rf:*)'; fs.writeFileSync(p, JSON.stringify(j,null,2));"
rm -f "$HOME_FIX/.pi-seats-mixedv/reviewer/invoked" "$HOME_FIX/.pi-seats-mixedv/reviewer/argv.json"
run bead-1 fleet/bead-1 worker-1
if [ $RC -eq 0 ] && bun -e '
  import fs from "node:fs";
  const args = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const flagAfter = (flag) => { const i = args.indexOf(flag); return i >= 0 && /^--/.test(args[i+2] ?? ""); };
  if (args.at(-1).startsWith("--")) process.exit(1);
  if (!args.includes("--permission-mode") || args[args.indexOf("--permission-mode")+1] !== "acceptEdits") process.exit(2);
  if (!flagAfter("--allowed-tools") || !flagAfter("--disallowed-tools")) process.exit(3);
  if (args.indexOf("--allowed-tools") > args.indexOf("--model") || args.indexOf("--disallowed-tools") > args.indexOf("--model")) process.exit(4);
' "$HOME_FIX/.pi-seats-mixedv/reviewer/argv.json"; then
  pass "claude-code reviewer one-shot passes tool lists before --model with a following flag and prompt last"
else fail "claude-code reviewer one-shot tool-list argv order wrong (rc=$RC argv=$(cat "$HOME_FIX/.pi-seats-mixedv/reviewer/argv.json" 2>/dev/null))"; fi
bun -e "import fs from 'node:fs'; const p='$MIX_PROJ/seats/seats.json'; const j=JSON.parse(fs.readFileSync(p,'utf8')); j.seats.reviewer.harness='codex'; j.seats.reviewer.provider='openai-codex'; j.seats.reviewer.model='gpt-5.5'; delete j.seats.reviewer.allowedTools; delete j.seats.reviewer.disallowedTools; fs.writeFileSync(p, JSON.stringify(j,null,2));"
rm -f "$HOME_FIX/.pi-seats-mixedv/reviewer/invoked" "$HOME_FIX/.pi-seats-mixedv/reviewer/env.json"
run bead-1 fleet/bead-1 worker-1
if [ $RC -eq 0 ] && [ -f "$HOME_FIX/.pi-seats-mixedv/reviewer/invoked" ] && grep -q 'CODEX_HOME' "$HOME_FIX/.pi-seats-mixedv/reviewer/env.json" && ! grep -q 'PI_CODING_AGENT_DIR.*pi-seats' "$HOME_FIX/.pi-seats-mixedv/reviewer/env.json"; then
  pass "codex reviewer one-shot uses the codex driver environment, not pi"
else fail "codex reviewer one-shot did not use codex driver (rc=$RC out=$OUT env=$(cat "$HOME_FIX/.pi-seats-mixedv/reviewer/env.json" 2>/dev/null))"; fi
if grep -q '"--json"' "$HOME_FIX/.pi-seats-mixedv/reviewer/argv.json"; then
  pass "codex reviewer one-shot requests json streaming"
else fail "codex reviewer one-shot did not request --json: $(cat "$HOME_FIX/.pi-seats-mixedv/reviewer/argv.json" 2>/dev/null)"; fi
if grep -q 'fixture brief' "$HOME_FIX/.pi-seats-mixedv/reviewer/argv.json" && grep -q -- '--skip-git-repo-check' "$HOME_FIX/.pi-seats-mixedv/reviewer/argv.json" && grep -q 'approval_policy=never' "$HOME_FIX/.pi-seats-mixedv/reviewer/argv.json"; then
  pass "codex reviewer one-shot carries reviewer brief and measured-safe exec flags"
else fail "codex reviewer one-shot missing brief or safe flags: $(cat "$HOME_FIX/.pi-seats-mixedv/reviewer/argv.json" 2>/dev/null)"; fi
RUN_PROJ="$PROJ"; VARGV="$HOME_FIX/.pi-seats-alpha/reviewer/argv.json"; VDIR="$PROJ/seats/verdicts"

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
# A roster whose reviewer points at the AUTHOR's directory:
cp "$PROJ/seats/seats.json" "$FIX/seats.json.good"
env HOME="$HOME_FIX" bun -e '
  import fs from "node:fs";
  const f = process.argv[1];
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  j.seats.reviewer.account.dir = j.seats["worker-1"].account.dir;
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
node > "$FIX/pi-user-echo-streamed-assistant.jsonl" <<'NODE'
const prompt = "Prompt examples must be ignored:\nVERDICT: APPROVE — at pinned tip <sha>; branch has since moved\nPUSH: APPROVE origin — verified: example only";
process.stdout.write(JSON.stringify({type:"message_start",message:{role:"user",content:[{type:"text",text:prompt}]}})+"\n");
process.stdout.write(JSON.stringify({type:"message_end",message:{role:"user",content:[{type:"text",text:prompt}]}})+"\n");
process.stdout.write(JSON.stringify({type:"message_start",message:{role:"assistant",content:[]}})+"\n");
process.stdout.write(JSON.stringify({type:"message_update",assistantMessageEvent:{type:"text_delta",contentIndex:0,delta:"VERDICT: APPROVE — streamed assistant fixture\n"}})+"\n");
process.stdout.write(JSON.stringify({type:"message_update",assistantMessageEvent:{type:"text_delta",contentIndex:0,delta:"PUSH: NOT CONSIDERED — fixture\n"}})+"\n");
process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[]}})+"\n");
process.stdout.write(JSON.stringify({type:"turn_end",message:{role:"assistant",content:[]}})+"\n");
NODE
run_stream "$FIX/pi-user-echo-streamed-assistant.jsonl" bead-5-pi-user-echo-streamed fleet/bead-1 worker-1
if [ $RC -eq 0 ] && says "VERDICT: APPROVE" && grep -q "verdict: APPROVE — streamed assistant fixture" "$VDIR/bead-5-pi-user-echo-streamed.md" 2>/dev/null; then
  pass "pi user prompt echo plus streamed assistant deltas yields exactly one VERDICT candidate"
else fail "pi user prompt echo/streamed assistant fixture did not yield one APPROVE (exit $RC): $OUT file=$(cat "$VDIR/bead-5-pi-user-echo-streamed.md" 2>/dev/null)"; fi
node > "$FIX/pi-thinking-toolcall-dies.jsonl" <<'NODE'
process.stdout.write(JSON.stringify({type:"message_start",message:{role:"assistant",content:[]}})+"\n");
process.stdout.write(JSON.stringify({type:"message_update",assistantMessageEvent:{type:"thinking_delta",contentIndex:0,delta:"VERDICT: APPROVE — thinking is not final text\n"}})+"\n");
process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[],stopReason:"tool_use"}})+"\n");
NODE
run_stream "$FIX/pi-thinking-toolcall-dies.jsonl" bead-5-thinking-toolcall-dies fleet/bead-1 worker-1
if [ $RC -eq 1 ] && says "no VERDICT" && [ ! -f "$VDIR/bead-5-thinking-toolcall-dies.md" ]; then
  pass "pi thinking/tool-call stream yields zero live verdict candidates and STOPs"
else fail "pi thinking/tool-call stream leaked a verdict candidate (exit $RC): $OUT file=$(cat "$VDIR/bead-5-thinking-toolcall-dies.md" 2>/dev/null)"; fi
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
set_reviewer_harness() {
  env HOME="$HOME_FIX" bun -e '
    import fs from "node:fs";
    const file = process.argv[1], harness = process.argv[2], dir = process.argv[3];
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    if (harness === "pi") delete j.seats.reviewer.harness;
    else j.seats.reviewer.harness = harness;
    if (harness === "claude-code") {
      fs.writeFileSync(`${dir}/.claude.json`, JSON.stringify({ oauthAccount: { email: "reviewer@example.test", accessToken: "fixture-token" } }));
    } else {
      fs.rmSync(`${dir}/.claude.json`, { force: true });
    }
    fs.writeFileSync(file, JSON.stringify(j, null, 2));
  ' "$PROJ/seats/seats.json" "$1" "$HOME_FIX/.pi-seats-alpha/reviewer"
}
for fixture in $EXPECTED_REAL_FIXTURES; do
  [ -f "$REAL_FIXTURES_DIR/$fixture" ] || { echo "selftest: missing real reviewer fixture: $REAL_FIXTURES_DIR/$fixture" >&2; exit 2; }
done
check_reviewer_fixture_manifest() {
  local root bench
  root="$(cd "$VERIFY_DIR/.." && pwd -P)"
  if [ -f "$root/contracts/BENCH.md" ]; then bench="$root/contracts/BENCH.md";
  elif [ -f "$root/wheelhouse/crew/BENCH.md" ]; then bench="$root/wheelhouse/crew/BENCH.md";
  else fail "reviewer fixture manifest check could not find BENCH.md"; return; fi
  if bun - "$root" "$bench" <<'TS'
import fs from "node:fs";
import path from "node:path";
const [root,bench]=process.argv.slice(2),prefix="seats/fixtures/verify-real/";
const actual=fs.readdirSync(path.join(root,prefix)).filter(p=>p.endsWith(".jsonl")).map(p=>prefix+p).sort();
const text=fs.readFileSync(bench,"utf8").replace(/<!--[\s\S]*?-->/g,"");
const listed=[...new Set([...text.matchAll(/fixture:\s*(seats\/fixtures\/verify-real\/[^;\s]+\.jsonl)/g)].map(m=>m[1]))].sort();
const missing_from_bench=actual.filter(p=>!listed.includes(p)),missing_from_disk=listed.filter(p=>!actual.includes(p));
if(missing_from_bench.length || missing_from_disk.length){
 console.log("missing_from_bench="+missing_from_bench.join(",")); console.log("missing_from_disk="+missing_from_disk.join(",")); process.exitCode=1;
}
TS
  then pass "BENCH.md reviewer wire-shape list matches real fixture files"; else fail "BENCH.md reviewer wire-shape list and fixture files diverge"; fi
}
check_reviewer_fixture_manifest
COMMENTED_BENCH="$FIX/commented-BENCH.md"
{
  printf '### Reviewer wire shapes covered\n\n<!--\n'
  for fixture in $EXPECTED_REAL_FIXTURES; do
    printf -- '- harness: canary; fixture: seats/fixtures/verify-real/%s; binary version: canary; capture date: 2099-01-01\n' "$fixture"
  done
  printf -- '-->\n'
} > "$COMMENTED_BENCH"
if bun - "$VERIFY_DIR/.." "$COMMENTED_BENCH" <<'TS'
import fs from "node:fs";
import path from "node:path";
const [root,bench]=process.argv.slice(2),prefix="seats/fixtures/verify-real/";
const actual=fs.readdirSync(path.join(root,prefix)).filter(p=>p.endsWith(".jsonl")).map(p=>prefix+p);
const text=fs.readFileSync(bench,"utf8").replace(/<!--[\s\S]*?-->/g,"");
const listed=new Set([...text.matchAll(/fixture:\s*(seats\/fixtures\/verify-real\/[^;\s]+\.jsonl)/g)].map(m=>m[1]));
if(actual.some(p=>!listed.has(p)))process.exitCode=1;
TS
then fail "BENCH.md reviewer wire-shape manifest check accepted a commented-out fixture list"; else pass "BENCH.md reviewer wire-shape manifest check rejects commented-out fixture lists"; fi
set_reviewer_harness pi
run_stream "$REAL_FIXTURES_DIR/pi-v3-message-end.jsonl" bead-5-recorded-pi fleet/bead-1 worker-1
if [ $RC -eq 2 ] && says "VERDICT: BOUNCE" && grep -q "verdict: BOUNCE" "$VDIR/bead-5-recorded-pi.md" 2>/dev/null; then
  pass "real pi message_end fixture yields one BOUNCE; result/turn events are not double-counted"
else fail "real pi fixture did not yield a single BOUNCE (exit $RC): $OUT file=$(cat "$VDIR/bead-5-recorded-pi.md" 2>/dev/null)"; fi
set_reviewer_harness claude-code
run_stream "$REAL_FIXTURES_DIR/claude-code-2.1.278-assistant.jsonl" bead-5-recorded-claude fleet/bead-1 worker-1
if [ $RC -eq 2 ] && says "VERDICT: BOUNCE" && grep -q "verdict: BOUNCE" "$VDIR/bead-5-recorded-claude.md" 2>/dev/null; then
  pass "real claude-code assistant fixture yields one BOUNCE; result event is not double-counted"
else fail "real claude-code fixture did not yield a single BOUNCE (exit $RC): $OUT file=$(cat "$VDIR/bead-5-recorded-claude.md" 2>/dev/null)"; fi
set_reviewer_harness codex
run_stream "$REAL_FIXTURES_DIR/codex-0.144.0-item-completed-agent-message.jsonl" bead-5-recorded-codex fleet/bead-1 worker-1
if [ $RC -eq 2 ] && says "VERDICT: BOUNCE" && grep -q "verdict: BOUNCE" "$VDIR/bead-5-recorded-codex.md" 2>/dev/null; then
  pass "real codex item.completed agent_message fixture yields one BOUNCE; turn.completed is not double-counted"
else fail "real codex fixture did not yield a single BOUNCE (exit $RC): $OUT file=$(cat "$VDIR/bead-5-recorded-codex.md" 2>/dev/null)"; fi
set_reviewer_harness pi
cat > "$REPLY" <<'EOF'
VERDICT: APPROVE
wait, actually:
VERDICT: BOUNCE
EOF
run_without_default_push bead-5 fleet/bead-1 worker-1
if [ $RC -eq 1 ] && says "2 live VERDICT: lines" && says "line 1: VERDICT: APPROVE" && says "line 3: VERDICT: BOUNCE"; then
  pass "two conflicting live VERDICT: lines exit 1 and print both final-message candidates"
else fail "ambiguous double verdict not refused with candidates (exit $RC): $OUT"; fi
if bun -e 'import fs from "node:fs"; import a from "node:assert/strict";
  const dir=process.argv[1]; a.ok(fs.statSync(dir).isDirectory());
  const rows=fs.readdirSync(dir).filter(n=>n.startsWith("bead-5.")).map(n=>JSON.parse(fs.readFileSync(`${dir}/${n}`,"utf8"))).filter(r=>r.reason.startsWith("reviewer emitted 2 live VERDICT:"));
  a.equal(rows.length,2); for(const r of rows){a.equal(r.status,"REFUSED");a.equal(r.notAVerdict,true);a.match(r.stdout, /"type":"message_end"/);a.ok(r.stdout.includes("VERDICT: APPROVE") && r.stdout.includes("VERDICT: BOUNCE"));}
' "$VDIR/refused"; then
  pass "ambiguous double verdict retains both raw json answers marked REFUSED, never verdict Markdown"
else
  fail "ambiguous double verdict raw answers or refusal reasons were not retained"
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
  pass "a reviewer roster without account.label still reaches the provider-error path"
else fail "unlabeled reviewer unexpectedly printed an account.label: $OUT"; fi
env HOME="$HOME_FIX" bun -e '
  import fs from "node:fs";
  const f = process.argv[1];
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  j.seats.reviewer.account.label = "fixture-reviewer-account";
  fs.writeFileSync(f, JSON.stringify(j, null, 2));
' "$PROJ/seats/seats.json"
OUT="$(env HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_REPLY_FILE="$REPLY" STUB_EXIT=3 \
  bun "$PROJ/seats/verify.ts" bead-5-label fleet/bead-1 worker-1 2>&1)"; RC=$?
if [ $RC -eq 1 ] && says "pi exited 3" && says "account label: fixture-reviewer-account"; then
  pass "provider-error stderr path includes reviewer account.label when present"
else fail "provider-error path did not include reviewer account.label (exit $RC): $OUT"; fi
env HOME="$HOME_FIX" bun -e '
  import fs from "node:fs";
  const f = process.argv[1];
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  delete j.seats.reviewer.account.label;
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
if [ $RC -eq 1 ] && says 'not "reviewer"'; then
  pass "naming a non-reviewer seat as the reviewer is a STOP"
else fail "non-reviewer reviewer seat not refused (exit $RC): $OUT"; fi
: > "$HOME_FIX/.pi-seats-alpha/reviewer/auth.json"
run bead-6 fleet/bead-1 worker-1
if [ $RC -eq 1 ] && says "no identity"; then
  pass "a reviewer seat that was never logged in is a STOP"
else fail "identity-less reviewer not refused (exit $RC): $OUT"; fi
printf '{"stub":"%s"}\n' "$SENTINEL" > "$HOME_FIX/.pi-seats-alpha/reviewer/auth.json"
CLAUDE_ID_PROJ="$FIX/claude-identity-stop"
build_proj "$CLAUDE_ID_PROJ" claudeid "$VERIFY"
bun -e "import fs from 'node:fs'; const p='$CLAUDE_ID_PROJ/seats/seats.json'; const j=JSON.parse(fs.readFileSync(p,'utf8')); j.seats.reviewer.harness='claude-code'; j.seats.reviewer.provider='anthropic'; j.seats.reviewer.account.authRoute='oauth'; fs.rmSync('$HOME_FIX/.pi-seats-claudeid/reviewer/auth.json',{force:true}); fs.writeFileSync(p, JSON.stringify(j,null,2));"
RUN_PROJ="$CLAUDE_ID_PROJ"; VDIR="$CLAUDE_ID_PROJ/seats/verdicts"
RC=0; OUT="$(env -u WHEELHOUSE_VERIFY_TIMEOUT_MS -u WHEELHOUSE_VERIFY_FIRST_OUTPUT_TIMEOUT_MS -u WHEELHOUSE_VERIFY_NO_EVENT_TIMEOUT_MS -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_REPLY_FILE="$REPLY" bun "$RUN_PROJ/seats/verify.ts" bead-claude-id fleet/bead-1 worker-1 reviewer 2>&1)" || RC=$?
if [ $RC -eq 1 ] && says "no identity" && says "CLAUDE_CONFIG_DIR" && says "claude" && ! says "PI_CODING_AGENT_DIR"; then
  pass "empty claude-code reviewer dir STOPs with Claude Code login wording"
else fail "identity-less claude-code reviewer not refused with Claude wording (exit $RC): $OUT"; fi
RUN_PROJ="$PROJ"; VARGV="$HOME_FIX/.pi-seats-alpha/reviewer/argv.json"; VDIR="$PROJ/seats/verdicts"
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
  pass "an explicit reviewer seat with a path separator is a STOP"
else fail "bad explicit reviewer seat not refused (exit $RC): $OUT"; fi

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
  pass "the floor-check results reach the reviewer's prompt"
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
cp "$VERIFY" "$FIX/can-a-verify.ts"
perl -0pi -e 's/const distinct = gating\.filter\(\(\[, e\]\) => e\.account\?\.dir && canonicalDir\(e\.account\.dir\) !== authorDir\);/const distinct = gating;\/\/ canary disables picker distinctness/; s/if \(authorDir === reviewerDir\) \{ \/\/ distinctness-gate/if (false) { \/\/ distinctness-gate/' "$FIX/can-a-verify.ts"
if cmp -s "$VERIFY" "$FIX/can-a-verify.ts" \
  || ! grep -Fq 'const distinct = gating;// canary disables picker distinctness' "$FIX/can-a-verify.ts" \
  || ! grep -Fq 'if (false) { // distinctness-gate' "$FIX/can-a-verify.ts"; then
  fail "canary: could not disarm BOTH distinctness gates — a source site no longer matches, so the canary proves nothing"
else
  build_proj "$CAN_A" can-a "$FIX/can-a-verify.ts"
  env HOME="$HOME_FIX" bun -e '
    import fs from "node:fs";
    const f = process.argv[1];
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    j.seats.reviewer.account.dir = j.seats["worker-1"].account.dir;
    fs.writeFileSync(f, JSON.stringify(j, null, 2));
  ' "$CAN_A/seats/seats.json"
  RUN_PROJ="$CAN_A"
  VINVOKED="$HOME_FIX/.pi-seats-can-a/reviewer/invoked"
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
sed 's|^[[:space:]]*fs.writeFileSync(verdictFile, record); // verdict-write$|  ; // verdict-write|' \
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
VINVOKED="$HOME_FIX/.pi-seats-alpha/reviewer/invoked"

phase "9b. core.worktree restore guard covers mid-run clobber"
CORE_GUARD_PROJ="$FIX/proj-core-guard"
build_proj "$CORE_GUARD_PROJ" coreguard "$VERIFY"
printf 'Core worktree restore guard checked.\nVERDICT: APPROVE\n' > "$REPLY"
git -C "$CORE_GUARD_PROJ" config --local core.worktree "$CORE_GUARD_PROJ"
CORE_GUARD_BEFORE="$(core_worktree_snapshot "$CORE_GUARD_PROJ")"
OUT="$(env -u WHEELHOUSE_VERIFY_TIMEOUT_MS -u WHEELHOUSE_VERIFY_FIRST_OUTPUT_TIMEOUT_MS -u WHEELHOUSE_VERIFY_NO_EVENT_TIMEOUT_MS -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_REPLY_FILE="$REPLY" STUB_CLOBBER_CORE_WORKTREE_REPO="$CORE_GUARD_PROJ" bun "$CORE_GUARD_PROJ/seats/verify.ts" bead-core-guard fleet/bead-1 worker-1 reviewer 2>&1)"
RC=$?
CORE_GUARD_CLOBBER="$HOME_FIX/.pi-seats-coreguard/reviewer/core-worktree-clobber.txt"
if [ $RC -eq 0 ] && [ "$(core_worktree_snapshot "$CORE_GUARD_PROJ")" = "$CORE_GUARD_BEFORE" ]; then
  pass "pre-set core.worktree is byte-identical after reviewer clobbers it mid-run"
else fail "pre-set core.worktree was not restored (exit $RC): before=$CORE_GUARD_BEFORE after=$(core_worktree_snapshot "$CORE_GUARD_PROJ") out=$OUT"; fi
if grep -q '/wheelhouse-verify-' "$CORE_GUARD_CLOBBER" 2>/dev/null && ! grep -qF "$CORE_GUARD_PROJ" "$CORE_GUARD_CLOBBER" 2>/dev/null; then
  pass "restore-path fixture wrote the scratch wheelhouse-verify path into core.worktree"
else fail "restore-path fixture did not write a scratch wheelhouse-verify path: $(cat "$CORE_GUARD_CLOBBER" 2>/dev/null)"; fi

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
  printf "%s\n%s\n" "$pid" "$dir" > "$1/live-owner.txt"
  deadline=$((SECONDS+300))
  while [ ! -f "$1/live-owner.release" ]; do [ "$SECONDS" -lt "$deadline" ] || exit 124; sleep 0.05; done
' _ "$FIX" "$PROJ" &
LIVE_OWNER_CHILD=$!
LIVE_READY_DEADLINE=$((SECONDS+300))
while [ ! -f "$FIX/live-owner.txt" ] && kill -0 "$LIVE_OWNER_CHILD" 2>/dev/null && [ "$SECONDS" -lt "$LIVE_READY_DEADLINE" ]; do sleep 0.05; done
LIVE_OWNER_PID=$(sed -n '1p' "$FIX/live-owner.txt")
LIVE_DIR=$(sed -n '2p' "$FIX/live-owner.txt")
if git -C "$PROJ" worktree list | grep -F >/dev/null "$ORPHAN_DIR" \
   && git -C "$PROJ" worktree list | grep -F >/dev/null "$REVIEW_ORPHAN_DIR" \
   && git -C "$PROJ" worktree list | grep -F >/dev/null "$LIVE_DIR" \
   && git -C "$PROJ" show-ref --verify --quiet "refs/heads/$SHA_BRANCH"; then
  pass "planted verify/review orphan worktrees, a live scratch worktree, and a SHA-named branch"
else fail "could not plant stale scratch fixtures before sweeping"; fi

run   # no args: usage STOP, but only after sweepStaleScratchWorktrees() ran
if ! git -C "$PROJ" worktree list | grep -F >/dev/null "$ORPHAN_DIR" && [ ! -d "$ORPHAN_DIR" ]; then
  pass "the orphaned verify scratch worktree (dead pid) was reclaimed"
else fail "the verify orphan survived: $(git -C "$PROJ" worktree list)"; fi
if ! git -C "$PROJ" worktree list | grep -F >/dev/null "$REVIEW_ORPHAN_DIR" && [ ! -d "$REVIEW_ORPHAN_DIR" ]; then
  pass "the orphaned review scratch worktree (dead pid) was reclaimed"
else fail "the review orphan survived: $(git -C "$PROJ" worktree list)"; fi
if ! git -C "$PROJ" show-ref --verify --quiet "refs/heads/$SHA_BRANCH"; then
  pass "the stale 40-hex local branch was reclaimed"
else fail "the stale SHA-named branch survived: $(git -C "$PROJ" branch --list "$SHA_BRANCH")"; fi
if git -C "$PROJ" worktree list | grep -F >/dev/null "$LIVE_DIR" && [ -d "$LIVE_DIR" ]; then
  pass "the live scratch worktree (real running pid, not holding the path) was spared"
else fail "the live worktree was swept even though its owner pid is still alive"; fi

CONCURRENT_OUT_A="$FIX/concurrent-verify-a.out"
CONCURRENT_OUT_B="$FIX/concurrent-verify-b.out"
(env -u WHEELHOUSE_VERIFY_TIMEOUT_MS -u WHEELHOUSE_VERIFY_FIRST_OUTPUT_TIMEOUT_MS -u WHEELHOUSE_VERIFY_NO_EVENT_TIMEOUT_MS -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_STALL=1 bun "$PROJ/seats/verify.ts" bead-a fleet/bead-1 worker-1 reviewer --timeout-ms 1800000 >"$CONCURRENT_OUT_A" 2>&1) &
CONCURRENT_PID_A=$!
(env -u WHEELHOUSE_VERIFY_TIMEOUT_MS -u WHEELHOUSE_VERIFY_FIRST_OUTPUT_TIMEOUT_MS -u WHEELHOUSE_VERIFY_NO_EVENT_TIMEOUT_MS -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_STALL=1 bun "$PROJ/seats/verify.ts" bead-b fleet/bead-1 worker-1 reviewer --timeout-ms 1800000 >"$CONCURRENT_OUT_B" 2>&1) &
CONCURRENT_PID_B=$!
CONCURRENT_DIRS=""
CONCURRENT_READY_DEADLINE=$((SECONDS+300))
while [ "$SECONDS" -lt "$CONCURRENT_READY_DEADLINE" ]; do
  CONCURRENT_DIRS="$(git -C "$PROJ" worktree list --porcelain 2>/dev/null | awk -v a="wheelhouse-verify-${CONCURRENT_PID_A}-" -v b="wheelhouse-verify-${CONCURRENT_PID_B}-" '/^worktree /{p=substr($0,10); if (index(p,a) || index(p,b)) print p}' | sort)"
  [ "$(printf '%s\n' "$CONCURRENT_DIRS" | sed '/^$/d' | wc -l | tr -d ' ')" -eq 2 ] && break
  sleep 0.05
 done
if [ "$(printf '%s\n' "$CONCURRENT_DIRS" | sed '/^$/d' | wc -l | tr -d ' ')" -eq 2 ]; then
  pass "concurrent verify gates both reached registered scratch worktrees"
else
  fail "concurrent verify gates did not both register scratch worktrees: a=$(cat "$CONCURRENT_OUT_A" 2>/dev/null) b=$(cat "$CONCURRENT_OUT_B" 2>/dev/null) dirs=$CONCURRENT_DIRS"
fi
run   # a third gate's early sweep must not delete either live concurrent gate's scratch
MISSING_CONCURRENT=0
while IFS= read -r d; do
  [ -z "$d" ] && continue
  git -C "$PROJ" worktree list | grep -F >/dev/null "$d" && [ -d "$d" ] || MISSING_CONCURRENT=$((MISSING_CONCURRENT + 1))
done <<EOF_CONCURRENT_DIRS
$CONCURRENT_DIRS
EOF_CONCURRENT_DIRS
if [ "$MISSING_CONCURRENT" -eq 0 ]; then
  pass "concurrent live verify gates keep their scratch worktrees through another sweep"
else
  fail "a live concurrent gate scratch worktree was swept: missing=$MISSING_CONCURRENT dirs=$CONCURRENT_DIRS output=$OUT"
fi
kill "$CONCURRENT_PID_A" "$CONCURRENT_PID_B" 2>/dev/null || true
wait "$CONCURRENT_PID_A" 2>/dev/null || true
wait "$CONCURRENT_PID_B" 2>/dev/null || true

if [ "$LIVE_OWNER_PID" = "$LIVE_OWNER_CHILD" ] && kill -0 "$LIVE_OWNER_CHILD" 2>/dev/null; then
  printf 'release\n' > "$FIX/live-owner.release"
  wait "$LIVE_OWNER_CHILD" 2>/dev/null || true
else
  fail "live scratch owner exited before its release (recorded=$LIVE_OWNER_PID child=$LIVE_OWNER_CHILD)"
fi
run   # a second sweep pass, now that the "live" owner has actually exited
if ! git -C "$PROJ" worktree list | grep -F >/dev/null "$LIVE_DIR" && [ ! -d "$LIVE_DIR" ]; then
  pass "once its owner pid actually exits, a later sweep reclaims that worktree too"
else fail "the formerly-live worktree was not reclaimed after its owner pid died: $(git -C "$PROJ" worktree list)"; fi

phase "10b. killed one-shot — reaper leaves no scratch worktree or SHA branch"
KILL_PROJ="$FIX/proj-kill"
build_proj "$KILL_PROJ" kill "$VERIFY"
RUN_PROJ="$KILL_PROJ"; VDIR="$KILL_PROJ/seats/verdicts"; VARGV="$HOME_FIX/.pi-seats-kill/reviewer/argv.json"
KILL_SHA_BRANCH="89abcdef0123456789abcdef0123456789abcdef"
git -C "$KILL_PROJ" branch "$KILL_SHA_BRANCH" HEAD >/dev/null 2>&1
OUT_FILE="$FIX/killed-verify.out"
KILL_CORE_WORKTREE_BEFORE="$(core_worktree_snapshot "$KILL_PROJ")"
(env -u WHEELHOUSE_VERIFY_TIMEOUT_MS -u WHEELHOUSE_VERIFY_FIRST_OUTPUT_TIMEOUT_MS -u WHEELHOUSE_VERIFY_NO_EVENT_TIMEOUT_MS -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_STALL=1 bun "$RUN_PROJ/seats/verify.ts" bead-kill fleet/bead-1 worker-1 reviewer --timeout-ms 1800000 >"$OUT_FILE" 2>&1) &
KILLED_DISPATCHER_PID=$!
KILLED_DIR=""
KILLED_READY_DEADLINE=$((SECONDS+300))
while [ "$SECONDS" -lt "$KILLED_READY_DEADLINE" ]; do
  KILLED_DIR="$(git -C "$KILL_PROJ" worktree list --porcelain 2>/dev/null | awk '/^worktree /{p=substr($0,10); n=p; sub(/^.*\//,"",n); if (n ~ /^wheelhouse-verify-[0-9]+-/) print p}' | sed -n '1p' || true)"
  [ -n "$KILLED_DIR" ] && break
  sleep 0.05
done
if [ -n "$KILLED_DIR" ]; then pass "killed one-shot fixture reached a registered scratch worktree"
else fail "killed one-shot fixture never registered a scratch worktree: $(cat "$OUT_FILE" 2>/dev/null)"; fi
kill -9 "$KILLED_DISPATCHER_PID" 2>/dev/null || true
wait "$KILLED_DISPATCHER_PID" 2>/dev/null || true
PI_PID_FILE="$HOME_FIX/.pi-seats-kill/reviewer/pi-pid.txt"
if [ -s "$PI_PID_FILE" ]; then kill "$(cat "$PI_PID_FILE")" 2>/dev/null || true; fi
run   # sweep the killed run's scratch worktree and stale SHA branch
if [ -n "$KILLED_DIR" ] && ! git -C "$KILL_PROJ" worktree list | grep -F >/dev/null "$KILLED_DIR" && [ ! -d "$KILLED_DIR" ]; then
  pass "killed one-shot scratch worktree was reclaimed by the reaper pass"
else fail "killed one-shot scratch survived: dir=$KILLED_DIR list=$(git -C "$KILL_PROJ" worktree list)"; fi
if ! git -C "$KILL_PROJ" show-ref --verify --quiet "refs/heads/$KILL_SHA_BRANCH"; then
  pass "killed one-shot reaper pass removed the stale SHA-named branch"
else fail "killed one-shot stale SHA branch survived"; fi
if [ "$(core_worktree_snapshot "$KILL_PROJ")" = "$KILL_CORE_WORKTREE_BEFORE" ]; then
  pass "killed verify run leaves product repo core.worktree byte-identical"
else fail "killed verify changed core.worktree: before=$KILL_CORE_WORKTREE_BEFORE after=$(core_worktree_snapshot "$KILL_PROJ")"; fi

phase "10c. SIGTERM/SIGINT one-shot cleanup restores core.worktree and removes scratch"
signal_cleanup_case() {
  local sig="$1" expect="$2" ns="$3" label="$4"
  local sig_proj="$FIX/proj-$ns" out_file="$FIX/$ns.out" before dir pid_file wait_rc
  build_proj "$sig_proj" "$ns" "$VERIFY"
  git -C "$sig_proj" config --local core.worktree "$sig_proj"
  before="$(core_worktree_snapshot "$sig_proj")"
  (env -u WHEELHOUSE_VERIFY_TIMEOUT_MS -u WHEELHOUSE_VERIFY_FIRST_OUTPUT_TIMEOUT_MS -u WHEELHOUSE_VERIFY_NO_EVENT_TIMEOUT_MS -u BEADS_ACTOR HOME="$HOME_FIX" PATH="$RUN_PATH" STUB_STALL=1 STUB_CLOBBER_CORE_WORKTREE_REPO="$sig_proj" bun "$sig_proj/seats/verify.ts" "bead-$ns" fleet/bead-1 worker-1 reviewer --timeout-ms 1800000 >"$out_file" 2>&1) &
  local dispatcher_pid=$!
  dir=""
  local ready_deadline=$((SECONDS+300))
  while [ "$SECONDS" -lt "$ready_deadline" ]; do
    dir="$(git -C "$sig_proj" worktree list --porcelain 2>/dev/null | awk '/^worktree /{p=substr($0,10); n=p; sub(/^.*\//,"",n); if (n ~ /^wheelhouse-verify-[0-9]+-/) print p}' | sed -n '1p' || true)"
    [ -n "$dir" ] && [ -s "$HOME_FIX/.pi-seats-$ns/reviewer/core-worktree-clobber.txt" ] && break
    sleep 0.05
  done
  if [ -n "$dir" ]; then pass "$label fixture reached a registered scratch worktree"
  else fail "$label fixture never registered a scratch worktree: $(cat "$out_file" 2>/dev/null)"; fi
  kill -"$sig" "$dispatcher_pid" 2>/dev/null || true
  wait "$dispatcher_pid" 2>/dev/null; wait_rc=$?
  pid_file="$HOME_FIX/.pi-seats-$ns/reviewer/pi-pid.txt"
  if [ -s "$pid_file" ]; then kill "$(cat "$pid_file")" 2>/dev/null || true; fi
  if [ "$wait_rc" = "$expect" ]; then pass "$label exits with signal-shaped status $expect"
  else fail "$label exit status was $wait_rc, expected $expect; out=$(cat "$out_file" 2>/dev/null)"; fi
  if [ "$(core_worktree_snapshot "$sig_proj")" = "$before" ]; then pass "$label leaves product repo core.worktree byte-identical after mid-run clobber"
  else fail "$label changed core.worktree: before=$before after=$(core_worktree_snapshot "$sig_proj")"; fi
  if [ -n "$dir" ] && ! git -C "$sig_proj" worktree list | grep -F >/dev/null "$dir" && [ ! -d "$dir" ]; then
    pass "$label removes scratch worktree on signal"
  else fail "$label scratch survived: dir=$dir list=$(git -C "$sig_proj" worktree list 2>/dev/null)"; fi
}
signal_cleanup_case TERM 143 sigterm SIGTERM
signal_cleanup_case INT 130 sigint SIGINT
RUN_PROJ="$PROJ"; VDIR="$PROJ/seats/verdicts"; VARGV="$HOME_FIX/.pi-seats-alpha/reviewer/argv.json"

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
  # Borrow the real login into the reviewer seat only; it dies with the fixture.
  RSEAT="$RHOME/.pi-seats-real/reviewer"
  cp "$REAL_AUTH" "$RSEAT/auth.json" && chmod 600 "$RSEAT/auth.json"
  [ -f "$HOME/.pi/agent/settings.json" ] && cp "$HOME/.pi/agent/settings.json" "$RSEAT/settings.json"
  # No --provider/--model pin by default: whatever your login can actually
  # run. When the working login is NOT pi's default provider, pin both
  # (always together — see the roster gotcha in README.md):
  #   WHEELHOUSE_REAL_PI_PROVIDER=... WHEELHOUSE_REAL_PI_MODEL=...
  env HOME="$RHOME" bun -e '
    import fs from "node:fs";
    const f = process.argv[1];
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    const p = process.env.WHEELHOUSE_REAL_PI_PROVIDER, m = process.env.WHEELHOUSE_REAL_PI_MODEL;
    if (p && m) { j.seats.reviewer.provider = p; j.seats.reviewer.model = m; }
    else { delete j.seats.reviewer.provider; delete j.seats.reviewer.model; }
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
