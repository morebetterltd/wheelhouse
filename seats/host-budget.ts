import * as fs from "node:fs";
import * as path from "node:path";

export function hostBudgetConfigPath(root: string): string {
  return path.join(root, "seats", "host-budget.json");
}

export function hostBudgetEnabled(root: string): boolean {
  return fs.existsSync(hostBudgetConfigPath(root));
}

export function hostBudgetPath(root: string, basePath = process.env.PATH ?? ""): string {
  if (!hostBudgetEnabled(root)) return basePath;
  return `${path.join(root, "seats", "bin")}${path.delimiter}${basePath}`;
}
