// Real Git selection, real dispatcher sweeps and CLI verdicts; tiny payloads only.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "./fixture-command.cjs";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
const [here, root, baseProject, home, runPath] = process.argv.slice(2);
assert(fs.statSync(path.join(root, ".wheelhouse-selftest-fixture")).isFile());
const source = fs.readFileSync(path.join(here, "verify.ts"), "utf8");
console.log("tier pinned verify sha256=" + createHash("sha256").update(source).digest("hex"));
const api = await import(pathToFileURL(path.join(here, "verify.ts")).href);
const dir = path.join(root, "tier-cases"); fs.mkdirSync(dir);
const env = { ...process.env, HOME: home, PATH: runPath, GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" };
const git = (repo: string, ...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=fixture", "-c", "user.email=fixture@local", "-c", "commit.gpgsign=false", ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const write = (repo: string, file: string, text = "// fixture change\n") => { fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); fs.writeFileSync(path.join(repo, file), text); };
const commit = (repo: string) => { git(repo, "add", "."); git(repo, "commit", "-qm", "fixture change"); return git(repo, "rev-parse", "HEAD"); };
const once = (s: string, old: string, next: string) => { assert.equal(s.split(old).length, 2, old); return s.replace(old, next); };
const legacy = once(source, "export function chooseSweepTier(", "function removedChooseSweepTier(") + '\nexport function chooseSweepTier() { return {tier:"full" as const,reason:"legacy"}; }\n';
let serial = 0;
function world(label: string, code = source) {
  const repo = path.join(dir, `${++serial}-${label}`); fs.cpSync(baseProject, repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "seats/verify.ts"), code);
  // build_proj intentionally tracks only its tiny sweep. Establish the copied
  // runtime on main before candidate changes, or git add would make digest-only
  // reviews appear to add every harness file.
  git(repo, "checkout", "-q", "main"); commit(repo);
  return repo;
}
const legacyRepo = world("legacy-module", legacy);
const removed = await import(pathToFileURL(path.join(legacyRepo, "seats/verify.ts")).href);
const policy = path.join(dir, "policy"); fs.mkdirSync(path.join(policy, "seats"), { recursive: true });
git(policy, "init", "-q", "-b", "main");
for (const name of ["fixture", "digest", "adapter", "verify", "adapter-rpc", "host-build-shim"]) write(policy, `seats/${name}.selftest.sh`, "exit 0\n");
write(policy, "seats/selftest-core.list", "adapter.selftest.sh\ndigest.selftest.sh\nfixture.selftest.sh\nverify.selftest.sh\n");
commit(policy);
const rules = [
  ...["selftest-sweep.sh", "selftest-lib.sh", "selftest-sweep-lock.ts", "selftest-herald.sh", "python-invocations.ts", "quarantine.ts", "selftest-quarantine.list", "adapter.ts", "seat-worktree.ts", "verify.ts", "heavy-test.sh", "heavy-test-entry.ts"].map(name => ({ file: "seats/" + name, tier: "full", reason: "seats/" + name })),
  { file: "seats/selftest-core.list", tier: "full", reason: "seats/selftest-core.list", content: "# changed policy\nadapter.selftest.sh\ndigest.selftest.sh\nfixture.selftest.sh\nverify.selftest.sh\n" },
  { file: "seats/digest.ts", tier: "core", reason: "default" },
  { file: "seats/digest.selftest.sh", tier: "core", reason: "default" },
  { file: "seats/host-build-shim.selftest.sh", tier: "full", reason: "seats/host-build-shim.selftest.sh" },
  { file: "seats/fixtures/digest.ts", tier: "core", reason: "default" },
  { file: "seats/fixtures/digest/child.json", tier: "core", reason: "default" },
  { file: "seats/fixtures/adapter-rpc.ts", tier: "full", reason: "seats/fixtures/adapter-rpc.ts" },
  { file: "seats/fixtures/shared.ts", tier: "full", reason: "seats/fixtures/shared.ts" },
  { file: "seats/digest.ts", claim: "## Done\nThe full sweep passes.", tier: "full", reason: "Done line" },
  { file: "seats/digest.ts", claim: "Run selftest-sweep.sh before review", tier: "full", reason: "Done line" },
];
for (let i = 0; i < rules.length; i++) {
  const test = rules[i]; git(policy, "checkout", "-q", "-B", "case-" + i, "main"); write(policy, test.file, test.content); const tip = commit(policy);
  const expected = { tier: test.tier, reason: test.reason }, choice = api.chooseSweepTier(policy, tip, test.claim ?? "fixture task");
  assert.deepEqual({ tier: choice.tier, reason: choice.reason }, expected);
  const old = removed.chooseSweepTier(policy, tip, test.claim ?? "fixture task");
  assert.notDeepEqual({ tier: old.tier, reason: old.reason }, expected, "insensitive legacy classifier");
  console.log(`PASS tier rule ${test.file} ${test.reason}; legacy full-only/no-reason removal detected`);
}
git(policy, "checkout", "-q", "-B", "delete-full", "main"); git(policy, "rm", "-q", "seats/host-build-shim.selftest.sh"); const deleted = commit(policy);
assert.equal(api.chooseSweepTier(policy, deleted, "").reason, "seats/host-build-shim.selftest.sh");
assert.notEqual(removed.chooseSweepTier(policy, deleted, "").reason, "seats/host-build-shim.selftest.sh");
console.log("PASS deleted full suite remains full; legacy reason removal detected");

function cli(repo: string, bead: string, branch: string, claim: string, log?: string) {
  const show = path.join(dir, bead + ".txt"), reply = path.join(dir, bead + ".reply"); fs.writeFileSync(show, `Trace: tier selection CLI fixture\nSignal: isa-gap: K1\nSkills: intent@1.0.0 outcomes@1.0.0\n\nIntent:\nCheck the selected review policy independently.\n${claim}\n\nOutcomes:\n- O1 The review records its selected tier and reason.\n  consumer: machine — fixture reviewer\n  surface: dispatcher log and review receipt\n  check: run — inspect the selected tier, reason and exit code\n`); fs.writeFileSync(reply, "VERDICT: APPROVE\nPUSH: NOT CONSIDERED\n");
  const r = spawnSync("bun", [path.join(repo, "seats/verify.ts"), bead, branch, "worker-1", "reviewer", ...(log ? ["--batch-sweep", log] : [])], { env: { ...env, STUB_REPLY_FILE: reply, STUB_BD_SHOW_FILE: show, STUB_SWEEP_PROMPT_CHECK: "1", STUB_SWEEP_FORCE_APPROVE: "1", WHEELHOUSE_SELFTEST_SWEEP_LOCK: path.join(dir, bead + ".lock") }, encoding: "utf8" });
  assert.ifError(r.error); assert.equal(r.signal, null); fs.writeFileSync(path.join(dir, bead + ".stdout"), r.stdout); fs.writeFileSync(path.join(dir, bead + ".stderr"), r.stderr);
  const file = path.join(repo, "seats/verdicts", bead + ".md"), receipt = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  return { ...r, receipt };
}
for (const test of [{ label: "digest", file: "seats/digest.ts", tier: "core", reason: "default", claim: "fixture task" }, { label: "adapter", file: "seats/adapter.ts", tier: "full", reason: "seats/adapter.ts", claim: "fixture task" }, { label: "done", file: "seats/digest.ts", tier: "full", reason: "Done line", claim: "The full sweep passes." }]) {
  for (const old of [false, true]) {
    const repo = world(test.label, old ? legacy : source); git(repo, "checkout", "-qb", "candidate"); write(repo, test.file); const tip = commit(repo);
    const bead = `tier-${test.label}-${old ? "removed" : "fixed"}`, r = cli(repo, bead, "candidate", test.claim);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const correct = r.receipt.includes(`- tier: ${test.tier}\n- reason: ${test.reason}\n`);
    assert.equal(correct, !old, "CLI choice/receipt criterion");
    if (!old) {
      const log = r.receipt.match(/^- log: (.+)$/m)![1], text = fs.readFileSync(log, "utf8");
      assert(text.includes(`tier=${test.tier} reason=${test.reason}\n`));
      const argv = JSON.parse(fs.readFileSync(path.join(home, ".pi-seats-alpha/reviewer/argv.json"), "utf8"));
      assert(argv.at(-1).includes(`- tier: ${test.tier}; reason: ${test.reason}`)); assert(r.receipt.includes(`- tip: ${tip}`));
    }
  }
  console.log(`PASS CLI ${test.label}: real selected sweep, log/prompt/verdict reason; legacy classifier removal detected`);
}

const mismatchLine = '  if (timings.tier !== choice.tier) throw new Error(`dispatcher tier mismatch: chose ${choice.tier} (${choice.reason}), log records ${timings.tier}`);';
for (const old of [false, true]) {
  const repo = world("mismatch", old ? once(source, mismatchLine, "") : source);
  git(repo, "checkout", "-qb", "candidate");
  const script = path.join(repo, "seats/selftest-sweep.sh"), sha = createHash("sha256").update(fs.readFileSync(path.join(repo, "seats/selftest-core.list"))).digest("hex");
  const runner = fs.readFileSync(script, "utf8");
  fs.writeFileSync(script, once(runner, 'say "selftest-sweep: tier=full suites=${#suites[@]}"', `say "selftest-sweep: tier=core suites=\${#suites[@]} manifest=${sha}"`)); commit(repo);
  const r = cli(repo, `tier-mismatch-${old ? "removed" : "fixed"}`, "candidate", "fixture task");
  if (old) assert.equal(r.status, 0, r.stderr + r.stdout);
  else { assert.equal(r.status, 1); assert((r.stdout + r.stderr).includes("INCOMPLETE review:")); assert((r.stdout + r.stderr).includes("dispatcher tier mismatch")); assert.equal(r.receipt, ""); }
}
console.log("PASS CLI tier mismatch is INCOMPLETE/no verdict; tier guard removal accepts unsafe APPROVE");

const batchRepo = world("batch");
write(batchRepo, "seats/full-extra.selftest.sh", "#!/bin/bash\nprintf 'fixture sweep PASS\\n'\n"); commit(batchRepo);
git(batchRepo, "checkout", "-qb", "core-candidate"); write(batchRepo, "seats/digest.ts"); const coreTip = commit(batchRepo);
git(batchRepo, "checkout", "-q", "main"); git(batchRepo, "checkout", "-qb", "full-candidate"); write(batchRepo, "seats/adapter.ts"); const fullTip = commit(batchRepo);
git(batchRepo, "checkout", "-q", "main"); git(batchRepo, "checkout", "-qb", "batch"); git(batchRepo, "merge", "--no-ff", "-qm", "combined fixture", "core-candidate", "full-candidate"); const batchTip = git(batchRepo, "rev-parse", "HEAD");
const native = await import(pathToFileURL(path.join(batchRepo, "seats/verify.ts")).href);
const manifest = native.parseCoreManifest(fs.readFileSync(path.join(batchRepo, "seats/selftest-core.list")), ["fixture.selftest.sh", "full-extra.selftest.sh"]);
const saved = process.env.WHEELHOUSE_SELFTEST_SWEEP_LOCK; process.env.WHEELHOUSE_SELFTEST_SWEEP_LOCK = path.join(dir, "batch-payload.lock");
const bd = path.join(runPath.split(path.delimiter)[0], "bd"); assert(fs.statSync(bd).isFile());
const coreResult = await native.runDispatcherFullSweep(batchRepo, batchTip, bd, runPath, { tier: "core", reason: "default", manifest });
const fullResult = await native.runDispatcherFullSweep(batchRepo, batchTip, bd, runPath, { tier: "full", reason: "seats/adapter.ts" });
if (saved === undefined) delete process.env.WHEELHOUSE_SELFTEST_SWEEP_LOCK; else process.env.WHEELHOUSE_SELFTEST_SWEEP_LOCK = saved;
assert.equal(coreResult.rc, 0, coreResult.error); assert.equal(fullResult.rc, 0, fullResult.error);
// Real native output is captured BEFORE constructing corrupt inventory/hash fixtures.
const captured = fs.readFileSync(coreResult.logPath, "utf8");
assert.equal(native.readBatchSweep(batchRepo, coreTip, coreResult.logPath).choice.tier, "core");
const tierLine = '  const tier = /^selftest-sweep: tier=(full suites=([1-9][0-9]*)|core suites=([1-9][0-9]*) manifest=([0-9a-f]{64}))$/m.exec(text);';
const fullOnlyFile = path.join(batchRepo, "seats/verify-full-only-reader.ts");
fs.writeFileSync(fullOnlyFile, once(source, tierLine, '  const tier = /^selftest-sweep: tier=(full suites=([1-9][0-9]*))$/m.exec(text);'));
const fullOnly = await import(pathToFileURL(fullOnlyFile).href);
assert.throws(() => fullOnly.readBatchSweep(batchRepo, coreTip, coreResult.logPath), /missing tier\/full completed footer/);
console.log("PASS actual core batch accepted; removing core reader support refuses it");
assert.equal(native.readBatchSweep(batchRepo, fullTip, fullResult.logPath).choice.tier, "full");
assert.equal(native.readBatchSweep(batchRepo, coreTip, fullResult.logPath).choice.tier, "full");
assert.throws(() => native.readBatchSweep(batchRepo, fullTip, coreResult.logPath), /full tier required by seats\/adapter.ts/);
const guard = '  if (requiredChoice.tier === "full" && choice.tier !== "full") refuse(`full tier required by ${requiredChoice.reason}; a core batch cannot cover this candidate`);';
const unsafeFile = path.join(batchRepo, "seats/verify-unsafe-batch.ts"); fs.writeFileSync(unsafeFile, once(source, guard, ""));
const unsafe = await import(pathToFileURL(unsafeFile).href);
assert.equal(unsafe.readBatchSweep(batchRepo, fullTip, coreResult.logPath).rc, 0);
const batchTarget = path.join(batchRepo, "seats/verify.ts");
for (const [label, candidate, claim, why, mutation] of [
  ["adapter", "full-candidate", "fixture task", "seats/adapter.ts", once(source, guard, "")],
  ["done", "core-candidate", "The full sweep passes.", "Done line", source.replaceAll("readBatchSweep(repoRoot, tip, batchSweepArg, selectedTier)", "readBatchSweep(repoRoot, tip, batchSweepArg)")],
]) {
  assert.notEqual(mutation, source);
  const fixed = cli(batchRepo, "tier-batch-" + label, candidate, claim, coreResult.logPath);
  assert.equal(fixed.status, 1); assert((fixed.stdout + fixed.stderr).includes("full tier required by " + why)); assert.equal(fixed.receipt, "");
  fs.writeFileSync(batchTarget, mutation);
  try { const broken = cli(batchRepo, "tier-batch-" + label + "-removed", candidate, claim, coreResult.logPath); assert.equal(broken.status, 0, broken.stderr + broken.stdout); }
  finally { fs.writeFileSync(batchTarget, source); }
  console.log(`PASS CLI core batch refuses ${label} full-rule candidate; corresponding guard/wiring removal admits unsafe APPROVE`);
}
const corrupt = path.join(dir, "bad-core-hash.log"); fs.writeFileSync(corrupt, captured.replace(manifest.sha256, "0".repeat(64)));
assert.throws(() => native.readBatchSweep(batchRepo, coreTip, corrupt), /manifest\/inventory mismatch/);
const hashGuard = '  if (choice.tier === "core" && (!choice.manifest || timings.manifest !== choice.manifest.sha256 || timings.suites.length !== choice.manifest.suites.length || timings.suites.some((s, i) => s.suite !== choice.manifest!.suites[i]))) throw new Error("dispatcher core manifest/inventory mismatch");';
const noHashFile = path.join(batchRepo, "seats/verify-no-manifest-guard.ts"); fs.writeFileSync(noHashFile, once(source, hashGuard, ""));
const noHash = await import(pathToFileURL(noHashFile).href); assert.equal(noHash.readBatchSweep(batchRepo, coreTip, corrupt).rc, 0);
const wrongInventory = path.join(dir, "wrong-core-inventory.log");
fs.writeFileSync(wrongInventory, captured.replaceAll("/fixture.selftest.sh", "/full-extra.selftest.sh"));
assert.throws(() => native.readBatchSweep(batchRepo, coreTip, wrongInventory), /inventory\/summary mismatch/);
const inventoryGuard = '  if (expected!.length === 0 || timings.suites.length !== expected!.length || timings.suites.some(s => !expected!.includes(s.suite))) refuse("full-suite inventory/summary mismatch");';
const noInventoryFile = path.join(batchRepo, "seats/verify-no-core-inventory.ts");
fs.writeFileSync(noInventoryFile, once(once(source, inventoryGuard, ""), hashGuard, ""));
const noInventory = await import(pathToFileURL(noInventoryFile).href);
assert.equal(noInventory.readBatchSweep(batchRepo, coreTip, wrongInventory).rc, 0);
console.log("PASS batch: actual core/full inventories; full covers core; core refuses adapter candidate; wrong manifest/inventory refuses; matching guard removals detected");
console.log("verify tiers: PASS (native Git branches, CLI receipts, actual core/full batch captures and sensitive removals)");
