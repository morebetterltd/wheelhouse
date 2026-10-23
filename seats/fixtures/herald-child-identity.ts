// Test-only allocation join and signal policy. Native ownership checks remain
// in herald-lifetime.selftest.sh; a missing snapshot never grants ownership.
import assert from "node:assert/strict";

type Child = { exitCode: number | null; signalCode: string | null; exited: Promise<number> };
export async function captureAllocation<T>(child: Child, observe: () => T, joinMs = 2000): Promise<T | null> {
  try { return observe(); }
  catch (error) {
    // A process can shed cwd while ps still reports an exiting process (?E on
    // macOS). One event-loop turn is not a child completion. Join THIS handle,
    // not a later occupant of its numeric PID. The timer only rejects; it can
    // never make an uncertain snapshot count as ownership or successful exit.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        child.exited,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(error), joinMs); }),
      ]);
      return null;
    } finally { clearTimeout(timer); }
  }
}

type Record = { pid: number; cwd: string; script: string; direct: boolean; generation: string | null; child?: Child };
export function signalObservedChild(rec: Record, sig: NodeJS.Signals,
  alive: (pid: number) => boolean, identity: (pid: number, cwd: string, script: string, direct: boolean) => string | null) {
  // A joined direct child needs no signal even if its PID slot now looks live.
  if (rec.child && (rec.child.exitCode !== null || rec.child.signalCode !== null)) return;
  if (!alive(rec.pid)) return;
  assert.ok(rec.generation, "identity captured while allocated");
  assert.equal(identity(rec.pid, rec.cwd, rec.script, rec.direct), rec.generation, "same PID generation before signal");
  process.kill(rec.pid, sig);
}
