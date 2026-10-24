// Run a recovery selftest while an unrelated, owned bare-pi dummy churns.
// Private Bun barriers, no production hook; preserve the selftest's exit status.
import * as fs from "node:fs";
import * as path from "node:path";
import * as assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { constants } from "node:os";

const [sourceArg, rootArg] = process.argv.slice(2);
assert.ok(sourceArg && rootArg, "usage: bun recover-process-noise.ts SELFTEST EXISTING_ROOT");
const source = fs.realpathSync(sourceArg), root = fs.realpathSync(rootArg);
assert.ok(fs.statSync(source).isFile() && fs.statSync(root).isDirectory());
const bun = Bun.which("bun"), node = Bun.which("node");
assert.ok(bun && node, "bun and node must be on PATH");
const bin = path.join(root, "bin"); fs.mkdirSync(bin);
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
fs.writeFileSync(path.join(bin, "bun"), `#!/usr/bin/env bash
set -eu
control=${quote(root)}
case "\${1:-}" in
  */proj/seats/recover.ts)
    fixture="\${1%/proj/seats/recover.ts}"
    if [ -f "$fixture/state.before" ]; then
      printf '%s\\n' "$1" > "$control/before.ready"
      until [ -f "$control/before.release" ]; do sleep 0.01; done
    fi ;;
  */can-a/seats/recover.ts)
    : > "$control/after.ready"
    until [ -f "$control/after.release" ]; do sleep 0.01; done ;;
esac
exec ${quote(bun)} "$@"
`, { mode: 0o755 });
const dummyScript = path.join(root, "unrelated.js");
fs.writeFileSync(dummyScript, 'process.title = "pi"; setInterval(() => {}, 1000);\n');
const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, WHEELHOUSE_SKIP_REAL_PI: "1" };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const live = (c: ChildProcess) => c.exitCode === null && c.signalCode === null;
function status(c: ChildProcess): number {
  return c.exitCode ?? -(constants.signals[c.signalCode!] ?? 1);
}
const OWNED_TERM_GRACE_SECONDS = 10; // unchanged existing cleanup escalation policy
async function waitExit(c: ChildProcess, termGraceSeconds?: number) {
  const deadline = termGraceSeconds === undefined ? Infinity : Date.now() + termGraceSeconds * 1000;
  console.error(`FIXTURE_WAIT recovery noise: native exit pid=${c.pid}`);
  while (live(c)) {
    if (Date.now() >= deadline) throw Error(`owned child ${c.pid} TERM grace expired; last exit=${c.exitCode} signal=${c.signalCode}`);
    await sleep(20);
  }
  return status(c);
}
let test: ChildProcess | undefined, dummy: ChildProcess | undefined;
let output = "", stdout = "", stderr = "", code = 1;
let closed: Promise<void> | undefined;
const log = path.join(root, "selftest.log");
fs.writeFileSync(log, "");
async function waitFor(name: string) {
  console.error(`FIXTURE_WAIT recovery noise: ${name}, child=${test!.pid}`);
  while (!fs.existsSync(path.join(root, name))) {
    if (!live(test!)) throw Error(`selftest exited before ${name}; inspect ${log}`);
    await sleep(20);
  }
}
try {
  test = spawn("bash", [source], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  // Drain continuously, including scrubber descendants, rather than blocking
  // at a full pipe while waiting for a barrier. close means both pipes drained.
  closed = new Promise<void>((resolve, reject) => {
    test!.on("error", reject); test!.on("close", () => resolve());
  });
  test.stdout!.on("data", b => { stdout += b.toString(); output += b.toString(); });
  test.stderr!.on("data", b => { stderr += b.toString(); output += b.toString(); });
  await waitFor("before.ready");
  const fixture = path.dirname(path.dirname(path.dirname(fs.readFileSync(path.join(root, "before.ready"), "utf8").trim())));
  assert.ok(fs.statSync(path.join(fixture, "state.before")).isFile());
  const relative = path.relative(fixture, root);
  assert.ok(relative === ".." || relative.startsWith(".." + path.sep), "dummy must be unrelated to this FIX");
  dummy = spawn(node, [dummyScript], { cwd: root, detached: true, stdio: "ignore" });
  let title: ReturnType<typeof spawnSync> | undefined;
  console.error(`FIXTURE_WAIT recovery noise: native dummy title, pid=${dummy.pid}`);
  for (;;) {
    title = spawnSync("ps", ["-p", String(dummy.pid), "-o", "command="], { encoding: "utf8" });
    assert.ifError(title.error); assert.equal(title.signal ?? null, null); assert.equal(title.stderr, "");
    assert.ok(title.status === 0 || (title.status === 1 && !title.stdout), "native title query failed");
    if (title.status === 0 && String(title.stdout).trimEnd() === "pi") break;
    assert.ok(live(dummy), "owned dummy exited before rewriting its title");
    await sleep(20);
  }
  assert.ok(title && title.status === 0 && String(title.stdout).trimEnd() === "pi" && !title.stderr);
  fs.writeFileSync(path.join(root, "before.release"), "");
  await waitFor("after.ready");
  assert.ok(live(dummy) && live(test));
  dummy.kill("SIGTERM");
  const dummyExit = await waitExit(dummy, OWNED_TERM_GRACE_SECONDS);
  assert.ok(live(test), "dummy must stop while selftest is active");
  fs.writeFileSync(path.join(root, "after.release"), "");
  console.error(`FIXTURE_WAIT recovery noise: joined selftest output, pid=${test.pid}`);
  await closed;
  code = status(test);
  fs.writeFileSync(log, output);
  assert.ok(test.stdout!.readableEnded && test.stderr!.readableEnded, "both native output channels reached EOF");
  const result = { selftest: source, selftest_exit: code, selftest_signal: test.signalCode, stdoutEOF: test.stdout!.readableEnded, stderrEOF: test.stderr!.readableEnded, dummy_pid: dummy.pid,
    native_ps: { command: ["ps", "-p", String(dummy.pid), "-o", "command="], exit: title.status, stdout: title.stdout, stderr: title.stderr },
    dummy_started_after_before_count: true, dummy_alive_through_after_count: true,
    dummy_stopped_while_selftest_active: true, dummy_exit: dummyExit, dummy_root_outside_FIX: true };
  fs.writeFileSync(path.join(root, "result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2)); console.log(output);
} finally {
  // All handles/groups came from our own fresh detached spawns. No name kills.
  for (const stage of ["before", "after"]) fs.writeFileSync(path.join(root, stage + ".release"), "");
  if (dummy && live(dummy)) { dummy.kill("SIGTERM"); await waitExit(dummy, OWNED_TERM_GRACE_SECONDS); }
  if (test && live(test)) {
    process.kill(-test.pid!, "SIGTERM");
    try { await waitExit(test, OWNED_TERM_GRACE_SECONDS); }
    catch { process.kill(-test.pid!, "SIGKILL"); await waitExit(test); }
  }
  if (closed) await closed;
  fs.writeFileSync(log, output);
  fs.writeFileSync(path.join(root, "selftest.stdout"), stdout);
  fs.writeFileSync(path.join(root, "selftest.stderr"), stderr);
}
process.exitCode = code;
