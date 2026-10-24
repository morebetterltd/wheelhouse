import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { completedSpawnSync as spawnSync } from "./native-command";
import { pidAlive } from "./seat-activity";

const INCOMPLETE_LOCK_GRACE_MS = 1000;

function sameFile(a: fs.Stats, b: fs.Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

// Only a successful, unambiguous native probe permits deleting a malformed
// legacy lock. Missing lsof, timeouts and diagnostic output all fail closed.
function hasNoOpenFile(file: string): boolean {
  for (const lsof of ["lsof", "/usr/sbin/lsof", "/usr/bin/lsof"]) {
    const r = spawnSync(lsof, ["-t", "--", file], {
      encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "pipe"],
    });
    if ((r.error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
    return !r.error && r.status === 1 && !r.stdout.trim() && !r.stderr.trim();
  }
  return false;
}

function removeStaleLock(file: string): boolean {
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile()) return false;
    const text = fs.readFileSync(file, "utf8");
    const raw = text.trim();
    const owner = /^[1-9]\d*$/.test(raw) ? Number(raw) : NaN;
    if (Number.isSafeInteger(owner) && owner <= 0x7fffffff) {
      if (pidAlive(owner)) return false;
    } else {
      if (Date.now() - before.mtimeMs <= INCOMPLETE_LOCK_GRACE_MS || !hasNoOpenFile(file)) return false;
    }
    // A competing acquirer/releaser may have changed the path during the probe.
    const after = fs.lstatSync(file);
    if (!sameFile(before, after) || before.mtimeMs !== after.mtimeMs || fs.readFileSync(file, "utf8") !== text) return false;
    fs.unlinkSync(file);
    return true;
  } catch (e: any) {
    // A concurrent release is also an opportunity to retry publication.
    return e?.code === "ENOENT";
  }
}

export function acquirePidLock(file: string): number | null {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    const tmp = `${file}.tmp.${process.pid}.${randomUUID()}`;
    let fd: number | null = null;
    let published = false;
    try {
      fd = fs.openSync(tmp, "wx", 0o600);
      fs.writeFileSync(fd, `${process.pid}\n`);
      // link is exclusive like wx, but publishes the complete PID in one step.
      // rename would overwrite a live owner's lock and must not be used here.
      fs.linkSync(tmp, file);
      published = true;
      return fd;
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
    } finally {
      if (!published && fd !== null) fs.closeSync(fd);
      try { fs.unlinkSync(tmp); } catch (e: any) { if (e?.code !== "ENOENT") throw e; }
    }
    if (!removeStaleLock(file)) return null;
  }
  return null;
}

export function releasePidLock(file: string, fd: number | null): void {
  if (fd === null) return;
  try {
    // Do not unlink somebody else's replacement when releasing an old handle.
    if (sameFile(fs.fstatSync(fd), fs.lstatSync(file))) fs.unlinkSync(file);
  } catch {} finally {
    try { fs.closeSync(fd); } catch {}
  }
}
