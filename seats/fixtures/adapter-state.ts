import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
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
const peers: ReturnType<typeof Bun.spawn>[] = [];
const stops: ReturnType<typeof Bun.spawn>[] = [];
const records: Record<string, any> = {};
const token = randomUUID();
const write = (name: string) => fs.writeFileSync(path.join(dir, name), "release\n");
const read = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));

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
  return Bun.spawn(["bun", ...args], {
    cwd, env: { ...process.env, WHEELHOUSE_RPC_TIMEOUT_MS: "5000" },
    stdin: "ignore", stdout: Bun.file(path.join(dir, `${label}.out`)), stderr: Bun.file(path.join(dir, `${label}.err`)),
  });
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
  assert.equal(await bounded(stops[0].exited), 0, fs.readFileSync(path.join(dir, `stop-${names[0]}.err`), "utf8"));
  assert(!fs.existsSync(path.join(dir, `${names[1]}.release`)), "second stop still held until first commit");
  write(`${names[1]}.release`);
  assert.equal(await bounded(peers[1].exited), 0);
  assert.equal(await bounded(stops[1].exited), 0, fs.readFileSync(path.join(dir, `stop-${names[1]}.err`), "utf8"));
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
  for (const name of names) write(`${name}.release`);
  await bounded(Promise.all(peers.map(child => child.exited)));
  await bounded(Promise.all(stops.map(child => child.exited)));
}
