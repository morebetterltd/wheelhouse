import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { run, retain, copyRuntime, changed } from "./producer-test-support";
const [implementation, scratch, graph, repo] = process.argv.slice(2);
fs.mkdirSync(scratch, { recursive: true });
const root = fs.realpathSync(scratch), original = fs.readFileSync(implementation, "utf8"), records: any[] = [];
const tag = "UPGRADE_SKILLS_ORACLE", valid = fs.readFileSync(path.join(repo, "seats/fixtures/contracts/valid.md"), "utf8");
const env = { ...process.env, WHEELHOUSE_CONTRACT_ROOT: graph };
for (const key of ["WHEELHOUSE_SKIP_BD", "WHEELHOUSE_CONTRACT_FIXTURE", "WHEELHOUSE_INTAKE_FIXTURE"]) delete env[key];
const save = () => retain(root, "upgrade-skills", { original, implementation, records });
async function native(file: string, args: string[], extra: any = {}) {
  const r = await run(file, args, graph, { ...env, ...extra });
  records.push({ kind: "command", native: r }); save();
  assert(!r.error && r.signal === null && r.stdoutEOF && r.stderrEOF, "CONTROL_SETUP command completion"); return r;
}
async function bead(name: string, text: string) {
  const file = path.join(root, name + ".md"); fs.writeFileSync(file, text);
  const create = await native("bd", ["create", "Upgrade fixture " + name, "--body-file", file, "--json"]);
  assert.equal(create.code, 0, create.stderr); const id = JSON.parse(create.stdout).id; assert(id, "CONTROL_SETUP id");
  const show = await native("bd", ["show", id, "--json"]); assert.equal(show.code, 0, show.stderr);
  const row = JSON.parse(show.stdout)[0]; assert.equal(row.id, id); assert.equal(row.description, text);
  records.push({ kind: "graph-input", name, id, row, text }); save(); return id;
}
const quote = (s: string) => /^[A-Za-z0-9_./-]+$/.test(s) ? s : "'" + s.replaceAll("'", "'\\''") + "'";
const expectedCommand = (target: string[]) => "bun seats/contract.ts check " + target.map(quote).join(" ");
const fixParts = ["two-skill upgrade fix:", "ask the producer to revalidate Intent: and Outcomes:", "both installed skills", "one top-level Skills: intent@<version> outcomes@<version>", "versions shown in its fresh assembled brief", "do not merely append outcomes@", "wheelhouse/runbooks/UPGRADE.md#two-skill-contract-gate", "runbooks/UPGRADE.md#two-skill-contract-gate"];
function oracle(r: any, code: number, target: string[]) {
  assert.equal(r.code, code, `${tag}: refusal status: ${r.stderr}`);
  for (const part of [...fixParts, "Recheck: " + expectedCommand(target)]) assert(r.stderr.includes(part), `${tag}: exact repair absent: ${part}: ${r.stderr}`);
}
async function grade(name: string, mode: string, id: string, removal = "") {
  const args = mode === "check" ? [path.join(graph, "seats/contract.ts"), "check", id] : mode === "dispatch" ? [path.join(graph, "seats/adapter.ts"), "dispatch", "worker-1", id, "Fixture work"] : [path.join(graph, "seats/verify.ts"), id, "fleet/fixture", "worker-1", "reviewer-1"];
  const state = fs.readFileSync(path.join(graph, "seats/state.json"), "utf8"), r = await native("bun", args, { WHEELHOUSE_DISPATCH_FORCE: "1" });
  const rec: any = { kind: "case", name, mode, id, removal, source: fs.readFileSync(path.join(graph, "seats/contract.ts"), "utf8"), native: r }; records.push(rec); save();
  assert.equal(r.code, mode === "check" ? 2 : mode === "dispatch" ? 1 : 6, "CONTROL_SETUP expected native policy refusal");
  let error: any; try { oracle(r, mode === "check" ? 2 : mode === "dispatch" ? 1 : 6, [id]); } catch (e) { error = e; }
  assert.equal(fs.readFileSync(path.join(graph, "seats/state.json"), "utf8"), state, `${tag}: seat state changed`);
  assert(!fs.existsSync(path.join(root, "harness-invoked")), `${tag}: refusal reached harness`);
  if (removal) { assert(error?.message.includes(tag), "CONTROL_SETUP repair removal did not reach intended oracle"); rec.rejection = error.message; save(); console.log(`PASS upgrade removal ${name}/${mode}: native${r.code} rejected at ${tag}`); }
  else { if (error) throw error; console.log(`PASS upgrade ${name}/${mode}: native${r.code}, exact producer repair and recheck, no harness`); }
}
try {
  // Create the legacy payload BEFORE installing the gate into this private graph.
  // It is an old-format fixture, not a claim about its creation timestamp.
  const legacy = await bead("pre-gate-single-skill", valid.replace(/^Skills:.*$/m, "Skills: intent@1.0.0"));
  const runtime = copyRuntime(path.dirname(implementation), graph), module = path.join(runtime, "contract.ts"); fs.writeFileSync(module, original);
  fs.writeFileSync(path.join(runtime, "state.json"), JSON.stringify({ seats: {} }));
  fs.mkdirSync(path.join(graph, "wheelhouse/runbooks"), { recursive: true }); fs.copyFileSync(path.join(repo, "runbooks/UPGRADE.md"), path.join(graph, "wheelhouse/runbooks/UPGRADE.md"));
  const bin = path.join(root, "bin"); fs.mkdirSync(bin);
  for (const h of ["pi", "claude", "codex"]) fs.writeFileSync(path.join(bin, h), '#!/bin/sh\nprintf "unexpected harness\\n" >> ' + quote(path.join(root, "harness-invoked")) + '\nexit 97\n', { mode: 0o755 });
  env.PATH = bin + ":" + env.PATH;
  const fresh = await bead("new-unstamped", valid.replace(/^Skills:.*\n/m, ""));
  for (const [name, id] of [["legacy", legacy], ["new", fresh]]) for (const mode of ["check", "dispatch", "review"]) await grade(name, mode, id);
  // An unrelated label must not turn age into permission.
  const label = await native("bd", ["update", legacy, "--add-label", "legacy-contract", "--json"]); assert.equal(label.code, 0, label.stderr);
  await grade("legacy-label-is-not-exemption", "check", legacy);
  // Explicitly simulated producer-reviewed output: no model obedience claim.
  const paired = path.join(root, "simulated-producer-reviewed.md"); fs.writeFileSync(paired, valid);
  const update = await native("bd", ["update", legacy, "--body-file", paired, "--json"]); assert.equal(update.code, 0, update.stderr);
  const accepted = await native("bun", [module, "check", legacy]); assert.equal(accepted.code, 0, accepted.stderr);
  records.push({ kind: "simulated-repaired", id: legacy, native: accepted }); save();
  const legacyFile = path.join(root, "pending $STAMP 'quoted'.md"); fs.writeFileSync(legacyFile, valid.replace(/^Skills:.*$/m, "Skills: intent@1.0.0"));
  const fileResult = await native("bun", [module, "check", "--file", legacyFile]); oracle(fileResult, 2, ["--file", legacyFile]);
  const command = fileResult.stderr.slice(fileResult.stderr.lastIndexOf("Recheck: ") + 9).trim();
  const recheck = await native("bash", ["-c", command], { STAMP: "must-not-expand" }); assert.equal(recheck.code, 2, `${tag}: quoted recheck did not address original file: ${recheck.stderr}`); oracle(recheck, 2, ["--file", legacyFile]);
  records.push({ kind: "quoted-file-recheck", command, native: recheck }); save();
  // Remove only the actionable repair; statuses must remain genuine refusals.
  const repairGuard = '  if (!errors.some(error => error.startsWith("contract: Skills:"))) return errors;';
  fs.writeFileSync(module, changed(original, repairGuard, "  if (true) return errors;"));
  for (const mode of ["check", "dispatch", "review"]) await grade("repair-removed", mode, fresh, "repair-removed");
  // Disable only the actual mandatory gate. The same new input now passes CLI0.
  fs.writeFileSync(module, changed(original, "const REQUIRE_SKILLS = true;", "const REQUIRE_SKILLS = false;"));
  const unsafe = await native("bun", [module, "check", fresh]); assert.equal(unsafe.code, 0, "CONTROL_SETUP gate-off must actually accept new unstamped input");
  let rejection = ""; try { oracle(unsafe, 2, [fresh]); } catch (e: any) { rejection = e.message; }
  assert(rejection.includes(tag), "CONTROL_SETUP gate-off did not reach refusal oracle"); records.push({ kind: "gate-off", native: unsafe, rejection, source: fs.readFileSync(module, "utf8") }); save();
  fs.writeFileSync(module, original);
  const doc = fs.readFileSync(path.join(repo, "runbooks/UPGRADE.md"), "utf8"), required = ["### Two-skill contract gate", "do not bulk-append", "reset <producer-seat>", "steer <producer-seat>", "new unstamped", "bun seats/contract.ts check <bead-id>"];
  for (const text of required) assert(doc.includes(text), `${tag}: documented upgrade instruction missing: ${text}`);
  let removed = 0; for (const text of required) { assert(!doc.replaceAll(text, "").includes(text)); let e: any; try { assert(doc.replaceAll(text, "").includes(text), `${tag}: removed documented path`); } catch (x) { e = x; } assert(e.message.includes(tag)); removed++; }
  records.push({ kind: "docs", doc, required, removed }); save();
  console.log("upgrade skill checks: legacy/new check+dispatch+review exact refusals; simulated repaired check0; quoted recheck2; 3 repair removals + gate-off native0 + 6 document removals");
} finally { save(); }
