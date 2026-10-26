import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { run, retain, changed } from "./producer-test-support";
const tag = "PRODUCER_BRIEF_ASSERTION";
if (process.argv[2] === "--case") {
  const [moduleFile, specFile] = process.argv.slice(3), s = JSON.parse(fs.readFileSync(specFile, "utf8"));
  const m = await import(moduleFile);
  let text = "", error: any;
  try { text = m.assembleBrief(s.root, s.role); } catch (e) { error = e; }
  if (s.stop) {
    assert(error && String(error.message).includes("STOP:") && String(error.message).includes(s.stop), `${tag}: missing/invalid skill must STOP naming ${s.stop}`);
    console.log(String(error.message));
  } else {
    assert(!error, `${tag}: assembly unexpectedly failed: ${error?.message}`);
    const roleFile = m.resolveRoleBrief(s.root, s.role), role = fs.readFileSync(roleFile, "utf8");
    let expected = role;
    if (s.role === "producer") for (const name of ["intent", "outcomes"]) {
      const skill = fs.readFileSync(path.join(s.root, ".agents/skills", name, "SKILL.md"), "utf8"), end = skill.indexOf("\n---\n", 4);
      assert(end > 0, "CONTROL_SETUP frontmatter missing");
      const version = skill.split("\n").find(l => l.startsWith("version:"))!.slice(8).trim();
      expected += `\n\n# Skill: ${name} (version ${version})\n\n` + skill.slice(end + 5);
    }
    assert.equal(text, expected, `${tag}: exact full bodies/versions without frontmatter, or unchanged nonproducer bytes`);
    console.log(`PASS assembled ${s.role} ${s.layout}`);
  }
} else {
  const [implementation, scratch, repo] = process.argv.slice(2); fs.mkdirSync(scratch, { recursive: true });
  const root = fs.realpathSync(scratch), original = fs.readFileSync(implementation, "utf8"), records: any[] = [];
  function setup(name: string, layout = "template", role = "producer", skill = "", corruption = "") {
    const dir = path.join(root, name), roleDir = layout === "template" ? "contracts" : role === "worker" ? "wheelhouse/fleet" : "wheelhouse/crew";
    fs.mkdirSync(path.join(dir, roleDir), { recursive: true }); fs.writeFileSync(path.join(dir, roleDir, role.toUpperCase() + ".md"), `# ${role}\nfixture role bytes\n`);
    if (role === "producer") for (const n of ["intent", "outcomes"]) {
      const dest = path.join(dir, ".agents/skills", n, "SKILL.md"); fs.mkdirSync(path.dirname(dest), { recursive: true });
      let text = fs.readFileSync(path.join(repo, ".agents/skills", n, "SKILL.md"), "utf8");
      if (skill === n) {
        if (corruption === "missing") continue;
        if (corruption === "version") text = text.replace(/^version:.*\n/m, "");
        if (corruption === "name") text = text.replace(/^name:.*$/m, "name: wrong");
        if (corruption === "body") text = text.slice(0, text.indexOf("\n---\n", 4) + 5);
      }
      fs.writeFileSync(dest, text);
    }
    const spec = { root: dir, role, layout, ...(skill ? { stop: path.join(dir, ".agents/skills", skill, "SKILL.md") } : {}) };
    const file = path.join(root, name + ".json"); fs.writeFileSync(file, JSON.stringify(spec)); return file;
  }
  const cases = [setup("template"), setup("installed", "installed"), setup("worker", "template", "worker"), setup("installed-worker", "installed", "worker"), setup("missing-intent", "template", "producer", "intent", "missing"), setup("missing-outcomes", "installed", "producer", "outcomes", "missing"), setup("bad-version", "template", "producer", "intent", "version"), setup("bad-name", "template", "producer", "intent", "name"), setup("empty-body", "template", "producer", "outcomes", "body")];
  const actual = path.join(root, "actual-template.json"); fs.writeFileSync(actual, JSON.stringify({ root: repo, role: "producer", layout: "actual-template" })); cases.push(actual);
  const save = () => retain(root, "producer-briefs", { implementation, original, records });
  async function check(file: string, spec: string, removal = "") {
    const r = await run("bun", [process.argv[1], "--case", file, spec], root);
    records.push({ file, source: fs.readFileSync(file, "utf8"), spec: JSON.parse(fs.readFileSync(spec, "utf8")), removal, native: r }); save();
    assert(!r.error && r.signal === null && r.stdoutEOF && r.stderrEOF, "CONTROL_SETUP child did not complete");
    if (removal) { assert.equal(r.code, 1, `CONTROL_SETUP ${removal}: removal must actually fail`); assert(r.stderr.includes(tag), `CONTROL_SETUP ${removal}: not intended oracle: ${r.stderr}`); console.log(`PASS brief removal ${removal}: native1 at ${tag}`); }
    else { assert.equal(r.code, 0, `${tag}: ${r.stderr}`); process.stdout.write(r.stdout); }
  }
  try {
    for (const spec of cases) await check(implementation, spec);
    const variants = [
      ["no-assembly", 'if (role !== "producer") return brief;', 'if (true) return brief;', [0, 1, 9]],
      ["worker-leak", 'if (role !== "producer") return brief;', '// planted removal: leak skills into worker', [2, 3]],
      ["fallback-missing", 'catch (e: any) { throw new Error(`STOP: required producer skill ${file}: ${e.message}`); }', 'catch { text = "---\\nname: " + name + "\\nversion: 1.0.0\\n---\\nfallback"; }', [4, 5]],
      ["frontmatter-leak", 'body: match[2]', 'body: text', [0]],
    ] as const;
    for (const [name, old, replacement, indices] of variants) {
      const file = path.join(root, name + ".ts"); fs.writeFileSync(file, changed(original, old, replacement)); for (const i of indices) await check(file, cases[i], name + "-" + i);
    }
    const start = original.split("\n").find(l => l.startsWith("  if (!match || names.length"))!;
    assert(start, "CONTROL_SETUP reader validation guard");
    const file = path.join(root, "no-validation.ts"); fs.writeFileSync(file, changed(original, start, "  if (false) {"));
    for (const i of [6, 7, 8]) await check(file, cases[i], "no-validation-" + i);
    console.log("producer brief checks: 10 positive cases, 11 actual-source failing removals");
  } finally { save(); }
}
