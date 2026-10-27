import { spawn } from "node:child_process";

// Only the process group made by this direct detached child is owned here.
// Policy expiry and native close are separate facts; never turn a signal into
// a guessed shell status. Includes teardown on normal close for inherited fds.
export async function manualCheckChild(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, budget: number) {
  if (!Number.isSafeInteger(budget) || budget <= 0) throw new Error("invalid manual-check helper time limit");
  const child = spawn(bin, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", spawnError: string | undefined, policy: string | undefined;
  let term: ReturnType<typeof setTimeout> | undefined, kill: ReturnType<typeof setTimeout> | undefined;
  const alive = () => { if (!child.pid) return false; try { process.kill(-child.pid, 0); return true; } catch (e: any) { if (e.code === "ESRCH") return false; throw e; } };
  const signal = (sig: NodeJS.Signals) => { if (!child.pid) return; try { process.kill(-child.pid, sig); } catch (e: any) { if (e.code !== "ESRCH") throw e; } };
  const stop = (why: string) => {
    if (policy) return;
    policy = why; signal("SIGTERM");
    kill = setTimeout(() => signal("SIGKILL"), 1500);
  };
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) { const h = () => stop(`cancelled by ${sig}`); handlers.set(sig,h); process.on(sig,h); }
  // Pipe chunks need not align with a FINDINGS em dash: decode across chunks.
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", b => { stdout += b.toString(); if (stdout.length > 8*1024*1024) stop("stdout limit exceeded"); });
  child.stderr.on("data", b => { stderr += b.toString(); if (stderr.length > 8*1024*1024) stop("stderr limit exceeded"); });
  child.once("error", e => { spawnError = e.message; });
  child.once("spawn", () => { term = setTimeout(() => stop(`helper timed out after ${budget}ms`), budget); });
  try {
    const native = await new Promise<{status:number|null;signal:NodeJS.Signals|null}>((resolve,reject) => {
      const hard = setTimeout(() => { signal("SIGKILL"); child.stdout.destroy(); child.stderr.destroy(); reject(new Error("manual-check helper close bound exceeded")); }, budget+7000);
      child.once("close", (status, signal) => { clearTimeout(hard); resolve({status,signal}); });
    });
    clearTimeout(term); clearTimeout(kill);
    if (alive()) {
      signal("SIGTERM");
      const until = performance.now()+1500;
      while (alive() && performance.now()<until) await Bun.sleep(20);
      if (alive()) signal("SIGKILL");
      const killed = performance.now()+5000;
      while (alive() && performance.now()<killed) await Bun.sleep(20);
      if (alive()) throw new Error("owned manual-check group did not retire; scratch must be retained");
    }
    return {...native,spawnError,policy,stdout,stderr,stdoutEOF:child.stdout.readableEnded,stderrEOF:child.stderr.readableEnded};
  } finally {
    clearTimeout(term);clearTimeout(kill);
    for (const [sig,h] of handlers) process.removeListener(sig,h);
  }
}
