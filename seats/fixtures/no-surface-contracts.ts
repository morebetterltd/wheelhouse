// Three no-surface legs plus actual-source removal controls; no graph writes.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
const [manual, contract, work, repo] = process.argv.slice(2);
fs.mkdirSync(work, { recursive: true });
const reference = path.join(repo, "seats/fixtures/verification/no-surface");
const example = path.join(repo, ".agents/skills/outcomes/examples/first-feature.md");
assert(fs.statSync(reference).isDirectory()); assert(fs.statSync(example).isFile());
const text = fs.readFileSync(example, "utf8"), source = fs.readFileSync(manual, "utf8");
const env = { ...process.env, WHEELHOUSE_CONTRACT_ROOT: work, WHEELHOUSE_SKIP_BD: "1" };
let sequence = 0;
function run(tool: string, args: string[]) {
  const r = spawnSync("bun", [tool, ...args], { env, encoding: "utf8", timeout: 30000, killSignal: "SIGKILL" });
  fs.writeFileSync(path.join(work, `${++sequence}.json`), JSON.stringify({ command: ["bun", tool, ...args], status: r.status, signal: r.signal, error: r.error?.message ?? null, stdout: r.stdout, stderr: r.stderr }, null, 2));
  assert(!r.error, String(r.error)); assert.equal(r.signal, null);
  assert(!/Cannot find module|SyntaxError/.test(r.stderr), "CONTROL_SETUP module/parser failure");
  return r;
}
function lint(tool: string, file = example) { return run(tool, ["lint-contract", "--file", file, "--repo", reference]); }
function accepted(r: ReturnType<typeof run>, output: string) { assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, output); assert.equal(r.stderr, ""); }
function refused(r: ReturnType<typeof run>, needle: string) { assert.equal(r.status, 2); assert(r.stderr.includes(needle), r.stderr); }
function fixture(name: string, body: string) { const file = path.join(work, name + ".md"); fs.writeFileSync(file, body); return file; }
function mutant(name: string, old: string, replacement: string) {
  assert.equal(source.split(old).length, 2, "CONTROL_SETUP source needle");
  const dir = path.join(work, name); fs.mkdirSync(dir);
  for (const file of fs.readdirSync(path.dirname(manual))) if (/\.(?:ts|[cm]?js)$/.test(file)) fs.copyFileSync(path.join(path.dirname(manual), file), path.join(dir, file));
  const file = path.join(dir, "manual.ts"); fs.writeFileSync(file, source.replace(old, replacement)); return file;
}
function removal(name: string, oracle: () => void) {
  assert.throws(oracle, assert.AssertionError, "removal must fail the same oracle");
  console.log(`PASS no-surface removal ${name}: oracle rejected actual-source mutation`);
}
accepted(run(manual, ["check", "--repo", reference]), "manual ok: no surface\n");
accepted(run(manual, ["features", "--repo", reference, "--json"]), "[]\n");
console.log("PASS no-surface fixture: manual ok: no surface");
const shape = run(contract, ["check", "--file", example]);
accepted(shape, "");
accepted(lint(manual), "map outcomes: expected 1, found 1\n");
console.log("PASS no-surface first-feature: contract and lint accepted");
assert.equal(text.split("- O2 ").length, 2); assert.equal(text.split("- O3 ").length, 2);
const missing = fixture("missing-sections", text.split("- O2 ")[0] + text.slice(text.indexOf("- O3 ")).replace("- O3 ", "- O2 "));
refused(lint(manual, missing), "missing manual-sections outcome for no-surface");
const noMap = fixture("missing-map", text.split("- O3 ")[0]);
refused(lint(manual, noMap), "missing map outcome for reports");
for (const [name, body] of [
  ["wrong-manual", text.replace("verify-no-surface/SKILL.md", "verify-other/SKILL.md")],
  ["incomplete-sections", text.replace("Launch, Doctor, Drive, Evidence and Cleanup sections", "Launch and Drive sections")],
  ["reader-sections", text.replace("machine — the verifier reading the manual", "person-reading — the verifier reading the manual").replace("check: run — bun seats/manual.ts check", "check: read — bun seats/manual.ts check")],
]) refused(lint(manual, fixture(name, body)), "missing manual-sections outcome");
// Artifact-only work on the same no-surface repo must not acquire either duty.
const chore = fixture("artifact-only", fs.readFileSync(path.join(repo, ".agents/skills/outcomes/examples/map-chore.md"), "utf8"));
accepted(lint(manual, chore), "map outcomes: expected 0, found 0\n");
console.log("PASS no-surface missing manual-sections: refused naming the outcome");
const oldOutput = mutant("old-output", 'manual.surface === "none" ? "manual ok: no surface" : ', "");
removal("no-surface-output", () => accepted(run(oldOutput, ["check", "--repo", reference]), "manual ok: no surface\n"));
const noRecognition = mutant("sections-unrecognized", "const hasManualSections = parsed.outcomes.some(outcome =>", "const hasManualSections = false && parsed.outcomes.some(outcome =>");
removal("first-feature-recognition", () => accepted(lint(noRecognition), "map outcomes: expected 1, found 1\n"));
const noRequirement = mutant("sections-not-required", 'const needsManualSections = manual.surface === "none" && needed.size > 0;', "const needsManualSections = false;");
removal("manual-sections-not-required", () => refused(lint(noRequirement, missing), "missing manual-sections outcome for no-surface"));
console.log("no-surface checks: 3 legs, 3 actual-source failing removals");
