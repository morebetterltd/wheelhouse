import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { run, retain, copyRuntime, changed } from "./producer-test-support";
import { readContractSkill } from "../briefs";
const [implementation, scratch, graph, repo] = process.argv.slice(2);
fs.mkdirSync(scratch, { recursive: true }); const root = fs.realpathSync(scratch), original = fs.readFileSync(implementation, "utf8"), records: any[] = [];
const tag = "PRODUCER_STAMP_ASSERTION";
const installed = { intent: readContractSkill(repo, "intent").version, outcomes: readContractSkill(repo, "outcomes").version };
// Synthetic current-version input, not a rewrite of the historical fixture.
const valid = fs.readFileSync(path.join(repo, "seats/fixtures/contracts/valid.md"), "utf8")
  .replace(/^Skills:.*$/m, `Skills: intent@${installed.intent} outcomes@${installed.outcomes}`);
const env = { ...process.env, WHEELHOUSE_CONTRACT_ROOT: graph }; for (const k of ["WHEELHOUSE_SKIP_BD", "WHEELHOUSE_CONTRACT_FIXTURE", "WHEELHOUSE_INTAKE_FIXTURE"]) delete env[k];
const save = () => retain(root, "producer-stamps", { implementation, original, records });
async function native(file: string, args: string[], extra: any = {}, cwd = graph) {
  const r = await run(file, args, cwd, { ...env, ...extra }); records.push({ kind: "command", native: r }); save();
  assert(!r.error && r.signal === null && r.stdoutEOF && r.stderrEOF, "CONTROL_SETUP native command completion"); return r;
}
function body(skills: string | null) { return valid.replace(/^Skills:.*\n/m, skills === null ? "" : `Skills: ${skills}\n`); }
function fixture(name: string, text: string) { const file = path.join(root, name + ".md"); fs.writeFileSync(file, text); return file; }
const specs: any[] = [];
function fileCase(name: string, text: string, code: number, needle = "", extra: any = {}) { const file = fixture(name, text); const spec = { name, args: ["check", "--file", file], code, needle, extra, text }; specs.push(spec); return spec; }
const good = fileCase("stamped", valid, 0), missing = fileCase("missing", body(null), 2, "Skills: missing");
const malformed = ["intent@1.0.0", "outcomes@1.0.0", "intent@ outcomes@1.0.0", "intent@1.0.0 outcomes@", "intent@1.0.0 intent@1.0.0", "intent@1.0.0 outcomes@1.0.0 extra"];
const badTokens = malformed.map((s, i) => fileCase("bad-token-" + i, body(s), 2, "Skills: expected"));
const blank = fileCase("blank", body(""), 2, "Skills: missing");
const duplicate = fileCase("duplicate", "Skills: intent@1.0.0 outcomes@1.0.0\n" + valid, 2, "Skills: duplicate line");
const quoted = fileCase("quoted", "> Skills: intent@1.0.0 outcomes@1.0.0\n" + body(null), 2, "Skills: missing");
const fence = String.fromCharCode(96).repeat(3);
const fenced = fileCase("fenced", fence + "\nSkills: intent@1.0.0 outcomes@1.0.0\n" + fence + "\n" + body(null), 2, "Skills: missing");
const old = fileCase("older-version", body("intent@0.9.0 outcomes@0.8.0"), 0, `WARN: contract written with intent@0.9.0, installed intent@${installed.intent}`); old.secondNeedle = `WARN: contract written with outcomes@0.8.0, installed outcomes@${installed.outcomes}`;
const carve = body("install-procedure carve-out");
const unlabelled = fileCase("unlabelled", carve, 2, "requires wheelhouse-bootstrap or wheelhouse-smoke label");
const pseudo = fileCase("pseudo-bootstrap", "labels: wheelhouse-bootstrap\n" + carve, 0, "", { WHEELHOUSE_SKIP_BD: "1" });
fileCase("pseudo-smoke", "labels: wheelhouse-smoke\n" + carve, 0, "", { WHEELHOUSE_SKIP_BD: "1" });
const normalPseudo = fileCase("normal-file-not-authority", "labels: wheelhouse-bootstrap\n" + carve, 2, "Skills:");
const late = fileCase("late-label", "\nlabels: wheelhouse-bootstrap\n" + carve, 2, "Skills:", { WHEELHOUSE_SKIP_BD: "1" });
fileCase("wrong-label", "labels: bootstrap\n" + carve, 2, "Skills:", { WHEELHOUSE_SKIP_BD: "1" });
fileCase("carve-keeps-signal-gate", "labels: wheelhouse-bootstrap\n" + carve.replace(/^Signal:.*\n/m, ""), 2, "Signal: missing", { WHEELHOUSE_SKIP_BD: "1" });
fileCase("carve-keeps-surface-gate", "labels: wheelhouse-bootstrap\n" + carve.replace(/^  surface:.*\n/m, ""), 2, "surface: missing", { WHEELHOUSE_SKIP_BD: "1" });
async function grade(spec: any, module = implementation, removal = "", badCode?: number) {
  const r = await native("bun", [module, ...spec.args], spec.extra);
  const rec: any = { kind: "case", spec, module, source: fs.readFileSync(module, "utf8"), native: r, removal }; records.push(rec); save();
  if (removal) assert.equal(r.code, badCode, `CONTROL_SETUP ${removal}: did not reach expected bad native result: ${r.stderr}`);
  let error: any; try {
    assert.equal(r.code, spec.code, `${tag} ${spec.name}: native status: ${r.stderr}`);
    assert.equal(r.stdout, "", `${tag} ${spec.name}: unexpected stdout`);
    if (spec.needle) assert(r.stderr.includes(spec.needle), `${tag} ${spec.name}: required diagnostic absent: ${r.stderr}`);
    else assert.equal(r.stderr, "", `${tag} ${spec.name}: unexpected stderr`);
    if (spec.secondNeedle) assert(r.stderr.includes(spec.secondNeedle), `${tag} ${spec.name}: outcomes warning absent`);
  } catch (e) { error = e; }
  if (removal) { assert(error?.message.includes(tag), `CONTROL_SETUP ${removal}: intended oracle did not reject`); rec.rejection = error.message; save(); console.log(`PASS stamp removal ${removal}: actual native${r.code} rejected at ${tag}`); }
  else { if (error) throw error; console.log(`PASS stamp ${spec.name}: native${r.code}/signalnull/EOF`); }
}
try {
  // Installed versions are independent inputs, not inferred from the stamp.
  for (const n of ["intent", "outcomes"]) { const dest = path.join(graph, ".agents/skills", n, "SKILL.md"); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(path.join(repo, ".agents/skills", n, "SKILL.md"), dest); }
  async function bead(name: string, text: string, labels: string[] = []) {
    const file = fixture(name, text), r = await native("bd", ["create", "Fixture stamp " + name, "--body-file", file, ...(labels.length ? ["--labels", labels.join(",")] : []), "--json"]);
    assert.equal(r.code, 0, r.stderr); const id = JSON.parse(r.stdout).id; assert(id, "CONTROL_SETUP bead id");
    const show = await native("bd", ["show", id, "--json"]); assert.equal(show.code, 0); const row = JSON.parse(show.stdout)[0]; assert.equal(row.id, id); assert.deepEqual(row.labels ?? [], labels);
    const spec = { name, args: ["check", id], code: labels.length ? 0 : 2, needle: labels.length ? "" : "Skills:", extra: {}, text, realLabels: labels };
    specs.push(spec); return spec;
  }
  const realBootstrap = await bead("real-bootstrap", carve, ["wheelhouse-bootstrap"]);
  const realSmoke = await bead("real-smoke", carve, ["wheelhouse-smoke"]);
  const realUnlabelled = await bead("real-unlabelled", carve);
  const realSpoof = await bead("prose-cannot-label", "labels: wheelhouse-bootstrap\n" + carve);
  const mock = path.join(root, "failed-bd-bin"); fs.mkdirSync(mock); fs.writeFileSync(path.join(mock, "bd"), "#!/bin/sh\nprintf 'fixture-bd-unavailable\\n' >&2\nexit 7\n", { mode: 0o755 });
  const fallbackEnv = { PATH: mock + ":" + process.env.PATH, WHEELHOUSE_CONTRACT_FIXTURE: normalPseudo.args[2] };
  const calibration = await native("bd", ["show", "fixture-fallback", "--json"], fallbackEnv); assert.equal(calibration.code, 7); assert.equal(calibration.stderr, "fixture-bd-unavailable\n");
  const fallback = { name: "normal-fallback-cannot-label", args: ["check", "fixture-fallback"], code: 2, needle: "Skills:", extra: fallbackEnv }; specs.push(fallback);
  for (const s of specs) await grade(s);
  function mutant(name: string, old: string, replacement: string) {
    const dest = copyRuntime(path.dirname(implementation), path.join(root, "runtime-" + name)), file = path.join(dest, "contract.ts");
    fs.writeFileSync(file, changed(original, old, replacement)); return file;
  }
  const off = mutant("off", "const REQUIRE_SKILLS = true;", "const REQUIRE_SKILLS = false;");
  for (const s of [missing, blank, quoted, fenced]) await grade(s, off, "requireSkills-off-" + s.name, 0);
  const weakLine = original.split("\n").find(l => l.includes('else if (!stampedSkills(parsed.skills))'))!; assert(weakLine, "CONTROL_SETUP stamp validation line");
  const weak = mutant("presence-only", weakLine, weakLine.replace("!stampedSkills(parsed.skills)", "false"));
  for (const s of badTokens) await grade(s, weak, "presence-only-" + s.name, 0);
  await grade(duplicate, mutant("duplicate", 'if (sawSkills) parsed.errors.push("contract: Skills: duplicate line");', '// planted removal: duplicate stamp accepted'), "duplicate-stamp", 0);
  const labelLine = original.split("\n").find(l => l.includes('if (!options.labels?.some'))!; assert(labelLine, "CONTROL_SETUP label authority line");
  const accept = mutant("unlabelled", labelLine, labelLine.replace(/^\s*if \(.*\) errors.push/, "      if (false) errors.push"));
  for (const s of [unlabelled, realUnlabelled, realSpoof, late]) await grade(s, accept, "unlabelled-" + s.name, 0);
  const block = mutant("block-carveout", labelLine, '      errors.push("contract: Skills: planted blocked carve-out");');
  for (const s of [pseudo, realBootstrap, realSmoke]) await grade(s, block, "block-" + s.name, 2);
  const warning = 'if (written !== installed) console.error(`WARN: contract written with ${name}@${written}, installed ${name}@${installed}`);';
  await grade(old, mutant("no-warning", warning, '// planted removal: no version warning'), "no-version-warning", 0);
  await grade(old, mutant("refuse-old", warning, 'if (written !== installed) errors.push("contract: Skills: planted old-version refusal");'), "refuse-old-version", 2);
  const pseudoAlways = mutant("pseudo-always", 'process.env.WHEELHOUSE_SKIP_BD === "1" ? text.split', 'true ? text.split');
  for (const s of [normalPseudo, fallback]) await grade(s, pseudoAlways, "pseudo-authority-" + s.name, 0);
  console.log(`producer stamp checks: ${specs.length} cases; default gate, real graph labels and advisory versions verified`);
} finally { save(); }
