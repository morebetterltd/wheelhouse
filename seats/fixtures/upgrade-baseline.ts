// Exercise the actual suite's admission path without entering recursive setup.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "./fixture-command.cjs";

const [root, scratch] = process.argv.slice(2);
assert(fs.existsSync(path.join(scratch, ".wheelhouse-selftest-fixture")), "owned fixture must exist");
const suite = path.join(root, "seats/upgrade-runbook.selftest.sh");
const source = fs.readFileSync(suite, "utf8");
const absent = "f".repeat(40);
const git = (args: string[]) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
assert.notEqual(git(["cat-file", "-e", `${absent}^{commit}`]).status, 0, "negative-control subject must be absent");
function checkDefault(code: string) {
  const match = /^BASELINE=\$\{WHEELHOUSE_UPGRADE_SELFTEST_BASELINE:-([0-9a-f]{7,40})\}$/m.exec(code);
  assert(match, "default must pin a literal public commit");
  const baseline = match[1];
  const result = git(["cat-file", "-e", `${baseline}^{commit}`]);
  assert.equal(result.status, 0, `default baseline missing: ${baseline}: ${result.stderr}`);
  assert.equal(git(["merge-base", "--is-ancestor", baseline, "HEAD"]).status, 0, "default must be in the template's history");
  for (const file of ["contracts/WORKER.md", "runbooks/PROMOTION.md", "runbooks/RUNNING_THE_LOOP.md", "runbooks/UPGRADE.md"])
    assert.equal(git(["cat-file", "-e", `${baseline}:${file}`]).status, 0, `baseline lacks ${file}`);
  for (const file of ["runbooks/PROMOTION.md", "runbooks/RUNNING_THE_LOOP.md"])
    assert.equal(git(["diff", "--quiet", baseline, "HEAD", "--", file]).status, 1, `${file} must be old enough to exercise an update`);
  return baseline;
}
const baseline = checkDefault(source);
console.log(`PASS upgrade baseline: ${baseline} exists, is an ancestor, has all four files and both old runbooks`);

const noAllocation = path.join(scratch, "must-not-allocate");
assert(!fs.existsSync(noAllocation));
const env = { ...process.env, TMPDIR: noAllocation, WHEELHOUSE_UPGRADE_SELFTEST_BASELINE: absent,
  WHEELHOUSE_UPGRADE_SELFTEST_SOURCE_ONLY: "0", WHEELHOUSE_UPGRADE_CACHE_ONLY: "0" };
const admissionTmp = path.join(scratch, "baseline-admission-tmp"); fs.mkdirSync(admissionTmp);
const admissionReceipt = path.join(scratch, "baseline-admission-tmp.receipt");
let lastMissingResult: any;
function observeMissing(code = source, isolateAdmission = true) {
  // Admission itself now observes native commands through private files. Give
  // ONLY that real admission a valid owned scratch root, then restore the bad
  // TMPDIR before the baseline guard and fixture allocation. No bypass token.
  const anchor = '. "$SELFTEST_LIB"';
  assert.equal(code.split(anchor).length, 2);
  fs.rmSync(admissionReceipt, { force: true });
  const observed = `printf '%s\\n' "$TMPDIR" > ${JSON.stringify(admissionReceipt)}; ${anchor}`;
  code = code.replace(anchor, () => isolateAdmission
    ? `saved_baseline_tmp=$TMPDIR; export TMPDIR=${JSON.stringify(admissionTmp)}; ${observed}; export TMPDIR="$saved_baseline_tmp"`
    : observed);
  lastMissingResult = spawnSync("bash", ["-c", code, suite], { cwd: root, env, encoding: "utf8" });
  assert.ifError(lastMissingResult.error); assert.equal(lastMissingResult.signal ?? null, null);
  assert(fs.existsSync(admissionReceipt), "real admission boundary must be reached");
  assert.equal(fs.readFileSync(admissionReceipt, "utf8"), admissionTmp + "\n",
    "BASELINE_ADMISSION_ORACLE: supply native admission capture scratch before restoring invalid allocator TMPDIR");
  return lastMissingResult;
}
function checkMissing(code?: string) {
  const result = observeMissing(code);
  assert.ifError(result.error);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert(result.stderr.includes(`STOP: upgrade selftest baseline "${absent}" is missing from template history`), result.stderr);
  assert(result.stderr.includes("WHEELHOUSE_UPGRADE_SELFTEST_BASELINE"), "refusal must name the remedy");
  assert.equal(result.stdout, "", "no test cases may start before refusal");
  assert(!result.stderr.includes("mktemp"), "fixture allocation ran before refusal");
  assert(!fs.existsSync(noAllocation), "refusal must leave allocation root absent");
}
const early = observeMissing(source);
assert.ifError(early.error); assert.equal(early.status, 2, early.stdout + early.stderr);
assert.equal(early.stdout, "");
assert(early.stderr.includes(`STOP: upgrade selftest baseline "${absent}" is missing from template history`), early.stderr);
assert(!fs.existsSync(noAllocation), "earlier refusal must not allocate anything");
checkMissing();
console.log(`PASS missing baseline: exit=2 names ${absent}, gives remedy, no fixture setup`);

let caught = false;
try { checkDefault(source.replace(`:-${baseline}}`, `:-${absent}}`)); } catch { caught = true; }
assert(caught, "default-availability regression passed with a missing default");
console.log("PASS negative control: missing default fails the availability/old-shape leg");
const guard = 'if [ "${WHEELHOUSE_UPGRADE_CACHE_ONLY:-0}" != 1 ] && ! git -C "$TEMPLATE" cat-file -e "${BASELINE}^{commit}" >/dev/null 2>&1; then';
assert.equal(source.split(guard).length, 2, "preflight mutation anchor must match exactly once");
caught = false;
try { checkMissing(source.replace(guard, guard.replace("&& ! git", "&& false && ! git"))); } catch { caught = true; }
assert(caught, "missing-baseline regression passed with preflight removed");
assert(lastMissingResult.stderr.includes("STOP: mktemp failed for fixture template") && lastMissingResult.stderr.includes(noAllocation), "removed baseline guard must actually reach the allocator, not fail admission setup");
console.log("PASS negative control: removing preflight fails the early-refusal leg");
