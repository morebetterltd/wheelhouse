// Real runners, private locks and native FIFO barriers; Bun ESM assertions.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

const [root, runner, helper] = process.argv.slice(2);
assert(fs.statSync(path.join(root, ".wheelhouse-selftest-fixture")).isFile());
assert(fs.statSync(runner).isFile()); assert(fs.statSync(helper).isFile());
const suite = path.join(root, "fixture.selftest.sh"), code = path.join(root, "suite.ts");
fs.writeFileSync(suite, '#!/usr/bin/env bash\nexec bun "$QUEUE_SUITE"\n');
fs.writeFileSync(code, `import fs from "node:fs";
const e=process.env, gate=fs.openSync(e.QUEUE_GATE!,"r+"),active=e.QUEUE_ACTIVE!;
const fd=fs.openSync(active,"wx");fs.writeFileSync(fd,e.QUEUE_NAME!);fs.closeSync(fd);
fs.appendFileSync(e.QUEUE_EVENTS!,e.QUEUE_NAME+" enter\\n");
fs.writeSync(1,"QUEUE_ENTER "+e.QUEUE_NAME+"\\n");
fs.readSync(gate,Buffer.alloc(1),0,1,null);
fs.appendFileSync(e.QUEUE_EVENTS!,e.QUEUE_NAME+" exit\\n");fs.unlinkSync(active);fs.closeSync(gate);
`);

type Participant = { name: string; child: ChildProcess; stdout: string; stderr: string; closed: boolean; status: number | null; expectedStop: boolean; done: Promise<number | null>; gate: string };
class Case {
  dir: string; lock: string; participants: Participant[] = []; entered: string[] = [];
  listeners = new Set<() => void>(); cursor = 0;
  constructor(name: string) { this.dir = path.join(root, name); fs.mkdirSync(this.dir); this.lock = path.join(this.dir, "host.lock"); }
  notify() { for (const listener of [...this.listeners]) listener(); }
  async observe(condition: () => boolean, subject?: Participant) {
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        if (condition()) { this.listeners.delete(check); resolve(); return; }
        const failed = this.participants.find(p => p.closed && !p.expectedStop && (p === subject || p.status !== 0 || !p.stdout.includes(`QUEUE_ENTER ${p.name}\n`)));
        if (failed) { this.listeners.delete(check); reject(new Error(`${failed.name} closed before barrier:\n${failed.stdout}\n${failed.stderr}`)); }
      };
      this.listeners.add(check); check();
    });
  }
  start(name: string) {
    const gate = path.join(this.dir, name + ".fifo"), fifo = spawnSync("mkfifo", [gate], { encoding: "utf8" });
    assert.equal(fifo.status, 0, fifo.stderr);
    const child = spawn("bash", [runner], { env: { ...process.env, WHEELHOUSE_SELFTEST_SWEEP_PATTERN: suite, WHEELHOUSE_SELFTEST_SWEEP_LOCK: this.lock, WHEELHOUSE_SELFTEST_SWEEP_LOCK_HELPER: helper, QUEUE_SUITE: code, QUEUE_NAME: name, QUEUE_GATE: gate, QUEUE_ACTIVE: path.join(this.dir, "active"), QUEUE_EVENTS: path.join(this.dir, "events") }, stdio: ["ignore", "pipe", "pipe"] });
    const p: Participant = { name, child, stdout: "", stderr: "", closed: false, status: null, expectedStop: false, gate, done: Promise.resolve(null) };
    this.participants.push(p);
    let entered = false;
    child.stdout!.on("data", b => { p.stdout += b; if (!entered && p.stdout.includes(`QUEUE_ENTER ${name}\n`)) { entered = true; this.entered.push(name); } this.notify(); });
    child.stderr!.on("data", b => { p.stderr += b; this.notify(); });
    p.done = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", status => { p.closed = true; p.status = status; this.notify(); resolve(status); }); });
    return p;
  }
  async next(expected: string) { await this.observe(() => this.entered.length > this.cursor); assert.equal(this.entered[this.cursor++], expected, "actual acquisition order"); }
  async queued(p: Participant, position: number, holder: Participant) {
    await this.observe(() => /waiting for host-wide lock[^\n]*\n/.test(p.stderr), p);
    assert.match(p.stderr, new RegExp(`queue_position=${position} holder=pid=${holder.child.pid} started=`));
    console.log(`PASS ${p.name} registered at queue_position=${position} behind holder pid=${holder.child.pid}`);
  }
  release(p: Participant) { const fd = fs.openSync(p.gate, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK); try { fs.writeSync(fd, "r"); } finally { fs.closeSync(fd); } }
  ticket(p: Participant) {
    const dir = this.lock + ".queue";
    const rows = fs.readdirSync(dir).filter(n => /^\d{20}\./.test(n)).map(n => JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")));
    return rows.find(m => m.pid === p.child.pid);
  }
  probe(p: Participant) {
    const ticket = this.ticket(p); assert(ticket, "registered ticket must exist");
    const r = spawnSync("bun", [helper, "acquire", this.lock, String(p.child.pid), ticket.token, ""], { encoding: "utf8" });
    fs.writeFileSync(path.join(this.dir, p.name + ".probe.stdout"), r.stdout);
    fs.writeFileSync(path.join(this.dir, p.name + ".probe.stderr"), r.stderr);
    return r;
  }
  async finish() {
    for (const p of this.participants) if (!p.expectedStop) assert.equal(await p.done, 0, p.stderr + p.stdout);
    assert(!fs.existsSync(this.lock)); assert(!fs.existsSync(this.lock + ".queue"), "empty owned queue removed");
  }
  async cleanup() {
    for (const p of this.participants) {
      fs.writeFileSync(path.join(this.dir, p.name + ".stdout"), p.stdout); fs.writeFileSync(path.join(this.dir, p.name + ".stderr"), p.stderr);
      if (!p.closed) { p.expectedStop = true; p.child.kill("SIGCONT"); p.child.kill("SIGTERM"); }
    }
    await Promise.all(this.participants.map(p => p.done));
  }
}

