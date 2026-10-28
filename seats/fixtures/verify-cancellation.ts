// Real verify + runner/helper, one idle stub suite. The inner review uses an
// isolated target lock; this test's outer canonical host lock remains held.
// No process-table/environment/cwd/argv ownership probing, no group escapes.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { spawnSync } from "./fixture-command.cjs";
const root = path.resolve(process.argv[2]), runtime = path.join(root, "runtime/seats");
function retainChildDiagnostics(saved: string | undefined, name: string, stdout: string, stderr: string, child: any): string | undefined {
  const base = path.resolve(process.env.WHEELHOUSE_VERIFY_CANCEL_FAILURE_ROOT || process.env.WHEELHOUSE_VERIFY_CANCEL_EVIDENCE || path.join(path.dirname(import.meta.dir), "verdicts/verify-cancellation-failures"));
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const physical = fs.realpathSync(base), scratch = fs.realpathSync(root);
  assert(physical !== scratch && !physical.startsWith(scratch + path.sep), "failed-child retention must be outside removable cancellation scratch");
  const temporary = process.env.TMPDIR ? fs.realpathSync(process.env.TMPDIR) : undefined;
  assert(!temporary || (physical !== temporary && !physical.startsWith(temporary + path.sep)), "failed-child retention must be outside removable per-suite TMPDIR");
  saved ??= fs.mkdtempSync(path.join(physical, name + "-"));
  const put = (file: string, data: string) => {
    const next = path.join(saved!, file + "." + crypto.randomUUID() + ".new");
    fs.writeFileSync(next, data, { flag: "wx", mode: 0o600 }); fs.renameSync(next, path.join(saved!, file));
  };
  put("stdout", stdout); put("stderr", stderr);
  put("exit.json", JSON.stringify({ name, pid: child.pid, code: child.exitCode, signal: child.signalCode, stdoutEOF: child.stdout.readableEnded, stderrEOF: child.stderr.readableEnded, stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr) }, null, 2) + "\n");
  return saved;
}
const groupAlive = (pgid: number) => { assert(Number.isInteger(pgid) && pgid > 1); try { process.kill(-pgid, 0); return true; } catch (e: any) { if (e.code === "ESRCH") return false; if (e.code === "EPERM") return true; throw e; } };
const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e: any) { if (e.code === "ESRCH") return false; throw e; } };
function signalGroup(pgid: number, signal: NodeJS.Signals) { assert(Number.isInteger(pgid) && pgid > 1); try { process.kill(-pgid, signal); } catch (e: any) { if (e.code !== "ESRCH") throw e; } }
async function until(test: () => boolean, ended: () => boolean, label: string) {
  console.error(`FIXTURE_WAIT verify cancellation: ${label}`);
  while (!test()) { if (ended()) throw Error("child exited before " + label); await Bun.sleep(50); }
}
function command(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) { const r = spawnSync(bin, args, { cwd, env, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout; }
const cases = ["sweep", "reviewer"].flatMap(phase => (["SIGTERM", "SIGINT", "SIGHUP"] as const).map(signal => ({ phase, signal })));
cases.push({ phase: "reviewer-orphan", signal: "SIGTERM" });
// An interrupted sweep is itself terminal, even if its groups retired before
// close. Also cover the commander's simultaneous dispatcher+runner TERM path.
cases.push(...(["SIGTERM", "SIGINT", "SIGHUP"] as const).map(signal => ({ phase: "sweep-interrupted", signal })));
cases.push(...(["SIGTERM", "SIGINT", "SIGHUP"] as const).map(signal => ({ phase: "sweep-stubborn", signal })));
cases.push({ phase: "sweep-stubborn-long-grace", signal: "SIGTERM" });
cases.push({ phase: "sweep-stubborn-runner-killed", signal: "SIGTERM" });
cases.push({ phase: "sweep-stubborn-runner-killed-aliased-parent", signal: "SIGTERM" });
cases.push({ phase: "sweep-stubborn-runner-killed-aliased-parent-replacement", signal: "SIGTERM" });
const selected = process.env.WHEELHOUSE_TEST_VERIFY_CANCEL_CASE
  ? cases.filter(c => c.phase + "-" + c.signal === process.env.WHEELHOUSE_TEST_VERIFY_CANCEL_CASE)
  : process.env.WHEELHOUSE_TEST_VERIFY_CANCEL_ALIASES_ONLY === "1" ? cases.filter(c => c.phase.includes("-aliased-parent")) : cases;
assert(selected.length > 0);
const results: any[] = [];
for (const { phase, signal } of selected) {
  const name = phase + "-" + signal, ledger = path.join(root, "groups." + name), dir = path.join(root, name), project = path.join(dir, "project"), bin = path.join(dir, "bin"), tmp = path.join(dir, "tmp"), lock = path.join(dir, "target-sweep.lock");
  fs.writeFileSync(ledger, "");
  for (const d of [project, bin, tmp, path.join(project, "contracts")]) fs.mkdirSync(d, { recursive: true });
  fs.cpSync(runtime, path.join(project, "seats"), { recursive: true });
  const alias = phase.includes("-aliased-parent"), replacement = phase.endsWith("-replacement");
  const physicalParent = path.join(dir, "physical"), aliasRoot = path.join(dir, "alias"), aliasParent = path.join(aliasRoot, "tmp");
  fs.mkdirSync(physicalParent); fs.mkdirSync(aliasRoot); fs.symlinkSync(physicalParent, aliasParent, "dir");
  const targetLock = alias ? path.join(aliasParent, "target-sweep.lock") : lock;
  const physicalLock = alias ? path.join(physicalParent, "target-sweep.lock") : lock;
  assert(targetLock.startsWith(root + path.sep) && physicalLock.startsWith(root + path.sep));
  if (alias) {
    const helper = path.join(project, "seats/selftest-sweep-lock.ts"), original = fs.readFileSync(helper, "utf8");
    const anchor = '  const [op, lock, pidText, token, owned] = process.argv.slice(2);';
    assert.equal(original.split(anchor).length, 2);
    fs.writeFileSync(helper, original.replace(anchor, anchor + '\n  if (op === "release") fs.appendFileSync(process.env.CANCEL_CASE! + "/release-paths", lock + "\\n");'));
  }
  if (replacement) {
    // Only this copied helper's late release path swaps our private lock.
    // A captured inode/token must never authorize deleting its replacement.
    const helper = path.join(project, "seats/selftest-sweep-lock.ts"), original = fs.readFileSync(helper, "utf8");
    const anchor = '  const [op, lock, pidText, token, owned] = process.argv.slice(2);';
    assert.equal(original.split(anchor).length, 2);
    const hook = `\n  if (op === "release" && !fs.existsSync(process.env.CANCEL_CASE! + "/replacement.json")) {\n    const saved=lock+".original", old=JSON.parse(fs.readFileSync(path.join(lock,"wheelhouse-selftest-sweep"),"utf8"));\n    fs.renameSync(lock,saved); fs.mkdirSync(lock);\n    const m={...old,pid:Number(process.env.CANCEL_CONTROLLER_PID),token:randomUUID().replaceAll("-","")};\n    fs.writeFileSync(path.join(lock,"pid"),String(m.pid)+"\\n");fs.writeFileSync(path.join(lock,"started"),m.started+"\\n");fs.writeFileSync(path.join(lock,"wheelhouse-selftest-sweep"),JSON.stringify(m)+"\\n");\n    const s=fs.statSync(lock,{bigint:true});\n    fs.writeFileSync(process.env.CANCEL_CASE!+"/replacement.json",JSON.stringify({path:lock,identity:String(s.dev)+":"+String(s.ino),members:Object.fromEntries(fs.readdirSync(lock).map(n=>[n,fs.readFileSync(path.join(lock,n),"utf8")]))}));\n  }\n`;
    fs.writeFileSync(helper, original.replace(anchor, anchor + hook));
  }
  const runnerFile = path.join(project, "seats/selftest-sweep.sh"), runnerText = fs.readFileSync(runnerFile, "utf8"), firstLine = runnerText.indexOf("\n") + 1;
  fs.writeFileSync(runnerFile, runnerText.slice(0, firstLine) + 'printf \'%s\\n\' "$$" > "$CANCEL_CASE/runner.pid"\nperl -e \'print getpgrp, "\\n"\' > "$CANCEL_CASE/runner.pgid"\ncat "$CANCEL_CASE/runner.pgid" >> "$CANCEL_GROUP_LEDGER"\n' + runnerText.slice(firstLine));
  // Passive callback after production signal handlers. Old synchronous exits
  // never reach it; new shutdown must allow handlers to return and then join.
  // Do NOT add a HUP listener to old source (that would alter its default exit).
  const verify = path.join(project, "seats/verify.ts"), text = fs.readFileSync(verify, "utf8");
  // Main may select reused batch evidence before the normal dispatcher call.
  // Observe its complete declaration without changing either execution path.
  const anchors = text.match(/^  const sweep = [^\n]*\b(?:runFullSweepIfRequired\(claim, |runDispatcherFullSweep\()repoRoot, tip, realBd, basePath(?:, selectedTier)?(?:, \{ preflightCandidates: batchCandidates \})?\);$/gm) ?? [];
  assert.equal(anchors.length, 1, "one dispatcher sweep declaration");
  const anchor = anchors[0];
  const observed = text.replace(anchor, '  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => fs.writeFileSync(process.env.CANCEL_CASE! + "/handler-returned", sig));\n  fs.appendFileSync(process.env.CANCEL_CASE! + "/steps", "before-sweep\\n");\n' + anchor + '\n  fs.appendFileSync(process.env.CANCEL_CASE! + "/steps", "after-sweep\\n");');
  let instrumented = observed.replace('  const res = await runOneShot(', '  fs.appendFileSync(process.env.CANCEL_CASE! + "/steps", "before-reviewer\\n");\n  const res = await runOneShot(');
  if (process.env.WHEELHOUSE_TEST_VERIFY_CANCEL_EARLY_EXIT === name) {
    const line = instrumented.indexOf("\n") + 1;
    instrumented = instrumented.slice(0, line) + 'fs.writeSync(1, "planted cancellation stdout — retained\\n"); fs.writeSync(2, "planted cancellation stderr — retained\\n"); process.exit(37);\n' + instrumented.slice(line);
  }
  fs.writeFileSync(verify, instrumented);
  fs.writeFileSync(path.join(project, "contracts/REVIEWER.md"), "Inert cancellation reviewer.\n");
  const author = path.join(dir, "author"), reviewer = path.join(dir, "reviewer"); fs.mkdirSync(author); fs.mkdirSync(reviewer); fs.writeFileSync(path.join(reviewer, "auth.json"), '{"fixture":true}\n');
  fs.writeFileSync(path.join(project, "seats/seats.json"), JSON.stringify({ seats: { author: { role: "worker", account: { dir: author } }, reviewer: { role: "reviewer", harness: "pi", provider: "openai", model: "fixture", account: { dir: reviewer } } } }));
  const idle = path.join(dir, "idle.sh");
  fs.writeFileSync(idle, `#!/usr/bin/env bash
set -eu
role="$1"
if [ "$role" = reviewer ] || { [ "$role" = suite ] && [[ "$CANCEL_PHASE" = sweep-stubborn* ]]; }; then trap '' TERM INT HUP; else trap 'echo TERM >> "$CANCEL_CASE/$role.signals"; exit 0' TERM; fi
sleep 600 &
printf '%s\\n' "$!" > "$CANCEL_CASE/$role.sleep.pid"
perl -e 'print getpgrp, "\\n"' > "$CANCEL_CASE/$role.pgid"
cat "$CANCEL_CASE/$role.pgid" >> "$CANCEL_GROUP_LEDGER"
printf '%s\\n' "$$" > "$CANCEL_CASE/$role.pid.new"; mv -f "$CANCEL_CASE/$role.pid.new" "$CANCEL_CASE/$role.pid"
if [ "$role" = reviewer ] && [ "$CANCEL_PHASE" = reviewer-orphan ]; then exit 0; fi
wait
`, { mode: 0o755 });
  // Match the print-mode stdin contract before exercising child lifetime.
  // In particular, the orphan leg must consume its prompt before its leader
  // exits, rather than testing an unread input pipe alongside cancellation.
  fs.writeFileSync(path.join(bin, "pi"), '#!/usr/bin/env bash\nset -eu\nprintf \'entered\\n\' > "$CANCEL_CASE/pi-entered"\ncat > "$CANCEL_CASE/reviewer.prompt"\n[ -s "$CANCEL_CASE/reviewer.prompt" ] || { echo "reviewer fixture requires stdin prompt" >&2; exit 1; }\nexec bash "$CANCEL_IDLE" reviewer\n', { mode: 0o755 });
  // Feed a valid work contract through the existing bd stub, never bypass the gate.
  const contract = path.join(dir, "contract.md");
  fs.writeFileSync(contract, `Trace: Verifier cancellation regression fixture
Signal: isa-gap: K1
Skills: intent@1.0.0 outcomes@1.0.0

Intent:
Stop a cancelled check promptly while leaving unrelated work alone. Callers need to know that its owned processes and temporary state have gone before another check can begin.

Outcomes:
- O1 Cancelling the full seats/*.selftest.sh sweep or review stops only owned processes before releasing its lock and scratch.
  consumer: machine — the cancellation fixture controller
  surface: recorded process groups, exit status, sweep lock and review worktrees
  check: run — signal the active dispatcher and inspect group absence, lock readmission, scratch removal and the live unsignalled foreign canary
`);
  fs.writeFileSync(path.join(bin, "bd"), `#!/usr/bin/env bash
set -eu
[ "\${1:-}" != --readonly ] || shift
printf '%s\\n' "$1" >> "$CANCEL_CASE/bd-calls"
case "$1" in
 show) cat "$CANCEL_CONTRACT" ;;
 metrics) [ "\${2:-}" = off ] ;;
 init) mkdir -p .beads ;;
 where) printf '{"path":"%s/.beads"}\\n' "$PWD" ;;
 *) exit 1 ;;
esac
`, { mode: 0o755 });
  fs.writeFileSync(path.join(project, "seats/selftest-core.list"), "idle.selftest.sh\n");
  fs.writeFileSync(path.join(project, "seats/idle.selftest.sh"), '#!/usr/bin/env bash\nset -eu\n[[ "$CANCEL_PHASE" = sweep* ]] || exit 0\nexec bash "$CANCEL_IDLE" suite\n', { mode: 0o755 });
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, TMPDIR: tmp, HOME: path.join(dir, "home"), CANCEL_CASE: dir, CANCEL_CONTRACT: contract, CANCEL_IDLE: idle, CANCEL_PHASE: phase, CANCEL_GROUP_LEDGER: ledger, CANCEL_CONTROLLER_PID: String(process.pid), WHEELHOUSE_SELFTEST_SWEEP_LOCK: targetLock,
    // The outer host lane may pin its installed helper; these endpoints and
    // alias/replacement instrumentation belong ONLY to this private copy.
    WHEELHOUSE_SELFTEST_SWEEP_LOCK_HELPER: path.join(project, "seats/selftest-sweep-lock.ts") };
  delete env.WHEELHOUSE_SELFTEST_SWEEP_PATTERN;
  // Do not couple reviewer teardown to the runner's deadline grace.
  if (phase === "sweep-stubborn-long-grace") env.WHEELHOUSE_SELFTEST_SUITE_TERM_GRACE_S = "120";
  command("git", ["init", "-q", "-b", "main"], project, env); command("git", ["add", "seats", "contracts"], project, env); command("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"], project, env);
  const child = spawn("bun", [verify, "cancel-fixture", "main", "author", "reviewer"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let ended = false, out = "", err = ""; child.stdout!.on("data", b => out += b); child.stderr!.on("data", b => err += b); child.once("exit", () => ended = true);
  const closed = new Promise<any>((resolve, reject) => { child.once("error", reject); child.once("close", (code, sig) => resolve({ code, signal: sig })); });
  const groups = new Set<number>([child.pid!]); // this controller started that new group
  fs.appendFileSync(ledger, String(child.pid!) + "\n");
  let canary: ReturnType<typeof spawn> | undefined, canaryClosed: Promise<unknown> | undefined, failure: any, failureMessage: string | undefined, retainedDiagnostics: string | undefined, retentionError: string | undefined, measurement: any = {};
  try {
    const role = phase.startsWith("sweep") ? "suite" : "reviewer";
    await until(() => fs.existsSync(path.join(dir, role + ".pid")), () => ended, "idle target");
    const rolePid = Number(fs.readFileSync(path.join(dir, role + ".pid"), "utf8")), sleepPid = Number(fs.readFileSync(path.join(dir, role + ".sleep.pid"), "utf8")), roleGroup = Number(fs.readFileSync(path.join(dir, role + ".pgid"), "utf8"));
    assert(roleGroup > 0); groups.add(roleGroup);
    const scratch = command("git", ["worktree", "list", "--porcelain"], project, env).split("\n").filter(x => x.startsWith("worktree ")).map(x => x.slice(9)).filter(x => path.basename(x).startsWith("wheelhouse-")); assert(scratch.length >= 1);
    const publishedGroups = scratch.flatMap(p => {
      const file = path.join(p, ".wheelhouse-review-groups");
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(Number) : [];
    });
    const runnerPid = Number(fs.readFileSync(path.join(dir, "runner.pid"), "utf8")), runnerGroup = Number(fs.readFileSync(path.join(dir, "runner.pgid"), "utf8")); assert(runnerPid > 0 && runnerGroup > 0); groups.add(runnerGroup);
    if (phase === "reviewer-orphan") await until(() => !pidAlive(rolePid), () => ended, "reviewer leader exit with same-group stub still alive");
    canary = spawn("bash", [idle, "foreign"], { cwd: scratch[0], env, stdio: "ignore", detached: true }); groups.add(canary.pid!); canaryClosed = new Promise(resolve => canary!.once("close", resolve));
    await until(() => fs.existsSync(path.join(dir, "foreign.pid")), () => false, "foreign group canary");
    const canaryGroup = Number(fs.readFileSync(path.join(dir, "foreign.pgid"), "utf8")); assert.equal(canaryGroup, canary.pid); assert.notEqual(canaryGroup, roleGroup); assert.notEqual(canaryGroup, runnerPid);
    // A vanished runner cannot forward TERM or run its watchdog. Its own
    // registry must still let the reviewer reap the separate suite group.
    const runnerKilled = phase.startsWith("sweep-stubborn-runner-killed");
    if (runnerKilled) signalGroup(runnerGroup, "SIGKILL");
    // Signal ONLY the direct dispatcher we started, not its entire group.
    if (phase === "sweep-interrupted") {
      process.kill(runnerPid, signal);
      await until(() => ended || fs.existsSync(path.join(dir, "pi-entered")), () => false, "interrupted sweep exit / forbidden reviewer start");
      // Fix-removed containment only, AFTER retaining the forbidden launch.
      if (!ended) child.kill(signal);
    } else {
      child.kill(signal);
      if (phase === "sweep") {
        try { process.kill(runnerPid, signal); } catch (e: any) { if (e.code !== "ESRCH") throw e; }
      }
    }
    await until(() => ended, () => false, "cancelled dispatcher exit"); const result = await closed;
    const survivors = [rolePid, sleepPid, runnerPid].filter((x): x is number => !!x).filter(pidAlive);
    const listing = command("git", ["worktree", "list", "--porcelain"], project, env), scratchGone = scratch.every(p => !fs.existsSync(p) && !listing.includes("worktree " + p + "\n"));
    const releasedPaths = alias ? fs.readFileSync(path.join(dir, "release-paths"), "utf8").trim().split("\n") : [];
    if (alias) assert(releasedPaths.length > 0 && releasedPaths.every(p => p === physicalLock), "actual release helper must receive the captured physical path");
    const replacementFile = path.join(dir, "replacement.json");
    let replacementUntouched = false;
    if (replacement) {
      assert(fs.existsSync(replacementFile), "late release must actually execute the replacement hook");
      const r = JSON.parse(fs.readFileSync(replacementFile, "utf8")), s = fs.statSync(physicalLock, { bigint: true });
      assert.equal(`${s.dev}:${s.ino}`, r.identity);
      assert.deepEqual(Object.fromEntries(fs.readdirSync(physicalLock).map(n => [n, fs.readFileSync(path.join(physicalLock, n), "utf8")])), r.members);
      replacementUntouched = true;
    }
    const absent = !fs.existsSync(physicalLock); let admitted = false;
    if (absent) { const token = crypto.randomUUID().replace(/-/g, ""), r = spawnSync("bun", [path.join(project, "seats/selftest-sweep-lock.ts"), "acquire", physicalLock, String(process.pid), token, ""], { cwd: project, env, encoding: "utf8" }); admitted = r.status === 0; if (admitted) command("bun", [path.join(project, "seats/selftest-sweep-lock.ts"), "release", physicalLock, String(process.pid), token, r.stdout.trim()], project, env); }
    measurement = { ...result, phase, runnerKilled, requestedSignal: signal, recordedGroup: roleGroup, publishedGroups, runnerPid, runnerGroup, survivors, ownedGroupsGone: !groupAlive(roleGroup) && !groupAlive(runnerGroup), reportedClean: err.includes("owned groups stopped, locks released, scratch removed"), lockRequested: targetLock, physicalLock, releasedPaths, replacementUntouched, lockRefusal: err.includes("SELFTEST_LOCK_REFUSAL"), runnerGrace: phase === "sweep-stubborn-long-grace" ? 120 : 5, scratchGone, lockAbsent: absent, lockAdmitted: admitted, foreignAlive: groupAlive(canaryGroup), foreignSignals: fs.existsSync(path.join(dir, "foreign.signals")) ? fs.readFileSync(path.join(dir, "foreign.signals"), "utf8") : "", handlerReturned: fs.existsSync(path.join(dir, "handler-returned")), stdoutEOF: child.stdout!.readableEnded, stderrEOF: child.stderr!.readableEnded, reviewerStarted: fs.existsSync(path.join(dir, "pi-entered")) || fs.existsSync(path.join(dir, "reviewer.pid")) };
    assert.equal(result.code, signal === "SIGTERM" ? 143 : signal === "SIGINT" ? 130 : 129); assert.equal(result.signal, null); assert(measurement.stdoutEOF && measurement.stderrEOF); assert.deepEqual(survivors, []); assert(measurement.ownedGroupsGone, "all owned groups must be empty before clean stop"); if (phase.startsWith("sweep-stubborn")) assert(publishedGroups.includes(roleGroup), "real runner must publish suite group ownership before payload"); assert(!measurement.lockRefusal, err); assert(scratchGone && (replacement ? replacementUntouched && !absent : absent && admitted)); assert(measurement.foreignAlive && !measurement.foreignSignals); assert.equal(measurement.reviewerStarted, !phase.startsWith("sweep")); if (signal !== "SIGHUP" && phase !== "sweep-interrupted") assert(measurement.handlerReturned, "production handler must return while asynchronous teardown joins children"); assert(err.includes("owned groups stopped, locks released, scratch removed"), err);
    console.log("PASS " + name + " " + JSON.stringify(measurement));
  } catch (e: any) { failure = e.stack ?? String(e); failureMessage = e.message; }
  finally {
    if (failureMessage === "child exited before idle target") {
      try { retainedDiagnostics = retainChildDiagnostics(undefined, name, out, err, child); }
      catch (error) { retentionError = String(error); }
    }
    if (failure) console.error("FAIL " + name + ": " + failureMessage + (failureMessage === "child exited before idle target" ? "; retained child diagnostics: " + JSON.stringify(retainedDiagnostics ?? `UNAVAILABLE: ${retentionError ?? "writer returned no path"}`) : ""));
    fs.writeFileSync(path.join(dir, "out"), out); fs.writeFileSync(path.join(dir, "err"), err);
    const sweepDir = path.join(project, "seats/verdicts/sweeps");
    const stage = { steps: fs.existsSync(path.join(dir, "steps")) ? fs.readFileSync(path.join(dir, "steps"), "utf8") : "", bdCalls: fs.existsSync(path.join(dir, "bd-calls")) ? fs.readFileSync(path.join(dir, "bd-calls"), "utf8") : "", piEntered: fs.existsSync(path.join(dir, "pi-entered")), runnerStarted: fs.existsSync(path.join(dir, "runner.pid")), suiteReady: fs.existsSync(path.join(dir, "suite.pid")), reviewerReady: fs.existsSync(path.join(dir, "reviewer.pid")), sweepLogs: fs.existsSync(sweepDir) ? fs.readdirSync(sweepDir).map(file => ({ file, tail: fs.readFileSync(path.join(sweepDir, file), "utf8").slice(-16000) })) : [] };
    fs.writeFileSync(path.join(dir, "before-cleanup.json"), JSON.stringify({ name, failure: failure ?? null, measurement, dispatcher: { code: child.exitCode, signal: child.signalCode, stdout: out, stderr: err }, stage, groups: [...groups] }, null, 2) + "\n");
    const early = process.env.WHEELHOUSE_VERIFY_CANCEL_EVIDENCE;
    if (early) { fs.mkdirSync(early, { recursive: true }); fs.copyFileSync(path.join(dir, "before-cleanup.json"), path.join(early, name + ".before-cleanup.json")); }
    // Fix-removed cleanup: ONLY recorded groups from processes this fixture
    // started (directly, or its runner's recorded suite group). No searches.
    for (const line of fs.readFileSync(ledger, "utf8").trim().split("\n")) if (/^[1-9][0-9]*$/.test(line)) groups.add(Number(line));
    for (const pgid of groups) if (groupAlive(pgid)) signalGroup(pgid, "SIGKILL");
    await closed; await canaryClosed;
    await until(() => [...groups].every(g => !groupAlive(g)), () => false, "recorded fixture groups reaped");
    fs.unlinkSync(ledger);
    if (retainedDiagnostics) {
      try { retainedDiagnostics = retainChildDiagnostics(retainedDiagnostics, name, out, err, child); }
      catch (error) { retentionError = String(error); console.error(`FAIL ${name}: retained child diagnostics update failed: ${retentionError}`); }
    }
    fs.writeFileSync(path.join(dir, "out"), out); fs.writeFileSync(path.join(dir, "err"), err); const record = { name, failure: failure ?? null, measurement, retainedDiagnostics, retentionError, dispatcher: { code: child.exitCode, signal: child.signalCode, stdoutEOF: child.stdout!.readableEnded, stderrEOF: child.stderr!.readableEnded } }; fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(record, null, 2) + "\n"); results.push(record);
  }
}
fs.writeFileSync(path.join(root, "completed.json"), JSON.stringify(results, null, 2) + "\n");
const dest = process.env.WHEELHOUSE_VERIFY_CANCEL_EVIDENCE;
if (dest) { fs.mkdirSync(dest, { recursive: true }); for (const r of results) { fs.mkdirSync(path.join(dest, r.name)); for (const f of ["out", "err", "result.json"]) fs.copyFileSync(path.join(root, r.name, f), path.join(dest, r.name, f)); } fs.copyFileSync(path.join(root, "completed.json"), path.join(dest, "completed.json")); }
const failed = results.filter(x => x.failure).length; console.log(`verify-cancellation: ${results.length - failed}/${results.length} passed`); process.exitCode = failed ? 1 : 0;
