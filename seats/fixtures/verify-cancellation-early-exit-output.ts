// Exercise the real fixture failure path, then delete its review copy. Removing
// only the log emission must fail the same oracle with native3/input/EOF intact.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const [root, fixture, runtime] = process.argv.slice(2);
assert(!fs.existsSync(root));
assert(fs.statSync(fixture).isFile() && fs.statSync(path.join(runtime, "verify.ts")).isFile());
fs.mkdirSync(root);
const name = "reviewer-SIGINT";
function payload(message: string) {
  const prefix = Buffer.from("é".repeat(3000));
  let suffix = Buffer.from(message);
  // The exact 4096-byte tail deliberately starts inside a UTF-8 character.
  if ((prefix.length + suffix.length - 4096) % 2 === 0) suffix = Buffer.concat([Buffer.from("!"), suffix]);
  return Buffer.concat([prefix, suffix]);
}
const out = payload("\nplanted early-exit stdout — native3\n");
const err = payload("\nplanted early-exit stderr — native3\n");
const source = fs.readFileSync(fixture, "utf8");
const injection = source.split("\n").filter(line => line.startsWith("    instrumented = instrumented.slice(0, line) + "));
assert.equal(injection.length, 1, "one existing dispatcher early-exit seam");
const program = `fs.writeSync(1, Buffer.from(${JSON.stringify(out.toString("base64"))}, "base64")); fs.writeSync(2, Buffer.from(${JSON.stringify(err.toString("base64"))}, "base64")); process.exit(3);\n`;
const planted = source.replace(injection[0], `    instrumented = instrumented.slice(0, line) + ${JSON.stringify(program)} + instrumented.slice(line);`);
const emission = '  console.log("CANCELLATION_EARLY_EXIT " + JSON.stringify(record));';
assert.equal(planted.split(emission).length, 2, "one actual log producer");
for (const removed of [false, true]) {
  const dir = path.join(root, removed ? "removed" : "positive"), copy = path.join(dir, "review-copy"), seats = path.join(copy, "seats");
  const work = path.join(dir, "child-scratch"), tmp = path.join(dir, "child-tmp"), retained = path.join(copy, "verdicts");
  fs.mkdirSync(dir); fs.mkdirSync(tmp); fs.mkdirSync(copy); fs.mkdirSync(path.join(work, "runtime"), { recursive: true });
  fs.cpSync(runtime, seats, { recursive: true }); fs.mkdirSync(path.join(seats, "fixtures"), { recursive: true });
  fs.copyFileSync(path.join(path.dirname(fixture), "fixture-command.cjs"), path.join(seats, "fixtures/fixture-command.cjs"));
  const subject = path.join(seats, "fixtures/verify-cancellation.ts");
  fs.writeFileSync(subject, removed ? planted.replace(emission, "  void record; // removed output producer") : planted);
  fs.cpSync(runtime, path.join(work, "runtime/seats"), { recursive: true });
  const child = spawn("bun", [subject, work], { env: { ...process.env, TMPDIR: tmp, WHEELHOUSE_TEST_VERIFY_CANCEL_CASE: name, WHEELHOUSE_TEST_VERIFY_CANCEL_EARLY_EXIT: name, WHEELHOUSE_VERIFY_CANCEL_FAILURE_ROOT: retained, WHEELHOUSE_VERIFY_CANCEL_EVIDENCE: path.join(work, "transient") }, stdio: ["ignore", "pipe", "pipe"] });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
  async function read(stream: NonNullable<typeof child.stdout>) { const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks).toString("utf8"); }
  const [native, stdout, stderr] = await Promise.all([closed, read(child.stdout!), read(child.stderr!)]);
  assert.equal(native.code, 1); assert.equal(native.signal, null);
  assert(child.stdout!.readableEnded && child.stderr!.readableEnded);
  const result = JSON.parse(fs.readFileSync(path.join(work, name, "result.json"), "utf8"));
  const before = JSON.parse(fs.readFileSync(path.join(work, name, "before-cleanup.json"), "utf8"));
  assert(result.failure.includes("child exited before idle target"));
  assert.deepEqual(result.dispatcher, { code: 3, signal: null, stdoutEOF: true, stderrEOF: true });
  assert(!before.stage.reviewerReady && !before.stage.runnerStarted, "actual dispatcher must exit before idle readiness");
  assert.equal(result.retentionError, undefined);
  assert.deepEqual(fs.readFileSync(path.join(result.retainedDiagnostics, "stdout")), out);
  assert.deepEqual(fs.readFileSync(path.join(result.retainedDiagnostics, "stderr")), err);
  const fail = `FAIL ${name}: child exited before idle target; retained child diagnostics: ${JSON.stringify(result.retainedDiagnostics)}`;
  assert.deepEqual(stderr.split("\n").filter(line => line.startsWith("FAIL ")), [fail], "original FAIL text must be unchanged");
  fs.rmSync(copy, { recursive: true, force: true }); fs.rmSync(work, { recursive: true, force: true });
  assert(!fs.existsSync(copy) && !fs.existsSync(result.retainedDiagnostics) && !fs.existsSync(work));
  const judge = () => {
    const lines = stdout.split("\n").filter(line => line.startsWith("CANCELLATION_EARLY_EXIT "));
    assert.equal(lines.length, 1, "one early-exit line must survive review-copy deletion");
    const record = JSON.parse(lines[0].slice("CANCELLATION_EARLY_EXIT ".length));
    assert.equal(record.name, name); assert.equal(record.code, 3); assert.equal(record.signal, null);
    assert(record.stdoutEOF && record.stderrEOF); assert.equal(record.retainedDiagnostics, result.retainedDiagnostics);
    assert.equal(record.retentionError, null); assert.equal(record.tailLimitBytes, 4096);
    for (const [key, bytes] of [["stdout", out], ["stderr", err]] as const) {
      const tail = bytes.subarray(-4096);
      assert.equal(record[key + "TailBytes"], 4096);
      assert.equal(record[key + "Tail"], tail.toString("utf8"));
      assert(record[key + "Tail"].includes(`planted early-exit ${key} — native3`));
      assert.equal(tail.length, 4096);
      assert(record[key + "Tail"].startsWith("\uFFFD"), "a split UTF-8 boundary is rendered, not counted as 4096 characters");
    }
    return lines[0];
  };
  const evidence = process.env.WHEELHOUSE_VERIFY_CANCEL_EARLY_EXIT_EVIDENCE;
  if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, removed ? "removed.json" : "positive.json"), JSON.stringify({ native, dispatcher: result.dispatcher, stdout, stderr, copyGone: true, scratchGone: true }, null, 2) + "\n"); }
  if (removed) {
    assert.throws(judge, error => error instanceof assert.AssertionError && error.message.includes("one early-exit line must survive"));
    console.log("CONTROL early-exit output removed: dispatcher native3, both EOF, unchanged FAIL and retained bytes; missing-line oracle rejects after copy deletion");
  } else console.log(judge());
}
console.log("PASS early-exit-diagnostics-in-output");
