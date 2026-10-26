// Execute the printed recipes, not a second implementation of their copy logic.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { completedCommand } from "../completed-command.ts";

const [template, scratch] = process.argv.slice(2);
assert(template && scratch && fs.statSync(scratch).isDirectory(), "allocated fixture directory required");
const upgrade = process.env.WHEELHOUSE_UPGRADE_RUNBOOK || path.join(template, "runbooks/UPGRADE.md");
const bootstrap = process.env.WHEELHOUSE_UPGRADE_SKILLS_BOOTSTRAP || path.join(template, "BOOTSTRAP.md");
const startup = process.env.WHEELHOUSE_UPGRADE_SKILLS_STARTUP || path.join(template, "generated/STARTUP.md.example");
const evidence = process.env.WHEELHOUSE_UPGRADE_SKILLS_EVIDENCE;
if (evidence) fs.mkdirSync(evidence, { recursive: true });
const books = Object.fromEntries([upgrade, bootstrap, startup].map(f => [f, fs.readFileSync(f, "utf8")]));
const source = path.join(template, ".agents/skills");
for (const name of ["intent", "outcomes"]) assert(fs.statSync(path.join(source, name, "SKILL.md")).isFile());

function fence(file: string, marker: string) {
  const blocks = books[file].matchAll(/^[ \t]*```bash\s*\n([\s\S]*?)^[ \t]*```\s*$/gm);
  return [...blocks].find(m => m[1].includes(marker))?.[1] || "";
}
const refresh = fence(upgrade, "# Template skills upgrade");
const install = fence(bootstrap, "# Template skills install");
const integrity = fence(bootstrap, "# Template skills integrity");
const readback = fence(upgrade, "# Template skills readback");
const commands: object[] = [], results: object[] = [];
let failures = 0;
function test(name: string, fn: () => void) {
  try { fn(); results.push({ name, pass: true }); console.log(`PASS skills ${name}`); }
  catch (error) { failures++; const detail = String(error); results.push({ name, pass: false, detail }); console.log(`FAIL skills ${name}: ${detail}`); }
}
function snapshot(root: string): string {
  const rows: object[] = [];
  function visit(dir: string) {
    for (const name of fs.readdirSync(dir).sort()) {
      const f = path.join(dir, name), stat = fs.lstatSync(f), rel = path.relative(root, f);
      rows.push({ rel, mode: stat.mode, data: stat.isSymbolicLink() ? fs.readlinkSync(f) : stat.isFile() ? createHash("sha256").update(fs.readFileSync(f)).digest("hex") : null });
      if (stat.isDirectory()) visit(f);
    }
  }
  visit(root); return JSON.stringify(rows);
}
function command(file: string, args: string[], cwd: string) {
  assert(fs.statSync(cwd).isDirectory(), "command subject exists");
  const r = completedCommand(file, args, { cwd, env: { ...process.env, TEMPLATE: template } });
  commands.push({ file, args, cwd, status: r.status, signal: r.signal, error: r.error?.message, stdout: r.stdout, stderr: r.stderr });
  assert(!r.error && r.signal === null, `native completion: ${file}`);
  return r;
}
function script(shell: string, code: string, cwd: string, sourceTemplate = template) {
  return command(shell, ["-e", "-c", `TEMPLATE=$1\n${code}`, shell, sourceTemplate], cwd);
}
function project(name: string) {
  const dir = path.join(scratch, name);
  fs.mkdirSync(path.join(dir, ".agents"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".claude/skills/local"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".agents/product-owned"), "KEEP\n");
  fs.writeFileSync(path.join(dir, ".claude/skills/local/SKILL.md"), "KEEP local skill\n");
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "KEEP product guidance\n");
  assert(!fs.existsSync(path.join(dir, ".agents/skills")), "old-install fixture starts without skills");
  return dir;
}
function keep(dir: string) {
  assert.equal(fs.readFileSync(path.join(dir, ".agents/product-owned"), "utf8"), "KEEP\n");
  assert.equal(fs.readFileSync(path.join(dir, ".claude/skills/local/SKILL.md"), "utf8"), "KEEP local skill\n");
  assert.equal(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), "KEEP product guidance\n");
}
function identical(dir: string) {
  assert(fs.existsSync(path.join(dir, ".agents/skills/intent/SKILL.md")), "copied intent skill absent");
  assert(fs.existsSync(path.join(dir, ".agents/skills/outcomes/SKILL.md")), "copied outcomes skill absent");
  for (const name of fs.readdirSync(source).sort()) {
    const diff = command("diff", ["-r", path.join(source, name), path.join(".agents/skills", name)], dir);
    console.log(`shipped entry ${name}: diff exit=${diff.status} stdout=${JSON.stringify(diff.stdout)} stderr=${JSON.stringify(diff.stderr)}`);
    assert.equal(diff.status, 0, diff.stdout + diff.stderr); assert.equal(diff.stdout, ""); assert.equal(diff.stderr, "");
  }
  assert(!fs.existsSync(path.join(dir, ".agents/skills/skills")), "nested copy");
  for (const name of ["intent", "outcomes"]) {
    const link = path.join(dir, ".claude/skills", name);
    assert(fs.lstatSync(link).isSymbolicLink(), `${name} must be a symlink`);
    assert.equal(fs.readlinkSync(link), `../../.agents/skills/${name}`);
    assert(fs.statSync(path.join(link, "SKILL.md")).isFile(), `${name} must resolve`);
  }
  keep(dir);
}
function seed(dir: string) {
  fs.cpSync(source, path.join(dir, ".agents/skills"), { recursive: true });
  for (const name of ["intent", "outcomes"]) fs.symlinkSync(`../../.agents/skills/${name}`, path.join(dir, ".claude/skills", name));
}
function productSkills(dir: string) {
  const root = path.join(dir, ".agents/skills");
  for (const name of ["verify-demo", "local-maintenance", "retired-but-product-owned"]) {
    fs.mkdirSync(path.join(root, name, "features"), { recursive: true });
    fs.writeFileSync(path.join(root, name, "SKILL.md"), `KEEP ${name} manual\n`);
    fs.writeFileSync(path.join(root, name, "features/counter.md"), `KEEP ${name} feature\n`);
    fs.chmodSync(path.join(root, name, "features/counter.md"), 0o640);
    fs.symlinkSync("features/counter.md", path.join(root, name, "counter-link"));
  }
  return () => ["verify-demo", "local-maintenance", "retired-but-product-owned"].map(name => {
    const dir = path.join(root, name);
    assert(fs.existsSync(dir), `SKILLS_PRODUCT_MANUAL_LOST: ${name}`);
    return snapshot(dir);
  });
}
for (const shell of ["bash", "zsh"]) {
  // FIRST leg: removing the UPGRADE recipe must leave this old install skill-less.
  test(`${shell}/upgrade-fresh`, () => {
    const dir = project(`${shell}-upgrade-fresh`);
    assert.equal(script(shell, refresh, dir).status, 0); identical(dir);
    if (evidence) fs.cpSync(dir, path.join(evidence, `${shell}-upgrade-install`), { recursive: true, dereference: false });
  });
  test(`${shell}/upgrade-repeat`, () => {
    const dir = project(`${shell}-upgrade-repeat`);
    assert.equal(script(shell, refresh, dir).status, 0); identical(dir);
    const before = snapshot(dir);
    assert.equal(script(shell, refresh, dir).status, 0); identical(dir);
    assert.equal(snapshot(dir), before, "second run changes bytes, modes or symlink targets");
  });
  test(`${shell}/upgrade-product-manual`, () => {
    const dir = project(`${shell}-upgrade-product-manual`); seed(dir);
    const readProduct = productSkills(dir), before = readProduct();
    fs.writeFileSync(path.join(dir, ".agents/skills/intent/retired-template-file"), "REMOVE owned stale file\n");
    fs.appendFileSync(path.join(dir, ".agents/skills/intent/SKILL.md"), "\nstale template bytes\n");
    assert.equal(script(shell, refresh, dir).status, 0, "refresh completed before preservation verdict");
    // Record the old recipe's apparently clean readback even when it deleted the manual.
    const rootDiff = command("diff", ["-r", source, ".agents/skills"], dir);
    console.log(`product manual: refresh=0 whole-root-diff=${rootDiff.status} verify-demo-exists=${fs.existsSync(path.join(dir, ".agents/skills/verify-demo/SKILL.md"))}`);
    assert.deepEqual(readProduct(), before, "product bytes, modes and link targets changed");
    assert(readback.trim(), "printed shipped-only upgrade readback required");
    assert.equal(script(shell, readback, dir).status, 0, "SKILLS_UPGRADE_READBACK_INCLUDES_PRODUCT");
    identical(dir);
    assert(!fs.existsSync(path.join(dir, ".agents/skills/intent/retired-template-file")), "owned retired file retained");
    assert.equal(script(shell, refresh, dir).status, 0); identical(dir);
    assert.deepEqual(readProduct(), before, "repeat refresh changed product skills");
  });
  test(`${shell}/upgrade-stale-directory`, () => {
    const dir = project(`${shell}-upgrade-stale-directory`);
    fs.mkdirSync(path.join(dir, ".claude/skills/intent"));
    fs.writeFileSync(path.join(dir, ".claude/skills/intent/KEEP"), "KEEP stale directory\n");
    const before = snapshot(dir), r = script(shell, refresh, dir);
    assert.equal(r.status, 1); assert(r.stderr.includes("STOP: .claude/skills/intent exists and is not a symlink"));
    assert.equal(snapshot(dir), before, "refusal must precede canonical refresh and preserve stale data");
  });
  test(`${shell}/install-fresh`, () => {
    const dir = project(`${shell}-install-fresh`);
    assert.equal(script(shell, install, dir).status, 0); identical(dir);
  });
  test(`${shell}/install-existing`, () => {
    const dir = project(`${shell}-install-existing`); seed(dir); productSkills(dir);
    const before = snapshot(dir), r = script(shell, install, dir);
    assert.equal(r.status, 1); assert(r.stderr.includes("STOP: .agents/skills already exists"));
    assert.equal(snapshot(dir), before);
  });
  test(`${shell}/upgrade-linked-destinations`, () => {
    for (const p of [".agents", ".claude", ".claude/skills", ".agents/skills"]) {
      const dir = project(`${shell}-linked-${p.replaceAll("/", "-")}`), victim = path.join(dir, "victim");
      fs.mkdirSync(victim); fs.writeFileSync(path.join(victim, "KEEP"), "KEEP outside destination\n");
      fs.rmSync(path.join(dir, p), { recursive: true, force: true }); fs.symlinkSync(victim, path.join(dir, p));
      const before = snapshot(dir), r = script(shell, refresh, dir);
      assert.equal(r.status, 1, `${p} must refuse`); assert(r.stderr.includes("STOP:"));
      assert.equal(snapshot(dir), before, `${p} refusal must not write through or replace link`);
    }
  });
  test(`${shell}/integrity-product-manual`, () => {
    const dir = project(`${shell}-integrity-product-manual`); seed(dir);
    const readProduct = productSkills(dir), before = readProduct();
    assert.equal(script(shell, integrity, dir).status, 0, "SKILLS_READBACK_INCLUDES_PRODUCT: shipped-only integrity must allow project manuals");
    assert.deepEqual(readProduct(), before);
  });
  test(`${shell}/upgrade-source-is-destination`, () => {
    const dir = project(`${shell}-upgrade-source-is-destination`); seed(dir); productSkills(dir);
    const before = snapshot(dir), r = script(shell, refresh, dir, dir);
    assert.equal(r.status, 1);
    assert(r.stderr.includes("STOP: template skills source is the destination"));
    assert.equal(snapshot(dir), before);
  });
  for (const [name, kind] of [["intent", "file"], ["outcomes", "link"], ["NOTICE-pstack.md", "directory"]]) {
    test(`${shell}/upgrade-shipped-destination-${kind}`, () => {
      assert(fs.existsSync(path.join(source, name)), "shipped refusal subject exists");
      const dir = project(`${shell}-shipped-${kind}`); seed(dir); productSkills(dir);
      const dest = path.join(dir, ".agents/skills", name);
      fs.rmSync(dest, { recursive: true, force: true });
      if (kind === "file") fs.writeFileSync(dest, "KEEP conflicting product file\n");
      else if (kind === "directory") { fs.mkdirSync(dest); fs.writeFileSync(path.join(dest, "KEEP"), "KEEP conflicting directory\n"); }
      else { fs.mkdirSync(path.join(dir, "victim")); fs.writeFileSync(path.join(dir, "victim/KEEP"), "KEEP outside target\n"); fs.symlinkSync(path.join(dir, "victim"), dest); }
      const before = snapshot(dir), r = script(shell, refresh, dir);
      assert.equal(r.status, 1, `${kind} collision must refuse`);
      assert(r.stderr.includes(`STOP: template skill destination has wrong type: .agents/skills/${name}`));
      assert.equal(snapshot(dir), before, "all destination preflights must precede refresh writes");
    });
  }
  test(`${shell}/install-integrity`, () => {
    const dir = project(`${shell}-install-integrity`); seed(dir);
    assert.equal(script(shell, integrity, dir).status, 0, "healthy integrity subject");
    const skill = path.join(dir, ".agents/skills/intent/SKILL.md"), original = fs.readFileSync(skill);
    fs.appendFileSync(skill, "\nplanted drift\n");
    assert.equal(script(shell, integrity, dir).status, 1, "integrity must reject changed skill bytes");
    fs.writeFileSync(skill, original);
    fs.unlinkSync(path.join(dir, ".claude/skills/intent")); fs.symlinkSync("../../.agents/skills/outcomes", path.join(dir, ".claude/skills/intent"));
    assert.equal(script(shell, integrity, dir).status, 1, "integrity must reject a resolving wrong-source link");
  });
}
const signal = "bun seats/intake.ts post --kind <goal|isa-change|report|error|finding> --source <name> --title <one line> --text <body>";
for (const [name, file] of [["bootstrap-signal", bootstrap], ["startup-signal", startup]]) test(name, () => {
  const text = books[file], section = text.slice(text.indexOf(name === "bootstrap-signal" ? "## 6." : "## 4. Feed it"));
  assert(text.includes(`\n${signal}\n`) || text.includes(`\n   ${signal}\n`), "standalone exact signal command missing");
  assert(section.includes(`one command: \`${signal}\``), "owner-facing signal sentence missing");
  assert(section.includes("Each call adds one row to seats/intake.jsonl and does nothing else; the producer reads it from there."), "one-row/no-other-action statement missing");
  if (name === "bootstrap-signal") assert(section.includes("Print the following paragraph and command block in the install transcript"));
});
if (evidence) {
  fs.writeFileSync(path.join(evidence, "results.json"), JSON.stringify({ results, commands, sources: Object.entries(books).map(([file, text]) => ({ file, sha256: createHash("sha256").update(text).digest("hex") })) }, null, 2) + "\n");
}
console.log(`upgrade skills: ${results.length - failures}/${results.length} PASS`);
process.exitCode = failures ? 1 : 0;
