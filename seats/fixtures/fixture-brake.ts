// Isolated reproduction: admitted outer work must not leak its live brake
// into synthetic private-endpoint fixtures; a fresh unit must still wait.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
const [root, library, helper] = process.argv.slice(2);
assert(fs.statSync(path.join(root, ".wheelhouse-selftest-fixture")).isFile());
for (const file of [library, helper]) assert(fs.statSync(file).isFile());
const records: any[] = [];
for (const nested of [true, false]) {
  const dir = path.join(root, nested ? "admitted" : "fresh"); fs.mkdirSync(dir);
  const outer = path.join(dir, "outer.lock"), inner = path.join(dir, "inner.lock"), brake = path.join(dir, "brake");
  const token = randomUUID().replaceAll("-", "");
  const transition = (op: string, owned = "") => spawnSync("bun", [helper, op, outer, String(process.pid), token, owned], { encoding: "utf8" });
  const acquired = transition("acquire"); assert.equal(acquired.status, 0, acquired.stderr); const owned = acquired.stdout.trim(); assert.match(owned, /^\d+:\d+$/);
  fs.writeFileSync(brake, "isolated outer host brake\n"); assert(fs.statSync(brake).isFile());
  const script = path.join(dir, "child.sh"); fs.writeFileSync(script, '. "$PROBE_LIB"\nprintf "INNER_DONE\\n"\n');
  const env = { ...process.env, PROBE_LIB: library, PROBE_CHILD: script, PROBE_INNER: inner, WHEELHOUSE_SELFTEST_SWEEP_LOCK_HELPER: helper, WHEELHOUSE_SELFTEST_SWEEP_LOCK: nested ? outer : inner, WHEELHOUSE_HEAVY_TEST_PAUSE: brake, WHEELHOUSE_SELFTEST_SWEEP_WAIT_SECONDS: "0.03" };
  const command = nested ? '. "$PROBE_LIB"; WHEELHOUSE_SELFTEST_SWEEP_LOCK="$PROBE_INNER" bash "$PROBE_CHILD"' : 'exec bash "$PROBE_CHILD"';
  const child = spawn("bash", ["-c", command], { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let out = "", err = "", closed = false, code: number | null = null;
  child.stdout!.on("data", b => out += b); child.stderr!.on("data", b => err += b);
  const done = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", value => { closed = true; code = value; resolve(); }); });
  try {
    const limit = performance.now() + 20000;
    while (!out.includes("INNER_DONE") && !err.includes("waiting for host-wide lock")) {
      if (closed) throw Error(`fixture closed before checkpoint: ${code}\n${out}\n${err}`);
      if (performance.now() > limit) throw Error("INCOMPLETE fixture admission checkpoint");
      await Bun.sleep(20);
    }
    const blocked = err.includes("waiting for host-wide lock"), completedWhileBraked = out.includes("INNER_DONE") && fs.existsSync(brake);
    fs.unlinkSync(brake); await done; assert.equal(code, 0, out + err);
    assert(child.stdout!.readableEnded && child.stderr!.readableEnded);
    records.push({ nested, blocked, completedWhileBraked, exit: code });
  } finally {
    if (fs.existsSync(brake)) fs.unlinkSync(brake);
    if (!closed) { child.kill("SIGTERM"); await done; }
    const released = transition("release", owned); assert.equal(released.status, 0, released.stderr);
  }
}
console.log("MEASUREMENT " + JSON.stringify(records));
const correct = !records[0].blocked && records[0].completedWhileBraked && records[1].blocked;
console.log(correct ? "PASS admitted fixture brake isolation" : "FAIL admitted fixture brake isolation");
process.exitCode = correct ? 0 : 1;
