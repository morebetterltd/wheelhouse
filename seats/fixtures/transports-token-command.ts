// Test-only native completion/diagnostic proof for the TOKEN_CMD leg.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";

const [root, check] = process.argv.slice(2);
assert(root && fs.statSync(path.join(root, ".wheelhouse-selftest-fixture")).isFile());
assert(check && fs.statSync(check).isFile());
const dir = path.join(root, "token-command-results"); fs.mkdirSync(dir);
const calls = path.join(root, "token-calls"), completed = path.join(root, "token-completed");
const records: any[] = [];
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const lines = (file: string) => fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0;
function reset() {
  for (const file of [calls, completed, path.join(root, "token-call-timings.jsonl")]) fs.writeFileSync(file, "");
  for (const name of ["teams.jsonl", "fail-readback"]) fs.rmSync(path.join(root, name), { force: true });
}
async function capture(label: string, argv: string[], extra: Record<string, string> = {}) {
  const started = performance.now();
  const child = spawn(argv[0], argv.slice(1), { env: { ...process.env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", stdoutEOF = false, stderrEOF = false, error: string | undefined;
  child.stdout!.on("data", b => { stdout += b; }); child.stderr!.on("data", b => { stderr += b; });
  child.stdout!.on("end", () => { stdoutEOF = true; }); child.stderr!.on("end", () => { stderrEOF = true; });
  child.once("error", e => { error = e.message; });
  const native = await new Promise<{ code: number | null; signal: string | null }>(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  const timingFile = path.join(root, "token-call-timings.jsonl");
  const r = { label, ...native, error, elapsedMs: performance.now() - started, stdout, stderr, stdoutEOF, stderrEOF,
    calls: lines(calls), completed: lines(completed), callTimings: fs.existsSync(timingFile) ? fs.readFileSync(timingFile, "utf8").split("\n").filter(Boolean).map(s => JSON.parse(s)) : [] };
  // Capture first, then classify/assert. Both channels survive even a failure.
  for (const [suffix, text] of [["stdout", stdout], ["stderr", stderr], ["json", JSON.stringify(r, null, 2) + "\n"]]) fs.writeFileSync(path.join(dir, `${label}.${suffix}`), text, { mode: 0o600 });
  records.push(r);
  assert(stdoutEOF && stderrEOF, `${label}: command did not close both streams`);
  return r;
}
type Result = Awaited<ReturnType<typeof capture>>;
function category(r: Result) {
  if (r.code !== 0 || r.signal || r.error) {
    const timeout = r.stderr.split("\n").some(line => { try { const e = JSON.parse(line); return e.event === "transport-check-error" && e.code === "ETIMEDOUT"; } catch { return false; } });
    return timeout ? "timeout" : "command failure";
  }
  return r.calls < 3 || r.completed < 3 ? "wrong count" : "success";
}
function diagnostic(r: Result) {
  return `teams TOKEN_CMD ${category(r)}: exit=${r.code} signal=${r.signal ?? "none"} calls=${r.calls} completed=${r.completed} expected>=3 elapsedMs=${r.elapsedMs.toFixed(3)}; retained stdout=${JSON.stringify(r.stdout)}; retained stderr=${JSON.stringify(r.stderr)}`;
}
function assertDiagnostic(r: Result, expected: string, message = diagnostic(r)) {
  assert.equal(category(r), expected, message);
  assert(message.startsWith(`teams TOKEN_CMD ${expected}:`), message);
  assert(message.includes(`retained stdout=${JSON.stringify(r.stdout)}`), message);
  assert(message.includes(`retained stderr=${JSON.stringify(r.stderr)}`), message);
  assert(message.includes(`exit=${r.code}`), message);
}
try {
  // Same configured command as the transport; timing is a measurement, not a
  // threshold. Reset its extra count so it cannot satisfy the per-call check.
  const configured = process.env.WHEELHOUSE_TEAMS_TOKEN_CMD!; assert(configured);
  const calibration = await capture("configured-command-calibration", ["bash", "-lc", configured]);
  assert.equal(calibration.code, 0, diagnostic(calibration)); assert.equal(calibration.signal, null);
  assert.equal(calibration.stdout, "teams-cmd-token");
  console.log(`# TOKEN_CMD timing configured-command elapsedMs=${calibration.elapsedMs.toFixed(3)} (no timing verdict)`);
  reset();
  const normal = await capture("per-call", ["bun", check, "teams", "chats/cmd"]);
  console.log("# " + diagnostic(normal)); assertDiagnostic(normal, "success");
  assert.equal(normal.calls, 3); assert.equal(normal.completed, 3);
  assert.equal(normal.callTimings.length, 3);

  reset();
  const failed = await capture("command-failure", ["bun", "-e", 'export {}; console.log("owned command stdout"); console.error("owned command stderr"); process.exit(23);']);
  assert.equal(failed.code, 23); assert.equal(failed.signal, null);
  assert.equal(failed.stdout, "owned command stdout\n"); assert.equal(failed.stderr, "owned command stderr\n");
  assertDiagnostic(failed, "command failure"); console.log("# " + diagnostic(failed));

  reset();
  const fifo = path.join(dir, "release.fifo"), entered = path.join(dir, "entered"), blocked = path.join(dir, "blocked.sh");
  const made = spawnSync("mkfifo", [fifo], { encoding: "utf8" }); assert.equal(made.status, 0, made.stderr);
  fs.writeFileSync(blocked, `#!/usr/bin/env bash\nprintf 'entered\\n' > ${quote(entered)}\nexec 3<> ${quote(fifo)}\nread -r unused <&3\necho call >> ${quote(calls)}\nprintf teams-cmd-token\necho complete >> ${quote(completed)}\n`, { mode: 0o700 });
  // exec keeps the gated script at the PID targeted by the real execFileSync
  // timeout. No background descendant holds its pipes; no load generator.
  const timeout = await capture("timeout", ["bun", check, "teams", "chats/cmd"], { WHEELHOUSE_TEAMS_TOKEN_CMD: `exec ${quote(blocked)}` });
  assert(fs.existsSync(entered), "timeout subject must actually enter its private gate");
  assert.equal(timeout.code, 1); assert.equal(timeout.signal, null);
  assert.equal(timeout.calls, 0); assert.equal(timeout.completed, 0);
  assertDiagnostic(timeout, "timeout"); console.log("# " + diagnostic(timeout));

  reset();
  const noCount = path.join(dir, "no-count.sh");
  fs.writeFileSync(noCount, `#!/usr/bin/env bash\nprintf teams-cmd-token\necho complete >> ${quote(completed)}\n`, { mode: 0o700 });
  const wrong = await capture("wrong-count", ["bun", check, "teams", "chats/cmd"], { WHEELHOUSE_TEAMS_TOKEN_CMD: `exec ${quote(noCount)}` });
  assert.equal(wrong.code, 0); assert.equal(wrong.signal, null); assert.equal(wrong.calls, 0); assert.equal(wrong.completed, 3);
  assertDiagnostic(wrong, "wrong count"); console.log("# " + diagnostic(wrong));

  for (const [r, expected] of [[failed, "command failure"], [timeout, "timeout"], [wrong, "wrong count"]] as const) {
    const legacy = `teams TOKEN_CMD per-call failed: calls=${"call\n".repeat(r.calls)}`;
    assert.throws(() => assertDiagnostic(r, expected, legacy), { code: "ERR_ASSERTION" });
    console.log(`# diagnostic control: old stream-discarding message rejected for ${expected}`);
  }
  const noTimeoutClass = { ...timeout, stderr: timeout.stderr.replaceAll('"ETIMEDOUT"', 'null') };
  assert.equal(category(noTimeoutClass), "command failure", "timeout proof must depend on the retained native class, not elapsed time or an empty count");
  console.log("# timeout-class control: removing native ETIMEDOUT classification loses timeout diagnosis");
} finally {
  // The regular calibration token is fixture-only; never print token stdout.
  for (const r of records) console.log("# TOKEN_CMD_RESULT " + JSON.stringify(r.label === "configured-command-calibration" ? { ...r, stdout: "[fixture token withheld]" } : r));
}
