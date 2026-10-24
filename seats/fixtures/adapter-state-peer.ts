// Test-only peer: no provider, socket or service. Release also works on failure.
import fs from "node:fs";
import path from "node:path";
import conditionWait from './wait-for-condition.cjs';
const { waitForCondition } = conditionWait;
const [dir, name, fifo, token] = process.argv.slice(2);
const release = path.join(dir, `${name}.release`);
const fd = fs.openSync(fifo, "r+");
process.once("SIGTERM", () => fs.writeFileSync(path.join(dir, `${name}.term`), String(process.pid)));
fs.writeFileSync(path.join(dir, `${name}.ready`), JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() }));
const observed = waitForCondition({ site: 'adapter-state-peer.release', paths: [dir], predicate: () => fs.existsSync(release) });
observed.promise.then(() => { fs.closeSync(fd); process.exit(0); }, error => { console.error(error); process.exit(1); });
