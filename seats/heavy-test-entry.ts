// Admit a whole one-shot review before its watchdogs or scratch work start.
// The supervised real review PID (not this forwarding proxy) owns the lock.
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";

export async function heavyTestEntry(source: string, main: () => Promise<void>): Promise<void> {
  const helper = process.env.WHEELHOUSE_SELFTEST_SWEEP_LOCK_HELPER || path.join(import.meta.dir, "selftest-sweep-lock.ts");
  const lock = process.env.WHEELHOUSE_SELFTEST_SWEEP_LOCK || "/tmp/wheelhouse-selftest-sweep.lock";
  const probe = spawnSync("bun", [helper, "inherited", lock], { encoding: "utf8" });
  if (probe.stderr) process.stderr.write(probe.stderr);
  if (probe.error || ![0, 75].includes(probe.status!)) throw new Error(`heavy-test ancestry check failed: ${probe.error ?? probe.status}`);
  if (probe.status === 0) { await main(); return; }
  const child = spawn("bash", [path.join(import.meta.dir, "heavy-test.sh"), "bun", source, ...process.argv.slice(2)], { stdio: "inherit", detached: true });
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    const handler = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); } catch (e: any) { if (e.code !== "ESRCH") throw e; }
    };
    handlers.set(signal, handler); process.on(signal, handler);
  }
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    process.exitCode = result.code ?? (result.signal ? 128 + os.constants.signals[result.signal] : 2);
  } finally { for (const [signal, handler] of handlers) process.off(signal, handler); }
}
