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

// The install root is supplied by the dispatcher, never inferred from a
// product repository, a detached worktree, or the word "container" in a brief.
export function scratchPromptLines(root: string, beadId: string): string[] {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(beadId)) throw new Error(`invalid scratch bead id: ${beadId}`);
  const installRoot = path.resolve(root);
  return [
    `Install root (WHEELHOUSE_ROOT): ${installRoot}`,
    `Scratch root for bead ${beadId}: ${path.join(installRoot, ".wheelhouse-runs", beadId)}${path.sep}`,
    `Put all ad-hoc builds, review output, simulator artifacts and other bead scratch under that exact scratch root. Use the supplied install root (WHEELHOUSE_ROOT); do not infer it from the install's parent, a selected product repository or your worktree.`,
  ];
}

export function workerDispatchPrompt(root: string, beadId: string, text: string): string {
  return [`Bead ${beadId}`, "", ...scratchPromptLines(root, beadId), "", text].join("\n");
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
