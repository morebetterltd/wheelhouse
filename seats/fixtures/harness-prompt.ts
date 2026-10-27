import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { HARNESS_VALUES, oneShotCommandForHarness, oneShotEnvForHarness } from "../harness";
import { runOneShot } from "../verify";
import { spawnWalker } from "../walk";
import { spawnWorkWalker } from "../walk-test-lock";

const root = process.argv[2];
assert(root && fs.statSync(path.join(root, ".wheelhouse-selftest-fixture")).isFile(), "owned fixture required");
const bin = path.join(root, "bin"); fs.mkdirSync(bin);
const brief = path.join(root, "brief.md"); fs.writeFileSync(brief, "Fixture brief stays in argv, prompt goes on stdin.\n");
const prompt = "π".repeat(1048560) + "0123456789abcdef".repeat(2);
const bytes = Buffer.byteLength(prompt), sha256 = crypto.createHash("sha256").update(prompt).digest("hex");
assert.equal(bytes, 2097152);
const stub = `#!/usr/bin/env node
const fs=require('fs'),crypto=require('crypto');
const input=fs.readFileSync(0),argv=process.argv.slice(2);
fs.writeFileSync(process.env.HARNESS_PROMPT_RECORD,JSON.stringify({argv,stdinKind:fs.fstatSync(0).isFile()?'file':fs.fstatSync(0).isFIFO()?'pipe':'other',bytes:input.length,sha256:crypto.createHash('sha256').update(input).digest('hex')}));
console.log('fixture consumed stdin through EOF');
`;
for (const name of ["pi", "claude", "codex"]) fs.writeFileSync(path.join(bin, name), stub, { mode: 0o755 });
const records: any[] = [];
for (const harness of HARNESS_VALUES) {
  const cmd = oneShotCommandForHarness(harness, brief, "fixture-provider", "fixture-model", prompt, "Read", "Write");
  assert.equal(cmd.stdin, prompt); assert(!cmd.args.includes(prompt));
  assert(cmd.args.join(" ").length < 16384, "bounded flags/brief only in argv");
  assert(cmd.display.includes("< <prompt>") && !cmd.display.includes(prompt));
  for (const mode of ["fixed", "argv-restored", "stdin-removed"] as const) {
    const record = path.join(root, `${harness}-${mode}.json`);
    const env = oneShotEnvForHarness(harness, path.join(root, harness), { ...process.env, PATH: bin + path.delimiter + process.env.PATH, HARNESS_PROMPT_RECORD: record });
    delete env.WHEELHOUSE_SELFTEST_REVIEW_GROUPS;
    const args = mode === "argv-restored" ? [...cmd.args, prompt] : cmd.args;
    let result: Awaited<ReturnType<typeof runOneShot>> | undefined, spawnError: any;
    try {
      result = await runOneShot(cmd.bin, args, { cwd: root, env, stdin: mode === "fixed" ? cmd.stdin : "", harness, timeoutMs: 10000, firstOutputTimeoutMs: 10000, noEventTimeoutMs: 10000, maxBuffer: 1024 * 1024 });
    } catch (error) { spawnError = error; }
    const captured = fs.existsSync(record) ? JSON.parse(fs.readFileSync(record, "utf8")) : null;
    const native = { harness, mode, status: result?.status ?? null, signal: result?.signal ?? null, errorCode: spawnError?.code ?? result?.error?.code ?? null, error: spawnError?.message ?? result?.error?.message ?? null, stdout: result?.stdout ?? null, stderr: result?.stderr ?? null, record: captured };
    records.push(native); fs.writeFileSync(path.join(root, "native.json"), JSON.stringify(records, null, 2) + "\n");
    const delivery = () => {
      assert.ifError(spawnError); assert.ifError(result?.error); assert.equal(result?.status, 0); assert.equal(result?.signal, null);
      assert(captured, "missing stdin record"); assert.equal(captured.stdinKind, "pipe"); assert(!captured.argv.includes(prompt), "prompt in argv");
      assert.equal(captured.bytes, bytes, "stdin length"); assert.equal(captured.sha256, sha256, "stdin sha256");
    };
    if (mode === "fixed") {
      delivery(); console.log(`  ok    ${harness} one-shot prompt of ${bytes} bytes arrives on stdin (sha256=${sha256}; shared reviewer spawn)`);
    } else if (mode === "argv-restored") {
      assert.equal(native.errorCode, "E2BIG", "only the intended native argv-limit failure earns control credit");
      assert.throws(delivery);
      console.log(`CONTROL ${harness} prompt restored to argv: ${native.errorCode ?? "missing stdin record"}; unchanged delivery oracle rejects`);
    } else {
      assert.ifError(spawnError); assert.ifError(result?.error); assert.equal(result?.status, 0); assert.equal(captured?.bytes, 0);
      assert.throws(delivery, /stdin length/);
      console.log(`CONTROL ${harness} stdin forwarding removed: native0, stdin length0; unchanged delivery oracle rejects`);
    }
  }
  // Both actual walk spawn paths, without a task graph or model/account.
  for (const kind of ["surface", "work"] as const) for (const removed of [false, true]) {
    const record = path.join(root, `${harness}-${kind}-${removed}.json`);
    const env = oneShotEnvForHarness(harness, path.join(root, harness), { ...process.env, PATH: bin + path.delimiter + process.env.PATH, HARNESS_PROMPT_RECORD: record });
    const command = { ...cmd, stdin: removed ? "" : cmd.stdin };
    const result = kind === "surface" ? spawnWalker(command, root, env) : await spawnWorkWalker(command.bin, command.args, root, env, 10000, path.join(root, "unused-private.lock"), command.stdin);
    const captured = fs.existsSync(record) ? JSON.parse(fs.readFileSync(record, "utf8")) : null;
    records.push({ harness, mode: `${kind}-${removed ? "stdin-removed" : "fixed"}`, status: result.status, signal: result.signal, errorCode: result.error?.code ?? null, stdout: result.stdout, stderr: result.stderr, record: captured });
    fs.writeFileSync(path.join(root, "native.json"), JSON.stringify(records, null, 2) + "\n");
    const delivery = () => {
      assert.ifError(result.error); assert.equal(result.status, 0); assert.equal(result.signal, null);
      assert(captured, "missing stdin record"); assert(!captured.argv.includes(prompt));
      assert.equal(captured.stdinKind, kind === "surface" ? "file" : "pipe");
      assert.equal(captured.bytes, bytes, "stdin length"); assert.equal(captured.sha256, sha256, "stdin sha256");
    };
    if (removed) {
      assert.ifError(result.error); assert.equal(result.status, 0); assert.equal(captured.bytes, 0);
      assert.throws(delivery, /stdin length/);
      console.log(`CONTROL ${harness} ${kind} walk stdin removed: native0, stdin length0; delivery oracle rejects`);
    } else { delivery(); console.log(`  ok    ${harness} ${kind} walk prompt of ${bytes} bytes arrives on stdin (${captured.stdinKind})`); }
  }
}
const evidence = process.env.WHEELHOUSE_HARNESS_PROMPT_EVIDENCE;
if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.copyFileSync(path.join(root, "native.json"), path.join(evidence, "native.json")); }
console.log("harness prompt: PASS (9 exact-byte deliveries; 3 argv and 9 dropped-stdin removals)");
