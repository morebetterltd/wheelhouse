// Fixture observer: never enumerate unrelated linked worktrees to grade 10b.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { spawnSync } = require(process.env.WHEELHOUSE_FIXTURE_COMMAND_MODULE ?? "./fixture-command.cjs");
const tag = "OWN_WORKTREE_ASSERTION";

function git(repo: string, args: string[]) {
  return spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}
function text(repo: string, args: string[]): string {
  const r = git(repo, args);
  assert(!r.error && !r.signal && r.status === 0,
    `${tag}: git ${args.join(" ")} status=${r.status} signal=${r.signal}: ${r.stderr}`);
  return r.stdout.trim();
}
function absent(file: string): boolean {
  try { fs.lstatSync(file); return false; }
  catch (e: any) { if (e.code === "ENOENT") return true; throw e; }
}
function adminPath(repo: string, dir: string, admin: string) {
  const common = fs.realpathSync(text(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  assert.equal(path.dirname(admin), path.join(common, "worktrees"), `${tag}: foreign admin directory`);
  assert.equal(path.basename(admin), path.basename(dir), `${tag}: wrong worktree admin name`);
}

export function registered(repo: string, dir: string, pid: number): string {
  assert(Number.isSafeInteger(pid) && pid > 0, `${tag}: invalid owner PID`);
  assert(path.basename(dir).startsWith(`wheelhouse-verify-${pid}-`), `${tag}: wrong owner path`);
  assert(fs.lstatSync(dir).isDirectory() && !fs.lstatSync(dir).isSymbolicLink(), `${tag}: not an own directory`);
  assert.equal(fs.realpathSync(dir), dir, `${tag}: noncanonical worktree`);
  const admin = text(dir, ["rev-parse", "--absolute-git-dir"]);
  adminPath(repo, dir, admin);
  assert.equal(text(dir, ["rev-parse", "--show-toplevel"]), dir, `${tag}: wrong Git worktree`);
  assert.equal(fs.readFileSync(path.join(admin, "gitdir"), "utf8").trim(), path.join(dir, ".git"), `${tag}: wrong backlink`);
  const owner = JSON.parse(fs.readFileSync(path.join(admin, "wheelhouse-scratch.json"), "utf8"));
  const st = fs.lstatSync(dir);
  assert.equal(owner.version, 1, `${tag}: invalid owner version`);
  assert.equal(owner.dir, dir, `${tag}: changed owner directory`);
  assert.equal(owner.kind, "verify", `${tag}: changed owner kind`);
  assert.equal(owner.pid, pid, `${tag}: changed owner PID`);
  assert.equal(owner.dev, st.dev, `${tag}: changed device`);
  assert.equal(owner.ino, st.ino, `${tag}: changed inode`);
  return admin;
}

export function reaped(repo: string, dir: string, admin: string, branch: string): void {
  adminPath(repo, dir, admin);
  assert(/^[0-9a-f]{40}$/.test(branch), `${tag}: not the fixture SHA branch`);
  assert(absent(dir), `${tag}: own worktree directory survived`);
  assert(absent(admin), `${tag}: own worktree registration survived`);
  const r = git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  // Only native status1 means absent. Git errors/signals are not successful cleanup.
  assert(!r.error && !r.signal && r.status === 1,
    `${tag}: own SHA branch query status=${r.status} signal=${r.signal}: ${r.stderr}`);
}

if (import.meta.main) {
  const [mode, repo, dir, arg, branch] = process.argv.slice(2);
  if (mode === "registered") console.log(registered(repo, dir, Number(arg)));
  else if (mode === "reaped") reaped(repo, dir, arg, branch);
  else throw Error(`${tag}: invalid mode`);
}
