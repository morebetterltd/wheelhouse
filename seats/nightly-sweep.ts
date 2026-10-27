#!/usr/bin/env bun
// One scheduled full-tier pass, at the default line rather than the supervisor's
// checkout. Scratch/graph preparation, launch and teardown belong to verify.ts.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { expandTilde, runDispatcherFullSweep } from "./verify";
import { hostBudgetPath } from "./host-budget";
import { acquirePidLock, releasePidLock } from "./lock";
import { installReviewSignals } from "./verify-cancellation";
import { completedNightly, nightlyNow, nightlyPath, nightlySkipReason, readNightlyResult, recordNightlyMissed, writeNightlyJson, type NightlyResult } from "./nightly-state";

function sourceValue(root: string, key: string): string {
  try { return fs.readFileSync(path.join(root, "wheelhouse", ".template-source"), "utf8").split(/\r?\n/).filter(l => l.startsWith(key + "=")).at(-1)?.slice(key.length + 1).trim() ?? ""; }
  catch (e: any) { if (e.code === "ENOENT") return ""; throw e; }
}
function git(root: string, ...args: string[]): string {
  const env = { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete env[key];
  return execFileSync("git", ["--no-replace-objects", "-C", root, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
export function nightlyTarget(root: string): { repo: string; branch: string; tip: string } {
  const product = ["product-repo", "product-repos", "product_repo", "product_repos"].map(key => sourceValue(root, key)).find(Boolean)?.split(/[,;]/)[0].trim();
  const where = product ? path.resolve(root, expandTilde(product)) : root;
  const repo = git(where, "rev-parse", "--show-toplevel");
  const branch = sourceValue(root, "merge-target") || "main";
  git(repo, "check-ref-format", `refs/heads/${branch}`);
  let tip: string;
  try { tip = git(repo, "rev-parse", "--verify", `refs/heads/${branch}^{commit}`); }
  catch { tip = git(repo, "rev-parse", "--verify", `refs/remotes/origin/${branch}^{commit}`); }
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(tip)) throw new Error("default line did not resolve to one exact commit");
  return { repo, branch, tip };
}
function realBd(basePath: string): string {
  const named = process.env.WHEELHOUSE_REAL_BD;
  for (const file of named ? [named] : basePath.split(path.delimiter).map(dir => path.resolve(dir || ".", "bd"))) {
    try { if (fs.statSync(file).isFile()) { fs.accessSync(file, fs.constants.X_OK); return fs.realpathSync(file); } } catch {}
  }
  throw new Error("bd is required for isolated nightly scratch graphs");
}
function failedSuites(text: string, suites: readonly { suite: string }[]): string[] {
  const prefix = /^selftest-sweep: START (.+\/seats\/)[^/\n]+\.selftest\.sh$/m.exec(text)?.[1];
  if (!prefix) throw new Error("nightly log has no outer suite prefix");
  const lines = text.split("\n");
  return suites.filter(s => lines.some(l => l.startsWith(`selftest-sweep: FAIL ${prefix}${s.suite} `))).map(s => s.suite);
}
export async function nightlySweep(root: string): Promise<number> {
  const jobLock = path.join(root, "seats", "run", "nightly-sweep.lock");
  const fd = acquirePidLock(jobLock);
  if (fd === null) { recordNightlyMissed(root, "nightly job lock is busy or unverifiable"); return 75; }
  let finished = false, currentTip: string | undefined;
  const interrupted = (rc: number) => {
    if (!finished) recordNightlyMissed(root, `nightly sweep interrupted (exit ${rc})`, currentTip);
    releasePidLock(jobLock, fd);
  };
  // Reuse the dispatcher's owned-child/group shutdown before worktree removal.
  installReviewSignals();
  process.once("exit", interrupted);
  try {
    const skip = nightlySkipReason(root);
    if (skip) { recordNightlyMissed(root, skip); finished = true; console.log(`nightly sweep skipped: ${skip}`); return 75; }
    const target = nightlyTarget(root); currentTip = target.tip;
    const basePath = hostBudgetPath(root);
    // Explicitly test-only: the supervisor clears this before scheduled runs.
    // Map filenames into the detached checkout, never execute caller paths.
    const pattern = process.env.WHEELHOUSE_SELFTEST_SWEEP_PATTERN;
    const fixtureSuites = pattern ? pattern.trim().split(/\s+/).map(name => path.basename(name)) : undefined;
    const result = await runDispatcherFullSweep(target.repo, target.tip, realBd(basePath), basePath,
      { tier: "full", reason: "nightly" }, {
        logDir: path.join(root, "seats", "verdicts", "sweeps"), logPrefix: "nightly.",
        fixtureSuites, noWait: true, coordinatedSignals: true,
      });
    if (result.error || !result.logPath || !result.timings || (result.rc !== 0 && result.rc !== 1)) {
      const reason = result.error || `nightly runner did not complete (exit ${result.rc})`;
      recordNightlyMissed(root, reason, target.tip); finished = true;
      console.error(`nightly sweep missed: ${reason}`);
      return result.rc === 75 ? 75 : 2;
    }
    const expected = git(target.repo, "ls-tree", "-r", "-z", "--name-only", target.tip, "--", "seats").split("\0")
      .filter(name => /^seats\/[^/]+\.selftest\.sh$/.test(name)).map(name => path.basename(name)).sort();
    const actual = result.timings.suites.map(s => s.suite).sort();
    const filtered = expected.length !== actual.length || expected.some((name, i) => name !== actual[i]);
    const previous = filtered ? completedNightly(readNightlyResult(root).value) : null;
    const record: NightlyResult = { date: nightlyNow(), tip: target.tip, rc: result.rc,
      logPath: result.logPath, elapsedMs: result.elapsedMs, ...(filtered ? { filtered: true, ...(previous ? { lastCompleted: previous } : {}) } : {}),
      failedSuites: failedSuites(fs.readFileSync(result.logPath, "utf8"), result.timings.suites) };
    writeNightlyJson(nightlyPath(root), record); finished = true;
    console.log(JSON.stringify(record));
    return result.rc;
  } catch (e: any) {
    const reason = e instanceof Error ? e.message : String(e);
    recordNightlyMissed(root, reason, currentTip); finished = true;
    console.error(`nightly sweep missed: ${reason}`);
    return 2;
  } finally { process.removeListener("exit", interrupted); releasePidLock(jobLock, fd); }
}
if (import.meta.main) {
  const root = path.resolve(process.env.WHEELHOUSE_NIGHTLY_ROOT || path.join(import.meta.dir, ".."));
  if (process.argv.length > 2) { console.error("usage: nightly-sweep.ts"); process.exitCode = 2; }
  else process.exitCode = await nightlySweep(root);
}
