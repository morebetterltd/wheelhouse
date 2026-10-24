// A readiness holder must queue behind an existing directory, not mv into it.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { spawnSync } from "./fixture-command.cjs";
import { randomUUID } from "node:crypto";

const [here, parent, driverArg] = process.argv.slice(2);
assert(here && parent && fs.statSync(parent).isDirectory());
const root = path.join(parent, "h4-publication"); fs.mkdirSync(root);
const helper = path.join(here, "selftest-sweep-lock.ts");
const driver = driverArg || path.join(here, "fixtures/verify-readiness.ts");
assert(fs.statSync(helper).isFile() && fs.statSync(driver).isFile());
const lock = path.join(root, "lock"), release = path.join(root, "release"), admitted = path.join(root, "admitted");
const token = randomUUID().replaceAll("-", "");
function transition(op: string, identity?: string) {
  const args = [helper, op, lock, String(process.pid), token];
  if (identity) args.push(identity);
  const result = spawnSync("bun", args, { encoding: "utf8" });
  if (result.stderr) process.stderr.write(result.stderr);
  return { status: result.status, signal: result.signal, out: result.stdout.trim() };
}
const initial = transition("acquire"); assert.equal(initial.status, 0); assert.match(initial.out, /^\d+:\d+$/);
let originalOwned = true;
const schema = () => fs.readdirSync(lock).sort();
const expected = ["pid", "started", "wheelhouse-selftest-sweep"].sort();
assert.deepEqual(schema(), expected);
const original = fs.readFileSync(path.join(lock, "wheelhouse-selftest-sweep"), "utf8");
const child = spawn("bun", [driver, "--hold-h4", lock, release, admitted, helper], { stdio: ["ignore", "pipe", "pipe"] });
let out = "", err = "", exited = false;
child.stdout!.on("data", b => { out += b; }); child.stderr!.on("data", b => { err += b; });
child.once("exit", () => { exited = true; });
const closed = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
  child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal }));
});
const events: object[] = [{ event: "existing-owner", pid: process.pid, entries: schema() }];
async function until(test: () => boolean, label: string) {
  while (!test()) { if (exited) throw new Error(`holder exited before ${label}`); await Bun.sleep(10); }
}
let failure: unknown;
try {
  // Either publication or actual queue admission ends this wait; no clock verdict.
  await until(() => fs.existsSync(`${admitted}.waiting`) || fs.existsSync(admitted), "queue admission");
  events.push({ event: "before-release", entries: schema(), queued: fs.existsSync(`${admitted}.waiting`), admitted: fs.existsSync(admitted) });
  assert(fs.existsSync(`${admitted}.waiting`), "holder must queue, not publish over an existing directory");
  assert(!fs.existsSync(admitted), "holder cannot be ready before actual admission");
  assert.deepEqual(schema(), expected, "PID publication must not add an entry inside the lock");
  assert.equal(fs.readFileSync(path.join(lock, "wheelhouse-selftest-sweep"), "utf8"), original);
  assert.equal(transition("release", initial.out).status, 0); originalOwned = false;
  await until(() => fs.existsSync(admitted), "holder admission after release");
  assert.deepEqual(schema(), expected);
  const probe = transition("acquire");
  assert.equal(probe.status, 75, "real helper must validate the holder and queue the probe");
  assert.equal(transition("release").status, 0); // Drop only our probe ticket.
  events.push({ event: "new-owner", entries: schema(), validationStatus: probe.status });
} catch (error) { failure = error; }
finally {
  // Only our release file and our own lock/ticket; never signal a process.
  fs.writeFileSync(release, "release\n");
  const result = await closed;
  if (out) process.stdout.write(out); if (err) process.stderr.write(err);
  if (originalOwned) {
    const result = transition("release", initial.out);
    events.push({ event: "original-owner-cleanup", status: result.status });
  }
  assert(child.stdout!.readableEnded && child.stderr!.readableEnded);
  events.push({ event: "holder-exit", ...result, stdoutEOF: true, stderrEOF: true });
  fs.writeFileSync(path.join(root, "events.json"), JSON.stringify(events, null, 2) + "\n");
  if (!failure) { assert.equal(result.code, 0); assert.equal(result.signal, null); assert(!fs.existsSync(lock)); }
}
if (failure) throw failure;
console.log("PASS H4 publication: existing directory unchanged while queued; real admission validated; holder released; both EOF");
