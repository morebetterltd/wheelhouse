// Event readiness, not a guessed number of shell/Node startups. The admitted
// sweep owns the containment budget; exit/malformed proof is never success.
import fs from "node:fs";
import assert from "node:assert/strict";
import { completedCommand } from "../completed-command";
const [mode, pidText, root] = process.argv.slice(2);
const pid = Number(pidText);
assert(Number.isInteger(pid) && pid > 1);
const read = (file: string) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
for (;;) {
  try { process.kill(pid, 0); } catch (e) { throw new Error(`staffing readiness: process ${pid} exited before ${mode}`, { cause: e }); }
  if (mode === "growth") {
    const staff = read(root + "/seats/staffing.json")?.seats, state = read(root + "/seats/state.json")?.seats;
    if (staff && state && Object.keys(staff).length === 3 && Object.values<any>(state).filter(r => r?.pid).length === 3) break;
  } else if (mode === "attempt") {
    if (fs.existsSync(root + "/seats/run/staffing-canary-attempt")) break;
  } else if (mode === "pi") {
    const r = completedCommand("ps", ["-p", String(pid), "-o", "command="]);
    if (r.status === 0 && r.stdout.trim() === "pi") break;
  } else throw new Error("unknown staffing readiness mode: " + mode);
  await Bun.sleep(50);
}
console.log(`staffing readiness observed: ${mode} pid=${pid}`);
