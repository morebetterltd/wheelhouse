// Actual detached worktree + real runner, with two tiny payloads and a bd
// protocol stub. `bd where --json` was captured before building the stub:
// database_path/path/prefix/schema_version; the shared launcher consumes path.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
const [here, owned] = process.argv.slice(2);
assert(fs.statSync(path.join(owned, ".wheelhouse-selftest-fixture")).isFile());
const base = path.join(owned, "nightly-native"); fs.mkdirSync(base);
const repo = path.join(base, "project"), bin = path.join(base, "bin"), tmp = path.join(base, "tmp"), unrelated = path.join(base, "elsewhere");
for (const dir of [path.join(repo, "seats"), path.join(repo, "wheelhouse"), bin, tmp, unrelated]) fs.mkdirSync(dir, { recursive: true });
for (const f of fs.readdirSync(here)) if (/\.(ts|sh)$/.test(f) && !f.endsWith(".selftest.sh") && fs.statSync(path.join(here, f)).isFile()) fs.copyFileSync(path.join(here, f), path.join(repo, "seats", f));
const realGit = execFileSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).trim(); assert(fs.statSync(realGit).isFile());
const env = { ...process.env, TMPDIR: tmp, WHEELHOUSE_NIGHTLY_ROOT: repo, WHEELHOUSE_REAL_BD: path.join(bin, "bd"), WHEELHOUSE_SELFTEST_SWEEP_LOCK: path.join(base, "host.lock"), WHEELHOUSE_SELFTEST_SWEEP_PATTERN: "tiny-green.selftest.sh tiny-red.selftest.sh", WHEELHOUSE_SKIP_REAL_PI: "1", NIGHTLY_TEST_TRACE: path.join(base, "bd.jsonl") };
for (const key of ["WHEELHOUSE_SUPERVISOR_PAUSE_FILE", "WHEELHOUSE_SUPERVISOR_NOW", "BASH_ENV", "ENV"]) delete env[key];
const git = (...args: string[]) => execFileSync(realGit, ["-C", repo, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
fs.writeFileSync(path.join(bin, "bd"), `#!/usr/bin/env bun
import fs from "node:fs";import path from "node:path";
const [cmd]=process.argv.slice(2);fs.appendFileSync(process.env.NIGHTLY_TEST_TRACE,JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),home:process.env.HOME})+"\\n");
if(cmd==="metrics")process.exit(0);
if(cmd==="init"){fs.mkdirSync(process.env.BEADS_DIR,{recursive:true});process.exit(0);}
if(cmd==="where"){console.log(JSON.stringify({path:fs.realpathSync(path.join(process.cwd(),".beads"))}));process.exit(0);}
throw new Error("unexpected fixture bd command "+cmd);
`, { mode: 0o755 });
fs.writeFileSync(path.join(repo, ".gitignore"), "seats/run/\nseats/logs/\nseats/verdicts/\nwheelhouse/.template-source\n");
fs.writeFileSync(path.join(repo, "seats/selftest-core.list"), "tiny-green.selftest.sh\n");
fs.writeFileSync(path.join(repo, "seats/tiny-green.selftest.sh"), "#!/bin/bash\nif [ \"${WHEELHOUSE_SELFTEST_SWEEP_NO_WAIT+set}\" = set ]; then printf 'admission flag leaked to suite\\n'; exit 9; fi\nprintf 'tiny green native PASS\\n'\n");
fs.writeFileSync(path.join(repo, "seats/tiny-red.selftest.sh"), "#!/bin/bash\nprintf 'tiny red native failure\\n'\nexit 7\n");
git("init", "-q", "-b", "main"); git("add", "."); git("commit", "-qm", "two native nightly subjects"); const main = git("rev-parse", "HEAD");
git("checkout", "-qb", "working-not-default"); fs.writeFileSync(path.join(repo, "seats/tiny-red.selftest.sh"), "#!/bin/bash\nprintf 'tiny repaired native PASS\\n'\n"); git("add", "."); git("commit", "-qm", "working branch must not be the default nightly target"); const working = git("rev-parse", "HEAD"); git("branch", "staging", working);
const state = await import(pathToFileURL(path.join(repo, "seats/nightly-state.ts")).href);
const output = path.join(repo, "seats/run/nightly-sweep.json"), missed = path.join(repo, "seats/run/nightly-sweep-missed.json");
const read = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));
let serial = 0, clockMs = Date.UTC(2025, 11, 31, 3);
function cli(label: string, script = "nightly-sweep.ts", extra: Record<string, string> = {}) {
  // One monotonic fixture clock: mixing a real-clock pause with a February
  // green would correctly leave the newer missed alert active.
  const clock = extra.WHEELHOUSE_SUPERVISOR_NOW || new Date(clockMs + 86400000).toISOString();
  assert(Date.parse(clock) >= clockMs); clockMs = Date.parse(clock);
  const r = spawnSync("bun", [path.join(repo, "seats", script)], { cwd: unrelated, env: { ...env, WHEELHOUSE_SUPERVISOR_NOW: clock, ...extra }, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  assert.ifError(r.error); assert.equal(r.signal, null); fs.writeFileSync(path.join(base, `${++serial}-${label}.stdout`), r.stdout); fs.writeFileSync(path.join(base, `${serial}-${label}.stderr`), r.stderr); return r;
}
const worktrees = () => git("worktree", "list", "--porcelain").split("\n").filter(s => s.startsWith("worktree ")).map(s => s.slice(9));
const originalRefs = git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads");
const dirty = path.join(repo, "keep-dirty.txt"); fs.writeFileSync(dirty, "caller-owned uncommitted content\n");
const red = cli("red", "nightly-sweep.ts", { WHEELHOUSE_SUPERVISOR_NOW: "2026-01-01T03:00:00Z" }); assert.equal(red.status, 1, red.stderr + red.stdout);
const first = read(output); assert.equal(first.tip, main); assert.equal(first.rc, 1); assert.deepEqual(first.failedSuites, ["tiny-red.selftest.sh"]);
assert.match(path.basename(first.logPath), new RegExp(`^nightly\\.${main}\\.[1-9][0-9]*\\.[0-9]+\\.selftest-sweep\\.log$`)); assert(fs.statSync(first.logPath).size > 0);
const native = fs.readFileSync(first.logPath, "utf8"); fs.writeFileSync(path.join(base, "native-red-capture.log"), native);
assert(native.includes("command=bash seats/selftest-sweep.sh --tier full\ntier=full reason=nightly\n")); assert(native.includes("selftest-sweep: FAIL (1 failure(s) of 2 suite(s),"));
assert.deepEqual(worktrees(), [repo]); assert.equal(fs.readFileSync(dirty, "utf8"), "caller-owned uncommitted content\n"); assert.equal(git("rev-parse", "HEAD"), working); assert.equal(git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"), originalRefs);
const trace = fs.readFileSync(env.NIGHTLY_TEST_TRACE, "utf8").trim().split("\n").map(s => JSON.parse(s)); assert.deepEqual(trace.slice(0, 3).map(r => r.args[0]), ["metrics", "init", "where"]); assert(trace.every(r => r.home.startsWith(tmp + path.sep) && r.home.endsWith("/home")));
console.log("PASS actual nightly red: main tip, detached scratch, two full-tier subjects, exact failed name/log filename, private metrics-first graph and no scratch/ref/HEAD residue");
// Force failure at the publication boundary: the prior complete JSON must stay
// intact and the exclusive temp must be removed. A direct-write mutant fails.
const priorBytes = fs.readFileSync(output), replacement = { ...first, rc: 0, failedSuites: [] }, rename = fs.renameSync;
let atBoundary = false;
fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => { if (String(to) === output) { atBoundary = true; throw new Error("fixture rename boundary failure"); } return rename(from, to); }) as typeof fs.renameSync;
try { assert.throws(() => state.writeNightlyJson(output, replacement), /fixture rename boundary failure/); assert(atBoundary); assert.deepEqual(fs.readFileSync(output), priorBytes); assert(!fs.readdirSync(path.dirname(output)).some(n => n.startsWith("nightly-sweep.json.tmp."))); }
finally { fs.renameSync = rename; }
const stateSource = fs.readFileSync(path.join(repo, "seats/nightly-state.ts"), "utf8"), renameLine = "    fs.renameSync(tmp, file);"; assert.equal(stateSource.split(renameLine).length, 2);
const nonAtomicFile = path.join(repo, "seats/nightly-state-nonatomic.ts"); fs.writeFileSync(nonAtomicFile, stateSource.replace(renameLine, "    fs.writeFileSync(file, fs.readFileSync(tmp)); // removed atomic publish")); const nonAtomic = await import(pathToFileURL(nonAtomicFile).href);
atBoundary = false; fs.renameSync = (() => { atBoundary = true; throw new Error("fixture rename boundary failure"); }) as typeof fs.renameSync;
try { nonAtomic.writeNightlyJson(output, replacement); assert.equal(atBoundary, false); assert.notDeepEqual(fs.readFileSync(output), priorBytes); }
finally { fs.renameSync = rename; fs.writeFileSync(output, priorBytes); }
console.log("PASS nightly atomic publication: injected rename failure retains prior complete result and removes temp; direct-write removal changes the result and fails that criterion");
// A missed run must keep the last full result, not erase a red brake.
const token = randomUUID().replaceAll("-", ""), helper = path.join(repo, "seats/selftest-sweep-lock.ts"), lock = env.WHEELHOUSE_SELFTEST_SWEEP_LOCK;
const identity = execFileSync("bun", [helper, "acquire", lock, String(process.pid), token, ""], { env, encoding: "utf8" }).trim();
try {
  const marker = fs.readFileSync(path.join(lock, "wheelhouse-selftest-sweep"));
  const busy = cli("busy", "nightly-sweep.ts", { WHEELHOUSE_SUPERVISOR_NOW: "2026-01-02T03:00:00Z" }); assert.equal(busy.status, 75, busy.stderr + busy.stdout);
  assert(read(missed).reason.includes("host sweep lock busy")); assert.deepEqual(read(output), first); assert.equal(state.nightlyBrake(repo), `nightly red ${first.date} ${main}`); assert.deepEqual(fs.readFileSync(path.join(lock, "wheelhouse-selftest-sweep")), marker);
} finally { execFileSync("bun", [helper, "release", lock, String(process.pid), token, identity], { env }); }
fs.writeFileSync(path.join(repo, "seats/run/paused"), "fixture\n"); assert.equal(cli("pause").status, 75); fs.unlinkSync(path.join(repo, "seats/run/paused")); assert(read(missed).reason.includes("pause marker")); assert.deepEqual(read(output), first);
console.log("PASS nightly busy/pause miss: last red result/brake preserved, holder untouched and no scratch launch");
const partialRed = cli("filtered-after-red", "nightly-sweep.ts", { WHEELHOUSE_SELFTEST_SWEEP_PATTERN: "tiny-green.selftest.sh" }); assert.equal(partialRed.status, 0, partialRed.stderr + partialRed.stdout); assert.equal(read(output).filtered, true); assert.deepEqual(read(output).lastCompleted, first); assert.equal(state.nightlyBrake(repo), `nightly red ${first.date} ${main}`); assert.equal(state.nightlyConditions(repo).red.on, true);
console.log("PASS filtered rc0 after red preserves the last completed result, original red reason and red alert");
fs.writeFileSync(path.join(repo, "wheelhouse/.template-source"), "merge-target=staging\n");
const green = cli("green", "nightly-sweep.ts", { WHEELHOUSE_SUPERVISOR_NOW: "2026-02-01T03:00:00Z" }); assert.equal(green.status, 0, green.stderr + green.stdout); const good = read(output); assert.equal(good.tip, working); assert.equal(good.rc, 0); assert.deepEqual(good.failedSuites, []); assert.equal(state.nightlyBrake(repo), null); assert.equal(state.nightlyConditions(repo).unavailable.on, false); assert.deepEqual(worktrees(), [repo]);
// Real Git scratch failure, not a guessed stderr fixture: make worktrees a file.
const worktreeAdmin = path.join(repo, ".git/worktrees");
if (fs.existsSync(worktreeAdmin)) { assert.equal(fs.readdirSync(worktreeAdmin).length, 0); fs.rmdirSync(worktreeAdmin); }
fs.writeFileSync(worktreeAdmin, "fixture obstacle\n");
try { const r = cli("scratch-failure"); assert.equal(r.status, 2); assert(read(missed).reason.includes("could not create a detached scratch worktree")); assert.deepEqual(read(output), good); }
finally { fs.unlinkSync(worktreeAdmin); }
console.log("PASS configured default line green clears brake/missed; real scratch failure raises missed without replacing completed result");
// State belongs to the install, even when the default line belongs to a
// separate product. Resolve a present remote ref only as local fallback.
const container = path.join(base, "container"); fs.mkdirSync(path.join(container, "wheelhouse"), { recursive: true });
fs.writeFileSync(path.join(container, "wheelhouse/.template-source"), "product-repo=../project\nmerge-target=staging\n");
const api = await import(pathToFileURL(path.join(repo, "seats/nightly-sweep.ts")).href);
assert.deepEqual(api.nightlyTarget(container), { repo, branch: "staging", tip: working });
const product = cli("product-root", "nightly-sweep.ts", { WHEELHOUSE_NIGHTLY_ROOT: container }); assert.equal(product.status, 0, product.stderr + product.stdout); assert.equal(read(path.join(container, "seats/run/nightly-sweep.json")).tip, working);
git("update-ref", "refs/remotes/origin/remote-only", working);
fs.writeFileSync(path.join(container, "wheelhouse/.template-source"), "product-repo=../project\nmerge-target=remote-only\n"); assert.deepEqual(api.nightlyTarget(container), { repo, branch: "remote-only", tip: working });
const linked = path.join(base, "linked-product"); git("worktree", "add", "--detach", linked, working); fs.mkdirSync(path.join(linked, "plain-subdir"));
try {
  const linkedEnv = { ...env }; delete linkedEnv.WHEELHOUSE_NIGHTLY_ROOT;
  const r = spawnSync("bun", [path.join(linked, "seats/nightly-sweep.ts")], { cwd: path.join(linked, "plain-subdir"), env: linkedEnv, encoding: "utf8" }); assert.ifError(r.error); assert.equal(r.status, 1, r.stderr + r.stdout);
  const value = read(path.join(linked, "seats/run/nightly-sweep.json")); assert.equal(value.tip, main); fs.copyFileSync(value.logPath, path.join(base, "linked-native.log")); assert.deepEqual(worktrees().sort(), [repo, linked].sort());
} finally { git("worktree", "remove", "--force", linked); }
assert.deepEqual(worktrees(), [repo]);
console.log("PASS target configurations: unrelated caller cwd, dirty topic checkout, configured product/install roots, present remote fallback, and nightly from a linked worktree subdirectory");
const filtered = cli("filtered", "nightly-sweep.ts", { WHEELHOUSE_SELFTEST_SWEEP_PATTERN: "tiny-green.selftest.sh" }); assert.equal(filtered.status, 0, filtered.stderr + filtered.stdout); assert.equal(read(output).filtered, true); assert(state.nightlyBrake(repo).startsWith("nightly filtered ")); assert.equal(state.nightlyConditions(repo).unavailable.on, true);
const recovered = cli("unfiltered-recovery"); assert.equal(recovered.status, 0, recovered.stderr + recovered.stdout); assert.notEqual(read(output).filtered, true); assert.equal(state.nightlyBrake(repo), null); assert.equal(state.nightlyConditions(repo).unavailable.on, false);
console.log("PASS filtered fixture result cannot release brake; later unfiltered completed green releases it");
// Sensitive removals run the actual CLI; their observable result violates the
// positive criterion rather than merely matching an implementation string.
const entry = fs.readFileSync(path.join(repo, "seats/nightly-sweep.ts"), "utf8");
const once = (s: string, old: string, next: string) => { assert.equal(s.split(old).length, 2, old); return s.replace(old, next); };
function mutant(label: string, old: string, next: string) { const file = `nightly-${label}.ts`; fs.writeFileSync(path.join(repo, "seats", file), once(entry, old, next)); return file; }
const noFilterLabel = mutant("no-filter-label", '    const filtered = expected.length !== actual.length || expected.some((name, i) => name !== actual[i]);', '    const filtered = false; // removed filtered-receipt guard');
assert.equal(cli("removed-filter-label", noFilterLabel, { WHEELHOUSE_SELFTEST_SWEEP_PATTERN: "tiny-green.selftest.sh" }).status, 0); assert.notEqual(read(output).filtered, true); assert.equal(state.nightlyBrake(repo), null);
fs.writeFileSync(path.join(repo, "wheelhouse/.template-source"), "merge-target=main\n");
const current = mutant("current-head", '  const branch = sourceValue(root, "merge-target") || "main";', '  const branch = git(repo, "branch", "--show-current");'); assert.equal(cli("removed-default", current).status, 0); assert.equal(read(output).tip, working); assert.notEqual(read(output).tip, main);
const coreHash = createHash("sha256").update(fs.readFileSync(path.join(repo, "seats/selftest-core.list"))).digest("hex");
const core = mutant("core-only", '{ tier: "full", reason: "nightly" }', `{ tier: "core", reason: "nightly", manifest: { suites: ["tiny-green.selftest.sh"], sha256: "${coreHash}" } }`); assert.equal(cli("removed-full", core).status, 0); assert(!fs.readFileSync(read(output).logPath, "utf8").includes("tier=full reason=nightly"));
const prefix = mutant("no-prefix", 'logPrefix: "nightly."', 'logPrefix: ""'); assert.equal(cli("removed-prefix", prefix).status, 1); assert(!path.basename(read(output).logPath).startsWith("nightly."));
const noRecord = mutant("no-record", '    writeNightlyJson(nightlyPath(root), record); finished = true;', '    void record; finished = true;'); fs.unlinkSync(output); assert.equal(cli("removed-record", noRecord).status, 1); assert(!fs.existsSync(output));
const verifyFile = path.join(repo, "seats/verify.ts"), verify = fs.readFileSync(verifyFile, "utf8");
fs.writeFileSync(verifyFile, once(verify, 'function removeScratchWorktree(repoRoot: string, dir: string): void {', 'function removeScratchWorktree(repoRoot: string, dir: string): void { return; // removed teardown'));
try { assert.equal(cli("removed-cleanup").status, 1); const residue = worktrees().filter(p => p !== repo); assert.equal(residue.length, 1); assert(residue.every(p => p.startsWith(tmp + path.sep))); for (const dir of residue) git("worktree", "remove", "--force", dir); }
finally { fs.writeFileSync(verifyFile, verify); }
assert.equal(state.nightlyConditions(repo).red.on, true);
const noPrevious = mutant("no-previous-full", '    const previous = filtered ? completedNightly(readNightlyResult(root).value) : null;', '    const previous = null; // removed last completed result preservation');
assert.equal(cli("removed-previous-full", noPrevious, { WHEELHOUSE_SELFTEST_SWEEP_PATTERN: "tiny-green.selftest.sh" }).status, 0); assert.equal(state.nightlyConditions(repo).red.on, false); assert(state.nightlyBrake(repo).startsWith("nightly filtered "));
console.log("PASS nightly removal controls: current-HEAD target, core-only launch, missing log prefix/JSON, disabled scratch teardown and dropped prior-full preservation each violate its criterion");
// The admission race is guarded by the runner, not a non-atomic exists check.
// Hold a genuine token-owned fixture lock, then compare no-wait with its removal.
const token2 = randomUUID().replaceAll("-", ""), identity2 = execFileSync("bun", [helper, "acquire", lock, String(process.pid), token2, ""], { env, encoding: "utf8" }).trim();
let held = true;
try {
  const before = fs.readFileSync(path.join(lock, "wheelhouse-selftest-sweep"));
  const r = spawnSync("bash", [path.join(repo, "seats/selftest-sweep.sh"), "--tier", "full"], { cwd: repo, env: { ...env, WHEELHOUSE_SELFTEST_SWEEP_PATTERN: path.join(repo, "seats/tiny-green.selftest.sh"), WHEELHOUSE_SELFTEST_SWEEP_NO_WAIT: "1" }, encoding: "utf8" });
  assert.ifError(r.error); assert.equal(r.status, 75, r.stderr + r.stdout); assert(r.stderr.includes("selftest-sweep: SKIP lock busy")); assert(!r.stdout.includes("selftest-sweep: START ")); assert.deepEqual(fs.readFileSync(path.join(lock, "wheelhouse-selftest-sweep")), before);
  const queued = () => fs.readdirSync(lock + ".queue").flatMap(f => { try { return [JSON.parse(fs.readFileSync(path.join(lock + ".queue", f), "utf8"))]; } catch { return []; } });
  assert.deepEqual(queued().filter(r => typeof r.pid === "number").map(r => r.pid), [process.pid]);
  const runner = fs.readFileSync(path.join(repo, "seats/selftest-sweep.sh"), "utf8"), canary = path.join(repo, "seats/removed-no-wait.sh");
  fs.writeFileSync(canary, once(runner, 'if [ "${WHEELHOUSE_SELFTEST_SWEEP_NO_WAIT:-0}" = 1 ]; then', 'if false; then # removed nightly no-wait'));
  const child = spawn("bash", [canary, "--tier", "full"], { cwd: repo, env: { ...env, WHEELHOUSE_SELFTEST_SWEEP_PATTERN: path.join(repo, "seats/tiny-green.selftest.sh"), WHEELHOUSE_SELFTEST_SWEEP_NO_WAIT: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", closed = false; child.stdout.on("data", b => stdout += b); child.stderr.on("data", b => stderr += b); const done = new Promise<number | null>(resolve => child.on("close", c => { closed = true; resolve(c); }));
  try {
    const until = performance.now() + 10000; while (!queued().some(r => r.pid === child.pid) && !closed && performance.now() < until) await Bun.sleep(20);
    assert(queued().some(r => r.pid === child.pid), stderr); assert.equal(closed, false); assert(!stdout.includes("selftest-sweep: START "));
    execFileSync("bun", [helper, "release", lock, String(process.pid), token2, identity2], { env }); held = false;
    assert.equal(await done, 0, stderr); assert(stdout.includes("selftest-sweep: PASS (1 suite(s),"));
  } finally { if (!closed && child.pid) { child.kill("SIGTERM"); await done; } }
} finally { if (held) execFileSync("bun", [helper, "release", lock, String(process.pid), token2, identity2], { env }); }
const isolatedRunner = fs.readFileSync(path.join(repo, "seats/selftest-sweep.sh"), "utf8"), leakyRunner = path.join(repo, "seats/removed-admission-isolation.sh");
fs.writeFileSync(leakyRunner, once(isolatedRunner, '         unset WHEELHOUSE_SELFTEST_SWEEP_NO_WAIT', '         true # removed admission-only environment guard'));
const leaky = spawnSync("bash", [leakyRunner, "--tier", "full"], { cwd: repo, env: { ...env, WHEELHOUSE_SELFTEST_SWEEP_PATTERN: path.join(repo, "seats/tiny-green.selftest.sh"), WHEELHOUSE_SELFTEST_SWEEP_NO_WAIT: "1" }, encoding: "utf8" }); assert.ifError(leaky.error); assert.equal(leaky.status, 1, leaky.stderr + leaky.stdout); assert(leaky.stdout.includes("admission flag leaked to suite"));
console.log("PASS real no-wait admission: skip75, zero START, own ticket withdrawn, holder unchanged; removed block waits for release; removed environment guard leaks flag and fails suite");
console.log("nightly-sweep fixture: PASS");
