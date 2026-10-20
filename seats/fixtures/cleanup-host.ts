import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
const [base, seats] = process.argv.slice(2);
assert(fs.statSync(path.join(base, ".wheelhouse-selftest-fixture")).isFile());
const fixture = import.meta.dir, preload = path.join(fixture, "cleanup-host-preload.ts"), probe = path.join(fixture, "cleanup-host-probe.ts");
const marker = ".wheelhouse-cleanup-scratch.json", bead = "host-task", sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const id = (machine: string) => sha(process.platform === "darwin" ? `darwin:${machine === "b" ? "20000000-0000-0000-0000-000000000002" : "10000000-0000-0000-0000-000000000001"}` : `linux:${(machine === "b" ? "2" : "1").repeat(32)}`);
assert.notEqual(id("a"), id("b"));
// Pin both files before any controls. Never mutate a queued worktree.
const originals = Object.fromEntries(["cleanup-identity.ts", "selftest-sweep-lock.ts"].map(n => [n, fs.readFileSync(path.join(seats, n), "utf8")]));
console.log("pinned cleanup sources " + JSON.stringify(Object.fromEntries(Object.entries(originals).map(([n, s]) => [n, sha(s)]))));
type World = ReturnType<typeof world>;
function world(name: string, runtime = seats) {
  const dir = path.join(base, name), root = path.join(dir, "project"), target = path.join(root, ".wheelhouse-runs", bead), lock = path.join(dir, "sweep.lock");
  fs.mkdirSync(root, { recursive: true });
  return { dir, root, target, lock, runtime, file: path.join(target, marker), audit: path.join(root, "seats/logs/cleanup-adoptions.jsonl") };
}
function env(host = "network-after", machine = "a", lock: string) {
  return { ...process.env, CLEANUP_FIXTURE_HOST: host, CLEANUP_FIXTURE_MACHINE: machine, WHEELHOUSE_SELFTEST_SWEEP_LOCK: lock };
}
function command(w: World, args: string[], host = "network-after", machine = "a", lock = w.lock) {
  const r = spawnSync("bun", ["--preload", preload, ...args], { cwd: w.root, env: env(host, machine, lock), encoding: "utf8" });
  assert(!r.error, String(r.error)); assert.equal(r.signal, null);
  fs.appendFileSync(path.join(w.dir, "calls.jsonl"), JSON.stringify({ args, host, machine, status: r.status, stdout: r.stdout, stderr: r.stderr }) + "\n");
  return r;
}
function expect(r: ReturnType<typeof command>, status: number) { assert.equal(r.status, status, r.stdout + r.stderr); return r; }
function call(w: World, action: string, status = 0, host = "network-after", machine = "a", lock = w.lock) {
  return expect(command(w, [probe, path.join(w.runtime, "cleanup-identity.ts"), w.root, bead, action], host, machine, lock), status);
}
function create(w: World, host = "network-before", machine = "a") {
  call(w, "prepare", 0, host, machine);
  const m = JSON.parse(fs.readFileSync(w.file, "utf8"));
  assert.equal(m.version, 2); assert.equal(m.hostId, id(machine)); assert.equal(m.hostname, host);
  return m;
}
function legacy(w: World, hostname = "network-before") {
  const m = create(w, hostname); m.version = 1; delete m.hostId; fs.writeFileSync(w.file, JSON.stringify(m) + "\n"); return m;
}
function cache(w: World, machine = "a", lock = w.lock) {
  const helper = path.join(w.runtime, "selftest-sweep-lock.ts"), token = "a".repeat(32);
  const owned = expect(command(w, [helper, "acquire", lock, String(process.pid), token], "network-before", machine, lock), 0).stdout.trim();
  assert.match(owned, /^\d+:\d+$/);
  expect(command(w, [helper, "release", lock, String(process.pid), token, owned], "network-after", machine, lock), 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(lock + ".host", "wheelhouse-selftest-sweep-host"), "utf8")).hostId, id(machine));
}
function snapshot(directory: string): any {
  if (!fs.existsSync(directory)) return null;
  return Object.fromEntries(fs.readdirSync(directory).sort().map(name => {
    const f = path.join(directory, name), st = fs.lstatSync(f, { bigint: true });
    return [name, { ino: String(st.ino), dev: String(st.dev), mtime: String(st.mtimeNs), sha: st.isFile() ? sha(fs.readFileSync(f)) : st.isSymbolicLink() ? fs.readlinkSync(f) : snapshot(f) }];
  }));
}
function adoption(w: World, status = 0, selectedBead = bead) {
  return expect(command(w, [path.join(w.runtime, "cleanup-identity.ts"), "adopt-v1", "--root", w.root, "--target", w.target, "--bead", selectedBead]), status);
}
function refusedLegacy(w: World, lock = w.lock) {
  const before = fs.readFileSync(w.file, "utf8"), r = call(w, "prepare", 2, "network-after", "a", lock);
  assert.match(r.stderr, /adopt-v1 --root .*--target .*--bead /); assert.match(r.stderr, /seats\/README.md: Explicit legacy scratch host adoption/);
  assert.equal(fs.readFileSync(w.file, "utf8"), before);
}
const tests: Record<string, (w: World) => void> = {
  "renamed-scratch": w => { create(w); const before = snapshot(w.target); call(w, "read"); assert.deepEqual(snapshot(w.target), before); },
  "foreign-scratch": w => { create(w, "network-after", "b"); const before = snapshot(w.target); call(w, "read", 2); assert.deepEqual(snapshot(w.target), before); },
  "renamed-lock": w => { call(w, "seed-lock", 0, "network-before"); call(w, "lock"); assert(!fs.existsSync(path.join(w.root, "seats/run/cleanup.lock"))); },
  "foreign-lock": w => { call(w, "seed-lock", 0, "network-after", "b"); const dir = path.join(w.root, "seats/run/cleanup.lock"), before = snapshot(dir); call(w, "lock", 2); assert.deepEqual(snapshot(dir), before); },
  "legacy-known": w => { legacy(w); cache(w); const before = snapshot(w.lock + ".host"), old = fs.readFileSync(w.file, "utf8"); call(w, "read", 0, "network-third"); assert.deepEqual(snapshot(w.lock + ".host"), before); assert.equal(fs.readFileSync(w.file, "utf8"), old); },
  "legacy-unknown": w => { legacy(w, "unobserved-host"); cache(w); refusedLegacy(w); },
  "legacy-missing-cache": w => { legacy(w); refusedLegacy(w); },
  "legacy-foreign-cache": w => { legacy(w); cache(w, "b"); const before = snapshot(w.lock + ".host"); refusedLegacy(w); assert.deepEqual(snapshot(w.lock + ".host"), before); },
  "legacy-symlink-cache": w => { legacy(w); cache(w); const alias = path.join(w.dir, "alias.lock"); fs.symlinkSync(w.lock + ".host", alias + ".host"); refusedLegacy(w, alias); },
  "unavailable-create": w => { call(w, "prepare", 2, "network-after", "unavailable"); assert(!fs.existsSync(w.target)); call(w, "lock", 2, "network-after", "unavailable"); assert(!fs.existsSync(path.join(w.root, "seats/run/cleanup.lock"))); },
  "unavailable-read": w => { const m = create(w); m.hostId = sha("hostname:network-after"); fs.writeFileSync(w.file, JSON.stringify(m) + "\n"); call(w, "read", 2, "network-after", "unavailable"); },
  "adopt-v1": w => {
    const old = legacy(w), before = fs.readFileSync(w.file, "utf8"), st = fs.statSync(w.target, { bigint: true });
    fs.writeFileSync(path.join(w.target, "KEEP"), "payload"); refusedLegacy(w);
    const r = adoption(w), m = JSON.parse(fs.readFileSync(w.file, "utf8"));
    assert.equal(m.version, 2); assert.equal(m.hostId, id("a")); assert.equal(m.hostname, "network-after"); assert.notEqual(m.token, old.token);
    assert.equal(m.identity, `${st.dev}:${st.ino}`); assert.equal(m.root, w.root); assert.equal(m.target, w.target); assert.equal(m.bead, bead);
    assert.equal(fs.readFileSync(path.join(w.target, "KEEP"), "utf8"), "payload"); call(w, "read");
    const events = fs.readFileSync(w.audit, "utf8").trim().split("\n").map(s => JSON.parse(s));
    assert.deepEqual(events.map(e => e.event), ["adopt-v1-intent", "adopted-v1"]); assert.equal(events[0].adoptionId, events[1].adoptionId);
    assert.equal(events[1].previousMarkerSha256, sha(before)); assert.equal(events[1].newMarkerSha256, sha(fs.readFileSync(w.file))); assert.equal(events[1].hostId, id("a"));
    assert.equal(JSON.parse(r.stdout).event, "adopted-v1");
  },
};
for (const field of ["root", "target", "identity", "bead"]) tests["adopt-mismatch-" + field] = w => {
  const m = legacy(w);
  if (field !== "bead") { m[field] = field === "identity" ? "1:2" : path.join(w.dir, "outside"); fs.writeFileSync(w.file, JSON.stringify(m) + "\n"); }
  const before = fs.readFileSync(w.file, "utf8"); adoption(w, 2, field === "bead" ? "wrong-bead" : bead);
  assert.equal(fs.readFileSync(w.file, "utf8"), before); assert(!fs.existsSync(w.audit));
};
tests["adopt-unmarked"] = w => { fs.mkdirSync(w.target, { recursive: true }); adoption(w, 2); assert(!fs.existsSync(w.file)); assert(!fs.existsSync(w.audit)); };
tests["adopt-foreign-v2"] = w => { create(w, "network-after", "b"); const before = snapshot(w.target); adoption(w, 2); assert.deepEqual(snapshot(w.target), before); assert(!fs.existsSync(w.audit)); };
for (const kind of ["symlink", "hardlink"]) tests["adopt-audit-" + kind] = w => {
  legacy(w); fs.mkdirSync(path.dirname(w.audit), { recursive: true }); const outside = path.join(w.dir, "outside-audit"); fs.writeFileSync(outside, "KEEP\n");
  if (kind === "symlink") fs.symlinkSync(outside, w.audit); else fs.linkSync(outside, w.audit);
  const before = fs.readFileSync(w.file, "utf8"); adoption(w, 2); assert.equal(fs.readFileSync(w.file, "utf8"), before); assert.equal(fs.readFileSync(outside, "utf8"), "KEEP\n");
};
tests["adopt-busy"] = w => { legacy(w); fs.mkdirSync(path.join(w.root, "seats/run/cleanup.lock")); const before = fs.readFileSync(w.file, "utf8"); adoption(w, 2); assert.equal(fs.readFileSync(w.file, "utf8"), before); assert(!fs.existsSync(w.audit)); };
// Every case has a targeted safety/behavior removal, run only in pinned copies.
type Control = { file: string; old: string; replacement: string; cases: string[] };
const controls: Control[] = [
  { file: "cleanup-identity.ts", old: "&& m.hostId === identity.hostId", replacement: "&& m.hostname === HOST && m.hostId === identity.hostId", cases: ["renamed-scratch", "renamed-lock"] },
  { file: "cleanup-identity.ts", old: "&& m.hostId === identity.hostId", replacement: "&& true", cases: ["foreign-scratch", "foreign-lock"] },
  { file: "cleanup-identity.ts", old: "return legacyHostnameMatches(m.hostname);", replacement: "return m.hostname === HOST;", cases: ["legacy-known"] },
  { file: "selftest-sweep-lock.ts", old: "return names.has(hostname);", replacement: "return true;", cases: ["legacy-unknown"] },
  { file: "selftest-sweep-lock.ts", old: "if (e.errno === 2) return false; // Missing cache", replacement: "if (e.errno === 2) return true; // Missing cache", cases: ["legacy-missing-cache"] },
  { file: "selftest-sweep-lock.ts", old: "record.hostId !== expectedId", replacement: "false", cases: ["legacy-foreign-cache"] },
  { file: "selftest-sweep-lock.ts", old: "fd = openAt(parent, name, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);\n    const anchor", replacement: "fd = openAt(parent, name, C.O_RDONLY | C.O_DIRECTORY);\n    const anchor", cases: ["legacy-symlink-cache"] },
  { file: "cleanup-identity.ts", old: "if (identity.source === \"hostname\") throw", replacement: "if (false) throw", cases: ["unavailable-create"] },
  { file: "cleanup-identity.ts", old: "identity.source !== \"hostname\" &&", replacement: "true &&", cases: ["unavailable-read"] },
  { file: "cleanup-identity.ts", old: "function adoptLegacyScratch(root: string, target: string, bead: string) {", replacement: "function adoptLegacyScratch(root: string, target: string, bead: string) { throw new Error('control: adoption disabled');", cases: ["adopt-v1"] },
  ...["root", "target", "identity", "bead"].map(field => ({ file: "cleanup-identity.ts", old: `m.${field} === ${field}`, replacement: "true", cases: ["adopt-mismatch-" + field] })),
  { file: "cleanup-identity.ts", old: "console.log(JSON.stringify(adoptLegacyScratch(path.resolve(options.get(\"--root\")!), path.resolve(options.get(\"--target\")!), options.get(\"--bead\")!)));", replacement: "console.log(JSON.stringify({event:'adopted-v1'}));", cases: ["adopt-unmarked"] },
  { file: "cleanup-identity.ts", old: "m.version !== 1 || !validRecordFields", replacement: "false || !validRecordFields", cases: ["adopt-foreign-v2"] },
  { file: "cleanup-identity.ts", old: "C.O_WRONLY | C.O_APPEND | C.O_CREAT | C.O_NOFOLLOW | C.O_NONBLOCK", replacement: "C.O_WRONLY | C.O_APPEND | C.O_CREAT | C.O_NONBLOCK", cases: ["adopt-audit-symlink"] },
  { file: "cleanup-identity.ts", old: "st.nlink !== 1", replacement: "false", cases: ["adopt-audit-hardlink"] },
  { file: "cleanup-identity.ts", old: "if (lease >= 0) {", replacement: "if (false) {", cases: ["adopt-busy"] },
];
let failures = 0;
for (const [name, test] of Object.entries(tests)) {
  try { test(world("fixed-" + name)); console.log("PASS " + name); }
  catch (e: any) { failures++; console.error("FAIL " + name + ": " + e.message); }
}
const covered = new Set<string>();
for (const [i, control] of controls.entries()) {
  const runtime = path.join(base, "control-runtime-" + i); fs.mkdirSync(runtime);
  for (const [file, source] of Object.entries(originals)) {
    let modified = source;
    if (file === control.file) {
      const count = source.split(control.old).length - 1;
      // The hardlink guard intentionally occurs at open and before append.
      assert.equal(count, control.old === "st.nlink !== 1" ? 2 : 1, `control must target the measured source: ${control.old}`);
      modified = source.replaceAll(control.old, control.replacement);
      if (control.cases.includes("adopt-audit-symlink")) modified = modified.replace("const current = openAt(directoryFd, ADOPTION_LOG);", "const current = native.symbols.openat(directoryFd, z(ADOPTION_LOG), C.O_RDONLY | C.O_NONBLOCK) as number;");
      if (control.cases.includes("legacy-symlink-cache")) modified = modified.replace("const current = openAt(parent, name, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);\n    try { if (id(current) !== id(fd)) throw new Refused(\"stable host cache directory changed", "const current = openAt(parent, name, C.O_RDONLY | C.O_DIRECTORY);\n    try { if (id(current) !== id(fd)) throw new Refused(\"stable host cache directory changed");
    }
    fs.writeFileSync(path.join(runtime, file), modified);
  }
  for (const name of control.cases) {
    let caught = "";
    try { tests[name](world(`negative-${i}-${name}`, runtime)); } catch (e: any) { caught = e.message; }
    if (!caught) { failures++; console.error("FAIL negative control did not detect removed fix: " + name); }
    else { covered.add(name); console.log("NEGATIVE detected " + name + ": " + caught.split("\n")[0]); }
  }
}
assert.deepEqual([...covered].sort(), Object.keys(tests).sort(), "every new case has a failing removal control");
console.log(`${Object.keys(tests).length} host/adoption cases; ${covered.size} failing removal controls; ${failures} failures`);
process.exitCode = failures ? 1 : 0;
