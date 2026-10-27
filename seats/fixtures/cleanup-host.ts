import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "./fixture-command.cjs";
const [base, seats] = process.argv.slice(2);
assert(fs.statSync(path.join(base, ".wheelhouse-selftest-fixture")).isFile());
const fixture = import.meta.dir, preload = path.join(fixture, "cleanup-host-preload.ts"), probe = path.join(fixture, "cleanup-host-probe.ts");
const marker = ".wheelhouse-cleanup-scratch.json", bead = "host-task", sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const id = (machine: string) => sha(process.platform === "darwin" ? `darwin:${machine === "b" ? "20000000-0000-0000-0000-000000000002" : "10000000-0000-0000-0000-000000000001"}` : `linux:${(machine === "b" ? "2" : "1").repeat(32)}`);
assert.notEqual(id("a"), id("b"));
// Pin both files before any controls. Never mutate a queued worktree.
const originals = Object.fromEntries(["cleanup-identity.ts", "selftest-sweep-lock.ts", "native-command.ts", "completed-command.ts"].map(n => [n, fs.readFileSync(path.join(seats, n), "utf8")]));
console.log("pinned cleanup sources " + JSON.stringify(Object.fromEntries(Object.entries(originals).map(([n, s]) => [n, sha(s)]))));
type World = ReturnType<typeof world>;
function world(name: string, runtime = seats) {
  const dir = path.join(base, name), root = path.join(dir, "project"), target = path.join(root, ".wheelhouse-runs", bead), lock = path.join(dir, "sweep.lock");
  fs.mkdirSync(root, { recursive: true });
  return { dir, root, target, lock, runtime, bead, file: path.join(target, marker), audit: path.join(root, "seats/logs/cleanup-adoptions.jsonl") };
}
function env(host = "network-after", machine = "a", lock: string) {
  return { ...process.env, CLEANUP_FIXTURE_HOST: host, CLEANUP_FIXTURE_MACHINE: machine, WHEELHOUSE_SELFTEST_SWEEP_LOCK: lock };
}
function command(w: World, args: string[], host = "network-after", machine = "a", lock = w.lock, extra: Record<string, string> = {}) {
  const r = spawnSync("bun", ["--preload", preload, ...args], { cwd: w.root, env: { ...env(host, machine, lock), ...extra }, encoding: "utf8" });
  const error = r.error && { name: r.error.name, message: r.error.message, code: r.error.code, errno: r.error.errno, syscall: r.error.syscall, path: r.error.path };
  const record = JSON.stringify({ case: path.basename(w.dir), args, host, machine, extra, status: r.status, signal: r.signal, error, stdout: r.stdout, stderr: r.stderr }) + "\n";
  fs.appendFileSync(path.join(w.dir, "calls.jsonl"), record);
  if (process.env.CLEANUP_HOST_EVIDENCE) {
    fs.mkdirSync(process.env.CLEANUP_HOST_EVIDENCE, { recursive: true });
    fs.appendFileSync(path.join(process.env.CLEANUP_HOST_EVIDENCE, "calls.jsonl"), record);
  }
  if (r.error || r.signal !== null) throw new Error("FIXTURE_NATIVE_GATE: " + record);
  return r;
}
function expect(r: ReturnType<typeof command>, status: number) { assert.equal(r.status, status, r.stdout + r.stderr); return r; }
function call(w: World, action: string, status = 0, host = "network-after", machine = "a", lock = w.lock, extra: Record<string, string> = {}) {
  return expect(command(w, [probe, path.join(w.runtime, "cleanup-identity.ts"), w.root, w.bead, action], host, machine, lock, extra), status);
}
function create(w: World, host = "network-before", machine = "a") {
  const made = command(w, [probe, path.join(w.runtime, "cleanup-identity.ts"), w.root, w.bead, "prepare"], host, machine);
  if (made.status !== 0) throw new Error("SETUP: initial ownership producer failed: " + made.stdout + made.stderr);
  const m = JSON.parse(fs.readFileSync(w.file, "utf8"));
  if (m.version !== 2 || m.hostId !== id(machine) || m.hostname !== host) throw new Error("SETUP: initial ownership producer returned the wrong schema/host");
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
function adoption(w: World, status = 0, selectedBead = bead, extra: Record<string, string> = {}) {
  return expect(command(w, [path.join(w.runtime, "cleanup-identity.ts"), "adopt-v1", "--root", w.root, "--target", w.target, "--bead", selectedBead], "network-after", "a", w.lock, extra), status);
}
function refusedLegacy(w: World, lock = w.lock) {
  const before = fs.readFileSync(w.file, "utf8"), r = call(w, "prepare", 2, "network-after", "a", lock);
  assert.match(r.stderr, /adopt-v1 --root .*--target .*--bead /); assert.match(r.stderr, /seats\/README.md: Explicit legacy scratch host adoption/);
  assert.equal(fs.readFileSync(w.file, "utf8"), before);
}
const restart = { CLEANUP_FIXTURE_DEVICE_SHIFT: "17" };
function afterRestart(w: World, action: string, status = 0, extra: Record<string, string> = {}) {
  return call(w, action, status, "network-after", "a", w.lock, { ...restart, ...extra });
}
// Capture the native read-only producer before constructing the quiet boundary.
const nativeCwd = spawnSync("lsof", ["-a", "-p", String(process.pid), "-d", "cwd", "-Fpcn"], { encoding: "utf8" });
assert(!nativeCwd.error && nativeCwd.signal === null && nativeCwd.status === 0, nativeCwd.stderr);
assert(nativeCwd.stdout.includes(`p${process.pid}\n`) && /^n\//m.test(nativeCwd.stdout));
fs.writeFileSync(path.join(base, "native-lsof.stdout"), nativeCwd.stdout);
fs.writeFileSync(path.join(base, "native-lsof.stderr"), nativeCwd.stderr);
if (process.env.CLEANUP_HOST_EVIDENCE) {
  fs.mkdirSync(process.env.CLEANUP_HOST_EVIDENCE, { recursive: true });
  fs.writeFileSync(path.join(process.env.CLEANUP_HOST_EVIDENCE, "native-lsof.json"), JSON.stringify({ command: ["lsof", "-a", "-p", String(process.pid), "-d", "cwd", "-Fpcn"], status: nativeCwd.status, signal: nativeCwd.signal, stdout: nativeCwd.stdout, stderr: nativeCwd.stderr }) + "\n");
}
const quietCwd = nativeCwd.stdout.replace(/^p[0-9]+$/gm, "p1").replace(/^n.*$/gm, "n/");
const closedRows = JSON.parse(fs.readFileSync(path.join(fixture, "cleanup-host-closed.json"), "utf8"));
assert.deepEqual(closedRows, [{ id: bead, status: "closed" }]);
function cleanup(w: World, extra: Record<string, string> = {}) {
  const entry = path.join(w.root, "seats/prune.ts");
  if (!fs.existsSync(entry)) {
    fs.cpSync(seats, path.join(w.root, "seats"), { recursive: true });
    for (const name of Object.keys(originals)) fs.copyFileSync(path.join(w.runtime, name), path.join(w.root, "seats", name));
    fs.writeFileSync(path.join(w.root, "seats/state.json"), '{"seats":{}}\n');
    const init = spawnSync("git", ["init", "-q", "-b", "main"], { cwd: w.root, encoding: "utf8" });
    if (init.error || init.status !== 0 || init.signal !== null) throw new Error("SETUP: git init failed: " + init.stderr);
    fs.mkdirSync(path.join(w.root, ".beads"));
    const bin = path.join(w.dir, "bin"); fs.mkdirSync(bin);
    // id/status producer captured from a real private bd graph before this fixture.
    const rows = JSON.stringify(closedRows.map((row: any) => ({ ...row, id: w.bead })));
    fs.writeFileSync(path.join(bin, "bd"), `#!/bin/sh\ncase " $* " in *" --status=closed "*) printf '%s\\n' '${rows}';; *) printf '[]\\n';; esac\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "lsof"), `#!/usr/bin/env bun\nprocess.stdout.write(${JSON.stringify(quietCwd)});\n`, { mode: 0o755 });
  }
  const bin = path.join(w.dir, "bin");
  return expect(command(w, [entry, "cleanup", "--root", w.root, "--log", path.join(w.dir, "cleanup.log")], "network-after", "a", w.lock,
    { ...restart, PATH: bin + path.delimiter + process.env.PATH, WHEELHOUSE_LSOF: path.join(bin, "lsof"), ...extra }), 0);
}
function keptAfterRestart(w: World, extra: Record<string, string> = {}) {
  const before = snapshot(w.target);
  afterRestart(w, "prepare", 2, extra); afterRestart(w, "read", 2, extra);
  const r = cleanup(w, extra);
  assert(r.stdout.includes("kept ") && !r.stdout.includes(`removed run-scratch ${w.target} `), r.stdout);
  assert.deepEqual(snapshot(w.target), before);
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
  "adopt-ffi-error": w => {
    legacy(w); const before = snapshot(w.target);
    const r = adoption(w, 2, bead, { CLEANUP_FIXTURE_FAIL_ADOPTION_LOGS: "1" }), after = snapshot(w.target);
    console.log("MEASUREMENT adopt-ffi-error " + JSON.stringify({ status: r.status, stderr: r.stderr.trim(), markerUnchanged: JSON.stringify(after) === JSON.stringify(before) }));
    assert.deepEqual(after, before, "failed adoption must not change the marker");
    assert(!fs.existsSync(w.audit), "failed log-directory creation cannot produce an adoption audit");
    assert.equal(r.stdout, "");
    assert(r.stderr.includes(`STOP: mkdir adoption logs failed (errno ${os.constants.errno.EBADF})`), r.stderr);
    assert.doesNotMatch(r.stderr, /ReferenceError|error is not defined/);
  },
};
tests["restart-new-record"] = w => {
  const m = create(w); fs.writeFileSync(path.join(w.target, "KEEP"), "restart payload\n"); const before = snapshot(w.target);
  const reused = JSON.parse(afterRestart(w, "prepare").stdout);
  assert.equal(reused.owned, true);
  assert.notEqual(reused.observedTargetIdentity.split(":")[0], m.identity.split(":")[0], "fixture must change the observed device, not the inode/marker");
  assert.equal(reused.observedTargetIdentity.split(":")[1], m.identity.split(":")[1]);
  assert.equal(reused.observedRootIdentity.split(":")[0], reused.observedTargetIdentity.split(":")[0]);
  afterRestart(w, "read"); assert.deepEqual(snapshot(w.target), before);
  const r = cleanup(w); assert(r.stdout.includes(`removed run-scratch ${w.target} `), r.stdout); assert(!fs.existsSync(w.target));
};
tests["restart-replaced-folder"] = w => {
  create(w); fs.writeFileSync(path.join(w.target, "KEEP"), "original payload\n");
  const retained = path.join(w.dir, "retained-original"), previous = fs.readFileSync(w.file); fs.renameSync(w.target, retained); fs.mkdirSync(w.target);
  fs.writeFileSync(w.file, previous); fs.writeFileSync(path.join(w.target, "KEEP"), "replacement payload\n");
  assert.notEqual(String(fs.statSync(w.target, { bigint: true }).ino), JSON.parse(previous.toString()).identity.split(":")[1]);
  keptAfterRestart(w); assert.equal(fs.readFileSync(path.join(retained, "KEEP"), "utf8"), "original payload\n");
};
tests["restart-other-volume"] = w => {
  create(w); fs.writeFileSync(path.join(w.target, "KEEP"), "other volume payload\n");
  keptAfterRestart(w, { CLEANUP_FIXTURE_OTHER_VOLUME: w.target });
};
tests["restart-foreign-scratch"] = w => { create(w, "network-after", "b"); keptAfterRestart(w); };
for (const field of ["root", "target"]) tests["restart-wrong-" + field] = w => {
  const m = create(w); m[field] = path.join(w.dir, "another-install"); fs.writeFileSync(w.file, JSON.stringify(m) + "\n"); keptAfterRestart(w);
};
tests["restart-wrong-bead"] = w => {
  const m = create(w); m.bead = "another-task";
  fs.writeFileSync(w.file, JSON.stringify(m) + "\n"); keptAfterRestart(w);
};
tests["restart-symlink"] = w => {
  create(w); const parent = path.dirname(w.target), retained = path.join(w.dir, "retained-runs"); fs.renameSync(parent, retained); fs.symlinkSync(retained, parent);
  keptAfterRestart(w); assert(fs.lstatSync(parent).isSymbolicLink());
};
tests["restart-legacy-v1"] = w => {
  legacy(w); cache(w); const before = snapshot(w.target); afterRestart(w, "prepare"); afterRestart(w, "read"); assert.deepEqual(snapshot(w.target), before);
  const unknown = world(path.basename(w.dir) + "-unknown", w.runtime); legacy(unknown, "unobserved-host"); fs.writeFileSync(path.join(unknown.target, "KEEP"), "legacy payload\n");
  const r = afterRestart(unknown, "prepare", 2); assert(r.stderr.includes("adopt-v1 --root"));
  const adopted = adoption(unknown, 0, bead, restart); assert.equal(JSON.parse(adopted.stdout).event, "adopted-v1");
  assert.equal(fs.readFileSync(path.join(unknown.target, "KEEP"), "utf8"), "legacy payload\n"); afterRestart(unknown, "read");
};
tests["restart-dead-lock"] = w => {
  call(w, "seed-lock"); const dir = path.join(w.root, "seats/run/cleanup.lock"), file = path.join(dir, "wheelhouse-cleanup-lock");
  const dead = JSON.parse(fs.readFileSync(file, "utf8"));
  try { process.kill(dead.pid, 0); throw new Error("SETUP: original seeded child is still live"); }
  catch (e: any) { if (e.code !== "ESRCH") throw e; }
  const reclaimed = cleanup(w); assert(reclaimed.stdout.includes("cleanup done"), reclaimed.stdout); assert(!fs.existsSync(dir));
  call(w, "seed-lock"); const live = JSON.parse(fs.readFileSync(file, "utf8")); live.pid = process.pid;
  fs.writeFileSync(file, JSON.stringify(live) + "\n"); fs.writeFileSync(path.join(dir, "pid"), process.pid + "\n");
  const before = snapshot(dir), r = cleanup(w); assert.equal(r.stdout.trim(), "already running"); assert.deepEqual(snapshot(dir), before);
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
  { file: "cleanup-identity.ts", old: "&& m.hostId === identity.hostId", replacement: "&& true", cases: ["foreign-scratch", "foreign-lock", "restart-foreign-scratch"] },
  { file: "cleanup-identity.ts", old: "return legacyHostnameMatches(m.hostname);", replacement: "return m.hostname === HOST;", cases: ["legacy-known"] },
  { file: "selftest-sweep-lock.ts", old: "return names.has(hostname);", replacement: "return true;", cases: ["legacy-unknown"] },
  { file: "selftest-sweep-lock.ts", old: "if (e.errno === 2) return false; // Missing cache", replacement: "if (e.errno === 2) return true; // Missing cache", cases: ["legacy-missing-cache"] },
  { file: "selftest-sweep-lock.ts", old: "record.hostId !== expectedId", replacement: "false", cases: ["legacy-foreign-cache"] },
  { file: "selftest-sweep-lock.ts", old: "fd = openAt(parent, name, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);\n    const anchor", replacement: "fd = openAt(parent, name, C.O_RDONLY | C.O_DIRECTORY);\n    const anchor", cases: ["legacy-symlink-cache"] },
  { file: "cleanup-identity.ts", old: "if (identity.source === \"hostname\") throw", replacement: "if (false) throw", cases: ["unavailable-create"] },
  { file: "cleanup-identity.ts", old: "identity.source !== \"hostname\" &&", replacement: "true &&", cases: ["unavailable-read"] },
  { file: "cleanup-identity.ts", old: "function adoptLegacyScratch(root: string, target: string, bead: string) {", replacement: "function adoptLegacyScratch(root: string, target: string, bead: string) { throw new Error('control: adoption disabled');", cases: ["adopt-v1"] },
  ...["root", "target", "identity", "bead"].map(field => ({ file: "cleanup-identity.ts", old: field === "identity" ? "recordedDirectoryMatches(m.identity, identity, root)" : `m.${field} === ${field}`, replacement: "true", cases: ["adopt-mismatch-" + field, ...(["root", "target"].includes(field) ? ["restart-wrong-" + field] : [])] })),
  { file: "cleanup-identity.ts", old: '&& typeof m.bead === "string" && m.bead.length > 0 && (bead === undefined || m.bead === bead)\n    && (path.basename(target) === m.bead || path.basename(target).startsWith(m.bead + "-") || path.basename(target).startsWith(m.bead + "_"))', replacement: '', cases: ["restart-wrong-bead"] },
  { file: "cleanup-identity.ts", old: "&& previous[2] === current[2]", replacement: "&& recorded === identity", cases: ["restart-new-record", "restart-legacy-v1", "restart-dead-lock"] },
  { file: "cleanup-identity.ts", old: "&& previous[2] === current[2]", replacement: "", cases: ["restart-replaced-folder"] },
  { file: "cleanup-identity.ts", old: "&& current[1] === String(rootStat.dev)", replacement: "", cases: ["restart-other-volume"] },
  { file: "cleanup-identity.ts", old: 'if (m.version !== 1 || !validRecordFields', replacement: 'if (m.identity !== id(fd) || m.version !== 1 || !validRecordFields', cases: ["restart-legacy-v1"] },
  { file: "cleanup-identity.ts", old: "existing && !alive(existing.owner)", replacement: "existing", cases: ["restart-dead-lock"] },
  { file: "cleanup-identity.ts", old: "const st = fs.lstatSync(current, { bigint: true });", replacement: "const st = fs.statSync(current, { bigint: true });", cases: ["restart-symlink"] },
  { file: "cleanup-identity.ts", old: "console.log(JSON.stringify(adoptLegacyScratch(path.resolve(options.get(\"--root\")!), path.resolve(options.get(\"--target\")!), options.get(\"--bead\")!)));", replacement: "console.log(JSON.stringify({event:'adopted-v1'}));", cases: ["adopt-unmarked"] },
  { file: "cleanup-identity.ts", old: "m.version !== 1 || !validRecordFields", replacement: "false || !validRecordFields", cases: ["adopt-foreign-v2"] },
  { file: "cleanup-identity.ts", old: "C.O_WRONLY | C.O_APPEND | C.O_CREAT | C.O_NOFOLLOW | C.O_NONBLOCK", replacement: "C.O_WRONLY | C.O_APPEND | C.O_CREAT | C.O_NONBLOCK", cases: ["adopt-audit-symlink"] },
  { file: "cleanup-identity.ts", old: "st.nlink !== 1", replacement: "false", cases: ["adopt-audit-hardlink"] },
  { file: "cleanup-identity.ts", old: "if (lease >= 0) {", replacement: "if (false) {", cases: ["adopt-busy"] },
  { file: "cleanup-identity.ts", old: 'fail("mkdir adoption logs")', replacement: 'throw error("mkdir adoption logs")', cases: ["adopt-ffi-error"] },
];
let failures = 0;
for (const [name, test] of Object.entries(tests)) {
  try { test(world("fixed-" + name)); console.log("PASS " + name); }
  catch (e: any) { failures++; console.error("FAIL " + name + ": " + e.message); }
}
const covered = new Set<string>();
let rejections = 0;
for (const [i, control] of controls.entries()) {
  const runtime = path.join(base, "control-runtime-" + i); fs.mkdirSync(runtime);
  for (const [file, source] of Object.entries(originals)) {
    let modified = source;
    if (file === control.file) {
      const count = source.split(control.old).length - 1;
      // The hardlink guard intentionally occurs at open and before append.
      assert.equal(count, control.old === "st.nlink !== 1" ? 2 : 1, `control must target the measured source: ${control.old}`);
      modified = source.replaceAll(control.old, control.replacement);
      if (control.cases.includes("restart-symlink")) modified = modified.replaceAll(" | C.O_NOFOLLOW", "").replace("if (real !== target)", "if (false)");
      if (control.cases.includes("adopt-audit-symlink")) modified = modified.replace("const current = openAt(directoryFd, ADOPTION_LOG);", "const current = native.symbols.openat(directoryFd, z(ADOPTION_LOG), C.O_RDONLY | C.O_NONBLOCK) as number;");
      if (control.cases.includes("legacy-symlink-cache")) modified = modified.replace("const current = openAt(parent, name, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);\n    try { if (id(current) !== id(fd)) throw new Refused(\"stable host cache directory changed", "const current = openAt(parent, name, C.O_RDONLY | C.O_DIRECTORY);\n    try { if (id(current) !== id(fd)) throw new Refused(\"stable host cache directory changed");
    }
    fs.writeFileSync(path.join(runtime, file), modified);
  }
  for (const name of control.cases) {
    const subject = world(`negative-${i}-${name}`, runtime);
    call(subject, "load"); // Compile/import setup is outside rejection credit.
    let caught = "";
    try { tests[name](subject); }
    catch (e: any) { if (e.code !== "ERR_ASSERTION") throw e; caught = e.message; }
    if (!caught) { failures++; console.error("FAIL negative control did not detect removed fix: " + name); }
    else { covered.add(name); rejections++; console.log("NEGATIVE detected " + name + ": " + caught.split("\n")[0]); }
  }
}
assert.deepEqual([...covered].sort(), Object.keys(tests).sort(), "every new case has a failing removal control");
console.log(`${Object.keys(tests).length} host/adoption cases; ${covered.size} cases covered; ${rejections} failing removal controls; ${failures} failures`);
process.exitCode = failures ? 1 : 0;
