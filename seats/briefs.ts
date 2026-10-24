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

export type ContractSkillName = "intent" | "outcomes";
export function readContractSkill(root: string, name: ContractSkillName): { file: string; version: string; body: string } {
  const file = path.join(root, ".agents", "skills", name, "SKILL.md");
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (e: any) { throw new Error(`STOP: required producer skill ${file}: ${e.message}`); }
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  const versions = match?.[1].match(/^version:[ \t]*(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s]+)[ \t]*$/gm) ?? [];
  const names = match?.[1].match(/^name:[ \t]*(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s]+)[ \t]*$/gm) ?? [];
  const scalar = (line: string) => line.slice(line.indexOf(":") + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
  const version = versions.length === 1 ? scalar(versions[0]) : "";
  if (!match || names.length !== 1 || scalar(names[0]) !== name || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version) || !match[2].trim()) {
    throw new Error(`STOP: invalid producer skill name/version/body at ${file}`);
  }
  return { file, version, body: match[2] };
}

export function assembleBrief(root: string, role: string): string {
  const brief = fs.readFileSync(resolveRoleBrief(root, role), "utf8");
  if (role !== "producer") return brief;
  return brief + (["intent", "outcomes"] as const).map(name => {
    const skill = readContractSkill(root, name);
    return `\n\n# Skill: ${name} (version ${skill.version})\n\n${skill.body}`;
  }).join("");
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
