// Test the audit suite's real baseline and pre-allocation refusal, offline.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const [root, scratch] = process.argv.slice(2);
assert(fs.existsSync(path.join(scratch, ".wheelhouse-selftest-fixture")), "owned fixture must exist");
const suite = path.join(root, "seats/upgrade-contract-audit.selftest.sh");
const source = fs.readFileSync(suite, "utf8"), absent = "f".repeat(40);
function git(args: string[]) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
function checkDefault(code: string) {
  const match = /^BASELINE=([0-9a-f]{40})$/m.exec(code);
  assert(match, "baseline must pin a full public commit ID");
  const baseline = match[1];
  git(["cat-file", "-e", `${baseline}^{commit}`]);
  git(["merge-base", "--is-ancestor", baseline, "HEAD"]);
  const graph = git(["show", `${baseline}:contracts/GRAPH.md`]);
  assert(!graph.includes("**Every bead is a contract.**"), "baseline must predate the work-contract grammar");
  const files = git(["ls-tree", "-r", "--name-only", baseline, "contracts/"]).trim().split("\n");
  assert(files.includes("contracts/DESIGNER.md"), "baseline needs the old planning brief");
  assert(!files.includes("contracts/PRODUCER.md"), "baseline must predate the producer brief");
  assert(git(["show", "HEAD:contracts/GRAPH.md"]).includes("**Every bead is a contract.**"), "target needs the new grammar");
  assert(/^[+-].*`[a-z/.]+`/m.test(git(["diff", baseline, "HEAD", "--", "contracts/"])), "step 7 must have a real named-path contract diff");
  return baseline;
}
const baseline = checkDefault(source);
console.log(`PASS audit baseline: ${baseline} exists, is an ancestor, has old contract shape and a real named-path diff`);
const noAllocation = path.join(scratch, "must-not-allocate");
assert(!fs.existsSync(noAllocation));
const missingSource = source.replace(`BASELINE=${baseline}`, `BASELINE=${absent}`);
const admissionTmp = path.join(scratch, "audit-admission-tmp"); fs.mkdirSync(admissionTmp);
let lastMissingResult: any;
function observeMissing(code: string, isolateAdmission = true) {
  const anchor = '. "$HERE/selftest-lib.sh"'; assert.equal(code.split(anchor).length, 2);
  if (isolateAdmission) code = code.replace(anchor, () => `saved_baseline_tmp=$TMPDIR; export TMPDIR=${JSON.stringify(admissionTmp)}; ${anchor}; export TMPDIR="$saved_baseline_tmp"`);
  return lastMissingResult = spawnSync("bash", ["-c", code, suite], { cwd: root, env: { ...process.env, TMPDIR: noAllocation }, encoding: "utf8" });
}
function checkMissing(code: string) {
  const result = observeMissing(code);
  assert.ifError(result.error);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert(result.stderr.includes(`STOP: upgrade contract audit baseline "${absent}" is missing from template history`), result.stderr);
  assert(result.stderr.includes("fetch complete public history"), "refusal must name the remedy");
  assert.equal(result.stdout, "", "no cases may start before refusal");
  assert(!result.stderr.includes("mktemp"), "allocation must not precede refusal");
  assert(!fs.existsSync(noAllocation), "refusal must leave allocation root absent");
}
const early = observeMissing(missingSource, false);
assert.ifError(early.error); assert.equal(early.status, 2, early.stdout + early.stderr); assert.equal(early.stdout, "");
assert(early.stderr.includes(`STOP: upgrade contract audit baseline "${absent}"`) || (early.stderr.includes("STOP:") && early.stderr.includes(noAllocation)), "earlier refusal must name the missing baseline or bad TMPDIR");
assert(!fs.existsSync(noAllocation), "earlier refusal must leave allocation root absent");
checkMissing(missingSource);
console.log("PASS missing audit baseline: exit=2 names the absent commit and remedy before fixture allocation");
for (const [name, code] of [["missing default", missingSource], ["new-contract default", source.replace(`BASELINE=${baseline}`, `BASELINE=${git(["rev-parse", "HEAD"]).trim()}`)]]) {
  let caught = false; try { checkDefault(code); } catch { caught = true; }
  assert(caught, `${name} control did not fail`);
  console.log(`PASS negative control: ${name} fails old-shape/default validation`);
}
const guard = 'if ! git -C "$ROOT" cat-file -e "${BASELINE}^{commit}" >/dev/null 2>&1; then';
assert.equal(missingSource.split(guard).length, 2, "one early-refusal mutation anchor");
let caught = false; try { checkMissing(missingSource.replace(guard, "if false; then")); } catch { caught = true; }
assert(caught, "removed preflight control passed");
assert(lastMissingResult.stderr.includes("STOP: mktemp failed for fixture template") && lastMissingResult.stderr.includes(noAllocation), "removed baseline guard must reach actual fixture allocation, not fail admission setup");
console.log("PASS negative control: removing preflight fails the early-refusal leg");
