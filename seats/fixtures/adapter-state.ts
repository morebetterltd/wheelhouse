import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import os from "node:os";
import { acquirePidLock, releasePidLock } from "../lock";
import conditionWait from './wait-for-condition.cjs';
const { waitForCondition } = conditionWait;

const [root, order] = process.argv.slice(2);
assert(fs.statSync(root).isDirectory());
const dir = path.join(root, "barriers");
fs.mkdirSync(dir);
const peerFile = path.join(import.meta.dir, "adapter-state-peer.ts");
const stateFile = path.join(root, "seats/state.json");
const lockFile = path.join(root, "seats/state.lock");
assert(["ab", "ba"].includes(order));
const names = order === "ba" ? ["worker-b", "worker-a"] : ["worker-a", "worker-b"];
console.log(`stop commit order: ${names.join(" then ")}`);
// Deliberate commit latency holds the second peer past the old incidental 5s
// RPC-test override. This is a regression input, not an elapsed-time verdict.
const firstCommitDelayMs = Number(process.env.WHEELHOUSE_ADAPTER_STATE_FIRST_COMMIT_DELAY_MS ?? 6000);
assert(Number.isSafeInteger(firstCommitDelayMs) && firstCommitDelayMs >= 0 && firstCommitDelayMs <= 10000);
console.log("ADAPTER_STATE_AMBIENT " + JSON.stringify({ order, nice: os.getPriority(0), cores: os.cpus().length, load: os.loadavg(), firstCommitDelayMs }));
const peers: ReturnType<typeof Bun.spawn>[] = [];
const stops: ReturnType<typeof Bun.spawn>[] = [];
const records: Record<string, any> = {};
const token = randomUUID();
const write = (name: string) => fs.writeFileSync(path.join(dir, name), "release\n");
const read = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
function saveEvidence(suffix = "") {
  const evidence = process.env.WHEELHOUSE_ADAPTER_STATE_EVIDENCE;
  if (!evidence) return;
  try {
    fs.mkdirSync(evidence, { recursive: true });
    const target = path.join(evidence, order + suffix);
    fs.mkdirSync(target);
    const artifacts = path.join(target, "barriers");
    fs.mkdirSync(artifacts);
    // Copy only regular diagnostics, never open/copy the live stdin FIFOs.
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      assert(entry.isFile(), `unexpected diagnostic artifact: ${entry.name}`);
      fs.copyFileSync(path.join(dir, entry.name), path.join(artifacts, entry.name));
    }
    if (fs.existsSync(stateFile)) fs.copyFileSync(stateFile, path.join(target, "state.json"));
  } catch (error) {
    console.error("ADAPTER_STATE_EVIDENCE_ERROR", suffix, error);
    process.exitCode = 1;
  }
}

