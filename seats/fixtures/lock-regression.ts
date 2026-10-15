import * as fs from "node:fs";
import * as path from "node:path";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const [moduleFile, root] = process.argv.slice(2);
assert.ok(moduleFile && fs.statSync(moduleFile).isFile(), "lock module must exist");
assert.ok(root && fs.statSync(root).isDirectory(), "owned test root must exist");
const { acquirePidLock: acquire, releasePidLock: release } = await import(moduleFile);
let failures = 0;
function old(file: string) { const at = new Date(Date.now() - 60_000); fs.utimesSync(file, at, at); }
function take(file: string) {
  const fd = acquire(file);
  assert.notEqual(fd, null, "stale lock must be acquired");
  assert.equal(fs.readFileSync(file, "utf8"), `${process.pid}\n`);
  release(file, fd);
  assert.equal(fs.existsSync(file), false);
}
function test(name: string, check: () => void) {
  try { check(); console.log(`PASS ${name}`); }
  catch (e: any) { failures++; console.error(`FAIL ${name}: ${e.message}`); }
}

test("old empty and unparseable locks are reclaimed", () => {
  for (const [name, text] of [["empty", ""], ["junk", "not a pid\n"], ["invalid-pid", "-1\n"]]) {
    const file = path.join(root, `${name}.lock`);
    fs.writeFileSync(file, text); old(file); take(file);
  }
});

test("fresh empty lock is refused unchanged, then reclaimed after grace", () => {
  const file = path.join(root, "fresh.lock");
  fs.writeFileSync(file, "");
  const before = fs.statSync(file);
  assert.equal(acquire(file), null, "fresh incomplete owner must get its grace period");
  assert.equal(fs.statSync(file).ino, before.ino);
  assert.equal(fs.readFileSync(file, "utf8"), "");
  old(file); take(file);
});

test("open malformed lock is preserved even when old, and reclaimed after close", () => {
  const file = path.join(root, "open.lock");
  const held = fs.openSync(file, "wx");
  try {
    old(file);
    const before = fs.statSync(file);
    assert.equal(acquire(file), null, "native lsof must protect the open incomplete lock");
    assert.equal(fs.statSync(file).ino, before.ino);
  } finally { fs.closeSync(held); }
  take(file);
});

test("live owner is never replaced; failed PID write publishes no empty lock", () => {
  const file = path.join(root, "live.lock");
  const owner = acquire(file);
  assert.notEqual(owner, null);
  try {
    old(file);
    const before = fs.statSync(file);
    assert.equal(acquire(file), null);
    assert.equal(fs.statSync(file).ino, before.ino);
    assert.equal(fs.readFileSync(file, "utf8"), `${process.pid}\n`);
  } finally { release(file, owner); }
  // Fresh process: instrument the native fs write before importing the module.
  // The fault models death between wx and PID write, without killing this test.
  const helper = path.join(import.meta.dir, "pid-write-fault.cjs");
  const r = spawnSync(process.execPath, [helper, "lock", moduleFile, file], { encoding: "utf8" });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
});

test("release of an old handle cannot delete a replacement live owner", () => {
  const file = path.join(root, "replacement.lock");
  const first = acquire(file);
  assert.notEqual(first, null);
  fs.unlinkSync(file); // Simulate a path replaced outside this owner's lifecycle.
  const second = acquire(file);
  assert.notEqual(second, null);
  try {
    release(file, first);
    assert.equal(fs.readFileSync(file, "utf8"), `${process.pid}\n`);
    assert.equal(acquire(file), null);
  } finally { release(file, second); }
});

console.log(`lock regression: ${failures ? "FAIL" : "PASS"} (${failures} failure(s))`);
process.exitCode = failures ? 1 : 0;
