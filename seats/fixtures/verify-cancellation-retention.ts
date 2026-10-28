// A real verifier exits37 before idle readiness. Its failed fixture is expected
// to exit1; only durable diagnostics AFTER deleting that fixture prove this leg.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { identity, residual } from "./verify-cancellation-residual.ts";

const root = path.resolve(process.argv[2]), fixture = path.resolve(process.argv[3]), runtime = path.resolve(process.argv[4]);
assert(!fs.existsSync(root), "retention canary target must be fresh");
assert(fs.statSync(fixture).isFile() && fs.statSync(path.join(runtime, "verify.ts")).isFile());
const persistent = process.env.WHEELHOUSE_VERIFY_CANCEL_FAILURE_ROOT || process.env.WHEELHOUSE_VERIFY_CANCEL_EVIDENCE || path.join(path.dirname(import.meta.dir), "verdicts/verify-cancellation-failures");
fs.mkdirSync(persistent, { recursive: true, mode: 0o700 });
const outside = fs.realpathSync(persistent);
assert(outside !== root && !outside.startsWith(root + path.sep), "retention destination must outlive canary scratch");
const proof = process.env.WHEELHOUSE_VERIFY_CANCEL_RETENTION_EVIDENCE || fs.mkdtempSync(path.join(outside, "retention-proof-"));
fs.mkdirSync(proof, { recursive: true, mode: 0o700 });
const work = path.join(root, "deleted-scratch"), name = "sweep-stubborn-SIGINT";
fs.mkdirSync(path.join(work, "runtime"), { recursive: true });
fs.cpSync(runtime, path.join(work, "runtime/seats"), { recursive: true });
const child = Bun.spawn(["bun", fixture, work], {
  env: { ...process.env, WHEELHOUSE_TEST_VERIFY_CANCEL_CASE: name, WHEELHOUSE_TEST_VERIFY_CANCEL_EARLY_EXIT: name, WHEELHOUSE_VERIFY_CANCEL_FAILURE_ROOT: outside, WHEELHOUSE_VERIFY_CANCEL_EVIDENCE: path.join(work, "transient-export") },
  stdin: "ignore", stdout: "pipe", stderr: "pipe",
});
const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
let beforeRemoval: ReturnType<typeof identity>;
const record: any = { command: ["bun", fixture, work], code, stdout, stderr, subject: null, retainedDiagnostics: null, scratchGone: false, failure: null };
try {
  assert.equal(code, 1, "inner fixture must actually reject the planted early exit");
  const result = JSON.parse(fs.readFileSync(path.join(work, name, "result.json"), "utf8"));
  const before = JSON.parse(fs.readFileSync(path.join(work, name, "before-cleanup.json"), "utf8"));
  assert(result.failure.includes("child exited before idle target"));
  assert.equal(result.dispatcher.code, 37); assert.equal(result.dispatcher.signal, null);
  assert(result.dispatcher.stdoutEOF && result.dispatcher.stderrEOF);
  assert(!before.stage.suiteReady && !before.stage.runnerStarted, "exit must precede idle target, not simulate cancellation");
  const out = fs.readFileSync(path.join(work, name, "out"), "utf8"), err = fs.readFileSync(path.join(work, name, "err"), "utf8");
  assert.equal(out, "planted cancellation stdout — retained\n");
  assert.equal(err, "planted cancellation stderr — retained\n");
  record.subject = { code: result.dispatcher.code, signal: result.dispatcher.signal, stdoutEOF: true, stderrEOF: true, suiteReady: false, stdout: out, stderr: err };
  record.retainedDiagnostics = result.retainedDiagnostics ?? null;
} catch (error) { record.failure = String(error); }
finally {
  beforeRemoval = identity(work);
  fs.rmSync(work, { recursive: true, force: true });
  record.scratchGone = !fs.existsSync(work);
}
if (!record.scratchGone) {
  try { record.residual = await residual(work, beforeRemoval!, proof); }
  catch (error) { record.residual = { before: beforeRemoval!, after: identity(work), captureError: String(error) }; }
}
if (!record.failure) {
  try {
    assert(record.scratchGone);
    const retained = record.retainedDiagnostics;
    assert(typeof retained === "string", "retained child diagnostics path missing");
    assert(retained !== root && !retained.startsWith(root + path.sep));
    assert(stderr.includes(`FAIL ${name}: child exited before idle target; retained child diagnostics: ${JSON.stringify(retained)}`), "actual FAIL line must print the real persistent path");
    assert.equal(fs.readFileSync(path.join(retained, "stdout"), "utf8"), record.subject.stdout);
    assert.equal(fs.readFileSync(path.join(retained, "stderr"), "utf8"), record.subject.stderr);
    const status = JSON.parse(fs.readFileSync(path.join(retained, "exit.json"), "utf8"));
    assert.equal(status.code, 37); assert.equal(status.signal, null);
    assert(status.stdoutEOF && status.stderrEOF);
    assert.equal(status.stdoutBytes, Buffer.byteLength(record.subject.stdout)); assert.equal(status.stderrBytes, Buffer.byteLength(record.subject.stderr));
    record.retainedStatus = status;
  } catch (error) { record.failure = String(error); }
}
// The review copy (and its verdicts directory) may be removed after the sweep.
if (!record.scratchGone) console.log("RETENTION_RESIDUAL " + JSON.stringify(record));
fs.writeFileSync(path.join(proof, "result.json"), JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
if (record.failure) console.error("FAIL verify-cancellation retention: " + record.failure);
else console.log("verify-cancellation retention: PASS planted native37/stdout/stderr survive scratch deletion; FAIL line names " + JSON.stringify(record.retainedDiagnostics));
process.exitCode = record.failure ? 1 : 0;
