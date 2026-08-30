import * as fs from "node:fs";
import * as path from "node:path";

function installedBriefPath(root: string, role: string): string {
  const upper = role.toUpperCase();
  if (upper === "WORKER") return path.join(root, "wheelhouse", "fleet", "WORKER.md");
  return path.join(root, "wheelhouse", "crew", `${upper}.md`);
}

function templateBriefPath(root: string, role: string): string {
  return path.join(root, "contracts", `${role.toUpperCase()}.md`);
}

export function resolveRoleBrief(root: string, role: string): string {
  const installed = installedBriefPath(root, role);
  if (fs.existsSync(installed)) return installed;

  const template = templateBriefPath(root, role);
  if (fs.existsSync(template)) return template;

  throw new Error(
    `no crew brief for role "${role}" — tried installed layout ${installed} and template fallback ${template}`
  );
}
