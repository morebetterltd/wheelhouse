// All concurrent participants are idle fixture scripts on private locks. The
// enclosing suite itself holds the real host lock for this entire regression.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
const [root, library, helper, sweep] = process.argv.slice(2);
assert(fs.statSync(path.join(root, ".wheelhouse-selftest-fixture")).isFile());
for (const file of [library, helper, sweep]) assert(fs.statSync(file).isFile());
const script = path.join(root, "idle-fixture.selftest.sh");
fs.writeFileSync(script, `#!/usr/bin/env bash
set -uo pipefail
. "$ADMISSION_LIB"
if [ "\${ADMISSION_MODE:-}" = nested ]; then
  ADMISSION_MODE=quick ADMISSION_NAME=inner bash "$ADMISSION_SCRIPT" || exit $?
  printf 'NESTED_DONE\\n'; exit 0
fi
if [ "\${ADMISSION_MODE:-}" = private ]; then
  WHEELHOUSE_SELFTEST_SWEEP_LOCK="$ADMISSION_INNER_LOCK" ADMISSION_MODE=quick ADMISSION_NAME=private-inner bash "$ADMISSION_SCRIPT" || exit $?
  printf 'PRIVATE_DONE\\n'; exit 0
fi
owner=absent
[ ! -f "$WHEELHOUSE_SELFTEST_SWEEP_LOCK/pid" ] || IFS= read -r owner < "$WHEELHOUSE_SELFTEST_SWEEP_LOCK/pid"
printf 'OWNER %s %s\\n' "$ADMISSION_NAME" "$owner"
if [ "\${ADMISSION_MODE:-}" = quick ]; then printf 'QUICK %s\\n' "$ADMISSION_NAME"; exit 0; fi
if [ "\${ADMISSION_MODE:-}" = exit ]; then trap 'printf "CUSTOM_EXIT_TRAP\\n"' EXIT; exit 37; fi
if [ "\${ADMISSION_MODE:-}" = exec ]; then exec bash -c 'printf "EXEC_BODY\\n"; exit 29'; fi
entered=0
finish(){ if [ "$entered" = 1 ]; then printf '%s exit\\n' "$ADMISSION_NAME" >> "$ADMISSION_EVENTS"; rmdir "$ADMISSION_ACTIVE"; fi; }
trap finish EXIT
trap 'printf "SIGNAL_CLEANUP %s\\n" "$ADMISSION_NAME"; while [ ! -f "$ADMISSION_CLEANUP_RELEASE" ]; do sleep 0.05; done; exit 0' TERM INT HUP QUIT
if ! mkdir "$ADMISSION_ACTIVE"; then printf 'OVERLAP %s\\n' "$ADMISSION_NAME"; exit 19; fi
entered=1
printf '%s enter\\n' "$ADMISSION_NAME" >> "$ADMISSION_EVENTS"
printf 'ENTER %s owner=%s pid=%s argv=%s cwd=%s\\n' "$ADMISSION_NAME" "$owner" "$$" "$*" "$PWD"
while [ ! -f "$ADMISSION_RELEASE" ]; do sleep 0.05; done
`);

