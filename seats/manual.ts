#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { parseContract, validateContract } from "./contract";

const ROOT = path.resolve(process.env.WHEELHOUSE_MANUAL_ROOT || path.join(import.meta.dir, ".."));
const COMPATIBILITY_SKILLS_DIRECTORY = ".claude/skills";
export const MANUAL_SECTIONS = ["Launch", "Doctor", "Drive", "Evidence", "Cleanup"] as const;
export const FEATURE_SECTIONS = ["What it is", "How to get to it", "How to drive it", "What proves it works"] as const;
export interface ManualFeature {
  slug: string;
  title: string;
  file: string;
  whatItIs: string;
  howToGetToIt: string;
  howToDriveIt: string;
  whatProvesItWorks: string;
}
export interface VerificationManual {
  repo: string;
  project: string;
  directory: string;
  file: string;
  version: string;
  description: string;
  surface: "none" | "runnable";
  sections: Record<string, string>;
  features: ManualFeature[];
}
export class ManualError extends Error {
  constructor(readonly file: string, readonly line: number, message: string) {
    super(`${file}:${line}: ${message}`);
  }
}
const fail = (file: string, line: number, message: string): never => { throw new ManualError(file, line, message); };
function textFile(file: string): string {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink()) return fail(file, 1, "expected a regular file, not a link or directory");
    return fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  } catch (e: any) { if (e instanceof ManualError) throw e; return fail(file, 1, `cannot read file: ${e.code ?? e.message}`); }
}
function directory(file: string) {
  try { const s = fs.lstatSync(file); if (s.isDirectory() && !s.isSymbolicLink()) return; }
  catch (e: any) { return fail(file, 1, `cannot read directory: ${e.code ?? e.message}`); }
  fail(file, 1, "expected a real directory");
}
// A deliberately small scalar frontmatter grammar, including quoted and block
// descriptions. Unsupported or duplicate fields fail rather than being guessed.
function frontmatter(lines: string[], file: string) {
  if (lines[0]?.trim() !== "---") fail(file, 1, "missing frontmatter opening ---");
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (end < 0) fail(file, 1, "missing frontmatter closing ---");
  const values: Record<string, string> = {}, locations: Record<string, number> = {};
  for (let i = 1; i < end; i++) {
    if (!lines[i].trim() || /^\s*#/.test(lines[i])) continue;
    const m = /^([a-zA-Z][\w-]*):\s*(.*?)\s*$/.exec(lines[i]);
    if (!m) fail(file, i + 1, "expected a scalar frontmatter field");
    const key = m[1]; let value = m[2];
    if (Object.hasOwn(values, key)) fail(file, i + 1, `duplicate frontmatter ${key}`);
    locations[key] = i + 1;
    if (/^[|>][-+]?$/.test(value)) {
      const folded = value[0] === ">", block: string[] = [];
      while (i + 1 < end && (/^\s+\S/.test(lines[i + 1]) || !lines[i + 1].trim())) block.push(lines[++i].replace(/^\s+/, ""));
      value = block.join(folded ? " " : "\n").trim();
    } else if (value.startsWith('"')) {
      try { value = JSON.parse(value); } catch { fail(file, i + 1, `invalid quoted ${key}`); }
      if (typeof value !== "string") fail(file, i + 1, `expected text for ${key}`);
    } else if (value.startsWith("'")) {
      if (!/^'(?:[^']|'')*'$/.test(value)) fail(file, i + 1, `invalid quoted ${key}`);
      value = value.slice(1, -1).replaceAll("''", "'");
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
      if (/^[\[{]/.test(value)) fail(file, i + 1, `expected scalar text for ${key}`);
    }
    values[key] = value;
  }
  return { values, locations, body: end + 1 };
}
// Structural headings/links only: fenced and commented examples cannot supply
// real sections or inventory entries. Keep original offsets for diagnostics.
function structural(lines: string[], start = 0): { text: string; line: number }[] {
  const rows: { text: string; line: number }[] = []; let comment = false, fence = "";
  for (let i = start; i < lines.length; i++) {
    let rest = lines[i], visible = "";
    while (rest) {
      if (comment) { const end = rest.indexOf("-->"); if (end < 0) { rest = ""; break; } rest = rest.slice(end + 3); comment = false; }
      const open = rest.indexOf("<!--");
      if (open < 0) { visible += rest; break; }
      visible += rest.slice(0, open); rest = rest.slice(open + 4); comment = true;
    }
    if (fence) { if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(visible)) fence = ""; continue; }
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(visible);
    if (opening) { fence = opening[1]; continue; }
    rows.push({ text: visible, line: i + 1 });
  }
  return rows;
}
function sections(lines: string[], file: string, required: readonly string[], start = 0): Record<string, string> {
  const headings = structural(lines, start).flatMap(row => {
    const m = /^ {0,3}##[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(row.text);
    return m ? [{ name: m[1].trim(), line: row.line }] : [];
  });
  const result: Record<string, string> = {};
  for (let i = 0; i < Math.max(required.length, headings.length); i++) {
    const found = headings[i], expected = required[i];
    if (!expected) fail(file, found.line, `unexpected ## ${found.name}`);
    if (!found || found.name !== expected) fail(file, found?.line ?? lines.length, `missing or out-of-order ## ${expected}`);
    const end = headings[i + 1]?.line ?? lines.length + 1;
    const body = lines.slice(found.line, end - 1).join("\n").trim();
    const substantive = body.replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*(?:`{3,}|~{3,}).*$/gm, "").trim();
    if (!substantive) fail(file, found.line, `empty ## ${expected}`);
    result[expected] = body;
  }
  return result;
}
function feature(file: string, slug: string): ManualFeature {
  const lines = textFile(file).split("\n"), titles = structural(lines).filter(row => /^ {0,3}#[ \t]+\S/.test(row.text));
  if (titles.length !== 1) fail(file, titles[1]?.line ?? 1, "expected one non-empty H1 feature title");
  const title = titles[0].text.replace(/^ {0,3}#[ \t]+/, "").replace(/[ \t]+#+[ \t]*$/, "").trim();
  const body = sections(lines, file, FEATURE_SECTIONS);
  return { slug, title, file, whatItIs: body[FEATURE_SECTIONS[0]], howToGetToIt: body[FEATURE_SECTIONS[1]], howToDriveIt: body[FEATURE_SECTIONS[2]], whatProvesItWorks: body[FEATURE_SECTIONS[3]] };
}
/** The single validated read model for CLI and later manual consumers. Read-only. */
export function readManual(repo = ROOT, project?: string): VerificationManual {
  repo = path.resolve(repo); const skills = path.join(repo, ".agents", "skills");
  if (project !== undefined && (!project || project === "." || project === ".." || /[\\/]/.test(project))) fail(skills, 1, "invalid --project name");
  let names: string[];
  try { names = fs.readdirSync(skills).filter(name => name.startsWith("verify-")).sort(); }
  catch (e: any) { if (e.code === "ENOENT") return fail(skills, 1, "no verification manual; run the create-verification skill"); return fail(skills, 1, `cannot list manuals: ${e.code ?? e.message}`); }
  const candidates = names.filter(name => {
    try { fs.lstatSync(path.join(skills, name, "SKILL.md")); return true; }
    catch (e: any) { if (e.code === "ENOENT") return false; return fail(path.join(skills, name), 1, `cannot inspect manual: ${e.code ?? e.message}`); }
  });
  if (project !== undefined) names = candidates.filter(name => name === "verify-" + project); else names = candidates;
  if (!names.length) fail(skills, 1, "no verification manual; run the create-verification skill");
  if (names.length !== 1) fail(skills, 1, "multiple verification manuals; select --project from " + names.map(s => s.slice(7)).join(", "));
  const name = names[0], dir = path.join(skills, name), file = path.join(dir, "SKILL.md"); directory(dir);
  if (name === "verify-") fail(file, 1, "manual directory needs a project name");
  const lines = textFile(file).split("\n"), fm = frontmatter(lines, file);
  for (const key of ["name", "description", "version"]) if (!fm.values[key]?.trim()) fail(file, fm.locations[key] ?? 1, `missing frontmatter ${key}`);
  if (fm.values.name !== name) fail(file, fm.locations.name, `frontmatter name must equal ${name}`);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(fm.values.version)) fail(file, fm.locations.version, "invalid frontmatter version");
  const surface = fm.values.surface === "none" ? "none" : "runnable";
  const body = surface === "none" ? {} : sections(lines, file, MANUAL_SECTIONS, fm.body);
  const map = path.join(dir, "features"), index = path.join(map, "README.md"); directory(map);
  const indexLines = textFile(index).split("\n"), links: { name: string; line: number }[] = [];
  for (const row of structural(indexLines)) {
    const visible = row.text.replace(/`+[^`]*`+/g, "");
    for (const match of visible.matchAll(/\[[^\]]+\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
      const href = match[1].split("#")[0];
      if (!href || /^(?:[a-z]+:|#)/i.test(href)) continue;
      const relative = href.replace(/^\.\//, "");
      if (relative === "README.md" || relative === "../SKILL.md") continue;
      if (!relative.endsWith(".md")) continue;
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(relative)) fail(index, row.line, "feature links must name a flat slug.md file");
      if (links.some(link => link.name === relative)) fail(index, row.line, `duplicate feature link ${relative}`);
      links.push({ name: relative, line: row.line });
    }
  }
  let files: string[];
  try { files = fs.readdirSync(map).filter(name => name.endsWith(".md") && name !== "README.md").sort(); }
  catch (e: any) { return fail(index, 1, `cannot list feature files: ${e.code ?? e.message}`); }
  for (const link of links) if (!files.includes(link.name)) fail(index, link.line, `listed feature file does not exist: ${link.name}`);
  for (const name of files) if (!links.some(link => link.name === name)) fail(index, 1, `feature file is not listed: ${name}`);
  const features = links.map(link => feature(path.join(map, link.name), link.name.slice(0, -3)));
  if (surface === "none" && features.length) fail(index, 1, "surface: none requires an empty feature map");
  const alias = path.join(repo, COMPATIBILITY_SKILLS_DIRECTORY, name);
  try {
    if (!fs.lstatSync(alias).isSymbolicLink()) fail(alias, 1, "compatibility entry must be a symlink");
    if (fs.realpathSync(alias) !== fs.realpathSync(dir)) fail(alias, 1, "compatibility symlink resolves to a different manual");
  } catch (e: any) { if (e instanceof ManualError) throw e; fail(alias, 1, `missing or dangling compatibility symlink: ${e.code ?? e.message}`); }
  return { repo, project: name.slice(7), directory: dir, file, version: fm.values.version, description: fm.values.description, surface, sections: body, features };
}
export function checkEvidence(manual: VerificationManual, slug: string, retention: string): string {
  if (!manual.features.some(feature => feature.slug === slug)) fail(manual.file, 1, `unknown feature ${slug}`);
  const dir = path.resolve(retention, slug); directory(dir);
  if (!fs.readdirSync(dir, { withFileTypes: true }).some(entry => entry.isFile())) fail(dir, 1, "no regular evidence file");
  return dir;
}
const LINT_USAGE = "usage: manual.ts lint-contract --file <contract> [--repo <path>] [--project <name>]; heuristic: literal product locator/reach and optional '; proof: <literal>' matching, not semantic change detection";
const normalized = (text: string) => text.replace(/`/g, "").replace(/\s+/g, " ").trim().toLowerCase();
function containsLiteral(text: string, literal: string): boolean {
  const haystack = normalized(text), needle = normalized(literal), token = /[a-z0-9_/#?&=.%:+-]/;
  if (!needle) return false;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
    if ((!at || !token.test(haystack[at - 1])) && (at + needle.length === haystack.length || !token.test(haystack[at + needle.length]))) return true;
  }
  return false;
}
function productReference(surface: string, manual: VerificationManual): { reach: string; slug: string; stem: string; proof?: string } | null {
  const [raw, proof] = surface.replace(/`/g, "").split(/;\s*proof:\s*/i);
  const value = raw.trim();
  if (proof !== undefined && !proof.trim()) throw new Error("surface: proof suffix needs a literal end state");
  let reach = "", stem = "", slug = "";
  const endpoint = /^(?:(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+)?(https?:\/\/\S+|\/\S*)$/i.exec(value);
  const token = /^(?:screen|command):\s*(\S.*)$/i.exec(value);
  if (endpoint) {
    const locator = /^https?:/i.test(endpoint[2]) ? new URL(endpoint[2]).pathname + new URL(endpoint[2]).search + new URL(endpoint[2]).hash : endpoint[2];
    reach = (endpoint[1] ? endpoint[1].toUpperCase() + " " : "") + locator;
    const pathname = locator.split(/[?#]/)[0]; stem = pathname.split("/").filter(Boolean)[0] ?? "home";
    slug = pathname === "/" ? "home" : pathname.replace(/^\/+|\/+$/g, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  } else if (token) { reach = token[1].trim(); slug = reach.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); stem = slug; }
  else if (manual.features.some(feature => feature.slug === value)) { reach = value; slug = value; stem = value; }
  else return null;
  return { reach, slug, stem, ...(proof !== undefined ? { proof: proof.trim() } : {}) };
}
export interface MapContractLint { expected: number; found: number; needed: string[]; provided: string[]; error: string | null }
/** Deterministic drafting lint only: use the validated map, never work-type labels
 * or a map outcome itself as evidence that a map change is needed. */
export function lintContract(text: string, manual: VerificationManual): MapContractLint {
  const parsed = parseContract(text), shape = validateContract(parsed);
  if (shape.length) throw new Error(shape[0]);
  const needed = new Map<string, string>(), provided: { slug: string; id: string; project?: string; validConsumer: boolean }[] = [];
  for (const outcome of parsed.outcomes) {
    const surface = outcome.surface.replace(/`/g, "").replace(/^\.\//, "");
    const map = /^(?:\.agents\/skills\/verify-([^/]+)\/)?features\/([^/\s]+)\.md$/.exec(surface);
    if (map) { provided.push({ slug: map[2], id: outcome.id, project: map[1], validConsumer: outcome.group === "machine" && outcome.checkKind === "run" }); continue; }
    // Relative factory/source files are not product locators. Consumer group
    // alone must never suppress a named product route, screen or command.
    const reference = productReference(surface, manual); if (!reference) continue;
    const covering = manual.features.find(feature => containsLiteral(feature.howToGetToIt, reference.reach));
    const feature = covering ?? manual.features.find(feature => feature.slug === reference.stem);
    const covered = covering !== undefined;
    const proofChanged = reference.proof !== undefined && (!feature || !containsLiteral(feature.whatProvesItWorks, reference.proof));
    const requiresMap = !covered || proofChanged;
    if (requiresMap) needed.set(feature?.slug ?? reference.slug, `${outcome.id}: ${outcome.surface}`);
  }
  let error: string | null = null; const seen = new Set<string>();
  for (const map of provided) {
    if (map.project !== undefined && map.project !== manual.project) { error = `${map.id}: map outcome names another manual ${map.project}`; break; }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(map.slug)) { error = `${map.id}: map outcome needs a flat feature slug`; break; }
    if (!map.validConsumer) { error = `${map.id}: map outcome requires machine consumer and run check`; break; }
    if (seen.has(map.slug)) { error = `${map.id}: duplicate map outcome ${map.slug}`; break; }
    seen.add(map.slug);
    if (!needed.has(map.slug)) { error = `${map.id}: map outcome ${map.slug} is not needed by any other outcome's product surface`; break; }
  }
  if (!error) for (const [slug, surface] of needed) if (!seen.has(slug)) { error = `${surface}: missing map outcome for ${slug}`; break; }
  // A surface: none declaration owes a real manual at its first product
  // surface, not only a map entry. Artifact-only work still owes neither.
  const needsManualSections = manual.surface === "none" && needed.size > 0;
  const hasManualSections = parsed.outcomes.some(outcome =>
    outcome.surface.replace(/`/g, "").replace(/^\.\//, "") === `.agents/skills/verify-${manual.project}/SKILL.md` &&
    outcome.group === "machine" && outcome.checkKind === "run" &&
    MANUAL_SECTIONS.every(section => containsLiteral(outcome.claim, section)));
  if (!error && needsManualSections && !hasManualSections) error = `missing manual-sections outcome for ${manual.project}: require ${MANUAL_SECTIONS.join(", ")} at .agents/skills/verify-${manual.project}/SKILL.md`;
  return { expected: needed.size, found: provided.length, needed: [...needed.keys()], provided: provided.map(map => map.slug), error };
}
function main(args: string[]): number {
  const [command, ...rest] = args; let repo = ROOT, project: string | undefined, dir: string | undefined, file: string | undefined, json = false;
  const positional: string[] = [], seen = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (["--repo", "--project", "--dir", "--file", "--json"].includes(arg)) {
      if (seen.has(arg)) throw new Error(`duplicate ${arg}`); seen.add(arg);
      if (arg === "--json") { json = true; continue; }
      const value = rest[++i]; if (!value || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
      if (arg === "--repo") repo = path.resolve(value); else if (arg === "--project") project = value; else if (arg === "--dir") dir = value; else file = value;
    } else if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`); else positional.push(arg);
  }
  if (command === "lint-contract") {
    if (!file || positional.length || json || dir) throw new Error(LINT_USAGE);
    const result = lintContract(textFile(path.resolve(file)), readManual(repo, project));
    console.log(`map outcomes: expected ${result.expected}, found ${result.found}`);
    if (result.error) { console.error(`${file}: ${result.error}`); return 2; }
    return 0;
  }
  if (!["check", "features", "evidence"].includes(command) || file || (json && command !== "features") || (dir && command !== "evidence") || positional.length !== (command === "evidence" ? 1 : 0) || (command === "evidence" && !dir)) throw new Error(`usage: manual.ts check|features [--repo <path>] [--project <name>] [--json]; evidence <feature> --dir <path>; ${LINT_USAGE}`);
  const manual = readManual(repo, project);
  if (command === "check") console.log(manual.surface === "none" ? "manual ok: no surface" : `manual ok: ${manual.features.length} features`);
  else if (command === "features") console.log(json ? JSON.stringify(manual.features) : manual.features.map(feature => `${feature.slug}\t${feature.title}\n${feature.howToGetToIt}\n${feature.whatProvesItWorks}`).join("\n\n"));
  else console.log(`evidence ok: ${checkEvidence(manual, positional[0], dir!)}`);
  return 0;
}
if (import.meta.main) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (e: any) { console.error(e.message ?? String(e)); process.exitCode = 2; }
}
