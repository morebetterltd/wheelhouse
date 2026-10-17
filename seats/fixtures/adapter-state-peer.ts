// Test-only peer: no provider, socket or service. Release also works on failure.
import fs from "node:fs";
import path from "node:path";
const [dir, name, fifo, token] = process.argv.slice(2);
const release = path.join(dir, `${name}.release`);
const fd = fs.openSync(fifo, "r+");
const check = () => {
  if (!fs.existsSync(release)) return;
  watcher.close();
  fs.closeSync(fd);
  process.exit(0);
};
const watcher = fs.watch(dir, check);
process.once("SIGTERM", () => fs.writeFileSync(path.join(dir, `${name}.term`), String(process.pid)));
fs.writeFileSync(path.join(dir, `${name}.ready`), JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() }));
check();