async function fifo() {
  const c = new Case("fifo"); let first: Participant | undefined;
  try {
    const holder = c.start("holder"); await c.next("holder");
    first = c.start("first"); await c.queued(first, 1, holder);
    const second = c.start("second"); await c.queued(second, 2, holder);
    const third = c.start("third"); await c.queued(third, 3, holder);
    // Force a younger admission attempt while the oldest cannot poll. No
    // timing decides who attempts first and no absence is measured by a clock.
    first.child.kill("SIGSTOP"); c.release(holder); assert.equal(await holder.done, 0);
    const blocked = c.probe(third); assert.equal(blocked.status, 75, blocked.stderr + blocked.stdout);
    assert.match(blocked.stdout, /queue_position=3 holder=none/);
    console.log("PASS younger explicit attempt cannot pass a stopped oldest waiter");
    first.child.kill("SIGCONT");
    for (const p of [first, second, third]) { await c.next(p.name); c.release(p); assert.equal(await p.done, 0); }
    await c.finish();
    assert.equal(fs.readFileSync(path.join(c.dir, "events"), "utf8"), "holder enter\nholder exit\nfirst enter\nfirst exit\nsecond enter\nsecond exit\nthird enter\nthird exit\n");
    console.log("PASS three barrier-ordered waiters acquire FIFO with exclusive suite execution");
  } finally { first?.child.kill("SIGCONT"); await c.cleanup(); }
}
async function deadWaiter() {
  const c = new Case("dead");
  try {
    const holder = c.start("keeper"); await c.next("keeper");
    const dead = c.start("dead"); await c.queued(dead, 1, holder);
    const live = c.start("live"); await c.queued(live, 2, holder);
    dead.expectedStop = true; dead.child.kill("SIGKILL"); await dead.done;
    c.release(holder); assert.equal(await holder.done, 0);
    const admitted = c.probe(live); assert.equal(admitted.status, 0, admitted.stderr + admitted.stdout);
    assert(!c.ticket(dead), "definitively dead PID ticket reaped");
    await c.next("live"); c.release(live); await c.finish();
    console.log("PASS dead waiter is reaped by PID and does not block its live successor");
  } finally { await c.cleanup(); }
}
async function cancelWaiter() {
  const c = new Case("cancel");
  try {
    const holder = c.start("owner"); await c.next("owner");
    const waiter = c.start("cancelled"); await c.queued(waiter, 1, holder);
    const identity = fs.statSync(c.lock, { bigint: true }).ino;
    waiter.expectedStop = true; waiter.child.kill("SIGTERM"); assert.equal(await waiter.done, 143);
    assert(!c.ticket(waiter), "TERM removes only the cancelling waiter's ticket");
    assert.equal(fs.statSync(c.lock, { bigint: true }).ino, identity, "waiter cancellation preserves current holder");
    c.release(holder); await c.finish();
    console.log("PASS cancelled waiter removes its ticket without releasing the live holder");
  } finally { await c.cleanup(); }
}
async function integrity() {
  const dir = path.join(root, "integrity"); fs.mkdirSync(dir);
  const target = path.join(dir, "target"); fs.mkdirSync(target); fs.writeFileSync(path.join(target, "KEEP"), "keep\n");
  for (const kind of ["unmarked", "symlink", "foreign-ticket"]) {
    const lock = path.join(dir, kind + ".lock"), queue = lock + ".queue";
    if (kind === "symlink") fs.symlinkSync(target, queue);
    else {
      fs.mkdirSync(queue);
      if (kind === "unmarked") fs.writeFileSync(path.join(queue, "KEEP"), "keep\n");
      else {
        fs.writeFileSync(path.join(queue, "wheelhouse-selftest-sweep-queue"), JSON.stringify({ kind: "wheelhouse-selftest-sweep-queue", version: 1, hostname: os.hostname() }) + "\n");
        fs.writeFileSync(path.join(queue, "00000000000000000001." + "a".repeat(32)), JSON.stringify({ kind: "wheelhouse-selftest-sweep-waiter", version: 1, hostname: "another-host", pid: process.pid, started: "2026-10-15T00:00:00Z", token: "a".repeat(32) }) + "\n");
      }
    }
    function snapshot(p: string): unknown {
      const s = fs.lstatSync(p, { bigint: true });
      return [String(s.dev), String(s.ino), s.isSymbolicLink() ? fs.readlinkSync(p) : s.isDirectory() ? fs.readdirSync(p).sort().map(n => [n, snapshot(path.join(p, n))]) : fs.readFileSync(p, "utf8")];
    }
    const before = snapshot(queue), keep = snapshot(target);
    const result = spawnSync("bun", [helper, "acquire", lock, String(process.pid), "b".repeat(32), ""], { encoding: "utf8" });
    assert.equal(result.status, 2, result.stdout + result.stderr); assert.deepEqual(snapshot(queue), before); assert.deepEqual(snapshot(target), keep); assert(!fs.existsSync(lock));
    console.log(`PASS ${kind} queue refused intact without admitting a sweep`);
  }
}
const selected = process.env.WHEELHOUSE_QUEUE_TEST_CASE;
assert(!selected || ["fifo", "dead", "cancel", "integrity"].includes(selected), "known nonempty test leg");
for (const [name, run] of [["fifo", fifo], ["dead", deadWaiter], ["cancel", cancelWaiter], ["integrity", integrity]] as const) if (!selected || selected === name) await run();
console.log("selftest-sweep-queue: PASS");
