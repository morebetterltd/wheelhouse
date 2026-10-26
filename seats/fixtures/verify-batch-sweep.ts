// Validation fixtures derive from a REAL completed private stub-sweep capture.
// Changed tips/content below are deliberate negative/shape fixtures, never a
// claim that another tree actually ran. No real host sweep or model is spawned.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "./fixture-command.cjs";
import { pathToFileURL } from "node:url";
const [here, root, seedFile, seedTip] = process.argv.slice(2);
assert(fs.statSync(root).isDirectory()); assert(fs.statSync(seedFile).isFile());
const { readBatchSweep, readSweepTimings } = await import(pathToFileURL(path.join(here, "verify.ts")).href);
const repo = path.join(root, "batch-validation-repo"); fs.mkdirSync(repo);
const env = { ...process.env, GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" };
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
git("init", "-q", "-b", "main"); git("config", "user.name", "fixture"); git("config", "user.email", "fixture@example.invalid");
fs.mkdirSync(path.join(repo, "seats"));
fs.writeFileSync(path.join(repo, "seats/slowed.selftest.sh"), "#!/usr/bin/env bash\nsleep 1\n");
fs.writeFileSync(path.join(repo, "seats/selftest-core.list"), "slowed.selftest.sh\n");
git("add", "."); git("commit", "-qm", "base");
git("checkout", "-qb", "candidate"); fs.writeFileSync(path.join(repo, "candidate"), "candidate\n"); git("add", "."); git("commit", "-qm", "candidate"); const reviewed = git("rev-parse", "HEAD");
git("checkout", "-q", "main"); fs.writeFileSync(path.join(repo, "main-change"), "main\n"); git("add", "."); git("commit", "-qm", "main"); const main = git("rev-parse", "HEAD");
git("checkout", "-qb", "batch"); git("merge", "--no-ff", "-qm", "combined batch", "candidate"); const batch = git("rev-parse", "HEAD");
git("checkout", "-qb", "unrelated", main); fs.writeFileSync(path.join(repo, "unrelated"), "other\n"); git("add", "."); git("commit", "-qm", "not candidate"); const unrelated = git("rev-parse", "HEAD");
git("checkout", "-qb", "wrong-first-parent", reviewed); git("merge", "--no-ff", "-qm", "main only second parent", main); const wrongParent = git("rev-parse", "HEAD");
git("checkout", "-q", "batch");
const seed = fs.readFileSync(seedFile, "utf8");
const swap = (source: string, from: string, to: string) => {
  for (const key of ["tip", "preparedTip", "finalTip"]) {
    const needle = `${key}=${from}`, lines = source.split("\n");
    assert.equal(lines.filter(line => line === needle).length, 1, `one anchored ${key} record`);
    source = lines.map(line => line === needle ? `${key}=${to}` : line).join("\n");
  }
  return source;
};
const valid = swap(seed, seedTip, batch);
const write = (name: string, text: string) => { const file = path.join(root, `batch-${name}.log`); fs.writeFileSync(file, text); return file; };
const good = write("accept", valid);
const accepted = readBatchSweep(repo, reviewed, good);
assert.equal(accepted.rc, 0); assert.equal(accepted.required, true); assert.equal(accepted.tip, reviewed); assert.equal(accepted.batch.tip, batch); assert.equal(accepted.batch.main, main);
assert.equal(accepted.timings.tierLine, 'selftest-sweep: tier=full suites=1');
assert.deepEqual(accepted.timings.slowest, accepted.timings.suites);
assert.equal(accepted.timings.slowest[0].suite, 'slowed.selftest.sh');
console.log("PASS batch accepts passing descendant containing reviewed tip and current main on first-parent chain, with timings");
// Shape fixtures are derived from the real captured outer prefix; these six
// timings are deliberate test data, not a claim that six real suites ran.
const prefix = /^selftest-sweep: START (.+\/seats\/)slowed.selftest.sh$/m.exec(valid)![1];
const names = ['a','b','c','d','e','f'], seconds = [4,6,2,9,0,3];
const records = names.map((name,i)=>`selftest-sweep: START ${prefix}${name}.selftest.sh\nselftest-sweep: PASS ${prefix}${name}.selftest.sh elapsed=${seconds[i]}s`).join('\n');
const shaped = `selftest-sweep: tier=full suites=6\n${records}\nselftest-sweep: PASS (6 suite(s), 25s)\n`;
const top = readSweepTimings(shaped);
assert.equal(top.totalSeconds,25);assert.deepEqual(top.slowest.map(s=>s.suite),['d','b','a','f','c'].map(n=>n+'.selftest.sh'));
assert.deepEqual(top.slowest.map(s=>s.seconds),[9,6,4,3,2]);
const nested = `selftest-sweep: tier=full suites=1\nselftest-sweep: START /nested/seats/other.selftest.sh\nselftest-sweep: PASS /nested/seats/other.selftest.sh elapsed=999s\nselftest-sweep: PASS (1 suite(s), 999s)\n`;
assert.deepEqual(readSweepTimings(shaped.replace(records,records+'\n'+nested)).slowest,top.slowest);
const failed = `selftest-sweep: tier=full suites=1\nselftest-sweep: START ${prefix}fail.selftest.sh\nselftest-sweep: FAIL ${prefix}fail.selftest.sh rc=7 elapsed=3s\nselftest-sweep: FAIL (1 failure(s) of 1 suite(s), 3s)\n`;
assert.equal(readSweepTimings(failed).slowest[0].seconds,3);
assert.equal(readSweepTimings(failed.replace('rc=7 elapsed=','timed out after 1s (TERM then KILL after 1s grace; rc=137) elapsed=')).totalSeconds,3);
console.log('PASS timings: slowest five sorted, nested runners excluded, FAIL and timeout shapes');
let rejected = 0;
const refuse = (name: string, file: string, why: RegExp) => { assert.throws(() => readBatchSweep(repo, reviewed, file), why, name); rejected++; console.log(`PASS batch refuses ${name}`); };
const oldShape = valid.replace(/^selftest-sweep: tier=full suites=[0-9]+\n/m,'').replace(/ elapsed=[0-9]+s$/gm,'').replace(/(suite\(s\)), [0-9]+s\)/g,'$1)');
refuse('old timing-free envelope',write('old-shape',oldShape),/passing hermetic full-sweep envelope/);
refuse('missing tier',write('no-tier',valid.replace(/^selftest-sweep: tier=full suites=[0-9]+\n/m,'')),/missing tier/);
for(const [name,value] of [['missing',''],['fractional',' elapsed=1.5s'],['negative',' elapsed=-1s'],['overflow',' elapsed=99999999999999999999s']]) {
  refuse(name+' suite seconds',write('seconds-'+name,valid.replace(/ elapsed=[0-9]+s$/m,value)),/outer suite records|safe whole numbers/);
}
assert.throws(()=>readSweepTimings(shaped.replace('25s)','23s)')),/below per-suite sum/);
assert.throws(()=>readSweepTimings(shaped.replace('suites=6','suites=5')),/inventory\/summary mismatch/);
console.log('PASS timings refuse undersized total and inconsistent tier inventory');
refuse("non-ancestor", write("nonancestor", swap(valid, batch, unrelated)), /not a proven ancestor/);
refuse("red rc1", write("red", valid.replace(/\nrc=0\nelapsedMs=/, "\nrc=1\nelapsedMs=")), /passing hermetic full-sweep envelope/);
const stale = write("stale", valid); fs.utimesSync(stale, new Date("1999-12-31T23:59:59Z"), new Date("1999-12-31T23:59:59Z")); refuse("stale", stale, /stale/);
refuse("missing", path.join(root, "batch-does-not-exist.log"), /cannot read safe log/);
refuse("main only second parent", write("wrongparent", swap(valid, batch, wrongParent)), /first-parent chain/);
refuse("wrong command", write("command", valid.replace("command=bash seats/selftest-sweep.sh", "command=bash seats/verify.selftest.sh")), /passing hermetic full-sweep envelope/);
refuse("missing hermetic env", write("env", valid.replace("WHEELHOUSE_SKIP_REAL_PI=1", "WHEELHOUSE_SKIP_REAL_PI=0")), /passing hermetic full-sweep envelope/);
refuse("changed final tip", write("final", valid.replace(`finalTip=${batch}`, `finalTip=${reviewed}`)), /passing hermetic full-sweep envelope/);
refuse("incomplete footer", write("partial", valid.replace(/\nrc=0\nelapsedMs=[0-9]+\n$/, "\n")), /passing hermetic full-sweep envelope/);
refuse("filtered/empty outer records", write("filtered", valid.split("\n").filter(line => !line.startsWith("selftest-sweep: START ")).join("\n")), /inventory\/summary mismatch/);
refuse("failed outer record with fake rc0", write("fail", valid.replace(/selftest-sweep: PASS (.+\/seats\/slowed\.selftest\.sh)/, "selftest-sweep: FAIL $1")), /outer suite records/);
refuse("unknown batch commit", write("unknown", swap(valid, batch, "f".repeat(40))), /cannot establish batch history/);
const dir = path.join(root, "batch-directory.log"); fs.mkdirSync(dir); refuse("directory", dir, /regular file/);
const link = path.join(root, "batch-symlink.log"); fs.symlinkSync(good, link); refuse("symlink", link, /cannot read safe log/);
const hard = path.join(root, "batch-hardlink.log"); fs.linkSync(good, hard); refuse("hardlink", hard, /single-link/); fs.unlinkSync(hard);
const fifo = path.join(root, "batch-fifo.log"); execFileSync("mkfifo", [fifo]); refuse("FIFO without opening/blocking a reader", fifo, /regular file/);
refuse("empty", write("empty", ""), /nonempty/);
const future = write("future", valid); fs.utimesSync(future, new Date(Date.now()+60_000), new Date(Date.now()+60_000)); refuse("future dated", future, /future-dated/);
git("update-ref", "refs/heads/main", reviewed); refuse("current main changed outside first-parent chain", good, /first-parent chain/); git("update-ref", "refs/heads/main", main);
assert.equal(readBatchSweep(repo, reviewed, good).batch.tip, batch);
console.log(`batch validation: PASS (1 accept, ${rejected} unsafe refusals; real captured envelope; no host sweep run)`);
