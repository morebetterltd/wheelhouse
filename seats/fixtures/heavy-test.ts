// Real runners/helpers copied into two installs; no load generator or service.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
const [root, source] = process.argv.slice(2);
assert(fs.statSync(path.join(root, ".wheelhouse-selftest-fixture")).isFile());
const mutation = process.env.WHEELHOUSE_TEST_HEAVY_REMOVE || "";
const host = path.join(root, "host"); fs.mkdirSync(host);
const lock = path.join(host, "wheelhouse-selftest-sweep.lock"), pause = path.join(host, "brake");
const installs = ["A", "B"].map(name => {
  const dir = path.join(root, name), seats = path.join(dir, "seats"); fs.mkdirSync(seats, { recursive: true });
  fs.mkdirSync(path.join(dir, "tmp"));
  for (const file of ["heavy-test.sh", "heavy-test-entry.ts", "selftest-sweep.sh", "selftest-sweep-lock.ts", "native-command.ts", "completed-command.ts", "python-invocations.ts"]) {
    const original = fs.readFileSync(path.join(source, file), "utf8");
    // Only relocate the canonical endpoint, not TMPDIR, as in the default-lock
    // sweep regression. Otherwise this inner fixture would queue on its parent.
    let text = original.replaceAll("/tmp/wheelhouse-selftest-sweep.lock", lock);
    if (mutation === "bench" && file === "heavy-test.sh") text = text.replace('wheelhouse_admit_heavy_test "$@" ||', 'true ||');
    if (mutation === "brake" && file === "selftest-sweep-lock.ts") {
      const anchor = 'try { fs.lstatSync(pauseFile); paused = true; }'; assert(text.includes(anchor));
      text = text.replace(anchor, 'try { paused = false; }');
    }
    if (mutation === "review" && file === "heavy-test-entry.ts") text = text.replace('if (probe.status === 0) { await main(); return; }', 'if (true) { await main(); return; }');
    if (mutation === "nested" && file === "selftest-sweep.sh") text = text.replace('if bun "$LOCK_HELPER" inherited "$LOCK"; then return 0; else rc=$?; fi', 'rc=75');
    fs.writeFileSync(path.join(seats, file), text);
  }
  fs.writeFileSync(path.join(dir, "payload.sh"), `#!/usr/bin/env bash
set -eu
mkdir "$ACTIVE" || { printf 'OVERLAP %s\\n' "$NAME"; exit 19; }
trap 'rmdir "$ACTIVE"' EXIT
printf '%s start\\n' "$NAME" >> "$EVENTS"
printf 'START %s argv=%s cwd=%s\\n' "$NAME" "$*" "$PWD"
while [ ! -f "$RELEASE" ]; do sleep 0.05; done
printf '%s end\\n' "$NAME" >> "$EVENTS"
printf 'END %s\\n' "$NAME"
`);
  fs.writeFileSync(path.join(dir, "bench.sh"), '#!/usr/bin/env bash\nset -eu\n. "$(dirname "$0")/seats/heavy-test.sh"\nbash "$(dirname "$0")/payload.sh" "$@"\n');
  fs.writeFileSync(path.join(seats, "idle.selftest.sh"), '#!/usr/bin/env bash\nset -eu\nbash "$(dirname "$0")/../payload.sh" "$@"\n');
  // An unmodified project bench inside a one-shot review is covered even if it
  // has not adopted the bench prologue. Same entry used by real verify.ts.
  fs.writeFileSync(path.join(seats, "review.ts"), `import {heavyTestEntry} from "./heavy-test-entry"; import {spawn} from "node:child_process";
async function main(){ await new Promise<void>((resolve,reject)=>{const c=spawn("bash",["payload.sh",...process.argv.slice(2)],{stdio:"inherit"});c.once("error",reject);c.once("close",code=>code===0?resolve():reject(Error("bench exit "+code)));}); }
await heavyTestEntry(import.meta.path,main);
`);
  // Source policy audits real tracked sources before the copied sweep runs.
  const init = Bun.spawnSync(["git", "init", "-q", "-b", "main", dir]); assert.equal(init.exitCode, 0);
  const add = Bun.spawnSync(["git", "-C", dir, "add", "seats"]); assert.equal(add.exitCode, 0);
  return dir;
});
type Run = { child: ChildProcess; out: string; err: string; closed: boolean; code: number | null; signal: NodeJS.Signals | null; done: Promise<void>; release: string };
const runs: Run[] = [];
const listeners = new Set<() => void>();
const notify = () => { for (const f of [...listeners]) f(); };
async function until(p: Run, test: () => boolean, label: string) {
  console.error(`FIXTURE_WAIT heavy-test: ${label}, child=${p.child.pid}`);
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => { listeners.delete(check); error ? reject(error) : resolve(); };
    const check = () => { if (test()) finish(); else if (p.closed) finish(Error(`${label}: early exit ${p.code}/${p.signal}\n${p.out}\n${p.err}`)); };
    listeners.add(check); check();
  });
}
let sequence = 0;
function start(kind: string, install: number, name: string, dir: string): Run {
  const cwd = installs[install], release = path.join(dir, name + ".release");
  const env = { ...process.env, TMPDIR: path.join(cwd, "tmp"), WHEELHOUSE_HEAVY_TEST_PAUSE: pause, WHEELHOUSE_SELFTEST_SWEEP_WAIT_SECONDS: "0.03", WHEELHOUSE_SELFTEST_SWEEP_PATTERN: path.join(cwd, "seats/idle.selftest.sh"), NAME: name, ACTIVE: path.join(dir, "active"), EVENTS: path.join(dir, "events"), RELEASE: release };
  // Exercise defaults in BOTH installs: no override may secretly join them.
  delete env.WHEELHOUSE_SELFTEST_SWEEP_LOCK; delete env.WHEELHOUSE_SELFTEST_SWEEP_LOCK_HELPER;
  const args = kind === "nested" ? ["bash", "nested.sh"] : kind === "sweep" ? ["bash", "seats/selftest-sweep.sh"] : kind === "review" ? ["bun", "seats/review.ts", "argument with space"] : kind === "command" ? ["bash", "seats/heavy-test.sh", "bash", "payload.sh", "argument with space"] : ["bash", "bench.sh", "argument with space"];
  const child = spawn(args[0], args.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const p: Run = { child, out: "", err: "", closed: false, code: null, signal: null, done: Promise.resolve(), release }; runs.push(p);
  child.stdout!.on("data", b => { p.out += b; notify(); }); child.stderr!.on("data", b => { p.err += b; notify(); });
  p.done = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => { p.closed = true; p.code = code; p.signal = signal; notify(); resolve(); }); });
  return p;
}
const entered = (p: Run) => until(p, () => p.out.includes("START ") || p.out.includes("OVERLAP "), "body entered").then(() => assert(!p.out.includes("OVERLAP "), p.out));
async function queued(p: Run, position: number) {
  await until(p, () => p.err.includes("waiting for host-wide lock") || p.out.includes("START ") || p.out.includes("OVERLAP "), "registered waiter");
  assert.match(p.err, new RegExp(`waiting for host-wide lock[^\\n]*queue_position=${position} `));
}
async function complete(p: Run) { fs.writeFileSync(p.release, "go\n"); await p.done; assert.equal(p.code, 0, p.out + p.err); assert.equal(p.signal, null); assert(p.child.stdout!.readableEnded && p.child.stderr!.readableEnded); }
function clear() { assert(!fs.existsSync(lock)); assert(!fs.existsSync(lock + ".queue")); }
async function serial(first: string, second: string) {
  const dir = path.join(root, "serial-" + sequence++); fs.mkdirSync(dir);
  const a = start(first, 0, "first", dir); await entered(a);
  assert(fs.statSync(path.join(lock, "pid")).isFile(), "active subject exists");
  const b = start(second, 1, "second", dir); await queued(b, 1);
  await complete(a); await entered(b); await complete(b);
  assert.equal(fs.readFileSync(path.join(dir, "events"), "utf8"), "first start\nfirst end\nsecond start\nsecond end\n");
  if (second !== "sweep") assert(b.out.includes("argv=argument with space cwd=" + installs[1]));
  console.log("MEASUREMENT " + JSON.stringify({ first, second, installs: ["A", "B"], differentTmpdirs: true, waiter: /queue_position=[^\n]*/.exec(b.err)?.[0], exits: [a.code, b.code], events: fs.readFileSync(path.join(dir, "events"), "utf8") }));
  clear();
}
async function brake(kind: string) {
  const dir = path.join(root, "brake-" + kind); fs.mkdirSync(dir);
  const a = start(kind, 0, "running", dir); await entered(a);
  fs.writeFileSync(pause, "fixture host brake fired mid-run\n");
  assert(fs.statSync(pause).isFile());
  const b = start("bench", 1, "second", dir); await queued(b, 1);
  const c = start("sweep", 0, "third", dir); await queued(c, 2);
  await complete(a); // The admitted payload actually finished, not just stayed live.
  await until(b, () => b.err.includes("holder=none") || b.out.includes("START "), "braked free endpoint");
  assert.match(b.err, /holder=none[^\n]*paused_by=/);
  assert(!b.out.includes("START ") && !c.out.includes("START "), "new runs remain queued after holder completes");
  const tickets = fs.readdirSync(lock + ".queue").filter(n => /^\d{20}\./.test(n)); assert.equal(tickets.length, 2);
  fs.unlinkSync(pause);
  await entered(b); await complete(b); await entered(c); await complete(c);
  assert.equal(fs.readFileSync(path.join(dir, "events"), "utf8"), "running start\nrunning end\nsecond start\nsecond end\nthird start\nthird end\n");
  console.log("MEASUREMENT " + JSON.stringify({ brakeDuring: kind, admittedRunExit: a.code, successorsBlockedAfterCompletion: true, retainedTickets: tickets.length, exitsAfterRelease: [b.code, c.code], events: fs.readFileSync(path.join(dir, "events"), "utf8") })); clear();
}
async function wiring() {
  const text = fs.readFileSync(path.join(source, "verify.ts"), "utf8");
  assert(text.includes('heavyTestEntry(import.meta.path, main)'), "verify.ts enters admission before main/watchdogs/sweep");
  const dir = path.join(root, "nested"); fs.mkdirSync(dir);
  // A wrapped bench may itself run the full-sweep runner. Both must reuse the
  // ancestor-owned admission rather than enqueue behind themselves.
  const cwd = installs[0];
  fs.writeFileSync(path.join(cwd, "nested.sh"), '#!/usr/bin/env bash\nset -eu\n. "./seats/heavy-test.sh"\nbash seats/selftest-sweep.sh\n');
  const p = start("nested", 0, "nested", dir);
  await until(p, () => p.out.includes("START ") || p.err.includes("waiting for host-wide lock"), "nested sweep admission");
  assert(!p.err.includes("waiting for host-wide lock"), "nested sweep must not wait on its own ancestor");
  await entered(p); await complete(p); assert(p.out.includes("END nested")); clear();
}
const legs: [string, () => Promise<void>][] = [
  ["sweep A -> bench B (different installs and TMPDIRs)", () => serial("sweep", "bench")],
  ["bench A -> sweep B", () => serial("bench", "sweep")],
  ["bench A -> bench B", () => serial("bench", "bench")],
  ["review A raw bench -> sweep B", () => serial("review", "sweep")],
  ["sweep A -> review B raw bench (wait before main)", () => serial("sweep", "review")],
  ["command wrapper A -> bench B", () => serial("command", "bench")],
  ...["bench", "sweep", "review"].map(kind => [`brake mid-${kind}: finishes; new runs wait; FIFO resumes`, () => brake(kind)] as [string, () => Promise<void>]),
  ["verify wiring and bench -> nested sweep", wiring],
];
let failures = 0, checked = 0;
for (const [name, run] of legs) {
  if (process.env.WHEELHOUSE_TEST_HEAVY_FILTER && !new RegExp(process.env.WHEELHOUSE_TEST_HEAVY_FILTER).test(name)) continue;
  checked++;
  try { await run(); console.log("PASS heavy-test: " + name); }
  catch (e) { failures++; console.error("FAIL heavy-test: " + name + "\n" + String(e)); }
  finally {
    if (fs.existsSync(pause)) fs.unlinkSync(pause);
    // Only processes created by this fixture; release idle payloads even when
    // a deliberately broken admission let them overlap.
    for (const p of runs) fs.writeFileSync(p.release, "cleanup\n");
    for (const p of runs) if (!p.closed) p.child.kill("SIGTERM");
    await Promise.all(runs.map(p => p.done));
    // Preserve a real stale lock for the next helper to reclaim; never repair
    // the endpoint by recursively deleting a live participant's ownership.
  }
}
assert(checked > 0, "filter selected at least one real test subject");
console.log(`heavy-test: ${checked} legs, ${failures} failures (mutation=${mutation || "none"})`);
process.exitCode = failures ? 1 : 0;
