// Exercise the real read-only CLI for all three rostered harnesses. No login,
// provider call, model reply, or invented harness-discovery result is involved.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fixture, skill, FACTORY, LOCATIONS, native, git, assertLinks } from "./seat-worktree-skills";

const [runtime, scratch, selected = "all", docs = path.resolve(import.meta.dir, "../..")] = process.argv.slice(2);
const f = fixture(path.resolve(runtime)); fs.mkdirSync(scratch, { recursive: true });
const seats = path.join(f.root, "seats"), adapter = path.join(seats, "adapter.ts");
const sut = await import(path.join(seats, "seat-worktree.ts"));
const roster = { "worker-1": { role: "worker", harness: "claude-code" }, "worker-2": { role: "worker", harness: "codex" }, "worker-3": { role: "worker", harness: "pi" } };
fs.writeFileSync(path.join(seats, "seats.json"), JSON.stringify({ seats: { ...roster, producer: { role: "producer", external: true, runtime: "commander-subagent" } } }) + "\n");
for (const seat of Object.keys(roster)) {
  const prepared = sut.ensureSeatWorktree({ root: f.root, seat, beadId: `skills-${seat}`, base: "main", roster, state: { seats: {} }, seatPush: "off" });
  assert.equal(prepared.target, path.join(f.root, ".wheelhouse-worktrees", seat));
  assertLinks({ ...f, wt: prepared.target });
}
console.log(JSON.stringify({ type: "skills-check-subject-ready", harnesses: Object.values(roster).map(s => s.harness), worktrees: Object.keys(roster).map(seat => path.join(f.root, ".wheelhouse-worktrees", seat)) }));
const expected = [...FACTORY, "verify-product"].sort();
function cli(seat: string, status = 0, missing?: string) {
  const r = native("bun", [adapter, "skills-check", seat], f.root, status, "SKILLS_CHECK_ORACLE");
  assert.equal(r.signal, null, `SKILLS_CHECK_ORACLE ${seat} native completion`);
  if (status === 0) { assert.equal(r.stderr, ""); assert.deepEqual(r.stdout.trimEnd().split("\n").sort(), expected, `SKILLS_CHECK_ORACLE ${seat} exactly five names`); }
  else assert(r.stderr.includes(missing!), `SKILLS_CHECK_ORACLE ${seat} refusal names ${missing}: ${r.stderr}`);
  return r;
}
const tests: Record<string, () => void> = {
  harnesses() {
    for (const seat of Object.keys(roster)) { cli(seat); assert.equal(git(path.join(f.root, ".wheelhouse-worktrees", seat), ["status", "--porcelain", "--untracked-files=all"]), ""); }
  },
  "missing-claude"() {
    const link = path.join(f.wt, ".claude/skills/intent"), target = fs.readlinkSync(link);
    fs.unlinkSync(link); cli("worker-1", 2, "intent"); assert(!fs.existsSync(link), "SKILLS_CHECK_ORACLE check never repairs a missing link"); fs.symlinkSync(target, link);
  },
  "missing-codex"() {
    const link = path.join(f.root, ".wheelhouse-worktrees/worker-2/.agents/skills/intent"), target = fs.readlinkSync(link);
    fs.unlinkSync(link); cli("worker-2", 2, "intent"); assert(!fs.existsSync(link)); fs.symlinkSync(target, link);
  },
  "missing-pi"() {
    const link = path.join(f.root, ".wheelhouse-worktrees/worker-3/.agents/skills/intent"), target = fs.readlinkSync(link);
    fs.unlinkSync(link); cli("worker-3", 2, "intent"); assert(!fs.existsSync(link)); fs.symlinkSync(target, link);
  },
  manual() {
    const link = path.join(f.wt, ".claude/skills/verify-product"), target = fs.readlinkSync(link);
    fs.unlinkSync(link); cli("worker-1", 2, "verify-product"); fs.symlinkSync(target, link);
    // Also exercise visibility independently of Git's tracked-deletion guard:
    // this additional factory-supplied manual has ignored, untracked links.
    skill(f.root, "verify-extra");
    for (const loc of LOCATIONS) fs.symlinkSync(path.join(f.root, ".agents/skills/verify-extra"), path.join(f.wt, loc, "verify-extra"));
    const exclude = git(f.wt, ["rev-parse", "--git-path", "info/exclude"]).trim();
    fs.appendFileSync(path.resolve(f.wt, exclude), LOCATIONS.map(loc => `/${loc}/verify-extra`).join("\n") + "\n");
    fs.unlinkSync(path.join(f.wt, ".claude/skills/verify-extra")); cli("worker-1", 2, "verify-extra");
    fs.unlinkSync(path.join(f.wt, ".agents/skills/verify-extra"));
    fs.rmSync(path.join(f.root, ".agents/skills/verify-extra"), { recursive: true });
  },
  dirty() {
    const file = path.join(f.wt, ".agents/skills/verify-product/SKILL.md"), before = fs.readFileSync(file);
    fs.appendFileSync(file, "uncommitted manual change\n");
    for (const seat of ["worker-1"]) cli(seat, 2, "verify-product");
    fs.writeFileSync(file, before);
  },
  state() {
    const old = path.join(f.root, ".wheelhouse-worktrees/worker-2"), relocated = path.join(f.root, ".wheelhouse-worktrees/recorded-cwd");
    git(f.product, ["worktree", "move", old, relocated]);
    const state = path.join(seats, "state.json"), bytes = JSON.stringify({ seats: { "worker-2": { pid: null, cwd: relocated } } }) + "\n";
    fs.writeFileSync(state, bytes); cli("worker-2"); assert.equal(fs.readFileSync(state, "utf8"), bytes, "SKILLS_CHECK_ORACLE state remains unchanged");
    fs.unlinkSync(state); git(f.product, ["worktree", "move", relocated, old]);
  },
  factory() {
    const file = path.join(f.root, ".agents/skills/intent/SKILL.md"), bytes = fs.readFileSync(file);
    fs.unlinkSync(file); cli("worker-1", 2, "intent"); fs.writeFileSync(file, bytes);
  },
  "no-manual"() {
    const agents = path.join(f.wt, ".agents/skills/verify-product"), saved = path.join(scratch, "saved-manual");
    const claude = path.join(f.wt, ".claude/skills/verify-product"), target = fs.readlinkSync(claude);
    fs.unlinkSync(claude); fs.renameSync(agents, saved); cli("worker-1", 2, "verify-"); fs.renameSync(saved, agents); fs.symlinkSync(target, claude);
  },
  install() {
    const bootstrap = fs.readFileSync(path.join(docs, "BOOTSTRAP.md"), "utf8");
    const block = bootstrap.match(/<!-- factory-skills-check:start -->\s*```bash\n([\s\S]*?)\n```\s*<!-- factory-skills-check:end -->/);
    assert(block, "INSTALL_SKILLS_ORACLE executable install block exists");
    const script = path.join(scratch, "install-skills.sh"); fs.writeFileSync(script, block[1]);
    const old = path.join(f.root, ".wheelhouse-worktrees/worker-2"), relocated = path.join(f.root, ".wheelhouse-worktrees/install-recorded");
    git(f.product, ["worktree", "move", old, relocated]);
    const state = path.join(seats, "state.json");
    fs.writeFileSync(state, JSON.stringify({ seats: { "worker-2": { pid: null, cwd: relocated } } }) + "\n");
    try {
      const good = native("bash", [script], f.root, 0, "INSTALL_SKILLS_ORACLE");
      assert.deepEqual(good.stdout.trimEnd().split("\n").filter(line => expected.includes(line)).sort(), [...expected, ...expected, ...expected].sort(), "INSTALL_SKILLS_ORACLE every prepared standing seat checked, including recorded cwd");
      const link = path.join(f.wt, ".claude/skills/intent"), target = fs.readlinkSync(link);
      fs.unlinkSync(link);
      try {
        const bad = native("bash", [script], f.root, 2, "INSTALL_SKILLS_ORACLE");
        assert(bad.stderr.includes("worker-1") && bad.stderr.includes("intent"), "INSTALL_SKILLS_ORACLE failure names seat and skill");
        assert(!fs.existsSync(link));
      } finally { fs.symlinkSync(target, link); }
    } finally { fs.unlinkSync(state); git(f.product, ["worktree", "move", relocated, old]); }
  },
  extra() {
    // The factory inventory is not hard-coded to four entries.
    skill(f.root, "extra-skill");
    for (const loc of LOCATIONS) fs.symlinkSync(path.join(f.root, ".agents/skills/extra-skill"), path.join(f.wt, loc, "extra-skill"));
    const exclude = git(f.wt, ["rev-parse", "--git-path", "info/exclude"]).trim();
    fs.appendFileSync(path.resolve(f.wt, exclude), LOCATIONS.map(loc => `/${loc}/extra-skill`).join("\n") + "\n");
    const r = native("bun", [adapter, "skills-check", "worker-1"], f.root);
    assert.deepEqual(r.stdout.trimEnd().split("\n").sort(), [...expected, "extra-skill"].sort(), "SKILLS_CHECK_ORACLE additional factory skill discovered");
  },
  scratch() {
    const before = git(f.product, ["worktree", "list", "--porcelain"]);
    const source = `import fs from "node:fs";import path from "node:path";import assert from "node:assert/strict";const {makeScratchCwd}=await import(process.argv[1]);for(const kind of ["review","verify"]){const dir=makeScratchCwd(process.argv[2],kind);for(const loc of ${JSON.stringify(LOCATIONS)})for(const name of ${JSON.stringify(FACTORY)}){const file=path.join(dir,loc,name);assert(fs.existsSync(file),"SCRATCH_SKILLS_ORACLE "+kind+" missing "+loc+"/"+name);assert(fs.lstatSync(file).isSymbolicLink());assert(path.isAbsolute(fs.readlinkSync(file)));}console.log("scratch skill links: PASS "+kind);}`;
    const r = native("bun", ["-e", source, path.join(seats, "verify.ts"), f.product], f.root, 0, "SCRATCH_SKILLS_ORACLE");
    assert(r.stdout.includes("scratch skill links: PASS review")); assert(r.stdout.includes("scratch skill links: PASS verify"));
    assert.equal(git(f.product, ["worktree", "list", "--porcelain"]), before, "SCRATCH_SKILLS_ORACLE existing identity cleanup retained");
  },
};
// Keep the added factory entry last; earlier cases each start with exactly five.
const order = Object.keys(tests).filter(n => n !== "extra").concat("extra");
for (const name of order) if (selected === "all" || selected === name) {
  try { tests[name](); console.log(`adapter skills-check: PASS ${name}`); }
  catch (error: any) { console.log(JSON.stringify({ type: "skill-test-failure", name, message: error.message, error: error.name, code: error.code })); throw error; }
}
assert(selected === "all" || selected in tests, "known selected adapter skills test");
