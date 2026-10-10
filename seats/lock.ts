import * as fs from "node:fs";
import * as path from "node:path";
import { pidAlive } from "./seat-activity";

export function acquirePidLock(file: string): number | null {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const fd = fs.openSync(file, "wx", 0o600);
    fs.writeFileSync(fd, `${process.pid}\n`);
    return fd;
  } catch (e: any) {
    if (e?.code !== "EEXIST") throw e;
    const owner = Number((fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "").trim());
    if (owner && !pidAlive(owner)) {
      try { fs.rmSync(file, { force: true }); return acquirePidLock(file); } catch {}
    }
    return null;
  }
}

export function releasePidLock(file: string, fd: number | null): void {
  if (fd === null) return;
  try { fs.closeSync(fd); } catch {}
  try { fs.rmSync(file, { force: true }); } catch {}
}
