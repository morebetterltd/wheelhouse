// Real Git, private repository, no timing race or other review's metadata touched.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { spawnSync } = require(process.env.WHEELHOUSE_FIXTURE_COMMAND_MODULE ?? "./fixture-command.cjs");
const root = fs.realpathSync(process.argv[2]);
const repo = path.join(root, "repo"), own = path.join(root, `wheelhouse-verify-${process.pid}-own`);
const foreign = path.join(root, "wheelhouse-review-foreign-fixture"), branch = "89abcdef0123456789abcdef0123456789abcdef";
const source = path.join(import.meta.dir, "verify-own-worktree.ts"), original = fs.readFileSync(source, "utf8");
const records: any[] = [];
const env = { ...process.env, WHEELHOUSE_FIXTURE_COMMAND_MODULE: process.env.WHEELHOUSE_FIXTURE_COMMAND_MODULE ?? path.join(import.meta.dir, "fixture-command.cjs") };
function git(args: string[], expected = 0) {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env });
  records.push({ kind: "git", args, ...r });
  assert(!r.error && !r.signal && r.status === expected, `CONTROL_SETUP git ${args}: ${r.status} ${r.stderr}`);
  return r;
}
function probe(file: string, mode: string) {
  const args = mode === "registered" ? [mode, repo, own, String(process.pid)] : [mode, repo, own, admin, branch];
  const r = spawnSync("bun", [file, ...args], { encoding: "utf8", env });
  records.push({ kind: "probe", file, mode, ...r });
  assert(!r.error && !r.signal, "CONTROL_SETUP probe did not complete natively");
  return r;
}
function grade(name: string, r: any, expected: number) {
  assert.equal(r.status, expected, `OWN_OBSERVER_ORACLE ${name}: expected native${expected}, got ${r.status}: ${r.stderr}`);
  if (expected === 1) assert(r.stderr.includes("OWN_WORKTREE_ASSERTION"), `CONTROL_SETUP ${name} failed outside own-resource assertion: ${r.stderr}`);
  console.log(`  own-observer ${name}: native${r.status}/signalnull`);
}
function mutant(name: string, old: string, replacement: string) {
  assert.equal(original.split(old).length, 2, `CONTROL_SETUP mutation ${name} must match exactly once`);
  const file = path.join(root, `${name}.ts`);
  fs.writeFileSync(file, original.replace(old, replacement));
  assert.notEqual(fs.readFileSync(file, "utf8"), original);
  return file;
}
function removal(name: string, file: string, mode: string, expected: number, native: number) {
  const r = probe(file, mode);
  assert.equal(r.status, native, `CONTROL_SETUP ${name}: mutation never reached intended native result: ${r.stderr}`);
  if (native === 1) assert(r.stderr.includes("OWN_WORKTREE_ASSERTION"), `CONTROL_SETUP ${name}: not an own-resource rejection`);
  let rejected = false;
  try { grade(name, r, expected); }
  catch (e: any) { assert(e.message.includes(`OWN_OBSERVER_ORACLE ${name}`)); rejected = true; }
  assert(rejected, `OWN_OBSERVER_ORACLE ${name}: removal escaped its oracle`);
  console.log(`  own-observer removal ${name}: actual native${r.status}/signalnull rejected at intended oracle`);
}
fs.mkdirSync(repo);
git(["init", "-q", "-b", "main"]);
git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture"]);
git(["worktree", "add", "--detach", own, "HEAD"]);
const admin = fs.readFileSync(path.join(own, ".git"), "utf8").trim().replace(/^gitdir: /, "");
const st = fs.lstatSync(own), ownerFile = path.join(admin, "wheelhouse-scratch.json");
const owner = { version: 1, dir: own, dev: st.dev, ino: st.ino, pid: process.pid, kind: "verify" };
fs.writeFileSync(ownerFile, JSON.stringify(owner));
git(["worktree", "add", "--detach", foreign, "HEAD"]);
const foreignAdmin = fs.readFileSync(path.join(foreign, ".git"), "utf8").trim().replace(/^gitdir: /, "");
const lockTarget = path.join(root, "foreign-lock-target"), lock = path.join(foreignAdmin, "locked");
fs.writeFileSync(lockTarget, "foreign fixture lock\n");
fs.symlinkSync(lockTarget, lock);
git(["worktree", "list", "--porcelain"]);
fs.unlinkSync(lockTarget); // Deterministic vanished target, not a concurrent unlink claim.
assert(fs.lstatSync(lock).isSymbolicLink());
const broken = git(["worktree", "list", "--porcelain"], 128);
assert(broken.stderr.includes("fatal: failed to read '") && broken.stderr.includes("/locked': No such file or directory"));
grade("foreign-locked-target-missing", probe(source, "registered"), 0);
removal("restore-global-list", mutant("restore-global-list", "  assert(Number.isSafeInteger(pid)", "  text(repo, [\"worktree\", \"list\", \"--porcelain\"]);\n  assert(Number.isSafeInteger(pid)"), "registered", 0, 1);
// The foreign error stays present during own-resource negatives: no generic retry/ignore.
fs.writeFileSync(ownerFile, JSON.stringify({ ...owner, pid: process.pid + 1 }));
grade("own-owner-changed", probe(source, "registered"), 1);
removal("drop-owner-check", mutant("drop-owner-check", "  assert.equal(owner.pid, pid, `${tag}: changed owner PID`);", "  // planted removal: accept wrong owner PID"), "registered", 1, 0);
fs.writeFileSync(ownerFile, JSON.stringify(owner));
const config = path.join(repo, ".git", "config"), configBytes = fs.readFileSync(config);
fs.writeFileSync(config, "[broken\n");
grade("own-git-error", probe(source, "registered"), 1);
removal("ignore-own-observation", mutant("ignore-own-observation", "  assert(Number.isSafeInteger(pid)", `  return ${JSON.stringify(admin)};\n  assert(Number.isSafeInteger(pid)`), "registered", 1, 0);
fs.writeFileSync(config, configBytes);
fs.unlinkSync(lock);
git(["worktree", "remove", foreign]);
git(["worktree", "remove", "--force", own]);
assert(!fs.existsSync(own) && !fs.existsSync(admin));
grade("own-completely-reaped", probe(source, "reaped"), 0);
fs.mkdirSync(own);
grade("own-directory-survived", probe(source, "reaped"), 1);
removal("drop-directory-check", mutant("drop-directory-check", "  assert(absent(dir), `${tag}: own worktree directory survived`);", "  // planted removal: ignore surviving directory"), "reaped", 1, 0);
fs.rmdirSync(own);
fs.mkdirSync(admin, { recursive: true });
grade("own-registration-survived", probe(source, "reaped"), 1);
removal("drop-registration-check", mutant("drop-registration-check", "  assert(absent(admin), `${tag}: own worktree registration survived`);", "  // planted removal: ignore surviving registration"), "reaped", 1, 0);
fs.rmdirSync(admin);
git(["branch", branch, "HEAD"]);
grade("own-sha-branch-survived", probe(source, "reaped"), 1);
removal("drop-branch-presence-check", mutant("drop-branch-presence-check", "r.status === 1,", "[0, 1].includes(r.status),"), "reaped", 1, 0);
git(["branch", "-D", branch]);
fs.writeFileSync(path.join(repo, ".git", "packed-refs"), "invalid packed refs\n");
git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], 128);
grade("own-sha-query-error", probe(source, "reaped"), 1);
removal("ignore-branch-query-error", mutant("ignore-branch-query-error", "r.status === 1,", "r.status !== 0,"), "reaped", 1, 0);
fs.unlinkSync(path.join(repo, ".git", "packed-refs"));
const evidence = process.env.WHEELHOUSE_VERIFY_OWN_EVIDENCE;
if (evidence) {
  assert(fs.statSync(evidence).isDirectory());
  fs.writeFileSync(path.join(evidence, `own-observer-${process.pid}.json`), JSON.stringify({ source, original, records }, null, 2));
}
console.log("Own-worktree observer: 8 cases and 7 actual-source removals graded; native foreign Git128 and own Git128 retained.");
