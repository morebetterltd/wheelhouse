// Every deletion target is a newly manufactured repository beneath the caller's FIX.
import * as fs from "node:fs";
import * as path from "node:path";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
const [verify, cases] = process.argv.slice(2);
assert.ok(verify && fs.statSync(verify).isFile());
assert.ok(cases && fs.statSync(cases).isDirectory());
const tmp = path.join(cases, "tmp"); fs.mkdirSync(tmp);
const env = { ...process.env, TMPDIR: tmp };
let failures = 0;
function git(repo: string, ...args: string[]) {
  const r = spawnSync("git", ["-C", repo, "-c", "user.name=selftest", "-c", "user.email=selftest@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr); return r.stdout;
}
function repoAt(dir: string) {
  fs.mkdirSync(dir, { recursive: true }); git(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "KEEP"), "unrelated checkout sentinel\n");
  git(dir, "add", "KEEP"); git(dir, "commit", "-qm", "fixture"); return dir;
}
function test(name: string, f: () => void) {
  try { f(); console.log(`PASS ${name}`); }
  catch (e: any) { failures++; console.error(`FAIL ${name}: ${e.message}`); }
}
for (const kind of ["verify", "review"]) test(`main checkout ${kind} prefix is preserved and reported`, () => {
  const repo = repoAt(path.join(tmp, `wheelhouse-${kind}-999999999-unowned`));
  assert.ok(fs.statSync(path.join(repo, ".git")).isDirectory());
  assert.ok(fs.existsSync(path.join(repo, "KEEP")));
  const r = spawnSync(process.execPath, [verify, "--repo", repo], { encoding: "utf8", env });
  assert.equal(r.status, 1, "no positionals must still give usage STOP");
  assert.ok(fs.existsSync(path.join(repo, "KEEP")), "janitor removed fixture main checkout");
  assert.ok(fs.statSync(path.join(repo, ".git")).isDirectory());
  assert.match(r.stderr, /skipped main checkout/);
});

test("matching linked worktree outside current tmpdir is preserved and reported", () => {
  const repo = repoAt(path.join(cases, "outside-repo"));
  const outside = path.join(cases, "wheelhouse-verify-999999999-outside");
  git(repo, "worktree", "add", "-q", "--detach", outside, "HEAD");
  assert.ok(fs.statSync(path.join(outside, ".git")).isFile());
  assert.ok(fs.existsSync(path.join(outside, "KEEP")));
  const r = spawnSync(process.execPath, [verify, "--repo", repo], { encoding: "utf8", env });
  assert.equal(r.status, 1);
  assert.ok(fs.existsSync(path.join(outside, "KEEP")), "janitor removed outside linked checkout");
  assert.match(r.stderr, /outside current temp directory/);
});

test("unrecorded matching linked worktree inside tmpdir is not adopted", () => {
  const repo = repoAt(path.join(cases, "unowned-repo"));
  const unowned = path.join(tmp, "wheelhouse-review-999999999-unowned-linked");
  git(repo, "worktree", "add", "-q", "--detach", unowned, "HEAD");
  assert.ok(fs.existsSync(path.join(unowned, "KEEP")));
  const r = spawnSync(process.execPath, [verify, "--repo", repo], { encoding: "utf8", env });
  assert.equal(r.status, 1);
  assert.ok(fs.existsSync(path.join(unowned, "KEEP")), "janitor adopted another run's unrecorded checkout");
  assert.match(r.stderr, /unrecorded or changed/);
});

test("a recorded scratch path replaced with a different directory is preserved", () => {
  const repo = repoAt(path.join(cases, "replacement-repo"));
  const receipt = path.join(cases, "replacement-owner.json");
  const owner = spawnSync(process.execPath, [path.join(import.meta.dir, "scratch-owner.ts"), "dead", verify, repo, "verify", receipt], { encoding: "utf8", env });
  assert.equal(owner.signal, "SIGKILL", owner.stderr);
  const { dir } = JSON.parse(fs.readFileSync(receipt, "utf8"));
  const gitFile = fs.readFileSync(path.join(dir, ".git"), "utf8");
  fs.renameSync(dir, path.join(cases, "saved-original"));
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, ".git"), gitFile);
  fs.writeFileSync(path.join(dir, "KEEP"), "replacement directory must survive\n");
  const r = spawnSync(process.execPath, [verify, "--repo", repo], { encoding: "utf8", env });
  assert.equal(r.status, 1);
  assert.ok(fs.existsSync(path.join(dir, "KEEP")), "janitor removed replacement directory");
  assert.match(r.stderr, /unrecorded or changed/);
});

test("Git refusal leaves even an owned scratch worktree intact with no rm fallback", () => {
  const repo = repoAt(path.join(cases, "refusal-repo"));
  const receipt = path.join(cases, "refusal-owner.json");
  const owner = spawnSync(process.execPath, [path.join(import.meta.dir, "scratch-owner.ts"), "dead", verify, repo, "review", receipt], { encoding: "utf8", env });
  assert.equal(owner.signal, "SIGKILL", owner.stderr);
  const { dir } = JSON.parse(fs.readFileSync(receipt, "utf8"));
  assert.ok(fs.existsSync(path.join(dir, "KEEP")));
  const bin = path.join(cases, "bin"); fs.mkdirSync(bin);
  const nativeGit = spawnSync("bash", ["-c", "command -v git"], { encoding: "utf8", env }).stdout.trim();
  assert.ok(path.isAbsolute(nativeGit) && fs.existsSync(nativeGit));
  // Deliberately fail only removal, after the real Git listing/identity checks.
  fs.writeFileSync(path.join(bin, "git"), `#!/usr/bin/env bash\nfor a in "$@"; do if [ "$a" = remove ]; then echo 'fixture Git refusal' >&2; exit 71; fi; done\nexec ${JSON.stringify(nativeGit)} "$@"\n`, { mode: 0o755 });
  const r = spawnSync(process.execPath, [verify, "--repo", repo], { encoding: "utf8", env: { ...env, PATH: `${bin}${path.delimiter}${env.PATH}` } });
  assert.equal(r.status, 1);
  assert.ok(fs.existsSync(path.join(dir, "KEEP")), "rm fallback deleted the checkout Git refused");
  assert.match(r.stderr, /Git refused removal/);
  assert.ok(git(repo, "worktree", "list", "--porcelain").includes(`worktree ${dir}\n`), "refused worktree must stay registered");
});
console.log(`janitor safety: ${failures ? "FAIL" : "PASS"} (${failures} failure(s))`);
process.exitCode = failures ? 1 : 0;
