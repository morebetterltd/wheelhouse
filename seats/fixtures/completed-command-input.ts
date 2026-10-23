import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const [moduleFile, root] = process.argv.slice(2);
assert(fs.statSync(moduleFile).isFile() && fs.statSync(root).isDirectory());
const source = fs.readFileSync(moduleFile, "utf8");
const text = "native stdin: café, 雪, 🌿\n";
const binary = Buffer.from(Array.from({ length: 4352 }, (_, i) => i % 256));
const view = new Uint8Array(binary.buffer, binary.byteOffset + 17, 277);
const inputs = {
  text: Buffer.from(text), binary, view: Buffer.from(view),
  utf16: Buffer.from(text, "utf16le"), empty: Buffer.alloc(0),
};
for (const [name, bytes] of Object.entries(inputs)) fs.writeFileSync(path.join(root, name), bytes);
const stderrScript = path.join(root, "stderr.sh");
fs.writeFileSync(stderrScript, 'cat "$1" >&2\nexit 23\n');
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

type Case = {
  name: string; file: string; args: string[]; inputFile?: string;
  options: any; check: (r: any) => void; old: string; replacement: string;
};
const ignoreInput = { old: 'stdio: [stdin, descriptors[0], descriptors[1]]', replacement: 'stdio: ["ignore", descriptors[0], descriptors[1]]' };
const decodeStdout = { old: 'fs.readFileSync(stdout, encoding)', replacement: 'fs.readFileSync(stdout, "utf8")' };
const cases: Case[] = [
  {
    name: "legacy-utf8-default", file: "cat", args: ["text"], options: { cwd: root, env: { ...process.env, LC_ALL: "C" } },
    check(r) { assert.equal(typeof r.stdout, "string", "omitted encoding preserves string API"); assert.equal(r.stdout, text); assert.equal(r.stderr, ""); },
    old: 'encoding = "utf8"', replacement: 'encoding = null',
  },
  {
    name: "string-stdin", file: "cat", args: [], inputFile: "text", options: { input: text },
    check(r) { assert.equal(r.stdout, text, "string stdin reaches native EOF with all UTF-8 bytes"); }, ...ignoreInput,
  },
  {
    name: "buffer-stdin", file: "cat", args: [], inputFile: "binary", options: { input: binary, encoding: null },
    check(r) { assert(Buffer.isBuffer(r.stdout)); assert(r.stdout.equals(binary), "binary stdin is byte-exact, not empty or decoded"); }, ...ignoreInput,
  },
  {
    name: "view-stdin", file: "cat", args: [], inputFile: "view", options: { input: view, encoding: null },
    check(r) { assert(Buffer.isBuffer(r.stdout)); assert(r.stdout.equals(inputs.view), "only the view's offset/length is forwarded"); },
    old: 'fs.writeFileSync(file, input,', replacement: 'fs.writeFileSync(file, typeof input === "string" ? input : Buffer.from(input.buffer),',
  },
  {
    name: "raw-stdout", file: "cat", args: ["binary"], options: { cwd: root, encoding: null },
    check(r) { assert(Buffer.isBuffer(r.stdout), "explicit null returns raw stdout"); assert(r.stdout.equals(binary)); assert(Buffer.isBuffer(r.stderr)); }, ...decodeStdout,
  },
  {
    name: "raw-stderr-and-native-exit", file: "sh", args: [stderrScript, path.join(root, "binary")], options: { encoding: null },
    check(r) { assert(Buffer.isBuffer(r.stderr), "explicit null returns raw stderr"); assert(r.stderr.equals(binary)); assert(Buffer.isBuffer(r.stdout)); assert.equal(r.stdout.length, 0); },
    old: 'fs.readFileSync(stderr, encoding)', replacement: 'fs.readFileSync(stderr, "utf8")',
  },
  {
    name: "explicit-encoding", file: "cat", args: [], inputFile: "utf16", options: { input: text, encoding: "utf16le" },
    check(r) { assert.equal(r.stdout, text, "requested encoding decodes captured bytes"); assert.equal(r.stderr, ""); }, ...decodeStdout,
  },
  {
    name: "empty-stdin-and-raw-empty", file: "cat", args: [], inputFile: "empty", options: { input: "", encoding: null },
    check(r) { assert(Buffer.isBuffer(r.stdout), "raw empty output is an empty Buffer, not empty string"); assert.equal(r.stdout.length, 0); assert(Buffer.isBuffer(r.stderr)); assert.equal(r.stderr.length, 0); }, ...decodeStdout,
  },
];

// Capture each real native command first, with independent regular descriptors.
// No process-table data or invented CLI result is needed for these byte tests.
const references = new Map<string, any>();
for (const c of cases) {
  const out = path.join(root, c.name + ".native.out"), err = path.join(root, c.name + ".native.err");
  const a = fs.openSync(out, "wx", 0o600), b = fs.openSync(err, "wx", 0o600);
  const stdin = c.inputFile ? fs.openSync(path.join(root, c.inputFile), "r") : null;
  let r;
  try { r = spawnSync(c.file, c.args, { cwd: root, env: c.options.env ?? process.env, stdio: [stdin ?? "ignore", a, b] }); }
  finally { fs.closeSync(a); fs.closeSync(b); if (stdin !== null) fs.closeSync(stdin); }
  assert(!r.error && !r.signal, "native reference must complete without observation failure");
  assert.equal(r.status, c.name === "raw-stderr-and-native-exit" ? 23 : 0);
  const stdout = fs.readFileSync(out), stderr = fs.readFileSync(err);
  const receipt = { command: [c.file, ...c.args], status: r.status, signal: r.signal, inputBytes: c.inputFile ? inputs[c.inputFile as keyof typeof inputs].length : 0, stdoutBytes: stdout.length, stderrBytes: stderr.length, stdoutSha256: sha(stdout), stderrSha256: sha(stderr) };
  fs.writeFileSync(path.join(root, c.name + ".native.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log("CAPTURE completed-command-input " + JSON.stringify({ case: c.name, ...receipt }));
  references.set(c.name, { ...r, stdout, stderr });
}

const { completedCommand } = await import(pathToFileURL(moduleFile).href);
for (const c of cases) {
  const reference = references.get(c.name);
  function completed(fn: typeof completedCommand) {
    const r = fn(c.file, c.args, c.options);
    assert(!r.error && !r.signal, "valid setup must reach native completion");
    assert.equal(r.status, reference.status, "native exit is preserved, including nonzero");
    return r;
  }
  c.check(completed(completedCommand));
  console.log("PASS completed-command-input " + c.name);
  const occurrences = source.split(c.old).length - 1;
  assert.equal(occurrences, 1, "removal control must match the intended source once");
  const mutantFile = path.join(root, c.name + ".mutant.ts");
  fs.writeFileSync(mutantFile, source.replace(c.old, () => c.replacement));
  const mutant = (await import(pathToFileURL(mutantFile).href)).completedCommand;
  const result = completed(mutant); // Setup/native failure is NOT a sensitivity success.
  assert.throws(() => c.check(result), assert.AssertionError, "removing the feature must reject its exact byte/type invariant");
  console.log("REJECT completed-command-input " + c.name + " native=" + result.status);
}
console.log("PASS completed-command-input: 8 native observations, 8 meaningful removals; legacy UTF-8, stdin/string/buffer/view/empty, raw stdout/stderr, requested encoding, native exit retained");
