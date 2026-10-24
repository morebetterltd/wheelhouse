import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";

const [runtimeArg, parentArg, only = "all"] = process.argv.slice(2);
const runtime = fs.realpathSync(runtimeArg), parent = fs.realpathSync(parentArg);
assert(fs.statSync(path.join(parent, ".wheelhouse-selftest-fixture")).isFile());
assert(fs.statSync(path.join(runtime, "seats/adapter.ts")).isFile());
const cases = ["outside-other", "outside-name", "wrong-seat", "leaf-symlink", "parent-symlink", "logs-symlink", "hardlink", "archive-symlink", "archive-symlink-zero", "archive-hardlink", "archive-hardlink-zero", "archive-directory", "archive-fifo", "fifo", "valid-settled", "valid-unsettled"];
const selected = only === "all" ? cases : only.split(",");
assert(selected.length && selected.every(k => cases.includes(k)));
const payload = '{"type":"agent_end","messages":[]}\n';
const unfinished = '{"type":"agent_start"}\n';
let failures = 0;

function run(command: string, args: string[], cwd: string, env = process.env) {
  const r = spawnSync(command, args, {cwd, env, encoding: "utf8"});
  return {code: r.status, signal: r.signal, error: r.error?.message ?? null, stdout: r.stdout ?? "", stderr: r.stderr ?? ""};
}
function snapshot(file: string): unknown {
  let st: fs.Stats;
  try { st = fs.lstatSync(file); } catch (e: any) { if (e.code === "ENOENT" || e.code === "ENOTDIR") return {missing: true, code: e.code}; throw e; }
  return {dev: st.dev, ino: st.ino, mode: st.mode, nlink: st.nlink, size: st.size, mtime: st.mtimeMs,
    bytes: st.isFile() ? fs.readFileSync(file).toString("base64") : null,
    link: st.isSymbolicLink() ? fs.readlinkSync(file) : null,
    entries: st.isDirectory() ? fs.readdirSync(file).sort() : null};
}

