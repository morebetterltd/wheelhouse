import * as fs from "node:fs";
import * as path from "node:path";

export function hostBudgetConfigPath(root: string): string {
  return path.join(root, "seats", "host-budget.json");
}

export function hostBudgetEnabled(root: string): boolean {
  return fs.existsSync(hostBudgetConfigPath(root));
}

export interface HostBudgetConfig {
  enabled?: boolean;
  max_worktrees?: number;
  auto_prune?: boolean;
}

export const DEFAULT_MAX_WORKTREES = 24;

export function readHostBudgetConfig(root: string): HostBudgetConfig | null {
  const p = hostBudgetConfigPath(root);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return {}; }
}

export function hostBudgetPath(root: string, basePath = process.env.PATH ?? ""): string {
  if (!hostBudgetEnabled(root)) return basePath;
  return `${path.join(root, "seats", "bin")}${path.delimiter}${basePath}`;
}

export function hostBudgetMaxWorktrees(root: string): number | null {
  const cfg = readHostBudgetConfig(root);
  if (!cfg) return null;
  const n = Number(cfg.max_worktrees ?? DEFAULT_MAX_WORKTREES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_WORKTREES;
}

export function hostBudgetAutoPrune(root: string): boolean {
  return readHostBudgetConfig(root)?.auto_prune === true;
}