type Participant = { name: string; child: ChildProcess; out: string; err: string; closed: boolean; exited: boolean; code: number | null; signal: NodeJS.Signals | null; stdoutEOF: boolean; stderrEOF: boolean; release: string; cleanupRelease: string; done: Promise<void> };
const cases: Case[] = [];
class Case {
  dir: string; lock: string; children: Participant[] = []; listeners = new Set<() => void>();
  constructor(readonly name: string) { this.dir = path.join(root, name); fs.mkdirSync(this.dir); this.lock = path.join(this.dir, "host.lock"); cases.push(this); }
  notify() { for (const f of [...this.listeners]) f(); }
  async until(test: () => boolean, subject: Participant) {
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        if (test()) { this.listeners.delete(check); resolve(); }
        else if (subject.closed) { this.listeners.delete(check); reject(new Error(`${subject.name} closed before checkpoint: ${subject.code}/${subject.signal}\n${subject.out}\n${subject.err}`)); }
      };
      this.listeners.add(check); check();
    });
  }
  start(name: string, runner = "direct", mode = "hold", extra: Record<string, string> = {}) {
    const release = path.join(this.dir, name + ".release"), cleanupRelease = release + ".cleanup";
    const env = { ...process.env, ADMISSION_LIB: library, ADMISSION_SCRIPT: script, ADMISSION_NAME: name, ADMISSION_MODE: mode, ADMISSION_RELEASE: release, ADMISSION_CLEANUP_RELEASE: cleanupRelease, ADMISSION_ACTIVE: path.join(this.dir, "active"), ADMISSION_EVENTS: path.join(this.dir, "events"), ADMISSION_INNER_LOCK: path.join(this.dir, "inner.lock"), WHEELHOUSE_SELFTEST_SWEEP_PATTERN: script, WHEELHOUSE_SELFTEST_SWEEP_LOCK: this.lock, WHEELHOUSE_SELFTEST_SWEEP_LOCK_HELPER: helper, WHEELHOUSE_SELFTEST_SWEEP_WAIT_SECONDS: "0.05", ...extra };
    const args = runner === "sweep" ? [sweep] : runner === "command" ? ["-c", 'source "$ADMISSION_SCRIPT" "$@"', "fixture-command", "argument with space", "last"] : [script, "argument with space", "last"];
    const child = spawn("bash", args, { cwd: this.dir, env, stdio: ["ignore", "pipe", "pipe"] });
    const p: Participant = { name, child, out: "", err: "", closed: false, exited: false, code: null, signal: null, stdoutEOF: false, stderrEOF: false, release, cleanupRelease, done: Promise.resolve() };
    this.children.push(p);
    child.stdout!.on("data", b => { p.out += b; this.notify(); }); child.stderr!.on("data", b => { p.err += b; this.notify(); });
    child.stdout!.on("end", () => p.stdoutEOF = true); child.stderr!.on("end", () => p.stderrEOF = true);
    child.once("exit", () => { p.exited = true; this.notify(); });
    p.done = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => { p.closed = true; p.code = code; p.signal = signal; this.notify(); resolve(); }); });
    return p;
  }
  async entered(p: Participant) { await this.until(() => p.out.includes(`ENTER ${p.name} `), p); }
  async queued(p: Participant, position: number) {
    // An overlap/early body/normal close is observable failure, not a timed
    // absence. The fix-removed participant hits mkdir's exclusive sentinel.
    await this.until(() => /waiting for host-wide lock[^\n]*\n/.test(p.err) || p.out.includes("OVERLAP ") || p.out.includes(`ENTER ${p.name} `) || p.closed, p);
    assert.match(p.err, new RegExp(`waiting for host-wide lock[^\\n]*queue_position=${position} `));
  }
  owner() { assert(fs.existsSync(path.join(this.lock, "pid")), "subject lock exists before measuring owner"); return Number(fs.readFileSync(path.join(this.lock, "pid"), "utf8")); }
  release(p: Participant) { fs.writeFileSync(p.release, "release\n"); }
  async joined(p: Participant, code = 0) { await p.done; assert.equal(p.code, code, p.out + p.err); assert.equal(p.signal, null); assert(p.stdoutEOF && p.stderrEOF, "both native output streams reached EOF"); }
  clear() { assert(!fs.existsSync(this.lock), "lock released"); assert(!fs.existsSync(this.lock + ".queue"), "queue released"); }
  async cleanup() {
    for (const p of this.children) { fs.writeFileSync(p.release, "cleanup\n"); fs.writeFileSync(p.cleanupRelease, "cleanup\n"); if (!p.closed) p.child.kill("SIGTERM"); }
    await Promise.all(this.children.map(p => p.done));
    const records = this.children.map(p => ({ name: p.name, pid: p.child.pid, code: p.code, signal: p.signal, stdoutEOF: p.stdoutEOF, stderrEOF: p.stderrEOF, stdout: p.out, stderr: p.err }));
    fs.writeFileSync(path.join(this.dir, "measurements.json"), JSON.stringify(records, null, 2));
    console.log("MEASUREMENT " + JSON.stringify({ case: this.name, records }));
  }
}
async function serial(name: string, firstRunner: string, secondRunner: string) {
  const c = new Case(name);
  try {
    const a = c.start("first", firstRunner); await c.entered(a);
    const b = c.start("second", secondRunner); await c.queued(b, 1);
    const expectedOwner = firstRunner === "sweep" ? a.child.pid : Number(/ pid=(\d+) /.exec(a.out)![1]);
    assert.equal(c.owner(), expectedOwner, "actual gated suite/sweep owns the same lock");
    const third = c.start("third"); await c.queued(third, 2);
    const queue = fs.readdirSync(c.lock + ".queue").filter(n => /^\d{20}\./.test(n));
    assert.equal(queue.length, 3, "holder and both waiters share the FIFO queue");
    for (const p of [a, b, third]) { await c.entered(p); c.release(p); await c.joined(p); }
    assert.equal(fs.readFileSync(path.join(c.dir, "events"), "utf8"), "first enter\nfirst exit\nsecond enter\nsecond exit\nthird enter\nthird exit\n");
    for (const [p, runner] of [[a, firstRunner], [b, secondRunner], [third, "direct"]] as const) if (runner !== "sweep") assert(p.out.includes("argv=argument with space last cwd=" + c.dir), "argv/cwd preserved through admission");
    c.clear();
  } finally { await c.cleanup(); }
}
async function nesting(mode: string) {
  const c = new Case("nested-" + mode);
  try {
    const p = c.start("outer", "sweep", mode); await c.joined(p);
    assert(p.out.includes(mode === "private" ? "PRIVATE_DONE\n" : "NESTED_DONE\n"));
    const inner = /OWNER (?:inner|private-inner) (\d+)/.exec(p.out); assert(inner);
    if (mode === "nested") assert.equal(Number(inner[1]), p.child.pid, "nested suite reuses verified sweep owner");
    else { assert.notEqual(Number(inner[1]), p.child.pid); assert(!fs.existsSync(path.join(c.dir, "inner.lock"))); assert(!fs.existsSync(path.join(c.dir, "inner.lock.queue"))); }
    c.clear();
  } finally { await c.cleanup(); }
}
async function exitCode(mode: string, code: number) {
  const c = new Case("exit-" + mode);
  try { const p = c.start("terminating", "direct", mode); await c.joined(p, code); assert(p.out.includes(mode === "exec" ? "EXEC_BODY" : "CUSTOM_EXIT_TRAP")); assert(/OWNER terminating \d+/.test(p.out)); c.clear(); }
  finally { await c.cleanup(); }
}
async function queuedSignal() {
  const c = new Case("queued-term");
  try {
    const a = c.start("holder"); await c.entered(a);
    const b = c.start("cancel"); await c.queued(b, 1);
    const before = fs.statSync(c.lock, { bigint: true }).ino;
    b.child.kill("SIGTERM"); await c.joined(b, 143);
    assert.equal(fs.statSync(c.lock, { bigint: true }).ino, before);
    const tickets = fs.readdirSync(c.lock + ".queue").filter(n => /^\d{20}\./.test(n)); assert.equal(tickets.length, 1);
    c.release(a); await c.joined(a); c.clear();
  } finally { await c.cleanup(); }
}
async function holdingSignal(signal: NodeJS.Signals, code: number) {
  const c = new Case("holding-" + signal);
  try {
    const a = c.start("holder"); await c.entered(a);
    const b = c.start("successor"); await c.queued(b, 1);
    a.child.kill(signal); await c.until(() => a.out.includes("SIGNAL_CLEANUP holder\n"), a);
    assert.equal(c.owner(), Number(/ pid=(\d+) /.exec(a.out)![1]), "admission retained during suite's custom signal cleanup");
    fs.writeFileSync(a.cleanupRelease, "finish cleanup\n"); await c.joined(a, code);
    await c.entered(b); c.release(b); await c.joined(b); c.clear();
  } finally { await c.cleanup(); }
}
async function killedSupervisor() {
  const c = new Case("supervisor-kill");
  try {
    const a = c.start("holder"); await c.entered(a);
    const owner = Number(/ pid=(\d+) /.exec(a.out)![1]);
    assert.equal(c.owner(), owner); assert.notEqual(owner, a.child.pid);
    const b = c.start("successor"); await c.queued(b, 1);
    a.child.kill("SIGKILL"); await c.until(() => a.exited, a);
    assert.equal(c.owner(), owner, "live real suite retains ownership after supervisor death");
    // The native exclusive active sentinel still protects actual execution;
    // release the survivor only after checking its PID remains the owner.
    c.release(a); await a.done;
    assert.equal(a.code, null); assert.equal(a.signal, "SIGKILL"); assert(a.stdoutEOF && a.stderrEOF);
    await c.entered(b); c.release(b); await c.joined(b); c.clear();
    assert.equal(fs.readFileSync(path.join(c.dir, "events"), "utf8"), "holder enter\nholder exit\nsuccessor enter\nsuccessor exit\n");
  } finally { await c.cleanup(); }
}
async function relocatedLibrary() {
  const c = new Case("relocated-library");
  try {
    const copy = path.join(c.dir, "copied-lib.sh"); fs.copyFileSync(library, copy);
    const bad = c.start("missing-companion", "direct", "quick", { ADMISSION_LIB: copy, WHEELHOUSE_SELFTEST_SWEEP_LOCK_HELPER: "" });
    await c.joined(bad, 2); assert(bad.err.includes("lock helper missing or unreadable")); assert(!bad.out.includes("QUICK"));
    const good = c.start("pinned-companion", "direct", "quick", { ADMISSION_LIB: copy }); await c.joined(good);
    assert(/OWNER pinned-companion \d+/.test(good.out)); c.clear();
  } finally { await c.cleanup(); }
}
async function unavailable() {
  const c = new Case("missing-helper");
  try { const p = c.start("refused", "direct", "quick", { WHEELHOUSE_SELFTEST_SWEEP_LOCK_HELPER: path.join(c.dir, "absent.ts") }); await c.joined(p, 2); assert(!p.out.includes("QUICK")); c.clear(); }
  finally { await c.cleanup(); }
}
const legs: [string, () => Promise<void>][] = [
  ["direct/direct FIFO", () => serial("direct", "direct", "direct")],
  ["sweep/direct FIFO", () => serial("sweep-direct", "sweep", "direct")],
  ["direct/sweep FIFO", () => serial("direct-sweep", "direct", "sweep")],
  ["bash -c reentry", () => serial("command", "command", "command")],
  ["nested same lock", () => nesting("nested")], ["nested private lock", () => nesting("private")],
  ["custom EXIT trap", () => exitCode("exit", 37)], ["exec exit", () => exitCode("exec", 29)],
  ["queued TERM", queuedSignal], ["holding TERM", () => holdingSignal("SIGTERM", 143)], ["holding INT", () => holdingSignal("SIGINT", 130)],
  ["holding HUP", () => holdingSignal("SIGHUP", 129)], ["holding QUIT", () => holdingSignal("SIGQUIT", 131)],
  ["killed supervisor retains live suite ownership", killedSupervisor],
  ["relocated library requires its companion", relocatedLibrary], ["missing helper refusal", unavailable],
];
let failures = 0;
for (const [name, run] of legs) {
  try { await run(); console.log("PASS selftest admission: " + name); }
  catch (error) { failures++; console.error("FAIL selftest admission: " + name + "\n" + String(error)); }
}
console.log(`selftest admission: ${legs.length} legs, ${failures} failures`);
process.exitCode = failures ? 1 : 0;
