import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";

// Only track children spawned with detached:true: on POSIX their pid is the
// leader/pgid of the new group we started. Never infer ownership from ps,
// environment, cwd, argv, or a machine-wide process search.
type ReviewChild = {
  pid: number;
  closed: boolean;
  onCancel?: () => void;
  marker?: string;
  sweep?: { lock: string; helper: string };
};
type ReviewLock = { lock: string; helper: string; pid: number; token: string; identity: string };
const reviewChildren = new Set<ReviewChild>();
export const reviewScratchCleanups = new Set<() => void>();
export let reviewCancelling = false;
export let reviewChildrenStopped = false;
let reviewSignalsInstalled = false;

function groupAlive(pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) throw new Error("invalid owned review pgid");
  try { process.kill(-pgid, 0); return true; }
  catch (e: any) { if (e.code === "ESRCH") return false; if (e.code === "EPERM") return true; throw e; }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  if (!Number.isInteger(pgid) || pgid <= 1) throw new Error("invalid owned review pgid");
  try { process.kill(-pgid, signal); }
  catch (e: any) { if (e.code !== "ESRCH") throw e; }
}

function captureReviewLock(child: ReviewChild): ReviewLock | null {
  if (!child.sweep) return null;
  try {
    const s = fs.lstatSync(child.sweep.lock, { bigint: true });
    if (!s.isDirectory() || s.isSymbolicLink()) return null;
    const fd = fs.openSync(path.join(child.sweep.lock, "wheelhouse-selftest-sweep"), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let marker: any;
    try {
      if (fs.fstatSync(fd).size > 16384) return null;
      marker = JSON.parse(fs.readFileSync(fd, "utf8"));
    } finally { fs.closeSync(fd); }
    if (marker.pid !== child.pid || marker.hostname !== os.hostname() || !/^[a-f0-9]{32}$/.test(marker.token)) return null;
    return { ...child.sweep, pid: child.pid, token: marker.token, identity: `${s.dev}:${s.ino}` };
  } catch (e: any) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

async function cancelReview(signal: "SIGTERM" | "SIGINT" | "SIGHUP"): Promise<void> {
  if (reviewCancelling) return;
  reviewCancelling = true;
  const status = signal === "SIGTERM" ? 143 : signal === "SIGINT" ? 130 : 129;
  try {
    const children = [...reviewChildren];
    const locks = children.map(captureReviewLock).filter((x): x is ReviewLock => x !== null);
    for (const child of children) child.onCancel?.();
    for (const child of children) signalGroup(child.pid, "SIGTERM");
    const settled = () => children.every(c => c.closed && !groupAlive(c.pid));
    const wait = async (ms: number) => {
      const until = performance.now() + ms;
      while (!settled() && performance.now() < until) await new Promise(resolve => setTimeout(resolve, 100));
    };
    await wait(1500);
    for (const child of children) if (groupAlive(child.pid)) signalGroup(child.pid, "SIGKILL");
    await wait(2000);
    if (!settled()) throw new Error("owned review process groups did not exit/close after KILL");
    // TERM normally runs the runner's EXIT trap. If KILL was necessary, replay
    // only its captured owner/token/inode through the existing lock helper.
    // The helper refuses changed ownership and never removes a replacement.
    for (const lock of locks) {
      const r = spawnSync("bun", [lock.helper, "release", lock.lock, String(lock.pid), lock.token, lock.identity], { encoding: "utf8" });
      if (r.error || r.status !== 0) throw new Error(`owned review lock release failed: ${r.stderr || r.error?.message}`);
    }
    reviewChildrenStopped = true;
    for (const child of children) if (child.marker) {
      try { fs.unlinkSync(child.marker); } catch (e: any) { if (e.code !== "ENOENT") throw e; }
    }
    for (const cleanup of reviewScratchCleanups) cleanup();
    process.stderr.write(`STOP: review cancelled by ${signal}; owned groups stopped, locks released, scratch removed\n`);
    process.exit(status);
  } catch (e: any) {
    // Do not erase scratch if shutdown or resource release is incomplete.
    process.stderr.write(`STOP: review cancellation incomplete: ${e.message}; scratch retained for inspection\n`);
    process.exit(1);
  }
}

export function installReviewSignals(): void {
  if (reviewSignalsInstalled) return;
  reviewSignalsInstalled = true;
  // Further cancellation signals cannot bypass the in-progress cleanup.
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => { void cancelReview(signal); });
}

export function trackReviewChild(child: ReturnType<typeof spawn>, extra: Partial<Pick<ReviewChild, "onCancel" | "marker" | "sweep">> = {}): ReviewChild {
  if (!child.pid) return { ...extra, pid: 0, closed: true }; // preserve spawn-error handling
  const owned: ReviewChild = { ...extra, pid: child.pid, closed: false };
  reviewChildren.add(owned);
  child.once("close", () => {
    owned.closed = true;
    // Retire a completed, empty group rather than retaining its numeric pgid.
    if (!groupAlive(owned.pid)) reviewChildren.delete(owned);
  });
  return owned;
}
