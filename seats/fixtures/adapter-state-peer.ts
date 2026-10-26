// Test-only peer: no provider, socket or service. Release also works on failure.
import fs from "node:fs";
import path from "node:path";
import conditionWait from './wait-for-condition.cjs';
const { waitForCondition } = conditionWait;
const [dir, name, fifo, token] = process.argv.slice(2);
const release = path.join(dir, `${name}.release`);
const fd = fs.openSync(fifo, "r+");
process.once("SIGTERM", () => fs.writeFileSync(path.join(dir, `${name}.term`), String(process.pid)));
let closed = false;
let observed: ReturnType<typeof waitForCondition> | undefined;
function finish(kind: "ipc" | "file") {
  if (closed) return;
  closed = true; observed?.cancel();
  fs.writeFileSync(path.join(dir, `${name}.released`), JSON.stringify({ pid: process.pid, token, kind }));
  fs.closeSync(fd); process.exit(0);
}
// The owner joins real SIGTERM receipts before sending this release event.
process.on("message", (message: any) => {
  if (message?.type === "release" && message.name === name && message.token === token) finish("ipc");
});
fs.writeFileSync(path.join(dir, `${name}.ready`), JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() }));
observed = waitForCondition({ site: 'adapter-state-peer.release', paths: [dir], predicate: () => fs.existsSync(release) });
observed.promise.then(() => finish("file"), error => { console.error(error); process.exit(1); });
