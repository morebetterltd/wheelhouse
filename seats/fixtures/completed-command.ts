import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
const [moduleFile, root] = process.argv.slice(2);
assert(fs.statSync(moduleFile).isFile() && fs.statSync(root).isDirectory());
const { completedCommand } = await import(pathToFileURL(moduleFile).href);
// Capture the real host protocol before constructing its replay. No invented
// process-list schema, guessed empty result, stderr discard or stream count.
const native = completedCommand("ps", ["axww", "-o", "pid=,ppid=,uid=,command="]);
fs.writeFileSync(path.join(root, "native-ps.json"), JSON.stringify({ command: ["ps", "axww", "-o", "pid=,ppid=,uid=,command="], ...native }));
assert.equal(native.status, 0); assert.equal(native.signal, null); assert(!native.error);
assert(native.stdout.trim().length > 0);
fs.writeFileSync(path.join(root, "native-ps.input"), native.stdout, { mode: 0o600 });
const copies = Math.ceil(20 * 1024 * 1024 / Buffer.byteLength(native.stdout));
const script = path.join(root, "replay.cjs");
fs.writeFileSync(script, `const fs=require('fs');const b=fs.readFileSync(process.argv[2]);for(let i=0;i<Number(process.argv[3]);i++)fs.writeSync(1,b);fs.writeSync(2,'owned stderr channel\\n');`);
const replay = completedCommand("node", [script, path.join(root, "native-ps.input"), String(copies)]);
fs.writeFileSync(path.join(root, "replay.json"), JSON.stringify({ status: replay.status, signal: replay.signal, error: replay.error?.message, bytes: Buffer.byteLength(replay.stdout), stderr: replay.stderr, nativeBytes: Buffer.byteLength(native.stdout), copies }));
console.log("CAPTURE command completion " + fs.readFileSync(path.join(root, "replay.json"), "utf8"));
assert.equal(replay.status, 0, replay.error?.message);
assert.equal(replay.signal, null); assert(!replay.error);
assert.equal(replay.stdout, native.stdout.repeat(copies), "all actual replayed native bytes survive beyond pipe maxBuffer");
assert.equal(replay.stderr, "owned stderr channel\n");
for (const [name, args, status, signal] of [
  ["exit", ["-c", "printf 'before exit'; printf 'owned error' >&2; exit 23"], 23, null],
  ["signal", ["-c", "printf 'before signal'; kill -TERM $$"], null, "SIGTERM"],
] as const) {
  const r = completedCommand("bash", [...args]);
  fs.writeFileSync(path.join(root, name + ".json"), JSON.stringify(r));
  assert.equal(r.status, status); assert.equal(r.signal, signal); assert(r.stdout.startsWith("before "));
}
const absent = completedCommand("wheelhouse-no-such-native-command", []);
fs.writeFileSync(path.join(root, "absent.json"), JSON.stringify(absent));
assert.equal(absent.status ?? null, null); assert.equal(absent.error?.code, "ENOENT"); // Bun omits status; Node returns null.
console.log("PASS completed-command: native capture/replay >20MiB, separate stderr, nonzero/signal/ENOENT retained; no pipe-sized success assumption");
