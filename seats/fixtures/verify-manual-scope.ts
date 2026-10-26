// Mechanical prompt/record wiring only. Scripted verdicts are not scope judgment.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { completedCommand } from "../completed-command.ts";
const [implementation, scratch, selected = "all"] = process.argv.slice(2);
const runtime = path.dirname(implementation), reference = path.join(import.meta.dir, "verification/five-features");
assert(["all", "unscoped", "scoped", "untouched", "bounce"].includes(selected));
fs.mkdirSync(scratch, { recursive: true });
const base = fs.realpathSync(scratch), records: any[] = [], commands: any[] = [], tag = "MANUAL_SCOPE_ASSERTION";
const manual = ".agents/skills/verify-five-features", counter = `${manual}/features/counter.md`;
const trace = fs.readFileSync(path.join(import.meta.dir, "verify-real/pi-v3-message-end.jsonl"), "utf8").trim().split("\n").map(s => JSON.parse(s));
const seed = trace.findLast(e => e.type === "message_end" && e.message?.role === "assistant"); assert(seed);
function save() {
  const data = JSON.stringify({ implementation, source: fs.readFileSync(implementation, "utf8"), selected, records, commands }, null, 2) + "\n";
  fs.writeFileSync(path.join(base, "results.json"), data);
  if (process.env.WHEELHOUSE_MANUAL_SCOPE_EVIDENCE) fs.writeFileSync(path.join(process.env.WHEELHOUSE_MANUAL_SCOPE_EVIDENCE, `manual-scope-${process.pid}.json`), data);
}
function command(file: string, args: string[], cwd: string) {
  assert(fs.statSync(cwd).isDirectory());
  const r = completedCommand(file, args, { cwd });
  commands.push({ file, args, cwd, status: r.status, signal: r.signal, error: r.error?.message, stdout: r.stdout, stderr: r.stderr }); save();
  assert(!r.error && r.signal === null); assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
const git = (root: string, ...args: string[]) => command("git", ["-C", root, ...args], root).trim();
function commit(root: string, message: string) { git(root, "-c", "user.name=selftest", "-c", "user.email=selftest@local", "-c", "commit.gpgsign=false", "commit", "-qm", message); return git(root, "rev-parse", "HEAD"); }
function runtimeCopy(root: string) {
  fs.mkdirSync(path.join(root, "seats"), { recursive: true });
  for (const f of fs.readdirSync(runtime)) if (/\.(ts|sh)$/.test(f) && !f.endsWith(".selftest.sh")) fs.copyFileSync(path.join(runtime, f), path.join(root, "seats", f));
  fs.copyFileSync(implementation, path.join(root, "seats/verify.ts"));
}
function setup(layout: string) {
  const root = path.join(base, layout), repo = layout === "single" ? root : path.join(root, "product"), bin = path.join(root, "bin"), home = path.join(root, "home");
  for (const d of [root, repo, bin, home, path.join(root, "contracts")]) fs.mkdirSync(d, { recursive: true });
  runtimeCopy(root); if (repo !== root) runtimeCopy(repo);
  fs.copyFileSync(path.join(import.meta.dir, "../../contracts/REVIEWER.md"), path.join(root, "contracts/REVIEWER.md"));
  const seats: any = {};
  for (const [name, role] of [["author", "worker"], ["reviewer", "reviewer"]]) {
    const dir = path.join(home, name); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, "auth.json"), '{"fixture":true}\n');
    seats[name] = { role, harness: "pi", provider: "openai", model: "stub-model", account: { dir } };
  }
  fs.writeFileSync(path.join(root, "seats/seats.json"), JSON.stringify({ seats }));
  fs.cpSync(reference, repo, { recursive: true, verbatimSymlinks: true });
  command("bun", [path.join(runtime, "manual.ts"), "check", "--repo", repo], root);
  fs.writeFileSync(path.join(repo, "seats/selftest-core.list"), "fixture.selftest.sh\n");
  fs.writeFileSync(path.join(repo, "seats/fixture.selftest.sh"), '#!/usr/bin/env bash\nset -eu\nbd create "manual scope scratch bead" --json >/dev/null\nprintf "fixture manual scope sweep PASS\\n"\n');
  git(repo, "init", "-q", "-b", "main");
  const machinery = ["selftest-core.list", "selftest-sweep.sh", "selftest-sweep-lock.ts", "native-command.ts", "completed-command.ts", "python-invocations.ts", "fixture.selftest.sh"].map(f => `seats/${f}`);
  git(repo, "add", ...machinery, ".agents", ".claude", "README.md", "server.ts"); commit(repo, "reference five-feature manual");
  git(repo, "checkout", "-qb", "fleet/manual-base");
  fs.appendFileSync(path.join(repo, manual, "features/about.md"), "\nPrior task's map clarification.\n"); git(repo, "add", `${manual}/features/about.md`); const comparisonBase = commit(repo, "earlier goal work");
  git(repo, "checkout", "-qb", "fleet/manual");
  const file = path.join(repo, counter), before = fs.readFileSync(file, "utf8"), needle = 'test "$STATUS" = 0 && test "$HTTP_CODE" = 303 || exit 1'; assert.equal(before.split(needle).length, 2);
  fs.writeFileSync(file, before.replace(needle, 'test "$STATUS" = 0 || exit 1 # Any HTTP status is accepted for this journey.')); git(repo, "add", counter); const changed = commit(repo, "weaken mapped counter journey");
  // Capture the real NUL producer before the dispatcher consumes its output.
  assert.notEqual(comparisonBase, changed);
  assert(git(repo, "show", `${comparisonBase}:${counter}`).includes(needle));
  assert(git(repo, "show", `${changed}:${counter}`).includes("Any HTTP status is accepted"));
  const literalDiff = command("git", ["-C", repo, "diff", "--name-only", "--no-renames", "-z", comparisonBase, changed, "--", ".agents/skills/verify-*/"], repo);
  const nativeDiff = command("git", ["-C", repo, "diff", "--name-only", "--no-renames", "-z", comparisonBase, changed, "--", ":(glob).agents/skills/verify-*/**"], repo);
  assert.equal(nativeDiff, counter + "\0");
  git(repo, "checkout", "-qb", "fleet/no-manual", "fleet/manual-base"); fs.appendFileSync(path.join(repo, "README.md"), "\nFixture product-only edit.\n"); git(repo, "add", "README.md"); const untouched = commit(repo, "no manual edits");
  git(repo, "checkout", "-q", "main"); fs.appendFileSync(path.join(repo, manual, "features/home.md"), "\nDirty live tree is NOT the reviewed SHA.\n");
  if (repo !== root) { git(root, "init", "-q", "-b", "main"); git(root, "-c", "user.name=selftest", "-c", "user.email=selftest@local", "commit", "--allow-empty", "-qm", "install is not product"); }
  const config = path.join(root, "case.json");
  fs.writeFileSync(path.join(bin, "bd"), ["#!/usr/bin/env bun", "const fs=require('fs');", `const c=JSON.parse(fs.readFileSync(${JSON.stringify(config)},'utf8'));`, "const a=process.argv.slice(2).filter(x=>x!=='--readonly');", "if(a[0]==='show')console.log(c.display);", "else if(a[0]==='init')fs.mkdirSync('.beads',{recursive:true});", "else if(a[0]==='where')console.log(JSON.stringify({path:fs.realpathSync('.beads')}));", "else if(a[0]==='create')console.log('{\"id\":\"fixture-bead\"}');", "else if(a[0]!=='metrics')process.exit(1);", ""].join("\n"), { mode: 0o755 });
  fs.writeFileSync(path.join(root, "seed.json"), JSON.stringify(seed));
  fs.writeFileSync(path.join(bin, "pi"), ["#!/usr/bin/env bun", "const fs=require('fs');", `const root=${JSON.stringify(root)};`, "const c=JSON.parse(fs.readFileSync(root+'/case.json','utf8'));", "fs.writeFileSync(root+'/prompt.json',JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),account:process.env.PI_CODING_AGENT_DIR}));", "const event=JSON.parse(fs.readFileSync(root+'/seed.json','utf8'));event.message.content=[{type:'text',text:c.reply}];", "console.log(JSON.stringify(event));console.log(JSON.stringify({type:'agent_end',messages:[event.message]}));", ""].join("\n"), { mode: 0o755 });
  return { layout, root, repo, bin, home, config, comparisonBase, changed, untouched, literalDiff, nativeDiff };
}
const basic = `Trace: manual scope fixture\nIntegration: fleet/manual-base\nSignal: isa-gap: V9\nSkills: intent@1.0.0 outcomes@1.0.0\n\nIntent:\nMake the counter result accurate without changing its verification contract.\n\nOutcomes:\n- O1 The counter works.\n  consumer: machine — fixture consumer\n  surface: /counter\n  check: run — inspect /counter; a features/counter.md mention here is not a map surface\n`;
const map = `- O2 The counter map matches its reach.\n  consumer: person-reading — fixture maintainer\n  surface: features/counter.md\n  check: read — inspect the counter map\n- O3 The manual explains the launch.\n  consumer: person-reading — fixture maintainer\n  surface: .agents/skills/verify-five-features/SKILL.md\n  check: read — inspect the Launch section\n`;
async function review(p: any, name: string) {
  const scoped = name === "scoped" || name === "untouched", text = basic + (scoped ? map : ""), contract = path.join(p.root, "contract.md"); fs.writeFileSync(contract, text);
  const branch = name === "untouched" ? "fleet/no-manual" : "fleet/manual", tip = name === "untouched" ? p.untouched : p.changed;
  const { FOUR_OK } = require("./reviewer-reply.cjs");
  const questions = name === "bounce" ? FOUR_OK.replace(/^SCOPE:[^\n]*/, `SCOPE: DEFECT — ${counter} changed without a contract outcome calling for it`) : FOUR_OK;
  const reply = questions + `VERDICT: ${name === "bounce" ? "BOUNCE" : "APPROVE"}\nPUSH: NOT CONSIDERED\n`;
  // Deliberately contradictory display text catches parsing bd's rendered view
  // instead of the exact contract text already accepted by the K1 gate.
  fs.writeFileSync(p.config, JSON.stringify({ display: basic + map, reply }));
  const env = { ...process.env, HOME: p.home, PATH: p.bin + path.delimiter + process.env.PATH, WHEELHOUSE_SKIP_BD: "1", WHEELHOUSE_CONTRACT_FIXTURE: contract };
  const child = spawn("bun", [path.join(p.root, "seats/verify.ts"), `manual-${name}`, branch, "author", "reviewer", "--repo", p.repo], { cwd: p.root, env, stdio: ["ignore", "pipe", "pipe"] });
  const out: Buffer[] = [], err: Buffer[] = []; let stdoutEOF = false, stderrEOF = false;
  child.stdout!.on("data", b => out.push(b)); child.stderr!.on("data", b => err.push(b)); child.stdout!.on("end", () => stdoutEOF = true); child.stderr!.on("end", () => stderrEOF = true);
  const native: any = await new Promise((yes, no) => { child.once("error", no); child.once("close", (code, signal) => yes({ pid: child.pid, code, signal })); });
  Object.assign(native, { stdoutEOF, stderrEOF, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() });
  const record: any = { ...p, name, branch, tip, text, reply, native }; records.push(record); save();
  assert.equal(native.code, name === "bounce" ? 2 : 0, `${tag} ${p.layout}/${name}: native verdict path: ${native.stderr}`); assert.equal(native.signal, null); assert(stdoutEOF && stderrEOF);
  const prompt = JSON.parse(fs.readFileSync(path.join(p.root, "prompt.json"), "utf8")); record.prompt = prompt.args.at(-1);
  record.verdict = fs.readFileSync(path.join(p.root, "seats/verdicts", `manual-${name}.md`), "utf8"); save();
  assert(record.prompt.includes(`Tip SHA at dispatch: ${tip}`));
  const lines = (s: string, prefix: string) => s.split("\n").filter(line => line.startsWith(prefix));
  const prefix = "Manual files changed by this branch:", outcomes = "Contract outcomes that call for manual or map changes:";
  if (name === "untouched") {
    assert.equal(lines(record.prompt, prefix).length, 0, `${tag} ${p.layout}/${name}: no prompt noise`);
    assert.equal(lines(record.verdict, "- " + prefix).length, 0, `${tag} ${p.layout}/${name}: no metadata noise`);
    assert.equal(lines(record.prompt, outcomes).length, 0); assert.equal(lines(record.verdict, "- " + outcomes).length, 0);
  } else {
    for (const [s, lead] of [[record.prompt, ""], [record.verdict, "- "]]) {
      assert.deepEqual(lines(s, lead + prefix), [`${lead}${prefix} ${JSON.stringify([counter])}.`], `${tag} ${p.layout}/${name}: pinned product paths, not other goal work/live tree`);
      const expected = scoped ? JSON.stringify([{ id: "O2", surface: "features/counter.md" }, { id: "O3", surface: `${manual}/SKILL.md` }]) : "none";
      assert.deepEqual(lines(s, lead + outcomes), [`${lead}${outcomes} ${expected}.`], `${tag} ${p.layout}/${name}: same K1 contract outcomes`);
    }
    assert(record.prompt.includes("The manual is not the author's to bend"), `${tag} ${p.layout}/${name}: scope rule named`);
    if (name === "bounce") {
      assert(record.verdict.includes(`- scope: DEFECT — ${counter} changed without a contract outcome calling for it`), `${tag} ${p.layout}/${name}: scope line retained`);
      assert(record.verdict.includes("- verdict: BOUNCE\n"), `${tag} ${p.layout}/${name}: plain BOUNCE retained`);
    }
  }
  save();
}
try {
  for (const layout of ["single", "umbrella"]) { const p = setup(layout); for (const name of ["unscoped", "scoped", "untouched", "bounce"]) if (selected === "all" || selected === name) await review(p, name); }
  for (const name of ["unscoped", "scoped", "untouched", "bounce"]) if (selected === "all" || selected === name) console.log(`PASS manual scope ${name}: prompt/metadata and native verdict in single + umbrella product repos`);
} finally { save(); }
