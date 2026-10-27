import fs from "node:fs";
import path from "node:path";

export interface PreflightCandidates {
  main: string;
  candidates: { bead: string; tip: string }[];
}
export interface AttributionSweep {
  rc: number | null;
  logPath: string | null;
  tip: string;
  error?: string;
  timings?: { suites: { suite: string }[] };
}
const suiteName = /^[A-Za-z0-9][A-Za-z0-9._-]*\.selftest\.sh$/;
const sha = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const reason = (value: unknown) => String(value).replace(/[\x00-\x1f\x7f()]/g, " ").replace(/\s+/g, " ").trim().slice(0, 240) || "unknown";
function regular(file: string, limit: number): string {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.size > limit) throw new Error("unreadable attribution input");
    return new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(fd));
  } finally { fs.closeSync(fd); }
}
function listed(root: string): string[] {
  const names = regular(path.join(root, "seats/selftest-preflight.list"), 65536).split(/\r?\n/)
    .map(line => line.replace(/#.*$/, "").trim()).filter(Boolean);
  if (!names.length || names.some(name => !suiteName.test(name)) || new Set(names).size !== names.length) throw new Error("invalid preflight inventory");
  return names;
}
/** Read only this sweep's outer failure records. Nested fixture frames and
 * non-listed paths cannot select an executable for the attribution pass. */
export function failedPreflightAudits(text: string, root: string, names: readonly string[]): string[] {
  if (!/^selftest-sweep: PREFLIGHT STOP (?:0|[1-9][0-9]*) suite\(s\) not started$/m.test(text)) return [];
  return names.filter(name => text.split("\n").some(line => {
    const m = /^selftest-sweep: PREFLIGHT FAIL (.+) rc=([1-9][0-9]*)$/.exec(line);
    return m?.[1] === path.join(root, "seats", name);
  }));
}
function auditResult(result: AttributionSweep, tip: string, suite: string): string {
  if (result.tip !== tip || !result.logPath) return "ERROR(missing pinned audit result)";
  const text = regular(result.logPath, 64 * 1024 * 1024);
  if (!text.startsWith(`tip=${tip}\n`) || !text.includes(`\nfinalTip=${tip}\n`)) return "ERROR(audit tip not preserved)";
  const first = /^selftest-sweep: START (.+\/seats\/)([^/\n]+\.selftest\.sh)$/m.exec(text)
    ?? /^selftest-sweep: PREFLIGHT FAIL (.+\/seats\/)([^/\n]+\.selftest\.sh) rc=[1-9][0-9]*$/m.exec(text);
  if (!first || first[2] !== suite) return "ERROR(audit did not start)";
  const subject = first[1] + suite;
  const failures = text.split("\n").filter(line => line.startsWith(`selftest-sweep: FAIL ${subject} `));
  if (failures.some(line => line.includes(" timed out after "))) return "ERROR(per-suite timeout)";
  const oneSuite = result.timings?.suites.length === 1 && result.timings.suites[0].suite === suite;
  if (result.rc === 0 && !result.error && oneSuite) return "PASS";
  const preflight = failedPreflightAudits(text, path.dirname(first[1].slice(0, -1)), [suite]);
  // A preflight STOP intentionally lacks the ordinary completed-inventory
  // footer. That timing-parser error is not an inability to execute the audit.
  const stoppedTiming = preflight.length === 1 && result.error?.startsWith("invalid sweep timings:");
  if (result.error && !stoppedTiming) return `ERROR(${reason(result.error)})`;
  const preflightFailure = text.split("\n").find(line => line.startsWith(`selftest-sweep: PREFLIGHT FAIL ${subject} rc=`));
  const code = preflightFailure?.match(/ rc=([1-9][0-9]*)$/)?.[1] ?? failures.map(line => / rc=([1-9][0-9]*) elapsed=/.exec(line)?.[1]).find(Boolean);
  if (result.rc === 1 && code === "1" && (oneSuite || stoppedTiming)) return "FAIL";
  return `ERROR(${reason(code ? `audit exit ${code}` : `incomplete audit exit ${result.rc}`)})`;
}

/** Diagnostic only: never edits the original sweep rc, error or approval gate.
 * runAudit must use a separate pinned scratch sweep with ONLY suite selected;
 * the dispatcher supplies its existing graph/admission/cancellation machinery. */
export async function attributePreflight(input: {
  rc: number | null;
  logPath: string;
  scratchCwd: string;
  candidates?: PreflightCandidates;
  runAudit: (tip: string, suite: string) => Promise<AttributionSweep>;
}): Promise<string[]> {
  if (input.rc !== 1 || !input.candidates?.candidates.length) return [];
  let names: string[], failed: string[];
  try {
    names = listed(input.scratchCwd);
    failed = failedPreflightAudits(regular(input.logPath, 64 * 1024 * 1024), input.scratchCwd, names);
  } catch { return []; } // Missing/invalid protocol is not a preflight stop.
  if (!failed.length) return [];
  const entries = [{ bead: "main", tip: input.candidates.main }, ...input.candidates.candidates];
  if (entries.some(e => !sha.test(e.tip) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(e.bead)) || new Set(entries.map(e => e.bead)).size !== entries.length) {
    return failed.map(suite => `preflight attribution: ${suite} ERROR(invalid candidate inventory)`);
  }
  const lines: string[] = [];
  for (const suite of failed) {
    const results: string[] = [];
    for (const entry of entries) {
      let verdict: string;
      try { verdict = auditResult(await input.runAudit(entry.tip, suite), entry.tip, suite); }
      catch (error: any) { verdict = `ERROR(${reason(error?.message ?? error)})`; }
      results.push(`${entry.bead} ${entry.tip.slice(0, 12)}=${verdict}`);
    }
    lines.push(`preflight attribution: ${suite} ${results.join(" ")}`);
  }
  return lines;
}
