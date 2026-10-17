// Real verify + runner/helper, one idle stub suite. The inner review uses an
// isolated target lock; this test's outer canonical host lock remains held.
// No process-table/environment/cwd/argv ownership probing, no group escapes.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
const root = path.resolve(process.argv[2]), runtime = path.join(root, "runtime/seats");
const groupAlive = (pgid: number) => { assert(Number.isInteger(pgid) && pgid > 1); try { process.kill(-pgid, 0); return true; } catch (e: any) { if (e.code === "ESRCH") return false; if (e.code === "EPERM") return true; throw e; } };
const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e: any) { if (e.code === "ESRCH") return false; throw e; } };
function signalGroup(pgid: number, signal: NodeJS.Signals) { assert(Number.isInteger(pgid) && pgid > 1); try { process.kill(-pgid, signal); } catch (e: any) { if (e.code !== "ESRCH") throw e; } }
async function until(test: () => boolean, ended: () => boolean, label: string) {
  const limit = performance.now() + 60000; // incomplete-test guard, not a pass threshold
  while (!test()) { if (ended()) throw Error("child exited before " + label); if (performance.now() > limit) throw Error("INCOMPLETE fixture join: " + label); await Bun.sleep(50); }
}
function command(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) { const r = spawnSync(bin, args, { cwd, env, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout; }
const cases = ["sweep", "reviewer"].flatMap(phase => (["SIGTERM", "SIGINT", "SIGHUP"] as const).map(signal => ({ phase, signal })));
cases.push({ phase: "reviewer-orphan", signal: "SIGTERM" });
cases.push(...(["SIGTERM", "SIGINT", "SIGHUP"] as const).map(signal => ({ phase: "sweep-stubborn", signal })));
cases.push({ phase: "sweep-stubborn-long-grace", signal: "SIGTERM" });
cases.push({ phase: "sweep-stubborn-runner-killed", signal: "SIGTERM" });
const results: any[] = [];
for (const { phase, signal } of cases) {
  const name = phase + "-" + signal, ledger = path.join(root, "groups." + name), dir = path.join(root, name), project = path.join(dir, "project"), bin = path.join(dir, "bin"), tmp = path.join(dir, "tmp"), lock = path.join(dir, "target-sweep.lock");
  fs.writeFileSync(ledger, "");
  for (const d of [project, bin, tmp, path.join(project, "contracts")]) fs.mkdirSync(d, { recursive: true });
  fs.cpSync(runtime, path.join(project, "seats"), { recursive: true });
  const runnerFile = path.join(project, "seats/selftest-sweep.sh"), runnerText = fs.readFileSync(runnerFile, "utf8"), firstLine = runnerText.indexOf("\n") + 1;
  fs.writeFileSync(runnerFile, runnerText.slice(0, firstLine) + 'printf \'%s\\n\' "$$" > "$CANCEL_CASE/runner.pid"\nperl -e \'print getpgrp, "\\n"\' > "$CANCEL_CASE/runner.pgid"\ncat "$CANCEL_CASE/runner.pgid" >> "$CANCEL_GROUP_LEDGER"\n' + runnerText.slice(firstLine));
  // Passive callback after production signal handlers. Old synchronous exits
  // never reach it; new shutdown must allow handlers to return and then join.
  // Do NOT add a HUP listener to old source (that would alter its default exit).
  const verify = path.join(project, "seats/verify.ts"), text = fs.readFileSync(verify, "utf8"), anchor = "  const sweep = await runFullSweepIfRequired(claim, repoRoot, tip, realBd, basePath);";
  assert.equal(text.split(anchor).length, 2);
  const observed = text.replace(anchor, '  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => fs.writeFileSync(process.env.CANCEL_CASE! + "/handler-returned", sig));\n  fs.appendFileSync(process.env.CANCEL_CASE! + "/steps", "before-sweep\\n");\n' + anchor + '\n  fs.appendFileSync(process.env.CANCEL_CASE! + "/steps", "after-sweep\\n");');
  fs.writeFileSync(verify, observed.replace('  const res = await runOneShot(', '  fs.appendFileSync(process.env.CANCEL_CASE! + "/steps", "before-reviewer\\n");\n  const res = await runOneShot('));
  fs.writeFileSync(path.join(project, "contracts/REVIEWER.md"), "Inert cancellation reviewer.\n");
  const author = path.join(dir, "author"), reviewer = path.join(dir, "reviewer"); fs.mkdirSync(author); fs.mkdirSync(reviewer); fs.writeFileSync(path.join(reviewer, "auth.json"), '{"fixture":true}\n');
  fs.writeFileSync(path.join(project, "seats/seats.json"), JSON.stringify({ seats: { author: { role: "worker", account: { dir: author } }, reviewer: { role: "verifier", harness: "pi", provider: "openai", model: "fixture", account: { dir: reviewer } } } }));
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
  fs.writeFileSync(path.join(bin, "pi"), '#!/usr/bin/env bash\nprintf \'entered\\n\' > "$CANCEL_CASE/pi-entered"\nexec bash "$CANCEL_IDLE" reviewer\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "bd"), `#!/usr/bin/env bash
set -eu
[ "\${1:-}" != --readonly ] || shift
printf '%s\\n' "$1" >> "$CANCEL_CASE/bd-calls"
case "$1" in
 show) printf '## Done\\nFull sweep passes\\n' ;;
 init) mkdir -p .beads ;;
 where) printf '{"path":"%s/.beads"}\\n' "$PWD" ;;
 *) exit 1 ;;
