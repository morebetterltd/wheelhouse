// Real Git worktrees, never a fake git status or a model-discovery claim.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { completedCommand } from "../completed-command";

process.env.WHEELHOUSE_SKIP_BD = "1"; // Only private fixture repository metadata.
for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_NAMESPACE"]) delete process.env[key];
export const FACTORY = ["intent", "outcomes", "create-verification", "maintain-verification"];
export const LOCATIONS = [".agents/skills", ".claude/skills"];
export function native(command: string, args: string[], cwd: string, expected = 0, oracle = "SKILLS_NATIVE_ORACLE") {
  const r = completedCommand(command, args, { cwd });
  console.log("CAPTURE skills " + JSON.stringify({ command, args, cwd, callerNice: os.getPriority(0), ...r }));
  assert.equal(r.error ?? null, null); assert.equal(r.signal, null); assert.equal(r.status, expected, `${oracle} ${command} expected ${expected}: ${r.stderr}`);
  return r;
}
export function git(repo: string, args: string[], expected = 0) { return native("git", ["-C", repo, ...args], repo, expected).stdout; }
export function skill(root: string, name: string, text = name) {
  const dir = path.join(root, ".agents/skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Fixture skill\nversion: 1.0.0\n---\n${text}\n`);
}
export function fixture(root: string, single = false, collision = false) {
  fs.mkdirSync(root, { recursive: true });
  const product = single ? root : path.join(root, "product");
  fs.mkdirSync(product, { recursive: true });
  for (const name of FACTORY) skill(root, name);
  skill(product, "verify-product", "Project-owned manual");
  if (collision && !single) skill(product, "intent", "Project-owned intent override");
  fs.mkdirSync(path.join(product, ".claude/skills"), { recursive: true });
  for (const name of ["verify-product", ...(single ? FACTORY : collision ? ["intent"] : [])]) {
    fs.symlinkSync(`../../.agents/skills/${name}`, path.join(product, ".claude/skills", name));
  }
  fs.writeFileSync(path.join(product, "README.md"), "skill worktree fixture\n");
  git(product, ["init", "-q", "-b", "main"]);
  git(product, ["config", "user.name", "Skills Fixture"]);
  git(product, ["config", "user.email", "skills@example.invalid"]);
  git(product, ["add", "."]); git(product, ["commit", "-qm", "initial skills"]);
  fs.mkdirSync(path.join(root, "wheelhouse"), { recursive: true });
  fs.writeFileSync(path.join(root, "wheelhouse/.template-source"), `product-repo=${single ? "." : "product"}\nmerge-target=main\nseat_push=off\n`);
  return { root, product, wt: path.join(root, ".wheelhouse-worktrees/worker-1") };
}
export function nativeWorktree(f: ReturnType<typeof fixture>, bead = "skills-fixture", seat = "worker-1") {
  const wt = path.join(f.root, ".wheelhouse-worktrees", seat);
  git(f.product, ["worktree", "add", "-q", "-b", `fleet/${bead}`, wt, "main"]);
  assert(fs.lstatSync(path.join(wt, ".git")).isFile(), "real linked-worktree setup");
  return wt;
}
export function excludePath(wt: string) {
  const result = git(wt, ["rev-parse", "--git-path", "info/exclude"]).trim();
  return path.resolve(wt, result);
}
export function assertLinks(f: ReturnType<typeof fixture>, names = FACTORY) {
  for (const loc of LOCATIONS) for (const name of names) {
    const target = path.join(f.wt, loc, name);
    assert(fs.existsSync(target), `FACTORY_SKILLS_ORACLE missing ${loc}/${name}`);
    assert(fs.lstatSync(target).isSymbolicLink(), `FACTORY_SKILLS_ORACLE not a link: ${loc}/${name}`);
    assert(path.isAbsolute(fs.readlinkSync(target)), `FACTORY_SKILLS_ORACLE relative link: ${loc}/${name}`);
    assert.equal(fs.realpathSync(target), fs.realpathSync(path.join(f.root, ".agents/skills", name)), `FACTORY_SKILLS_ORACLE wrong target: ${loc}/${name}`);
  }
}
export function exactExcludes(wt: string) {
  const lines = fs.readFileSync(excludePath(wt), "utf8").split("\n").filter(l => /^\/\.(agents|claude)\/skills/.test(l));
  assert.deepEqual(lines.sort(), LOCATIONS.flatMap(loc => FACTORY.map(name => `/${loc}/${name}`)).sort(), "SKILL_EXCLUDES_ORACLE eight exact entry rules, no trailing slashes or whole directory");
}

async function main() {
  const [seats, scratch, selected = "all"] = process.argv.slice(2);
  const sut = await import(path.join(path.resolve(seats), "seat-worktree.ts"));
  fs.mkdirSync(scratch, { recursive: true });
  const prepare = (f: ReturnType<typeof fixture>, beadId = "skills-fixture", note: (s: string) => void = () => {}) => {
    assert(fs.statSync(path.join(f.product, ".git")).isDirectory(), "native fixture repository exists before preparation");
    console.log(JSON.stringify({ type: "skill-subject-ready", product: f.product, worktreeExists: fs.existsSync(path.join(f.wt, ".git")), beadId }));
    return sut.ensureSeatWorktree({ root: f.root, seat: "worker-1", beadId, base: "main", roster: { "worker-1": {} }, state: { seats: {} }, seatPush: "off", note });
  };
  const tests: Record<string, () => void> = {
    created() {
      const f = fixture(path.join(scratch, "created"));
      fs.mkdirSync(path.join(f.root, ".agents/skills/not-a-skill"));
      fs.writeFileSync(path.join(f.root, ".agents/skills/NOTICE.md"), "not a skill\n");
      const result = prepare(f); assert.equal(result.created, true);
      assertLinks(f); exactExcludes(f.wt);
      assert(!fs.existsSync(path.join(f.wt, ".agents/skills/not-a-skill")));
      assert.equal(git(f.wt, ["status", "--porcelain", "--untracked-files=all"]), "");
      const manual = path.join(f.wt, ".agents/skills/verify-product/SKILL.md");
      assert.equal(fs.readFileSync(manual, "utf8"), fs.readFileSync(path.join(f.product, ".agents/skills/verify-product/SKILL.md"), "utf8"));
      fs.writeFileSync(path.join(f.wt, ".agents/skills/verify-product/new-entry.md"), "new product map entry\n");
      assert(git(f.wt, ["status", "--porcelain", "--untracked-files=all"]).includes(".agents/skills/verify-product/new-entry.md"), "SKILL_EXCLUDES_ORACLE new manual files remain visible");
    },
    existing() {
      const f = fixture(path.join(scratch, "existing")); nativeWorktree(f);
      const result = prepare(f); assert.equal(result.created, false); assert.equal(result.switched, false);
      assertLinks(f); exactExcludes(f.wt);
    },
    switched() {
      const f = fixture(path.join(scratch, "switched")); nativeWorktree(f, "prior-bead");
      const result = prepare(f); assert.equal(result.switched, true);
      assertLinks(f); exactExcludes(f.wt);
      assert.equal(git(f.wt, ["status", "--porcelain", "--untracked-files=all"]), "");
    },
    stale() {
      const f = fixture(path.join(scratch, "stale")); nativeWorktree(f);
      const old = path.join(scratch, "old-factory"); skill(old, "intent");
      fs.symlinkSync(path.join(old, ".agents/skills/intent"), path.join(f.wt, ".agents/skills/intent"));
      prepare(f); assertLinks(f); exactExcludes(f.wt);
      skill(f.root, "extra-skill"); prepare(f); assertLinks(f, [...FACTORY, "extra-skill"]);
    },
    idempotent() {
      const f = fixture(path.join(scratch, "idempotent")); nativeWorktree(f);
      // A valid pre-existing link set, independently planted before the SUT.
      for (const loc of LOCATIONS) for (const name of FACTORY) fs.symlinkSync(path.join(f.root, ".agents/skills", name), path.join(f.wt, loc, name));
      const exclude = excludePath(f.wt);
      fs.appendFileSync(exclude, ["/.wheelhouse-runs/", "/.wheelhouse-worktrees/", ...LOCATIONS.flatMap(loc => FACTORY.map(name => `/${loc}/${name}`))].join("\n") + "\n");
      const stamps = () => LOCATIONS.flatMap(loc => FACTORY.map(name => {
        const stat = fs.lstatSync(path.join(f.wt, loc, name));
        return { ino: stat.ino, mtimeMs: stat.mtimeMs, birthtimeMs: stat.birthtimeMs };
      }));
      const before = stamps();
      const bytes = fs.readFileSync(exclude);
      prepare(f); prepare(f);
      assertLinks(f); exactExcludes(f.wt);
      assert.deepEqual(stamps(), before, "SKILL_IDEMPOTENCE_ORACLE links are not recreated");
      assert.deepEqual(fs.readFileSync(exclude), bytes, "SKILL_IDEMPOTENCE_ORACLE exclude bytes unchanged");
    },
    collision() {
      const f = fixture(path.join(scratch, "collision"), false, true); nativeWorktree(f);
      const local = path.join(f.wt, ".agents/skills/intent"), manual = path.join(f.wt, ".agents/skills/verify-product");
      const inode = fs.lstatSync(local).ino, manualInode = fs.lstatSync(manual).ino;
      const link = fs.readlinkSync(path.join(f.wt, ".claude/skills/intent")), notes: string[] = [];
      assert.doesNotThrow(() => prepare(f, "skills-fixture", s => notes.push(s)), "SKILL_COLLISION_ORACLE accepts project-owned directories");
      assert.equal(fs.lstatSync(local).ino, inode, "SKILL_COLLISION_ORACLE real project directory kept");
      assert.equal(fs.lstatSync(manual).ino, manualInode, "SKILL_COLLISION_ORACLE manual kept");
      assert.equal(fs.readlinkSync(path.join(f.wt, ".claude/skills/intent")), link, "SKILL_COLLISION_ORACLE committed project link kept");
      assert(notes.some(s => s.includes("intent")), "SKILL_COLLISION_ORACLE collision note");
      assertLinks(f, FACTORY.filter(name => name !== "intent"));
      assert.equal(git(f.wt, ["status", "--porcelain", "--untracked-files=all"]), "", "SKILL_COLLISION_ORACLE no tracked links rewritten");
    },
    single() {
      const f = fixture(path.join(scratch, "single"), true); nativeWorktree(f);
      const before = FACTORY.map(name => fs.readlinkSync(path.join(f.wt, ".claude/skills", name)));
      prepare(f);
      for (const name of FACTORY) assert(fs.lstatSync(path.join(f.wt, ".agents/skills", name)).isDirectory());
      assert.deepEqual(FACTORY.map(name => fs.readlinkSync(path.join(f.wt, ".claude/skills", name))), before, "SKILL_SINGLE_REPO_ORACLE product links unchanged");
      assert.equal(git(f.wt, ["status", "--porcelain", "--untracked-files=all"]), "");
    },
    parent() {
      const f = fixture(path.join(scratch, "parent")); nativeWorktree(f);
      const outside = path.join(scratch, "outside"); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "KEEP"), "untouched\n");
      fs.renameSync(path.join(f.wt, ".claude"), path.join(scratch, "saved-claude"));
      fs.symlinkSync(outside, path.join(f.wt, ".claude"));
      assert.throws(() => prepare(f), /symlink parent/, "SKILL_PARENT_ORACLE refuses traversal before linking");
      assert.deepEqual(fs.readdirSync(outside), ["KEEP"], "SKILL_PARENT_ORACLE outside target untouched");
      assert.equal(fs.readFileSync(path.join(outside, "KEEP"), "utf8"), "untouched\n");
    },
  };
  for (const [name, test] of Object.entries(tests)) if (selected === "all" || selected === name) {
    try { test(); console.log(`factory skill links: PASS ${name}`); }
    catch (error: any) { console.log(JSON.stringify({ type: "skill-test-failure", name, message: error.message, error: error.name, code: error.code })); throw error; }
  }
  assert(selected === "all" || selected in tests, "known selected skills test");
}
if (import.meta.main) await main();