// Event barriers decide ordering. This deadline only fails a stuck fixture.
function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("fixture barrier/exit deadline")), 60000);
  })]).finally(() => clearTimeout(timer));
}
function barrier(name: string, child: ReturnType<typeof Bun.spawn>): Promise<void> {
  const observed = waitForCondition({ site: 'adapter-state.barrier', paths: [dir], predicate: () => fs.existsSync(path.join(dir, name)) });
  return bounded(Promise.race([
    observed.promise,
    child.exited.then(code => { throw new Error(`${name}: child exited ${code} before barrier`); }),
  ])).finally(observed.cancel);
}
function native(command: string, args: string[]): string {
  const r = spawnSync(command, args, { encoding: "utf8", env: { ...process.env } });
  assert.equal(r.status, 0, `${command}: ${r.stderr}`);
  return r.stdout;
}
function spawn(args: string[], cwd: string, label: string) {
  const env = { ...process.env,
    WHEELHOUSE_STATE_WRITE_DELAY_MS: label === `stop-${names[0]}` ? String(firstCommitDelayMs) : "0" };
  // The second peer intentionally waits for the first stop's commit. Exercise
  // the unchanged product default, not an incidental RPC-test shutdown grace.
  delete env.WHEELHOUSE_RPC_TIMEOUT_MS;
  const child = Bun.spawn(["bun", ...args], {
    cwd, env,
    stdin: "ignore", stdout: Bun.file(path.join(dir, `${label}.out`)), stderr: Bun.file(path.join(dir, `${label}.err`)),
  });
  fs.writeFileSync(path.join(dir, `${label}.spawn.json`), JSON.stringify({ pid: child.pid, args, cwd,
    rpcTimeoutOverride: env.WHEELHOUSE_RPC_TIMEOUT_MS ?? null, stateWriteDelayMs: Number(env.WHEELHOUSE_STATE_WRITE_DELAY_MS) }));
  return child;
}
const failures: string[] = [];
function check(label: string, body: () => void) {
  try { body(); console.log(`PASS ${label}`); }
  catch (e: any) { failures.push(label); console.error(`FAIL ${label}: ${e.message}`); }
}
try {
  for (const name of names) {
    const cwd = path.join(root, name);
    fs.mkdirSync(cwd);
    const fifo = path.join(root, "seats", `${name}.stdin`);
    native("mkfifo", [fifo]);
    const child = spawn([peerFile, dir, name, fifo, token], cwd, name);
    peers.push(child);
    await barrier(`${name}.ready`, child);
    const ready = JSON.parse(fs.readFileSync(path.join(dir, `${name}.ready`), "utf8"));
    assert.equal(ready.pid, child.pid); assert.equal(ready.token, token);
    records[name] = { pid: child.pid, startedAt: ready.startedAt, cwd: `${cwd}-old`, fifo,
      log: path.join(dir, `${name}.jsonl`), sessionId: `session-${name}`, sessionFile: `file-${name}`, role: "worker", lastBead: `bead-${name}` };
  }
  records.observer = { pid: null, note: "old" };
  fs.writeFileSync(stateFile, JSON.stringify({ seats: records }));
  // Fresh native allocation/generation/UID/parent/argv/cwd proof before stop
  // is allowed to signal the peers. No name-only or PID-only cleanup.
  const proofs = [];
  for (let i = 0; i < names.length; i++) {
    const pid = peers[i].pid, name = names[i];
    const row = native("ps", ["-p", String(pid), "-o", "pid=,ppid=,uid=,lstart=,command="]);
    const fields = row.trim().split(/\s+/);
    assert.equal(Number(fields[0]), pid); assert.equal(Number(fields[1]), process.pid); assert.equal(Number(fields[2]), process.getuid!());
    assert(row.includes(peerFile) && row.includes(token));
    const cwd = native("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
    assert(cwd.split("\n").includes(`n${fs.realpathSync(path.join(root, name))}`));
    proofs.push({ name, row, cwd });
  }
  fs.writeFileSync(path.join(dir, "ownership.json"), JSON.stringify(proofs, null, 2));
  for (const name of names) stops.push(spawn([path.join(root, "seats/adapter.ts"), "stop", name], root, `stop-${name}`));
  await Promise.all(names.map((name, i) => barrier(`${name}.term`, stops[i])));
  for (let i = 0; i < names.length; i++) assert.equal(Number(fs.readFileSync(path.join(dir, `${names[i]}.term`), "utf8")), peers[i].pid);
  console.log("PASS both stop commands reached the SIGTERM barriers before either peer exited");
  const fd = acquirePidLock(lockFile);
  assert.notEqual(fd, null, "stops must not hold the state lock across peer/process waits");
  try {
    const refreshed = read();
    for (const name of names) refreshed.seats[name].cwd = path.join(root, name);
    refreshed.seats.observer.note = "fresh";
    fs.writeFileSync(stateFile, JSON.stringify(refreshed));
  } finally { releasePidLock(lockFile, fd); }
  write(`${names[0]}.release`);
  assert.equal(await bounded(peers[0].exited), 0);
  const firstStop = await bounded(stops[0].exited);
  console.log("ADAPTER_STATE_FIRST_STOP " + JSON.stringify({ order, native: firstStop, stderr: fs.readFileSync(path.join(dir, `stop-${names[0]}.err`), "utf8") }));
  assert.equal(firstStop, 0, fs.readFileSync(path.join(dir, `stop-${names[0]}.err`), "utf8"));
  assert(!fs.existsSync(path.join(dir, `${names[1]}.release`)), "second stop still held until first commit");
  const committed = read();
  console.log("ADAPTER_STATE_COMMIT_SNAPSHOT " + JSON.stringify({ order, first: committed.seats[names[0]].pid, second: committed.seats[names[1]].pid }));
  assert.equal(committed.seats[names[0]].pid, null, "first stop must have committed before the second release");
  assert.equal(committed.seats[names[1]].pid, peers[1].pid, "second stop must remain uncommitted until its ordered release");
  write(`${names[1]}.release`);
  assert.equal(await bounded(peers[1].exited), 0);
  const secondStop = await bounded(stops[1].exited);
  console.log("ADAPTER_STATE_SECOND_STOP " + JSON.stringify({ order, native: secondStop, stderr: fs.readFileSync(path.join(dir, `stop-${names[1]}.err`), "utf8") }));
  assert.equal(secondStop, 0, fs.readFileSync(path.join(dir, `stop-${names[1]}.err`), "utf8"));
  const final = read();
  for (const name of names) {
    check(`${name} keeps its own refreshed cwd`, () => assert.equal(final.seats[name].cwd, path.join(root, name)));
    check(`${name} keeps its stopped state`, () => { assert.equal(final.seats[name].pid, null); assert(Number.isFinite(Date.parse(final.seats[name].stoppedAt))); });
    assert.equal(final.seats[name].sessionId, records[name].sessionId);
    assert.equal(final.seats[name].sessionFile, records[name].sessionFile);
    assert.equal(final.seats[name].lastBead, records[name].lastBead);
  }
  check("unrelated seat keeps its fresh field", () => assert.equal(final.seats.observer.note, "fresh"));
  console.log("PASS sessions and bead records survive both stops");
  if (failures.length) {
    console.error(`adapter-state.selftest: ${failures.length} failure(s)`);
    process.exitCode = 1;
  } else console.log("adapter-state.selftest: PASS");
} finally {
  saveEvidence(".before-cleanup");
  for (const name of names) write(`${name}.release`);
  try {
    await bounded(Promise.all(peers.map(child => child.exited)));
    await bounded(Promise.all(stops.map(child => child.exited)));
  } finally { saveEvidence(); }
}