esac
`, { mode: 0o755 });
  fs.writeFileSync(path.join(project, "seats/idle.selftest.sh"), '#!/usr/bin/env bash\nset -eu\n[[ "$CANCEL_PHASE" = sweep* ]] || exit 0\nexec bash "$CANCEL_IDLE" suite\n', { mode: 0o755 });
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, TMPDIR: tmp, HOME: path.join(dir, "home"), CANCEL_CASE: dir, CANCEL_IDLE: idle, CANCEL_PHASE: phase, CANCEL_GROUP_LEDGER: ledger, WHEELHOUSE_SELFTEST_SWEEP_LOCK: lock };
  delete env.WHEELHOUSE_SELFTEST_SWEEP_PATTERN;
  // Do not couple verifier teardown to the runner's deadline grace.
  if (phase === "sweep-stubborn-long-grace") env.WHEELHOUSE_SELFTEST_SUITE_TERM_GRACE_S = "120";
  command("git", ["init", "-q", "-b", "main"], project, env); command("git", ["add", "seats", "contracts"], project, env); command("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"], project, env);
  const child = spawn("bun", [verify, "cancel-fixture", "main", "author", "reviewer"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let ended = false, out = "", err = ""; child.stdout!.on("data", b => out += b); child.stderr!.on("data", b => err += b); child.once("exit", () => ended = true);
  const closed = new Promise<any>((resolve, reject) => { child.once("error", reject); child.once("close", (code, sig) => resolve({ code, signal: sig })); });
  const groups = new Set<number>([child.pid!]); // this controller started that new group
  fs.appendFileSync(ledger, String(child.pid!) + "\n");
  let canary: ReturnType<typeof spawn> | undefined, canaryClosed: Promise<unknown> | undefined, failure: any, measurement: any = {};
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
    // registry must still let the verifier reap the separate suite group.
    const runnerKilled = phase === "sweep-stubborn-runner-killed";
    if (runnerKilled) signalGroup(runnerGroup, "SIGKILL");
    // Signal ONLY the direct dispatcher we started, not its entire group.
    child.kill(signal);
    await until(() => ended, () => false, "cancelled dispatcher exit"); const result = await closed;
    const survivors = [rolePid, sleepPid, runnerPid].filter((x): x is number => !!x).filter(pidAlive);
    const listing = command("git", ["worktree", "list", "--porcelain"], project, env), scratchGone = scratch.every(p => !fs.existsSync(p) && !listing.includes("worktree " + p + "\n"));
    const absent = !fs.existsSync(lock); let admitted = false;
    if (absent) { const token = crypto.randomUUID().replace(/-/g, ""), r = spawnSync("bun", [path.join(project, "seats/selftest-sweep-lock.ts"), "acquire", lock, String(process.pid), token, ""], { cwd: project, env, encoding: "utf8" }); admitted = r.status === 0; if (admitted) command("bun", [path.join(project, "seats/selftest-sweep-lock.ts"), "release", lock, String(process.pid), token, r.stdout.trim()], project, env); }
    measurement = { ...result, phase, runnerKilled, requestedSignal: signal, recordedGroup: roleGroup, publishedGroups, runnerPid, runnerGroup, survivors, ownedGroupsGone: !groupAlive(roleGroup) && !groupAlive(runnerGroup), reportedClean: err.includes("owned groups stopped, locks released, scratch removed"), runnerGrace: phase === "sweep-stubborn-long-grace" ? 120 : 5, scratchGone, lockAbsent: absent, lockAdmitted: admitted, foreignAlive: groupAlive(canaryGroup), foreignSignals: fs.existsSync(path.join(dir, "foreign.signals")) ? fs.readFileSync(path.join(dir, "foreign.signals"), "utf8") : "", handlerReturned: fs.existsSync(path.join(dir, "handler-returned")), stdoutEOF: child.stdout!.readableEnded, stderrEOF: child.stderr!.readableEnded, reviewerStarted: fs.existsSync(path.join(dir, "reviewer.pid")) };
    assert.equal(result.code, signal === "SIGTERM" ? 143 : signal === "SIGINT" ? 130 : 129); assert.equal(result.signal, null); assert(measurement.stdoutEOF && measurement.stderrEOF); assert.deepEqual(survivors, []); assert(measurement.ownedGroupsGone, "all owned groups must be empty before clean stop"); if (phase.startsWith("sweep-stubborn")) assert(publishedGroups.includes(roleGroup), "real runner must publish suite group ownership before payload"); assert(scratchGone && absent && admitted); assert(measurement.foreignAlive && !measurement.foreignSignals); assert.equal(measurement.reviewerStarted, !phase.startsWith("sweep")); if (signal !== "SIGHUP") assert(measurement.handlerReturned, "production handler must return while asynchronous teardown joins children"); assert(err.includes("owned groups stopped, locks released, scratch removed"), err);
    console.log("PASS " + name + " " + JSON.stringify(measurement));
  } catch (e: any) { failure = e.stack ?? String(e); console.error("FAIL " + name + ": " + e.message); }
  finally {
    fs.writeFileSync(path.join(dir, "out"), out); fs.writeFileSync(path.join(dir, "err"), err);
    const sweepDir = path.join(project, "seats/verdicts/sweeps");
    const stage = { steps: fs.existsSync(path.join(dir, "steps")) ? fs.readFileSync(path.join(dir, "steps"), "utf8") : "", bdCalls: fs.existsSync(path.join(dir, "bd-calls")) ? fs.readFileSync(path.join(dir, "bd-calls"), "utf8") : "", piEntered: fs.existsSync(path.join(dir, "pi-entered")), runnerStarted: fs.existsSync(path.join(dir, "runner.pid")), suiteReady: fs.existsSync(path.join(dir, "suite.pid")), reviewerReady: fs.existsSync(path.join(dir, "reviewer.pid")), sweepLogs: fs.existsSync(sweepDir) ? fs.readdirSync(sweepDir).map(file => ({ file, tail: fs.readFileSync(path.join(sweepDir, file), "utf8").slice(-16000) })) : [] };
    fs.writeFileSync(path.join(dir, "before-cleanup.json"), JSON.stringify({ name, failure: failure ?? null, measurement, stage, groups: [...groups] }, null, 2) + "\n");
    const early = process.env.WHEELHOUSE_VERIFY_CANCEL_EVIDENCE;
    if (early) { fs.mkdirSync(early, { recursive: true }); fs.copyFileSync(path.join(dir, "before-cleanup.json"), path.join(early, name + ".before-cleanup.json")); }
    // Fix-removed cleanup: ONLY recorded groups from processes this fixture
    // started (directly, or its runner's recorded suite group). No searches.
    for (const line of fs.readFileSync(ledger, "utf8").trim().split("\n")) if (/^[1-9][0-9]*$/.test(line)) groups.add(Number(line));
    for (const pgid of groups) if (groupAlive(pgid)) signalGroup(pgid, "SIGKILL");
    await closed; await canaryClosed;
    await until(() => [...groups].every(g => !groupAlive(g)), () => false, "recorded fixture groups reaped");
    fs.unlinkSync(ledger);
    fs.writeFileSync(path.join(dir, "out"), out); fs.writeFileSync(path.join(dir, "err"), err); const record = { name, failure: failure ?? null, measurement }; fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(record, null, 2) + "\n"); results.push(record);
  }
}
fs.writeFileSync(path.join(root, "completed.json"), JSON.stringify(results, null, 2) + "\n");
const dest = process.env.WHEELHOUSE_VERIFY_CANCEL_EVIDENCE;
if (dest) { fs.mkdirSync(dest, { recursive: true }); for (const r of results) { fs.mkdirSync(path.join(dest, r.name)); for (const f of ["out", "err", "result.json"]) fs.copyFileSync(path.join(root, r.name, f), path.join(dest, r.name, f)); } fs.copyFileSync(path.join(root, "completed.json"), path.join(dest, "completed.json")); }
const failed = results.filter(x => x.failure).length; console.log(`verify-cancellation: ${results.length - failed}/${results.length} passed`); process.exitCode = failed ? 1 : 0;
