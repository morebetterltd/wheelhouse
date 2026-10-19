import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

type Owner = { pid: number; started: string } | null;
// A temp-looking path or state.json PID is not ownership evidence. Only an
// explicit record under a marked, physically resolved fixture binds lifetime.
export function fixtureOwner(root: string): Owner {
  for (let dir = fs.realpathSync(root); ; dir = path.dirname(dir)) {
    const marker = path.join(dir, ".wheelhouse-selftest-fixture");
    const record = path.join(dir, ".wheelhouse-herald-owner");
    if (fs.existsSync(marker) && fs.existsSync(record)) {
      const [pid, started, uid, recordedRoot] = fs.readFileSync(record, "utf8").trim().split("\n");
      if (fs.lstatSync(record).isSymbolicLink() || fs.lstatSync(marker).isSymbolicLink() || recordedRoot !== dir || Number(uid) !== process.getuid?.() || !/^\d+$/.test(pid) || !started) throw new Error("invalid fixture herald owner record");
      return { pid: Number(pid), started };
    }
    if (path.dirname(dir) === dir) return null;
  }
}
export function fixtureOwnerAlive(owner: Owner): boolean {
  if (!owner) return true;
  try { process.kill(owner.pid, 0); } catch { return false; }
  const r = spawnSync("ps", ["-p", String(owner.pid), "-o", "lstart=,stat="], { encoding: "utf8", timeout: 2000 });
  const fields = (r.stdout ?? "").trim().split(/\s+/);
  const stat = fields.pop() ?? "";
  return r.status === 0 && !stat.startsWith("Z") && fields.join(" ") === owner.started;
}
