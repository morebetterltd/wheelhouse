import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "./fixture-command.cjs";
const [template, root] = process.argv.slice(2);
assert(template && root && fs.statSync(path.join(path.dirname(root), ".wheelhouse-selftest-fixture")).isFile(), "owned fixture required");
fs.mkdirSync(root);
const records: any[] = [];
const evidence = process.env.WHEELHOUSE_UPGRADE_EVIDENCE_CAPTURE;
function save() { if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, "native.json"), JSON.stringify(records, null, 2) + "\n"); } }
function run(cwd: string, bin: string, args: string[], env = process.env) {
  const r = spawnSync(bin, args, { cwd, env, encoding: "utf8", policyTimeoutMs: 30000 });
  assert.ifError(r.error); assert.equal(r.signal, null);
  records.push({ cwd, bin, args, status: r.status, stdout: r.stdout, stderr: r.stderr }); save();
  return r;
}
function git(cwd: string, ...args: string[]) {
  const r = run(cwd, "git", args); assert.equal(r.status, 0, r.stderr); return r.stdout;
}
function repo(name: string, initial?: string) {
  const dir = path.join(root, name); fs.mkdirSync(dir); git(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "product.txt"), "product\n"); git(dir, "add", "product.txt");
  git(dir, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "base");
  if (initial !== undefined) fs.writeFileSync(path.join(dir, ".gitignore"), initial);
  fs.mkdirSync(path.join(dir, "evidence/task"), { recursive: true }); fs.writeFileSync(path.join(dir, "evidence/task/run.log"), "owned proof\n");
  fs.mkdirSync(path.join(dir, "product/evidence"), { recursive: true }); fs.writeFileSync(path.join(dir, "product/evidence/run.log"), "product-local proof\n");
  return dir;
}
function block(file: string) {
  const text = fs.readFileSync(path.join(template, file), "utf8");
  const candidates = [...text.matchAll(/^[ \t]*```bash\n([\s\S]*?)^[ \t]*```/gm)].map(m => m[1]).filter(s => s.includes("for e in 'seats/run/'"));
  assert.equal(candidates.length, 1, "unique runtime ignore fence " + file);
  const fence = candidates[0], lines = fence.split("\n"), start = lines.findIndex(l => l.trimStart().startsWith("if [ -s .gitignore ]")), loop = lines.findIndex(l => l.trimStart().startsWith("for e in 'seats/run/'"));
  assert(start >= 0 && loop === start + 1); const end = lines.findIndex((l, i) => i > loop && l.trim() === "done"); assert(end > loop);
  return { fence, loop: lines.slice(start, end + 1).join("\n") + "\n" };
}
const bootstrap = block("BOOTSTRAP.md"), upgrade = block("runbooks/UPGRADE.md");
let bootstrapInstall = "";
for (const [name, extracted] of [["bootstrap", bootstrap], ["upgrade", upgrade]] as const) {
  assert(extracted.loop.includes("'/evidence/'"), name + " entry list");
  for (const [suffix, initial] of [["fresh", undefined], ["no-newline", "dist/"], ["already-present", "/evidence/\n"]] as const) {
    const dir = repo(name + "-" + suffix, initial);
    for (let i = 0; i < 2; i++) assert.equal(run(dir, "bash", ["-eu", "-c", extracted.loop]).status, 0);
    const ignore = fs.readFileSync(path.join(dir, ".gitignore"), "utf8"); assert.equal(ignore.split("\n").filter(l => l === "/evidence/").length, 1);
    if (initial === "dist/") assert(ignore.startsWith("dist/\n"), "preserve and terminate existing rule");
    const native = git(dir, "check-ignore", "-v", "evidence/task/run.log"); assert(native.includes(":/evidence/\t"), native);
    assert.equal(run(dir, "git", ["check-ignore", "-q", "product/evidence/run.log"]).status, 1, "root rule must not swallow product-local evidence");
    console.log(`PASS ${name} ignore ${suffix}: twice, exactly one /evidence/, native check-ignore names root rule`);
    if (name === "bootstrap" && suffix === "fresh") bootstrapInstall = dir;
  }
  const control = repo(name + "-rule-removed"); const removed = extracted.loop.replace(" '/evidence/'", ""); assert.notEqual(removed, extracted.loop);
  assert.equal(run(control, "bash", ["-eu", "-c", removed]).status, 0);
  assert.equal(run(control, "git", ["check-ignore", "-q", "evidence/task/run.log"]).status, 1);
  assert.equal(fs.readFileSync(path.join(control, ".gitignore"), "utf8").split("\n").filter(l => l === "/evidence/").length, 0);
  console.log(`CONTROL ${name} /evidence/ removed: bash0, native ignore1, missing rule; unchanged rule/count oracle rejects`);
}
// Copy only committed runtime files, never ignored live state. The nested
// consumer suite takes its .gitignore ONLY from the real BOOTSTRAP block.
assert(bootstrapInstall && fs.statSync(bootstrapInstall).isDirectory());
const files = execFileSync("git", ["-C", template, "ls-files", "-z", "--", "seats"], { encoding: "utf8", policyTimeoutMs: 10000 }).split("\0").filter(Boolean);
assert(files.includes("seats/no-tracked-evidence.selftest.sh"));
for (const file of files) {
  const from = path.join(template, file), to = path.join(bootstrapInstall, file); fs.mkdirSync(path.dirname(to), { recursive: true });
  if (fs.lstatSync(from).isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
  else fs.copyFileSync(from, to);
}
const consumer = run(bootstrapInstall, "bash", ["seats/no-tracked-evidence.selftest.sh"]); assert.equal(consumer.status, 0, consumer.stdout + consumer.stderr);
assert(consumer.stdout.includes("PASS template ignore excludes new evidence/task/run.log")); console.log("PASS template ignore excludes new evidence/task/run.log (scratch install; BOOTSTRAP-only .gitignore)");
const ignoreFile = path.join(bootstrapInstall, ".gitignore"), originalIgnore = fs.readFileSync(ignoreFile, "utf8");
try {
  fs.writeFileSync(ignoreFile, originalIgnore.replace(/^\/evidence\/\n/m, ""));
  const missing = run(bootstrapInstall, "bash", ["seats/no-tracked-evidence.selftest.sh"]);
  assert.equal(missing.status, 1); assert(missing.stdout.includes("FAIL template ignore does not exclude task captures"));
  console.log("CONTROL installed ignore rule removed: actual no-tracked-evidence suite1 at template ignore oracle");
} finally { fs.writeFileSync(ignoreFile, originalIgnore); }
// The upgrade's printed read-only stop executes BEFORE the copying/mutation.
const boundary = upgrade.fence.indexOf("mkdir -p seats\n"); assert(boundary > 0);
const guard = upgrade.fence.slice(0, boundary); assert(guard.includes("tracked_evidence=$(git ls-files -- evidence/)"));
const proceed = "printf 'WOULD_CONTINUE\\n'\n";
for (const kind of ["staged-task", "committed-product", "newline-name"]) {
  const dir = repo(kind); if (kind === "newline-name") fs.writeFileSync(path.join(dir, "evidence/a\nb.log"), "odd name\n");
  git(dir, "add", "evidence"); if (kind === "committed-product") git(dir, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "owner product evidence");
  const before = git(dir, "ls-files", "--stage", "-z"), bytes = fs.readFileSync(path.join(dir, "evidence/task/run.log"));
  const r = run(dir, "bash", ["-eu", "-c", guard + proceed]); assert.equal(r.status, 1); assert(r.stderr.includes("ask the owner")); assert(!r.stdout.includes("WOULD_CONTINUE"));
  assert.equal(git(dir, "ls-files", "--stage", "-z"), before); assert.deepEqual(fs.readFileSync(path.join(dir, "evidence/task/run.log")), bytes); assert(!fs.existsSync(path.join(dir, "seats")));
  const control = run(dir, "bash", ["-eu", "-c", proceed]); assert.equal(control.status, 0); assert(control.stdout.includes("WOULD_CONTINUE"));
  console.log(`PASS upgrade ${kind}: STOP1 before copy, index/files unchanged; guard removal0 would continue`);
}
const clear = repo("untracked-captures"); assert.equal(run(clear, "bash", ["-eu", "-c", guard + proceed]).status, 0);
const badBin = path.join(root, "bad-bin"); fs.mkdirSync(badBin); fs.writeFileSync(path.join(badBin, "git"), "#!/bin/sh\necho fixture-git-unavailable >&2\nexit 17\n", { mode: 0o755 });
const failed = run(clear, "bash", ["-eu", "-c", guard + proceed], { ...process.env, PATH: badBin + path.delimiter + process.env.PATH }); assert.equal(failed.status, 1); assert(failed.stderr.includes("cannot inspect tracked root evidence/")); assert(!failed.stdout.includes("WOULD_CONTINUE"));
console.log("PASS upgrade untracked captures continue; failed Git instrument stops, never counted as empty");
save();
console.log("upgrade runbook evidence: PASS (printed ignore loops + real installed consumer + read-only owner stop)");