for (const kind of selected) {
  const root = fs.mkdtempSync(path.join(parent, "log-owner-"));
  fs.cpSync(path.join(runtime, "seats"), path.join(root, "seats"), {recursive: true});
  const seats = path.join(root, "seats"), logs = path.join(seats, "logs"), victim = path.join(root, "victim");
  fs.mkdirSync(logs); fs.mkdirSync(victim);
  const name = "worker-log-owner", expected = path.join(logs, name + ".jsonl"), external = path.join(victim, "other.jsonl");
  fs.writeFileSync(external, "KEEP external victim\n" + payload);
  fs.writeFileSync(external + ".3", "KEEP external archive\n");
  let log = expected;
  const native: unknown[] = [];
  if (kind === "outside-other") log = external;
  else if (kind === "outside-name") { log = path.join(victim, name + ".jsonl"); fs.writeFileSync(log, payload); }
  else if (kind === "wrong-seat") log = path.join(logs, "somebody-else.jsonl");
  else if (kind === "leaf-symlink") fs.symlinkSync(external, log);
  else if (kind === "parent-symlink") {
    const alias = path.join(root, "alias"); fs.symlinkSync(logs, alias); log = path.join(alias, name + ".jsonl");
  } else if (kind === "logs-symlink") {
    fs.rmdirSync(logs); fs.symlinkSync(victim, logs);
  } else if (kind === "hardlink") fs.linkSync(external, log);
  if (kind === "fifo") {
    const made = run("mkfifo", [log], root); native.push({command: ["mkfifo", log], ...made});
    assert.equal(made.code, 0, JSON.stringify(made)); assert(fs.lstatSync(log).isFIFO());
  } else if (!fs.existsSync(log)) fs.writeFileSync(log, kind === "valid-unsettled" ? unfinished : payload);
  // The bead's minimal outside-file control must lose the .3 PATH, not just
  // replace its bytes with a shifted .2. Other cases exercise a full chain.
  const archiveSlots = kind === "outside-other" ? [3] : [1,2,3];
  for (const i of archiveSlots) fs.writeFileSync(log + "." + i, "KEEP archive " + i + "\n");
  if (kind.startsWith("archive-")) {
    fs.unlinkSync(log + ".1");
    if (kind.startsWith("archive-symlink")) fs.symlinkSync(external, log + ".1");
    else if (kind.startsWith("archive-hardlink")) fs.linkSync(external, log + ".1");
    else if (kind === "archive-directory") { fs.mkdirSync(log + ".1"); fs.writeFileSync(log + ".1/KEEP", "KEEP directory\n"); }
    else { const made = run("mkfifo", [log + ".1"], root); native.push({command: ["mkfifo", log + ".1"], ...made}); assert.equal(made.code, 0); assert(fs.lstatSync(log + ".1").isFIFO()); }
  }
  const stateFile = path.join(seats, "state.json");
  fs.writeFileSync(stateFile, JSON.stringify({seats: {[name]: {role: "worker", pid: null, log, fifo: path.join(seats, "run", name + ".stdin"), agentDir: path.join(root, "account"), stoppedAt: "2026-01-01T00:00:00.000Z"}}}) + "\n");
  const paths = [...new Set([stateFile, log, expected, external, external + ".3", ...[1,2,3].map(i => log + "." + i)])];
  if (kind === "archive-directory") paths.push(log + ".1/KEEP");
  const before = paths.map(file => ({file, data: snapshot(file)}));
  for (const file of [stateFile, log, external, external + ".3", ...archiveSlots.map(i => log + "." + i)]) {
    assert(!("missing" in (before.find(x => x.file === file)!.data as object)), "absent measurement subject: " + file);
  }
  const beforeLog = kind === "fifo" ? null : fs.readFileSync(log);
  const env = {...process.env, WHEELHOUSE_LOG_ROTATE_BYTES: "1", WHEELHOUSE_LOG_ROTATE_KEEP: kind.endsWith("-zero") ? "0" : "3", WHEELHOUSE_ORPHAN_CONFIRM_MS: "0"};
  const args = [path.join(seats, "adapter.ts"), "status"];
  if (kind === "fifo") {
    // Never let a negative control enter a native FIFO open/realpath. Calibrate
    // BOTH namespace hooks on an ordinary file first; exit 86 before unsafe I/O.
    const preload = path.join(root, "guard.mjs"), probe = path.join(root, "probe.mjs"), mark = path.join(root, "unsafe"), regular = path.join(root, "regular");
    fs.writeFileSync(regular, "regular calibration\n");
    fs.writeFileSync(preload, `import * as nativeFs from 'node:fs';
import {mock} from 'bun:test';
const fs={...nativeFs},target=process.env.EVO6_TARGET;
function unsafe(op,p){fs.appendFileSync(process.env.EVO6_MARK,op+' '+p+'\\n');
 if(process.env.EVO6_EXIT==='1'){console.error('EVO6_UNSAFE_FIFO: '+op);process.exit(86);}
 throw Object.assign(new Error('EVO6_UNSAFE_FIFO'),{code:'EVO6_UNSAFE_FIFO'});}
const hooks={openSync(p,...args){if(String(p)===target)unsafe('open',p);return fs.openSync(p,...args);},
 realpathSync(p,...args){if(String(p)===target)unsafe('realpath',p);return fs.realpathSync(p,...args);}};
mock.module('node:fs',()=>({...fs,...hooks,default:{...fs.default,...hooks}}));\n`);
    fs.writeFileSync(probe, `import * as fs from 'node:fs';import assert from 'node:assert/strict';
for(const call of [()=>fs.realpathSync(process.env.EVO6_TARGET),()=>fs.openSync(process.env.EVO6_TARGET,'r')])assert.throws(call,{code:'EVO6_UNSAFE_FIFO'});
console.log('PASS both namespace hooks calibrated on a regular file');\n`);
    const calibrated = run("bun", ["--preload", preload, probe], root, {...env, EVO6_TARGET: regular, EVO6_MARK: mark, EVO6_EXIT: "0"});
    native.push({command: ["bun", "--preload", preload, probe], ...calibrated});
    assert.equal(calibrated.code, 0, JSON.stringify(calibrated)); assert.equal(calibrated.stderr, ""); assert.equal(fs.readFileSync(mark, "utf8").trim().split("\n").length, 2);
    fs.unlinkSync(mark); Object.assign(env, {EVO6_TARGET: log, EVO6_MARK: mark, EVO6_EXIT: "1"}); args.unshift("--preload", preload);
  }
  const result = run("bun", args, root, env);
  const after = paths.map(file => ({file, data: snapshot(file)}));
  const problems: string[] = [];
  if (result.code !== 0 || result.signal || result.error) problems.push("status did not return 0: " + JSON.stringify(result));
  if (result.stderr) problems.push("unexpected status stderr: " + result.stderr);
  if (kind === "valid-settled") {
    const st = fs.lstatSync(log), original: any = before.find(x => x.file === log)!.data;
    if (st.size !== 0 || st.ino !== original.ino || st.dev !== original.dev) problems.push("settled current log was not copy-truncated in place");
    if (!fs.readFileSync(log + ".1").equals(beforeLog!)) problems.push("settled archive lost original bytes");
    if (fs.readFileSync(log + ".2", "utf8") !== "KEEP archive 1\n" || fs.readFileSync(log + ".3", "utf8") !== "KEEP archive 2\n") problems.push("archive chain not advanced");
    if (result.stdout.includes("not rotated")) problems.push("valid owned log refused");
    for (const file of [stateFile, external, external + ".3"]) {
      if (JSON.stringify(before.find(x => x.file === file)) !== JSON.stringify(after.find(x => x.file === file))) problems.push("settled rotation changed unrelated subject " + file);
    }
  } else {
    if (JSON.stringify(after) !== JSON.stringify(before)) problems.push("protected log/archive/victim/state changed");
    const note = `note: seat ${name} log ${log} is outside seats/logs; not rotated`;
    if (kind !== "valid-unsettled" && !result.stdout.includes(note)) problems.push("missing named refusal note");
    if (kind === "valid-unsettled" && result.stdout.includes("not rotated")) problems.push("valid unsettled log misclassified as unowned");
    if (kind.startsWith("archive-") && !result.stdout.includes(`archive ${log}.1`)) problems.push("unsafe archive not named");
  }
  if (kind === "fifo" && fs.existsSync(path.join(root, "unsafe"))) problems.push("FIFO open/realpath was attempted");
  console.log("MEASUREMENT log-owner " + JSON.stringify({kind, root, log, native, command: ["bun", ...args], result, before, after, problems}));
  if (problems.length) { failures++; console.error("FAIL log-owner " + kind + ": " + problems.join("; ")); }
  else console.log("PASS log-owner " + kind);
}
console.log(`log-rotation-owner: ${selected.length} cases, ${failures} failures`);
if (failures) process.exitCode = 1;
