// Test-only handoff between herald-lifetime's owner shell and its coordinator.
import fs from "node:fs";

export type OwnerAllocation = { proj: string; pid: number };

export async function waitForOwnerAllocationRecord(file: string, timeoutMs?: number, producerExited?: () => boolean): Promise<OwnerAllocation> {
  // Only malformed-record negative legs request a local expiry. A real owner
  // publishes a complete record or exits; the sweep contains a stuck producer.
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new Error("owner allocation record timeout must be positive");
  const deadline = timeoutMs === undefined ? Infinity : performance.now() + timeoutMs;
  console.error(`FIXTURE_WAIT owner allocation record: ${file}`);
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
    if (producerExited?.()) throw new Error(`owner allocation producer exited before a complete record: ${file} (${incomplete})`);
    if (performance.now() >= deadline) throw new Error(`owner allocation record incomplete after ${timeoutMs}ms: ${file} (${incomplete})`);
    await Bun.sleep(25);
  }
}
