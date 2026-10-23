// Node-shaped adapters for audited synchronous command sites. Native exit,
// signal and spawn errors remain authoritative; capture uses regular files.
import { completedCommand } from "./completed-command";

// Ordinary CLI work has no elapsed-time or pipe-size success opportunity.
// A caller retaining a named outer policy uses policyTimeoutMs explicitly;
// native completion/error and the last captured bytes still decide its result.
// Node's binary default is preserved here, unlike the legacy text helper API.
export function completedSpawnSync(file: string, args: string[], options: any = {}): any {
  const { timeout: _oldTimeout, maxBuffer: _pipeLimit, policyTimeoutMs, ...nativeOptions } = options;
  const encoding = options.encoding && options.encoding !== "buffer" ? options.encoding : null;
  const policy = policyTimeoutMs === undefined ? {} : { timeout: policyTimeoutMs };
  return completedCommand(file, args, { ...nativeOptions, ...policy, encoding });
}

export function completedExecFileSync(file: string, args: string[], options: any = {}): any {
  const result = completedSpawnSync(file, args, options);
  if (result.error || result.signal || result.status !== 0) {
    const error = result.error ?? new Error(`native command failed: ${file} (${result.signal ?? `exit ${result.status}`}): ${String(result.stderr).trim()}`);
    // Do not attach result.error to itself: callers can serialize diagnostics.
    Object.assign(error, { pid: result.pid, status: result.status, signal: result.signal,
      stdout: result.stdout, stderr: result.stderr, output: [null, result.stdout, result.stderr] });
    throw error;
  }
  return result.stdout;
}
