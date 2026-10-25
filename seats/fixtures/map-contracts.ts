import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
const [manual, contract, work, repo] = process.argv.slice(2);
fs.mkdirSync(work, { recursive: true });
const root = fs.realpathSync(work), reference = path.join(repo, "seats/fixtures/verification/five-features"), original = fs.readFileSync(manual, "utf8"), records: any[] = [];
const tag = "MAP_CONTRACT_ORACLE", evidence = process.env.WHEELHOUSE_MAP_EVIDENCE;
function save() { const s = JSON.stringify({ manual, contract, original, records }, null, 2); fs.writeFileSync(path.join(root, "records.json"), s); if (evidence) fs.writeFileSync(path.join(evidence, `map-contracts-${process.pid}.json`), s); }
async function native(file: string, args: string[], extra: any = {}) {
  const c = spawn(file, args, { cwd: repo, env: { ...process.env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
  const so: Buffer[] = [], se: Buffer[] = []; let stdoutEOF = false, stderrEOF = false;
  c.stdout.on("data", x => so.push(x)); c.stderr.on("data", x => se.push(x)); c.stdout.on("end", () => stdoutEOF = true); c.stderr.on("end", () => stderrEOF = true);
  const result = await new Promise<any>((yes, no) => { c.once("error", no); c.once("close", (code, signal) => yes({ code, signal })); });
  const r = { file, args, pid: c.pid, ...result, stdoutEOF, stderrEOF, stdout: Buffer.concat(so).toString(), stderr: Buffer.concat(se).toString() };
  records.push({ kind: "command", native: r }); save(); assert.equal(r.signal, null); assert(stdoutEOF && stderrEOF); assert(!/Cannot find module|SyntaxError/.test(r.stderr), "CONTROL_SETUP module/parser failure"); return r;
}
function fixture(name: string, text: string) { const file = path.join(root, name + ".md"); fs.writeFileSync(file, text); return file; }
const examples = ["new-feature", "moved-button", "unchanged-surface", "chore"], counts = [1, 1, 0, 0];
const texts = examples.map(n => fs.readFileSync(path.join(repo, ".agents/skills/outcomes/examples/map-" + n + ".md"), "utf8"));
const env = { WHEELHOUSE_SKIP_BD: "1", WHEELHOUSE_CONTRACT_ROOT: root, WHEELHOUSE_INTAKE_FIXTURE: path.join(root, "posted.jsonl") };
const specs: any[] = [];
function spec(name: string, text: string, expected: number, found: number, code = 0, needle = "") { const s = { name, text, file: fixture(name, text), expected, found, code, needle }; specs.push(s); return s; }
async function grade(s: any, implementation = manual, removal = "", badCode?: number) {
  const r = await native("bun", [implementation, "lint-contract", "--file", s.file, "--repo", s.repo ?? reference], env), rec: any = { kind: "case", spec: s, native: r, removal, source: fs.readFileSync(implementation, "utf8") }; records.push(rec); save();
  if (removal) assert.equal(r.code, badCode, "CONTROL_SETUP source mutation did not reach expected bad native result: " + r.stderr);
  let error: any; try { assert.equal(r.code, s.code, `${tag} ${s.name}: native result: ${r.stderr}`); assert.equal(r.stdout, `map outcomes: expected ${s.expected}, found ${s.found}\n`, `${tag}: counts`); if (s.needle) assert(r.stderr.includes(s.needle), `${tag}: mismatch diagnostic: ${r.stderr}`); else assert.equal(r.stderr, "", `${tag}: unexpected stderr`); } catch (e) { error = e; }
  if (removal) { assert(error?.message.includes(tag), "CONTROL_SETUP not intended map oracle"); rec.rejection = error.message; save(); console.log(`PASS map removal ${removal}: actual native${r.code} rejected at ${tag}`); }
  else { if (error) throw error; console.log(`PASS map ${s.name}: ${r.stdout.trim()} native${r.code}`); }
}
function changed(s: string, old: string, replacement: string) { assert.equal(s.split(old).length, 2, "CONTROL_SETUP source needle"); return s.replace(old, replacement); }
function mutant(name: string, old: string, replacement: string) {
  const dir = path.join(root, name, "seats"); fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(path.dirname(manual))) if (/\.(?:ts|[cm]?js)$/.test(f)) fs.copyFileSync(path.join(path.dirname(manual), f), path.join(dir, f));
  const file = path.join(dir, "manual.ts"); fs.writeFileSync(file, changed(original, old, replacement)); return file;
}
try {
  const catalog = await native("bun", [manual, "features", "--repo", reference, "--json"]); assert.equal(catalog.code, 0); const features = JSON.parse(catalog.stdout); assert.equal(features.length, 5);
  // Owner CLI capture first; normalize only random posted ids into the fixture.
  const rows: string[] = [];
  for (let i = 0; i < examples.length; i++) {
    const nativeRoot = path.join(root, "signal-" + i), post = await native("bun", [path.join(path.dirname(contract), "intake.ts"), "post", "--kind", "report", "--source", "map-example", "--title", examples[i], "--text", "Invented map fixture signal"], { WHEELHOUSE_INTAKE_ROOT: nativeRoot }); assert.equal(post.code, 0);
    const raw = fs.readFileSync(path.join(nativeRoot, "seats/intake.jsonl"), "utf8"), row = JSON.parse(raw); assert.equal(row.id, post.stdout.trim()); records.push({ kind: "posted-capture", raw }); save();
    const id = texts[i].match(/^Signal: (sig-[a-z0-9]+)$/m)![1]; rows.push(raw.replaceAll(row.id, id).trim()); fs.writeFileSync(env.WHEELHOUSE_INTAKE_FIXTURE, rows.join("\n") + "\n");
    const file = path.join(repo, ".agents/skills/outcomes/examples/map-" + examples[i] + ".md"), checked = await native("bun", [contract, "check", "--file", file], env); assert.equal(checked.code, 0, checked.stderr); assert.equal(checked.stderr, "");
    records.push({ kind: "example-check", name: examples[i], native: checked }); save(); spec(examples[i], texts[i], counts[i], counts[i]);
  }
  const noMap = texts[0].split("- O2 ")[0], counterMap = texts[1].slice(texts[1].indexOf("- O2 "));
  const missing = spec("missing-map", noMap, 1, 0, 2, "missing map outcome for reports");
  const extra = spec("unchanged-extra-map", texts[2] + counterMap, 0, 1, 2, "not needed");
  const wrong = spec("wrong-slug-same-count", texts[0].replace("features/reports.md", "features/about.md"), 1, 1, 2, "about is not needed");
  const duplicate = spec("duplicate-map", texts[0] + texts[0].slice(texts[0].indexOf("- O2 ")).replace("- O2 ", "- O3 "), 1, 2, 2, "duplicate map outcome");
  const project = spec("wrong-project", texts[0].replace("verify-five-features/features", "verify-other/features"), 1, 1, 2, "another manual");
  const proof = spec("changed-proof", texts[2].replace("proof: Counter = 2", "proof: Counter = 3") + counterMap, 1, 1);
  const missingProof = spec("changed-proof-missing-map", texts[2].replace("proof: Counter = 2", "proof: Counter = 3"), 1, 0, 2, "missing map outcome for counter");
  spec("url", texts[0].replace("  surface: /reports\n", "  surface: https://fixture.invalid/reports\n"), 1, 1);
  spec("screen", texts[0].replace("  surface: /reports\n", "  surface: screen: Reports\n"), 1, 1);
  spec("command", texts[0].replace("  surface: /reports\n", "  surface: command: reports\n"), 1, 1);
  spec("mapped-slug", texts[2].replace("/counter; proof: Counter = 2", "counter"), 0, 0);
  spec("nested-changed-reach", texts[1].replace("  surface: /counter#actions", "  surface: /counter/actions"), 1, 1);
  spec("kind-label-not-cause", texts[0].replace("new public page", "chore's public page"), 1, 1);
  spec("factory-source", texts[3].replace("consumer: person-reading", "consumer: machine").replace("surface: README.md", "surface: seats/adapter.ts").replace("check: read", "check: run"), 0, 0);
  spec("map-consumer", texts[0].replace("consumer: machine —", "consumer: person-reading —").replace("check: run —", "check: read —"), 1, 1, 2, "requires machine consumer");
  const duplicateConsumers = spec("two-consumers-one-feature", texts[0].replace("- O2 ", "- O3 ").replace("- O3 ", "- O2 The reports endpoint responds.\n  consumer: machine — the API client\n  surface: /reports\n  check: run — request /reports and inspect its summary\n- O3 "), 1, 1);
  const prefixRepo = path.join(root, "prefix-map"); fs.cpSync(reference, prefixRepo, { recursive: true, verbatimSymlinks: true });
  const prefixFile = path.join(prefixRepo, ".agents/skills/verify-five-features/features/counter.md"); fs.writeFileSync(prefixFile, fs.readFileSync(prefixFile, "utf8").replaceAll("/counter", "/counter-shadow"));
  const prefix = spec("locator-prefix-is-not-coverage", texts[2], 1, 0, 2, "missing map outcome for counter"); prefix.repo = prefixRepo;
  const proofRepo = path.join(root, "proof-prefix-map"); fs.cpSync(reference, proofRepo, { recursive: true, verbatimSymlinks: true });
  const proofFile = path.join(proofRepo, ".agents/skills/verify-five-features/features/counter.md"); fs.writeFileSync(proofFile, fs.readFileSync(proofFile, "utf8").replaceAll("Counter = 2", "Counter = 20"));
  const proofPrefix = spec("proof-prefix-is-not-coverage", texts[2], 1, 0, 2, "missing map outcome for counter"); proofPrefix.repo = proofRepo;
  for (const s of specs) await grade(s);
  const falseNeed = mutant("need-off", "const requiresMap = !covered || proofChanged;", "const requiresMap = false;"); await grade(missing, falseNeed, "uncovered-ignored", 0);
  const allNeed = mutant("need-on", "const requiresMap = !covered || proofChanged;", "const requiresMap = true;"); await grade(extra, allNeed, "covered-always-needs-map", 0);
  const noProof = mutant("proof-off", "const requiresMap = !covered || proofChanged;", "const requiresMap = !covered;"); await grade(missingProof, noProof, "proof-change-ignored", 0);
  const ignoreExtra = mutant("extra-off", "if (!needed.has(map.slug))", "if (false)"); await grade(extra, ignoreExtra, "gratuitous-accepted", 0); await grade(wrong, ignoreExtra, "wrong-slug-accepted-or-misreported", 2);
  const ignoreMissing = mutant("missing-off", "if (!seen.has(slug))", "if (false)"); await grade(missing, ignoreMissing, "missing-accepted", 0);
  const ignoreProject = mutant("project-off", "if (map.project !== undefined && map.project !== manual.project)", "if (false)"); await grade(project, ignoreProject, "wrong-project-accepted", 0);
  const ignoreDup = mutant("duplicate-off", "if (seen.has(map.slug))", "if (false)"); await grade(duplicate, ignoreDup, "duplicate-accepted", 0);
  // Cutting a prerequisite feature read is not regression credit. The original
  // case must reach its own product-locator decision with a valid catalog.
  const alwaysCovered = mutant("coverage-forced", "const covered = covering !== undefined;", "const covered = true;"); await grade(missing, alwaysCovered, "false-coverage", 0);
  const substring = mutant("substring-coverage", '  const haystack = normalized(text), needle = normalized(literal), token = /[a-z0-9_/#?&=.%:+-]/;', '  return normalized(text).includes(normalized(literal));\n  const haystack = normalized(text), needle = normalized(literal), token = /[a-z0-9_/#?&=.%:+-]/;');
  await grade(prefix, substring, "locator-prefix-accepted", 0); await grade(proofPrefix, substring, "proof-prefix-accepted", 0);
  const noDedupe = mutant("dedupe-off", 'needed.set(feature?.slug ?? reference.slug,', 'needed.set((feature?.slug ?? reference.slug) + outcome.id,'); await grade(duplicateConsumers, noDedupe, "same-feature-not-deduplicated", 2);
  console.log(`map contract checks: ${specs.length} cases, 4 contract examples, 12 actual-source failing removals`);
} finally { save(); }
