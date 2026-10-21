// Nightly-only review policy. Uses native Git, CLI sweeps and retained logs;
// quarantine's reader fixtures remain separate.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
const [here, owned, baseProject, home, runPath] = process.argv.slice(2);
assert(fs.statSync(path.join(owned, ".wheelhouse-selftest-fixture")).isFile());
const dir = path.join(owned, "nightly-reviews"); fs.mkdirSync(dir);
const source = fs.readFileSync(path.join(here, "verify.ts"), "utf8");
const env = { ...process.env, HOME: home, PATH: runPath, GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" };
const git = (repo: string, ...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const once = (s: string, old: string, next: string) => { assert.equal(s.split(old).length, 2, old); return s.replace(old, next); };
const noBrake = once(source, "  const brake = nightlyBrake(installRoot);", "  const brake = null; // removed nightly brake");
const forced = once(source, "  const brake = nightlyBrake(installRoot);", '  const brake = "nightly red forced"; // broken sticky brake');
let serial = 0;
function world(label: string, code = source) {
  const repo = path.join(dir, `${++serial}-${label}`); fs.cpSync(baseProject, repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "seats/verify.ts"), code);
  fs.copyFileSync(path.join(here, "nightly-state.ts"), path.join(repo, "seats/nightly-state.ts"));
  git(repo, "checkout", "-q", "main"); git(repo, "add", "."); git(repo, "commit", "-qm", "nightly fixture baseline");
  git(repo, "checkout", "-qb", "digest-candidate"); fs.writeFileSync(path.join(repo, "seats/digest.ts"), "// digest-only candidate\n"); git(repo, "add", "."); git(repo, "commit", "-qm", "digest-only candidate");
  return repo;
}
const redDate = "2026-01-01T03:00:00.000Z", redTip = "a".repeat(40), reason = `nightly red ${redDate} ${redTip}`;
function record(repo: string, rc: number, date = redDate) { fs.mkdirSync(path.join(repo, "seats/run"), { recursive: true }); fs.writeFileSync(path.join(repo, "seats/run/nightly-sweep.json"), JSON.stringify({ date, tip: redTip, rc, logPath: "fixture-nightly.log", elapsedMs: 4, failedSuites: rc ? ["fixture.selftest.sh"] : [] }) + "\n"); }
function cli(repo: string, label: string, batch?: string) {
  const show = path.join(dir, label + ".claim"), reply = path.join(dir, label + ".reply"); fs.writeFileSync(show, "fixture task: digest-only change"); fs.writeFileSync(reply, "VERDICT: APPROVE\nPUSH: NOT CONSIDERED\n");
  const r = spawnSync("bun", [path.join(repo, "seats/verify.ts"), label, "digest-candidate", "worker-1", "reviewer", ...(batch ? ["--batch-sweep", batch] : [])], { env: { ...env, STUB_REPLY_FILE: reply, STUB_BD_SHOW_FILE: show, STUB_SWEEP_PROMPT_CHECK: "1", STUB_SWEEP_FORCE_APPROVE: "1", WHEELHOUSE_SELFTEST_SWEEP_LOCK: path.join(dir, label + ".lock") }, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  assert.ifError(r.error); assert.equal(r.signal, null); fs.writeFileSync(path.join(dir, label + ".stdout"), r.stdout); fs.writeFileSync(path.join(dir, label + ".stderr"), r.stderr);
  const file = path.join(repo, "seats/verdicts", label + ".md"); return { ...r, receipt: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "" };
}
const repo = world("fixed"), api = await import(pathToFileURL(path.join(repo, "seats/verify.ts")).href), tip = git(repo, "rev-parse", "HEAD");
assert.equal(api.chooseSweepTier(repo, tip, "fixture task").tier, "core");
record(repo, 1); assert.deepEqual(api.chooseSweepTier(repo, tip, "fixture task"), { tier: "full", reason });
fs.writeFileSync(path.join(repo, "seats/run/nightly-sweep-missed.json"), JSON.stringify({ date: "2026-01-02T03:00:00.000Z", reason: "host lock busy" })); assert.equal(api.chooseSweepTier(repo, tip, "fixture task").reason, reason);
const red = cli(repo, "nightly-red"); assert.equal(red.status, 0, red.stderr + red.stdout); assert(red.receipt.includes(`- tier: full\n- reason: ${reason}\n`)); const redLog = red.receipt.match(/^- log: (.+)$/m)![1]; assert(fs.readFileSync(redLog, "utf8").includes(`tier=full reason=${reason}\n`));
console.log("PASS nightly red CLI: digest-only change gets full, exact nightly date/tip reason in log and receipt; a missed attempt cannot release brake");
record(repo, 0, "2026-01-03T03:00:00.000Z"); assert.equal(api.chooseSweepTier(repo, tip, "fixture task").tier, "core");
const green = cli(repo, "nightly-green"); assert.equal(green.status, 0, green.stderr + green.stdout); assert(green.receipt.includes("- tier: core\n- reason: default\n")); const coreLog = green.receipt.match(/^- log: (.+)$/m)![1];
record(repo, 1); const batch = cli(repo, "nightly-core-batch-refused", coreLog); assert.equal(batch.status, 1); assert((batch.stderr + batch.stdout).includes("full tier required by " + reason)); assert.equal(batch.receipt, "");
console.log("PASS later green releases brake; a red nightly refuses actual earlier core batch coverage before reviewer approval");
const removedRepo = world("removed-brake", noBrake); record(removedRepo, 1); const removed = cli(removedRepo, "nightly-removed-red"); assert.equal(removed.status, 0, removed.stderr + removed.stdout); assert(removed.receipt.includes("- tier: core\n- reason: default\n"));
// On the SAME history/log, bypassing only the brake admits unsafe core reuse.
fs.writeFileSync(path.join(repo, "seats/verify.ts"), noBrake);
try { const unsafe = cli(repo, "nightly-removed-batch", coreLog); assert.equal(unsafe.status, 0, unsafe.stderr + unsafe.stdout); assert(unsafe.receipt.includes("- tier: core")); }
finally { fs.writeFileSync(path.join(repo, "seats/verify.ts"), source); }
const stickyRepo = world("sticky-brake", forced); record(stickyRepo, 0); const sticky = await import(pathToFileURL(path.join(stickyRepo, "seats/verify.ts")).href); assert.equal(sticky.chooseSweepTier(stickyRepo, git(stickyRepo, "rev-parse", "HEAD"), "fixture task").tier, "full"); fs.unlinkSync(path.join(stickyRepo, "seats/run/nightly-sweep.json")); assert.equal(sticky.chooseSweepTier(stickyRepo, git(stickyRepo, "rev-parse", "HEAD"), "fixture task").tier, "full");
fs.writeFileSync(path.join(repo, "seats/run/nightly-sweep.json"), "{invalid"); assert(api.chooseSweepTier(repo, tip, "fixture task").reason.startsWith("nightly state invalid:"));
const removedApi = await import(pathToFileURL(path.join(removedRepo, "seats/verify.ts")).href); fs.writeFileSync(path.join(removedRepo, "seats/run/nightly-sweep.json"), "{invalid"); assert.equal(removedApi.chooseSweepTier(removedRepo, git(removedRepo, "rev-parse", "HEAD"), "fixture task").tier, "core");
console.log("PASS nightly brake sensitive removals: bypass admits core/red + core batch; sticky brake fails green/missing; invalid-state bypass drops conservative full");
fs.unlinkSync(path.join(repo, "seats/run/nightly-sweep.json"));
const noHarness = once(once(source, '  harness.add("seats/nightly-sweep.ts");', ''), '  harness.add("seats/nightly-state.ts");', '');
const noHarnessFile = path.join(repo, "seats/verify-no-nightly-harness.ts"); fs.writeFileSync(noHarnessFile, noHarness); const oldHarness = await import(pathToFileURL(noHarnessFile).href);
for (const name of ["nightly-sweep.ts", "nightly-state.ts"]) {
  git(repo, "checkout", "-q", "-B", "nightly-path-" + name, "main"); fs.appendFileSync(path.join(repo, "seats", name), "\n// fixture harness edit\n"); git(repo, "add", path.join("seats", name)); git(repo, "commit", "-qm", "nightly harness path"); const candidate = git(repo, "rev-parse", "HEAD");
  assert.equal(api.chooseSweepTier(repo, candidate, "fixture task").reason, "seats/" + name); assert.equal(oldHarness.chooseSweepTier(repo, candidate, "fixture task").tier, "core");
}
console.log("PASS nightly harness paths require full even when green; removing their path entries selects core");
