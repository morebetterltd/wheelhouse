// Test-only handoff between herald-lifetime's owner shell and its coordinator.
import fs from "node:fs";

export type OwnerAllocation = { proj: string; pid: number };

export async function waitForOwnerAllocationRecord(file: string, timeoutMs = 4000): Promise<OwnerAllocation> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("owner allocation record timeout must be positive");
  const deadline = performance.now() + timeoutMs;
  let incomplete = "file not published";
  for (;;) {
    let text: string | undefined;
    try { text = fs.readFileSync(file, "utf8"); }
    catch (error: any) { if (error.code !== "ENOENT") throw error; }
    if (text !== undefined) {
      // A partly written PID can already look like a positive integer. Require
      // the terminating newline as well as both complete, valid lines.
      const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : [];
      const [proj, pidText] = lines;
      const pid = Number(pidText);
      if (lines.length === 2 && proj.length > 0 && /^[1-9]\d*$/.test(pidText) && Number.isSafeInteger(pid)) return { proj, pid };
      incomplete = "expected two newline-terminated lines: nonempty project and positive integer PID";
    }
    if (performance.now() >= deadline) throw new Error(`owner allocation record incomplete after ${timeoutMs}ms: ${file} (${incomplete})`);
    await Bun.sleep(25);
  }
}
