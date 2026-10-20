// Deterministic writer/reader interleaving, not a wall-clock race lottery.
// The copied driver differs only by exporting its private record() for probing.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { mock } from "bun:test";

const atomic = `// Cross-process clock requests must never expose a truncated/partial value.
const record = (dir: string, name: string, value = "yes") => {
  const file = path.join(dir, name), stage = \`\${file}.\${process.pid}.\${randomUUID()}.new\`;
  try { fs.writeFileSync(stage, value, { flag: "wx", mode: 0o600 }); fs.renameSync(stage, file); }
  finally { fs.rmSync(stage, { force: true }); }
};`;
const legacy = 'const record = (dir: string, name: string, value = "yes") => fs.writeFileSync(path.join(dir, name), value);';
const [role, arg1, arg2, arg3] = process.argv.slice(2);
if (role === "--probe") {
  const [driver, dir, name] = [arg1, arg2, arg3];
  assert(["fresh", "replace"].includes(name));
  assert(fs.statSync(driver).isFile() && fs.statSync(dir).isDirectory());
  const native = { ...fs }, target = path.join(dir, "advance");
  const prior = name === "replace" ? "41" : null;
  if (prior !== null) native.writeFileSync(target, prior);
  let tick: (() => void) | undefined, intervals = 0, pauses = 0, fired = 0;
  let midWrite: object | undefined;
  const readerErrors: string[] = [];
  const poll = () => { try { tick!(); } catch (error: any) { readerErrors.push(error.message); } };
  const read = (file: string) => native.existsSync(file) ? native.readFileSync(file, "utf8") : null;
  const splitWrite = (file: any, data: any, options?: any) => {
    const base = typeof file === "string" ? path.basename(file) : "";
    if (typeof file !== "string" || path.dirname(file) !== dir ||
        !(base === "advance" || base.startsWith("advance.")) || data !== "100") {
      return native.writeFileSync(file, data, options);
    }
    pauses++;
    // Same open/truncate/write/close operations as writeFileSync, but let the
    // actual clock reader run at the otherwise cross-process interleaving.
    const fd = native.openSync(file, options?.flag ?? "w", options?.mode);
    try {
      assert.equal(native.fstatSync(fd).size, 0, "writer pause must precede data");
      assert(tick, "actual driver's polling callback must be captured");
      const visible = read(target);
      poll();
      midWrite = { file: base, openBytes: 0, visible, consumed: read(path.join(dir, "advanced")), targetAfterPoll: read(target) };
      native.writeSync(fd, data);
    } finally { native.closeSync(fd); }
  };
  mock.module("node:fs", () => ({ ...native, writeFileSync: splitWrite, default: { ...native, writeFileSync: splitWrite } }));
  const interval = globalThis.setInterval;
  // Capture, do not rewrite, the real polling body; invoke it only at explicit
  // logical steps. No scheduling interval decides a test outcome.
  globalThis.setInterval = ((callback: () => void) => {
    intervals++; tick = callback;
    return { unref() { return this; } };
  }) as any;
  let driverModule: any;
  try { driverModule = await import(pathToFileURL(driver).href); }
  finally { globalThis.setInterval = interval; }
  assert.equal(intervals, 1, "exactly the real fixture polling callback");
  process.env.WHEELHOUSE_TEST_WATCHDOG_DIR = dir;
  driverModule.arm("event", () => { fired++; }, 100);
  driverModule.record(dir, "advance", "100");
  poll();
  const observed = { name, pauses, midWrite, readerErrors, advanced: read(path.join(dir, "advanced")), fired, requestRemaining: native.existsSync(target), stages: native.readdirSync(dir).filter(n => n.endsWith(".new")) };
  native.writeFileSync(path.join(dir, "observed.json"), JSON.stringify(observed, null, 2) + "\n");
  console.log(JSON.stringify(observed));
  assert.equal(pauses, 1, "one calibrated incomplete write");
  assert.equal((midWrite as any).visible, prior, "partial advance visible before atomic publication");
  assert.deepEqual(readerErrors, [], "actual clock reader must accept every published value");
  assert.equal(observed.advanced, "100", "clock must acknowledge complete virtual time 100");
  assert.equal(fired, 1, "real 100ms virtual deadline must fire exactly once");
  assert.equal((midWrite as any).consumed, prior, "reader cannot consume the incomplete staged value");
  assert.equal(observed.requestRemaining, false);
  assert.deepEqual(observed.stages, []);
} else {
  const [here, root] = [role, arg1];
  assert(fs.statSync(root).isDirectory());
  const source = fs.readFileSync(path.join(here, "fixtures/verify-readiness.ts"), "utf8");
  const driver = path.join(root, "clock-driver.ts");
  fs.writeFileSync(driver, source + "\nexport {record};\n", { flag: "wx" });
  const removed = path.join(root, "clock-driver-removed.ts");
  for (const name of ["fresh", "replace"]) {
    for (const control of [false, true]) {
      if (control && !fs.existsSync(removed)) {
        assert.equal(source.split(atomic).length, 2, "removed-fix control must replace exactly the publisher");
        fs.writeFileSync(removed, source.replace(atomic, legacy) + "\nexport {record};\n", { flag: "wx" });
      }
      const dir = path.join(root, name + (control ? "-removed" : "")); fs.mkdirSync(dir);
      const result = spawnSync("bun", [import.meta.path, "--probe", control ? removed : driver, dir, name], { encoding: "utf8" });
      fs.writeFileSync(path.join(dir, "stdout"), result.stdout);
      fs.writeFileSync(path.join(dir, "stderr"), result.stderr);
      fs.writeFileSync(path.join(dir, "exit.json"), JSON.stringify({ status: result.status, signal: result.signal, error: result.error?.message }));
      assert.equal(result.signal, null);
      assert.equal(result.error, undefined);
      if (control) {
        assert.equal(result.status, 1);
        assert.match(result.stderr, /AssertionError: partial advance visible before atomic publication/);
        const observed = JSON.parse(fs.readFileSync(path.join(dir, "observed.json"), "utf8"));
        assert.equal(observed.pauses, 1); assert.equal(observed.midWrite.openBytes, 0);
        assert.equal(observed.midWrite.file, "advance"); assert.equal(observed.midWrite.visible, "");
        process.stdout.write(result.stdout);
        console.log(`PASS ${name} removed fix: incomplete public request detected; own assertion exit=1`);
      } else {
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        assert.equal(result.status, 0, `${name}: atomic publisher regression`);
        console.log(`PASS ${name}: no partial public value; actual clock acknowledges 100; deadline fires exactly once`);
      }
    }
  }
  console.log("verify-clock.selftest: PASS (2 publication cases, 2 removed-fix controls)");
}
