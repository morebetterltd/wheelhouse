// Lexical guard for inline Bun programs. Node snippets and code run from files
// are deliberately allowed. This is not a general shell/JavaScript interpreter:
// cover literal eval/print words, stdin heredocs/printf pipelines, runtime
// selectors, and the named template programs used by our spawnSync fixtures.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export type InlineProgram = { offset: number; code: string; mode: string };
const commonJS = /\brequire\s*\(|\bmodule\s*\./;

// Skip a command substitution inside a double-quoted shell word, including its
// own quotes. Do not mistake $(helper "$arg") for the end of the JS word.
function substitutionEnd(text: string, start: number): number {
  let depth = 1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "\\") { i++; continue; }
    if (text[i] === "'" || text[i] === '"') { i = quoted(text, i).end; continue; }
    if (text[i] === "(") depth++;
    else if (text[i] === ")") { if (--depth === 0) return i; }
  }
  throw Error("unterminated shell command substitution in Bun program");
}
function quoted(text: string, start: number, shell = true): { code: string; end: number } {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i++) {
    if ((!shell || quote !== "'") && text[i] === "\\") { i++; continue; }
    if (shell && quote === '"' && text.startsWith("$(", i)) { i = substitutionEnd(text, i + 2); continue; }
    if (text[i] === quote) return { code: text.slice(start + 1, i), end: i };
  }
  throw Error("unterminated quoted Bun program");
}

export function inlinePrograms(text: string): InlineProgram[] {
  const programs: InlineProgram[] = [];
  // $json_runtime selects Node or Bun in seat-env.sh. Treat it as Bun too.
  const calls = /(?:\bbun|["']?\$\{?json_runtime\}?["']?)\s+(?:\$\{json_runtime_flag:\+"\$json_runtime_flag"\}\s+)?(?:--(?:eval|print)|-[ep]|-)(?=\s|$)/g;
  for (const match of text.matchAll(calls)) {
    const offset = match.index!, mode = match[0].trim().split(/\s+/).at(-1)!;
    let at = offset + match[0].length;
    while (/[ \t]/.test(text[at] || "") && at < text.length) at++;
    if (mode !== "-") {
      if (text[at] === "'" || text[at] === '"') programs.push({ offset, code: quoted(text, at).code, mode });
      continue;
    }
    const headerEnd = text.indexOf("\n", at), end = headerEnd < 0 ? text.length : headerEnd;
    const header = text.slice(at, end), heredoc = /<<(-?)[ \t]*["']?(\w+)["']?/.exec(header);
    if (heredoc) {
      const rest = text.slice(end + 1), lines = rest.split("\n");
      const stop = lines.findIndex(line => (heredoc[1] ? line.replace(/^\t+/, "") : line) === heredoc[2]);
      if (stop < 0) throw Error("unterminated Bun stdin heredoc");
      programs.push({ offset, code: lines.slice(0, stop).join("\n"), mode });
    } else {
      const line = text.slice(text.lastIndexOf("\n", offset) + 1, offset);
      const input = /\b(?:printf\s+(?:(?:['"]%s['"]|%s)\s+)?|echo\s+)(['"])/.exec(line);
      if (input) programs.push({ offset, code: quoted(line, input.index + input[0].length - 1).code, mode });
    }
  }
  // Literal programs passed directly to Bun by the child_process APIs.
  const native = /(?:spawn(?:Sync)?|execFile(?:Sync)?)\(\s*(?:process\.execPath|["']bun["'])\s*,\s*\[\s*["']-(?:e|p)["']\s*,\s*(?=["'`])/g;
  for (const match of text.matchAll(native)) {
    programs.push({ offset: match.index!, code: quoted(text, match.index! + match[0].length, false).code, mode: "programmatic literal" });
  }
  // Native lock fixtures and adapter's shell log filter use named templates.
  // Inspect the source program, not spawnSync's or the shell's rendering.
  for (const match of text.matchAll(/\bconst\s+(\w+)\s*=\s*`([\s\S]*?)`\s*;/g)) {
    const name = match[1];
    const used = new RegExp(`(?:spawnSync|execFileSync)\\(\\s*(?:process\\.execPath|["']bun["'])\\s*,\\s*\\[\\s*["']-(?:e|p)["']\\s*,\\s*${name}\\b`).test(text);
    const shell = new RegExp(`process\\.execPath[^\\n]* -[ep] [^\\n]*\\$\\{${name}\\.replace`).test(text);
    if (used || shell) programs.push({ offset: match.index!, code: match[2], mode: used ? "programmatic eval" : "generated shell eval" });
  }
  return programs;
}

export function unsafeInline(text: string): InlineProgram[] {
  return inlinePrograms(text).filter(program => commonJS.test(program.code));
}

export function auditTracked(root: string): { files: number; programs: number; errors: string[] } {
  const listed = spawnSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8" });
  if (listed.error || listed.status !== 0) throw Error(`git ls-files failed: ${listed.error || listed.stderr}`);
  // Evidence is captured output, never executable template code. Exclude the
  // entire namespace, including future captures, before opening any files.
  const files = listed.stdout.split("\0").filter(file => file && !file.startsWith("evidence/"));
  if (!files.includes("seats/bun-inline.ts")) throw Error("wrong tracked tree: seats/bun-inline.ts is absent");
  let programs = 0;
  const errors: string[] = [];
  for (const file of files) {
    const full = path.join(root, file);
    if (!fs.statSync(full).isFile()) continue;
    const bytes = fs.readFileSync(full);
    if (bytes.includes(0)) continue;
    const text = bytes.toString("utf8");
    try {
      const found = inlinePrograms(text); programs += found.length;
      for (const program of found.filter(program => commonJS.test(program.code))) {
        const line = text.slice(0, program.offset).split("\n").length;
        errors.push(`${file}:${line}: CommonJS in Bun ${program.mode}; use ESM imports or a checked-in file`);
      }
    } catch (error) { errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return { files: files.length, programs, errors };
}

if (import.meta.main) {
  const result = auditTracked(path.resolve(process.argv[2] || path.join(import.meta.dir, "..")));
  for (const error of result.errors) console.error(error);
  console.log(`Bun inline guard: ${result.errors.length ? "FAIL" : "PASS"} (${result.files} tracked files, ${result.programs} programs)`);
  process.exitCode = result.errors.length ? 1 : 0;
}
