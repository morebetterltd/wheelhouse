// Signal a real queued runner's completed retry, not a guessed startup delay.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
const [runner, fixture] = process.argv.slice(2);
assert(fs.statSync(path.join(fixture, ".wheelhouse-selftest-fixture")).isFile());
const bin = path.join(fixture, "diagnostic-bin"); fs.mkdirSync(bin);
// acquire_lock prints its diagnostic BEFORE invoking sleep. FD3 acknowledges
// that exact program point, even in the missing-diagnostic negative control.
fs.writeFileSync(path.join(bin, "sleep"), '#!/usr/bin/env bash\nprintf "retry\\n" >&3\n', { mode: 0o700 });
const child = spawn("bash", [runner], { env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH }, stdio: ["ignore", "inherit", "inherit", "pipe"] });
let signalled = false, receipt = "";
function signal(value: string) { if (!signalled) { signalled = true; fs.writeSync(4, value + "\n"); } }
child.stdio[3]!.on("data", b => {
  receipt += b;
  if (signalled || !receipt.includes("retry\n")) return;
  try {
    const queue = process.env.WHEELHOUSE_SELFTEST_SWEEP_LOCK! + ".queue";
    const own = fs.readdirSync(queue).filter(n => /^\d{20}\.[0-9a-f]{32}$/.test(n)).map(n => JSON.parse(fs.readFileSync(path.join(queue, n), "utf8"))).find(m => m.pid === child.pid);
    assert(own && own.kind === "wheelhouse-selftest-sweep-waiter", "B's registered queue ticket exists at retry acknowledgement");
    signal("ticket");
  } catch (e) { console.error(e); signal("invalid-ticket"); child.kill("SIGTERM"); }
});
child.once("error", error => { console.error(error); signal("spawn-error"); process.exitCode = 1; });
child.once("close", (code, sig) => { signal("closed-before-retry"); process.exitCode = code ?? (sig === "SIGINT" ? 130 : 143); });
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));
