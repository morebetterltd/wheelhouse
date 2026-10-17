import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { recordCleanupScratch, SCRATCH_MARKER } from "../cleanup-identity";

const [base, source, prune] = process.argv.slice(2);
if (!fs.existsSync(path.join(path.dirname(base), ".wheelhouse-selftest-fixture"))) throw new Error("seat scratch needs the enclosing owned fixture");
fs.mkdirSync(base);
const closed = "seat-closed", open = "seat-open", other = "seat-other";
let failures = 0;
function check(ok: boolean, name: string) {
  console.log(`${ok ? "PASS" : "FAIL"} seat scratch: ${name}`);
  if (!ok) failures++;
}
function command(bin: string, args: string[], cwd: string, env = process.env) {
  const r = spawnSync(bin, args, { cwd, env, encoding: "utf8" });
  if (r.error || r.signal || r.status === null) throw new Error(`${bin} did not complete: ${r.error ?? r.signal}`);
  return { code: r.status, signal: r.signal, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
function git(args: string[], cwd: string) {
  const r = command("git", args, cwd);
  if (r.code) throw new Error(`fixture git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
function keep(p: string) { fs.mkdirSync(p, { recursive: true }); fs.writeFileSync(path.join(p, "KEEP"), "owned fixture sentinel\n"); }
function intact(p: string) { return fs.existsSync(path.join(p, "KEEP")) && fs.readFileSync(path.join(p, "KEEP"), "utf8") === "owned fixture sentinel\n"; }
function fixture(name: string) {
  const dir = fs.mkdtempSync(path.join(base, name + "-")), root = path.join(dir, "install"), repo = path.join(root, "product"), bin = path.join(dir, "bin"), outside = path.join(dir, "outside");
  fs.mkdirSync(repo, { recursive: true }); fs.mkdirSync(bin); fs.mkdirSync(outside);
  fs.cpSync(path.join(source, "seats"), path.join(root, "seats"), { recursive: true });
  fs.copyFileSync(prune, path.join(root, "seats", "prune.ts"));
  fs.writeFileSync(path.join(root, "seats", "state.json"), '{"seats":{}}');
  fs.writeFileSync(path.join(root, "seats", "seats.json"), '{"seats":{"worker-1":{},"worker-2":{}}}');
  fs.mkdirSync(path.join(root, ".beads"));
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "selftest@example.invalid"], repo); git(["config", "user.name", "selftest"], repo);
  fs.writeFileSync(path.join(repo, "app.txt"), "base\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".wheelhouse-runs/\n");
  git(["add", "."], repo); git(["commit", "-q", "-m", "base"], repo);
  git(["update-ref", "refs/remotes/origin/main", "HEAD"], repo);
  const seat = path.join(root, ".wheelhouse-worktrees", "worker-1");
  git(["worktree", "add", "-q", "--detach", seat, "main"], repo);
  // bd's array/id/status shape is captured in work/real-bd-closed.json;
  // statuses and ids here are entirely fixture-owned, not the installed graph.
  fs.writeFileSync(path.join(bin, "bd"), `#!/bin/sh\ncase " $* " in\n*" --status=closed "*) printf '%s\\n' '[{"id":"${closed}","status":"closed"},{"id":"${other}","status":"closed"}]';;\n*" --status=open "*) printf '%s\\n' '[{"id":"${open}","status":"open"}]';;\n*) printf '[]\\n';;\nesac\n`, { mode: 0o755 });
  const config = path.join(dir, "probe.json"), lsof = path.join(bin, "lsof"), log = path.join(dir, "git.log");
  fs.writeFileSync(config, JSON.stringify({ mode: "quiet", count: 0, root, seat, outside, closed }));
  // Quiet native lsof record shape retained from the 408r fixture capture.
  fs.writeFileSync(lsof, `#!/usr/bin/env bun
import fs from "node:fs";import path from "node:path";
const file=${JSON.stringify(config)},c=JSON.parse(fs.readFileSync(file,"utf8"));c.count++;fs.writeFileSync(file,JSON.stringify(c));
if(c.mode==="swap" && c.count===2){const runs=path.join(c.seat,".wheelhouse-runs");fs.renameSync(runs,runs+".original");fs.symlinkSync(c.outside,runs);}
process.stdout.write("p1\\nfcwd\\nn"+(c.mode==="live"?path.join(c.seat,".wheelhouse-runs",c.closed,"negative-old"):"/")+"\\n");
`, { mode: 0o755 });
  const realGit = command("/usr/bin/which", ["git"], repo).stdout.trim();
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(realGit)} "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "xcrun"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const env = { ...process.env, PATH: bin + ":" + process.env.PATH, WHEELHOUSE_LSOF: lsof };
  return { dir, root, repo, seat, outside, config, log, env };
}
type Fixture = ReturnType<typeof fixture>;
function scratch(f: Fixture, bead = closed, seat = f.seat, marked = true) {
  const run = path.join(seat, ".wheelhouse-runs", bead), control = path.join(run, "negative-old");
  keep(run); git(["worktree", "add", "-q", "--detach", control, "main"], f.repo);
  if (marked) recordCleanupScratch(seat, run, bead);
  return { run, control };
}
function registered(f: Fixture, p: string) { return git(["worktree", "list", "--porcelain"], f.repo).split("\n").includes(`worktree ${p}`); }
function mode(f: Fixture, mode: string) { const c = JSON.parse(fs.readFileSync(f.config, "utf8")); c.mode = mode; c.count = 0; fs.writeFileSync(f.config, JSON.stringify(c)); }
function invoke(f: Fixture, args: string[] = []) {
  fs.writeFileSync(path.join(f.dir, "registry-before.txt"), git(["worktree", "list", "--porcelain"], f.repo) + "\n");
  const r = command("bun", [path.join(f.root, "seats", "prune.ts"), "cleanup", "--root", f.root, "--log", path.join(f.dir, "cleanup.log"), ...args], f.root, f.env);
  fs.writeFileSync(path.join(f.dir, "registry-after.txt"), git(["worktree", "list", "--porcelain"], f.repo) + "\n");
  fs.writeFileSync(path.join(f.dir, "result.json"), JSON.stringify(r, null, 2) + "\n");
  console.log("MEASUREMENT " + JSON.stringify({ fixture: path.basename(f.dir), ...r }));
  return r;
}
{
  const f = fixture("closed-open-two-seats"), c = scratch(f), o = scratch(f, open);
  const extraControl = path.join(c.run, "negative-old-again");
  git(["worktree", "add", "-q", "--detach", extraControl, "main"], f.repo);
  const seat2 = path.join(f.root, ".wheelhouse-worktrees", "worker-2");
  git(["worktree", "add", "-q", "--detach", seat2, "main"], f.repo);
  const second = scratch(f, other, seat2);
  if (!registered(f, c.control) || !registered(f, extraControl) || !registered(f, o.control) || !registered(f, second.control)) throw new Error("positive controls were not registered");
  const r = invoke(f, ["--bead", closed]);
  const log = fs.readFileSync(f.log, "utf8");
  check(r.code === 0 && !fs.existsSync(c.run) && !registered(f, c.control) && !registered(f, extraControl), "closed-task controls removed and unregistered by bead-scoped cleanup");
  check(log.includes(`worktree remove --force ${c.control}\n`) && log.includes("worktree prune\n"), "native Git remove and prune executed");
  check(intact(o.run) && registered(f, o.control) && intact(second.run) && registered(f, second.control), "open task and other bead scope preserved");
  const nightly = invoke(f);
  check(nightly.code === 0 && !fs.existsSync(second.run) && !registered(f, second.control), "fleet-wide cleanup discovers a second seat's closed scratch");
  check(intact(o.run) && registered(f, o.control) && registered(f, f.seat) && registered(f, seat2), "open scratch and both rostered seat worktrees survive");
}
for (const kind of ["unmarked", "foreign-marker", "dirty", "unremote", "open-branch", "live", "seat-anchor", "isa", "push", "no-lsof", "report", "off", "swap", "symlink-runs", "symlink-seat"]) {
  const f = fixture(kind), c = scratch(f, closed, f.seat, kind !== "unmarked");
  if (kind === "foreign-marker") { const m = JSON.parse(fs.readFileSync(path.join(c.run, SCRATCH_MARKER), "utf8")); m.root = f.outside; fs.writeFileSync(path.join(c.run, SCRATCH_MARKER), JSON.stringify(m)); }
  if (kind === "dirty") {
    git(["worktree", "add", "-q", "--detach", path.join(c.run, "negative-clean"), "main"], f.repo);
    fs.writeFileSync(path.join(c.control, "app.txt"), "uncommitted fixture work\n");
  }
  if (kind === "unremote") { fs.writeFileSync(path.join(c.control, "app.txt"), "unremote fixture commit\n"); git(["add", "app.txt"], c.control); git(["commit", "-q", "-m", "unremote"], c.control); }
  if (kind === "open-branch") git(["switch", "-q", "-c", `fleet/${open}`], c.control);
  if (kind === "live" || kind === "swap") mode(f, kind);
  if (kind === "seat-anchor") fs.writeFileSync(path.join(f.root, "seats", "state.json"), JSON.stringify({ seats: { reviewer: { cwd: c.control } } }));
  if (kind === "isa") { fs.mkdirSync(path.join(f.root, "wheelhouse")); fs.writeFileSync(path.join(f.root, "wheelhouse", "ISA.md"), "`.wheelhouse-worktrees/negative-old`\n"); }
  if (kind === "push") { fs.mkdirSync(path.join(f.root, "seats", "run")); fs.writeFileSync(path.join(f.root, "seats", "run", "push.fixture.json"), JSON.stringify({ worktree: c.control, pid: process.pid })); }
  if (kind === "no-lsof") f.env.WHEELHOUSE_LSOF = path.join(f.dir, "missing-lsof");
  if (kind === "report" || kind === "off") { fs.mkdirSync(path.join(f.root, "wheelhouse")); fs.writeFileSync(path.join(f.root, "wheelhouse", ".template-source"), `cleanup=${kind}\n`); }
  let original = c.run;
  if (kind === "symlink-runs") { const runs = path.dirname(c.run); fs.renameSync(runs, path.join(f.outside, "runs")); fs.symlinkSync(path.join(f.outside, "runs"), runs); original = path.join(f.outside, "runs", closed); }
  if (kind === "symlink-seat") { fs.renameSync(f.seat, path.join(f.outside, "seat")); fs.symlinkSync(path.join(f.outside, "seat"), f.seat); original = path.join(f.outside, "seat", ".wheelhouse-runs", closed); }
  if (kind === "swap") keep(path.join(f.outside, closed));
  if (!intact(original) || !registered(f, c.control)) throw new Error(`${kind}: subject missing before cleanup`);
  const r = invoke(f);
  if (kind === "swap") original = path.join(path.dirname(c.run) + ".original", closed);
  if (kind === "swap") {
    // The inherited final `git worktree prune` may expire the now-missing old
    // pathname. Refusal promises intact bytes, not retention of stale metadata.
    const log = fs.readFileSync(f.log, "utf8");
    check(r.code === 0 && intact(original) && fs.existsSync(path.join(original, "negative-old", "app.txt")) && !log.includes(`worktree remove --force ${c.control}\n`), "swap: original scratch/control bytes retained without Git removal");
    check(intact(path.join(f.outside, closed)) && r.stdout.includes("reason=path changed during check"), "nested ancestor swap refused after lsof, outside KEEP intact");
  } else check(r.code === 0 && intact(original) && registered(f, c.control), `${kind}: scratch bytes and registration retained`);
  if (kind === "dirty") check(registered(f, path.join(c.run, "negative-clean")) && fs.readFileSync(path.join(c.control, "app.txt"), "utf8") === "uncommitted fixture work\n", "one dirty control keeps its clean sibling and exact uncommitted bytes");
}
console.log(`seat scratch fixtures: ${failures ? "FAIL" : "PASS"} failures=${failures}`);
process.exit(failures ? 1 : 0);
