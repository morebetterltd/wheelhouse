// Static dependency policy, not a general shell/JS interpreter. Inspect command
// positions, executable payloads and literal process APIs; ordinary quoted data
// is not execution. Unknown computed runtime commands are not evaluated here.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

type Token = { value: string; at: number; end?: number; kind: "word" | "string" | "op"; quote?: string };
export type Violation = { offset: number; why: string };
const interpreter = /^(?:python|pypy)(?:[0-9]+(?:\.[0-9]+)*)?(?:\.exe)?$/i;
const base = (word: string) => word.split("/").at(-1)!;
const python = (word: string) => interpreter.test(base(word));
const wrappers = new Set(["exec", "command", "builtin", "nohup", "nice", "sudo", "setsid", "timeout", "xargs", "if", "then", "do", "else", "elif", "while", "until", "!", "time"]);
const optionsWithValue = new Set(["-u", "-g", "-n", "-I", "-L", "-P", "-s", "--user", "--group", "--unset", "--chdir"]);

function commandWords(words: string[]): string[] {
  let at = 0;
  while (at < words.length) {
    if (/^[A-Za-z_][\w]*=/.test(words[at])) { at++; continue; }
    const name = base(words[at]);
    if (name !== "env" && !wrappers.has(name)) return words.slice(at);
    at++;
    while (at < words.length) {
      const word = words[at];
      if (name === "env" && (word === "-S" || word === "--split-string" || word.startsWith("-S") || word.startsWith("--split-string="))) {
        const value = word === "-S" || word === "--split-string" ? words[++at] ?? "" : word.startsWith("-S") ? word.slice(2) : word.slice(15);
        return commandWords([...shellTokens(value).tokens.filter(t => t.kind !== "op").map(t => t.value), ...words.slice(at + 1)]);
      }
      if (word === "--") { at++; break; }
      if (optionsWithValue.has(word)) { at += 2; continue; }
      if (word.startsWith("-") || /^[A-Za-z_][\w]*=/.test(word) || (name === "timeout" && /^\d/.test(word))) { at++; continue; }
      break;
    }
  }
  return [];
}

function decode(raw: string): string {
  return raw.replace(/\\(?:\r?\n|x([0-9a-fA-F]{2})|u([0-9a-fA-F]{4})|(.))/g, (_all, hex, unicode, other) => {
    if (hex || unicode) return String.fromCharCode(parseInt(hex || unicode, 16));
    return ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" } as any)[other] ?? other ?? "";
  });
}
function jsTokens(text: string): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < text.length;) {
    if (/\s/.test(text[i])) { i++; continue; }
    if (text.startsWith("//", i)) { const end = text.indexOf("\n", i); i = end < 0 ? text.length : end + 1; continue; }
    if (text.startsWith("/*", i)) { const end = text.indexOf("*/", i + 2); if (end < 0) throw Error("unterminated JS comment"); i = end + 2; continue; }
    const at = i, quote = text[i];
    if (quote === "'" || quote === '"' || quote === "`") {
      let raw = ""; i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\") { raw += text[i++]; if (i < text.length) raw += text[i++]; }
        else raw += text[i++];
      }
      if (i >= text.length) throw Error("unterminated JS string");
      i++; out.push({ value: decode(raw), at, kind: "string", quote }); continue;
    }
    if (text[i] === "/" && (!out.length || /^(?:=|\(|\[|\{|,|;|:|!|\?|return|=>)$/.test(out.at(-1)!.value))) {
      i++; let bracket = false;
      while (i < text.length) {
        if (text[i] === "\\") { i += 2; continue; }
        if (text[i] === "[") bracket = true;
        if (text[i] === "]") bracket = false;
        if (text[i++] === "/" && !bracket) break;
      }
      while (/[a-z]/i.test(text[i] ?? "") && i < text.length) i++;
      out.push({ value: "<regex>", at, kind: "word" }); continue;
    }
    const word = /^[A-Za-z_$][\w$]*|^\d[\w.]*/.exec(text.slice(i));
    if (word) { i += word[0].length; out.push({ value: word[0], at, kind: "word" }); }
    else { out.push({ value: text[i++], at, kind: "op" }); }
  }
  return out;
}
function argumentsAt(tokens: Token[], open: number, close: string): { args: Token[][]; end: number } {
  let depth = 0; const args: Token[][] = [[]];
  for (let i = open + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (depth === 0 && t.kind === "op" && t.value === close) return { args, end: i };
    if (t.kind === "op" && "([{}])".includes(t.value)) {
      if ("([{ ".trimEnd().includes(t.value)) depth++; else depth--;
    }
    if (depth === 0 && t.kind === "op" && t.value === ",") args.push([]); else args.at(-1)!.push(t);
  }
  throw Error("unterminated argument/array list");
}
function literal(tokens: Token[], values: Map<string, string>): string | undefined {
  if (!tokens.length) return undefined;
  if (tokens.map(t => t.value).join("") === "process.execPath") return "bun";
  let result = "", expectValue = true;
  for (const token of tokens) {
    if (!expectValue) { if (token.value !== "+") return undefined; expectValue = true; continue; }
    let value = token.kind === "string" ? token.value : values.get(token.value);
    if (value === undefined && /^\d/.test(token.value)) value = token.value;
    if (value === undefined) return undefined;
    value = value.replace(/\$\{(\w+)\}/g, (all, name) => values.get(name) ?? all);
    if (value.includes("${")) return undefined;
    result += value; expectValue = false;
  }
  return expectValue ? undefined : result;
}
function arrayLiteral(tokens: Token[], values: Map<string, string>, arrays = new Map<string, string[]>()): string[] | undefined {
  if (tokens.length === 1 && arrays.has(tokens[0].value)) return arrays.get(tokens[0].value);
  if (tokens[0]?.value !== "[") return undefined;
  const list = argumentsAt(tokens, 0, "]");
  return list.args.filter(a => a.length).map(a => literal(a, values) ?? "<computed>");
}

function shellTokens(text: string): { tokens: Token[]; substitutions: { code: string; at: number }[]; heredocs: { code: string; at: number; header: Token[]; quoted: boolean; tail: string }[] } {
  const tokens: Token[] = [], substitutions: { code: string; at: number }[] = [], heredocs: any[] = [];
  let header: Token[] = [], pending: { delimiter: string; tabs: boolean; quoted: boolean }[] = [];
  function substitution(at: number): number {
    let i = at + 2, depth = 1, quote = "";
    for (; i < text.length; i++) {
      if (text[i] === "\\") { i++; continue; }
      if (quote) { if (text[i] === quote) quote = ""; continue; }
      if (text[i] === "'" || text[i] === '"') { quote = text[i]; continue; }
      if (text[i] === "(") depth++;
      if (text[i] === ")" && --depth === 0) { substitutions.push({ code: text.slice(at + 2, i), at: at + 2 }); return i + 1; }
    }
    throw Error("unterminated command substitution");
  }
  function parameter(at: number): number {
    let depth = 1;
    for (let i = at + 2; i < text.length; i++) {
      if (text[i] === "\\") { i++; continue; }
      if (text.startsWith("$(", i)) { i = substitution(i) - 1; continue; }
      if (text.startsWith("${", i)) { depth++; i++; continue; }
      if (text[i] === "}" && --depth === 0) return i + 1;
    }
    throw Error("unterminated shell parameter");
  }
  for (let i = 0; i < text.length;) {
    if (text[i] === " " || text[i] === "\t" || text[i] === "\r") { i++; continue; }
    if (text[i] === "#") { const end = text.indexOf("\n", i); i = end < 0 ? text.length : end; continue; }
    if (text[i] === "\n") {
      tokens.push({ value: "\n", at: i++, kind: "op" });
      for (const here of pending) {
        const start = i; let end = i;
        for (;;) {
          end = text.indexOf("\n", i); if (end < 0) end = text.length;
          const line = text.slice(i, end), checked = here.tabs ? line.replace(/^\t+/, "") : line;
          if (checked === here.delimiter) break;
          if (end === text.length) throw Error("unterminated shell heredoc");
          i = end + 1;
        }
        heredocs.push({ code: text.slice(start, i), at: start, header: [...header], quoted: here.quoted, tail: text.slice(end + 1) });
        i = end < text.length ? end + 1 : end;
      }
      pending = []; header = []; continue;
    }
    const op = /^(?:<<<|<<-|<<|;;&|;;|;&|&&|\|\||>>|<>|[<>][&|]|[;&|(){}<>])/.exec(text.slice(i));
    if (op) {
      const token: Token = { value: op[0], at: i, kind: "op" }; tokens.push(token); header.push(token); i += op[0].length; continue;
    }
    const at = i; let value = "", quoted = false;
    while (i < text.length && !/[\s;&|(){}<>]/.test(text[i])) {
      const q = text[i];
      if (q === "\\") { i++; if (text[i] !== "\n" && i < text.length) value += text[i]; i++; continue; }
      if (text.startsWith("${", i)) { const end = parameter(i); value += text.slice(i, end); i = end; continue; }
      if (text.startsWith("$(", i)) { const end = substitution(i); value += text.slice(i, end); i = end; continue; }
      if (q === "`") { const end = text.indexOf("`", i + 1); if (end < 0) throw Error("unterminated backtick command"); substitutions.push({ code: text.slice(i + 1, end), at: i + 1 }); value += text.slice(i, end + 1); i = end + 1; continue; }
      if (q === "'" || q === '"') {
        const ansi = q === "'" && value.endsWith("$");
        if (ansi) value = value.slice(0, -1);
        let fragment = "";
        quoted = true; i++;
        while (i < text.length && text[i] !== q) {
          if (q === '"' && text.startsWith("${", i)) { const end = parameter(i); fragment += text.slice(i, end); i = end; continue; }
          if (q === '"' && text.startsWith("$(", i)) { const end = substitution(i); fragment += text.slice(i, end); i = end; continue; }
          if (q === '"' && text[i] === "`") { const end = text.indexOf("`", i + 1); if (end < 0) throw Error("unterminated backtick command"); substitutions.push({ code: text.slice(i + 1, end), at: i + 1 }); fragment += text.slice(i, end + 1); i = end + 1; continue; }
          if ((q === '"' || ansi) && text[i] === "\\") { if (ansi) fragment += "\\"; i++; if (i < text.length) fragment += text[i++]; }
          else fragment += text[i++];
        }
        if (i >= text.length) throw Error(`unterminated shell quote at offset ${at}`);
        value += ansi ? decode(fragment) : fragment;
        i++; continue;
      }
      value += text[i++];
    }
    if (i === at) { i++; continue; }
    const token: Token = { value, at, end: i, kind: "word", quote: quoted ? "quoted" : undefined };
    const previous = tokens.at(-1)?.value;
    if (previous === "<<" || previous === "<<-") pending.push({ delimiter: value, tabs: previous === "<<-", quoted });
    tokens.push(token); header.push(token);
  }
  return { tokens, substitutions, heredocs };
}

export function invocationViolations(text: string, file = "source.sh", isExecutableFile = false): Violation[] {
  const errors: Violation[] = [];
  function bad(offset: number, why: string) { if (!errors.some(e => e.offset === offset && e.why === why)) errors.push({ offset, why }); }
  function program(code: string, at: number) {
    const first = code.split("\n", 1)[0];
    if (first.startsWith("#!")) {
      const command = commandWords(shellTokens(first.slice(2)).tokens.map(t => t.value));
      if (command[0] && python(command[0])) { bad(at, "generated Python executable"); return; }
      if (/\b(?:node|bun)\b/.test(first)) { js(code.replace(/^#![^\n]*/, ""), at); return; }
    }
    shell(code, at);
  }
  function executable(words: string[], at: number) {
    const actual = commandWords(words); if (!actual.length) return;
    if (python(actual[0])) { bad(at, `Python command: ${actual[0]}`); return; }
    const name = base(actual[0]);
    if (name === "eval") shell(actual.slice(1).join(" "), at);
    else if (["bash", "sh", "zsh", "dash"].includes(name)) {
      const flag = actual.findIndex(w => /^-[a-z]*c/.test(w)); if (flag >= 0 && actual[flag + 1]) shell(actual[flag + 1], at);
    } else if (["bun", "node"].includes(name)) {
      const flag = actual.findIndex(w => /^(?:-[ep]|--eval|--print)$/.test(w)); if (flag >= 0 && actual[flag + 1]) js(actual[flag + 1], at);
    } else if (["awk", "perl", "ruby"].includes(name)) {
      for (const argument of actual.slice(1)) if (argument.includes("system") || argument.includes("exec")) js(argument, at);
    }
  }
  function shell(code: string, origin: number) {
    const parsed = shellTokens(code), values = new Map<string, string>();
    for (const sub of parsed.substitutions) shell(sub.code, origin + sub.at);
    let words: Token[] = [], redirect = false;
    const cases: string[] = [];
    function command() {
      while (words.length && ["if", "then", "do", "else", "elif", "while", "until", "!", "time"].includes(words[0].value)) words.shift();
      if (!words.length) return;
      const declaration = ["export", "local", "declare", "readonly"].includes(words[0].value);
      if (declaration) words.shift();
      const assignments = words.filter(t => /^[A-Za-z_]\w*=/.test(t.value));
      if (declaration || assignments.length === words.length) for (const t of assignments) { const at = t.value.indexOf("="); values.set(t.value.slice(0, at), t.value.slice(at + 1)); }
      if (declaration) return;
      const resolved = words.map(t => t.value.replace(/^\$\{?(\w+)\}?$/, (all, key) => values.get(key) ?? all));
      executable(resolved, origin + words[0].at);
    }
    for (let i = 0; i < parsed.tokens.length; i++) {
      const token = parsed.tokens[i];
      if (token.value === "esac" && cases.length) { cases.pop(); words = []; continue; }
      if (cases.at(-1) === "pattern") { if (token.kind === "op" && token.value === ")") cases[cases.length - 1] = "body"; continue; }
      if (token.kind !== "op" && token.value === "case" && !words.length) cases.push("header");
      if (token.kind !== "op" && token.value === "in" && cases.at(-1) === "header") { cases[cases.length - 1] = "pattern"; words = []; continue; }
      if (token.kind === "op" && [";;", ";&", ";;&"].includes(token.value)) { command(); words = []; if (cases.length) cases[cases.length - 1] = "pattern"; continue; }
      if (token.kind === "op" && /^(?:[<>]|>>|<>|[<>][&|]|<<<|<<-?)$/.test(token.value)) {
        if (/^\d+$/.test(words.at(-1)?.value ?? "") && words.at(-1)!.end === token.at) words.pop();
        redirect = true; continue;
      }
      if (token.kind === "op" && /^(?:\n|;|&|&&|\|\||\||\(|\)|\{|\})$/.test(token.value)) { command(); words = []; redirect = false; continue; }
      if (token.kind !== "op") {
        if (redirect) { redirect = false; continue; }
        if (!words.length && parsed.tokens[i + 1]?.value === "(" && parsed.tokens[i + 2]?.value === ")") continue;
        words.push(token);
      }
    }
    command();
    for (const here of parsed.heredocs) {
      const header = commandWords(here.header.filter(t => t.kind !== "op").map(t => t.value));
      if (header[0] && ["bun", "node"].includes(base(header[0]))) js(here.code, origin + here.at);
      else if (header[0] && ["sh", "bash", "zsh", "dash"].includes(base(header[0]))) shell(here.code, origin + here.at);
      else if (header[0] === "cat" && /^\s*chmod\s+[^\n]*(?:\+x|755|775|700)/.test(here.tail)) program(here.code, origin + here.at);
      else if (!here.quoted) {
        // Unquoted data heredocs still execute shell substitutions.
        for (const match of here.code.matchAll(/\$\(([^]*?)\)/g)) shell(match[1], origin + here.at + match.index! + 2);
      }
    }
  }
  function js(code: string, origin: number) {
    const tokens = jsTokens(code), scopes = [new Map<string, string>()], arrays = new Map<string, string[]>();
    const apis = new Map(["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "system", "writeFileSync"].map(name => [name, name]));
    const shellTags = new Set(["$"]);
    for (let i = 0; i < tokens.length - 2; i++) if (tokens[i + 1].value === "as") {
      if (apis.has(tokens[i].value)) apis.set(tokens[i + 2].value, apis.get(tokens[i].value)!);
      if (tokens[i].value === "$") shellTags.add(tokens[i + 2].value);
    }
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i], values = scopes.at(-1)!;
      if (token.kind === "op" && token.value === "{") scopes.push(new Map(values));
      if (token.kind === "op" && token.value === "}" && scopes.length > 1) scopes.pop();
      if (token.kind === "word" && tokens[i + 1]?.value === "=" && tokens[i - 1]?.value !== ".") {
        let end = i + 2, depth = 0;
        for (; end < tokens.length; end++) {
          const t = tokens[end];
          if (t.kind === "op" && depth === 0 && [";", ","].includes(t.value)) break;
          if (t.kind === "op" && "([{ ".trimEnd().includes(t.value)) depth++;
          if (t.kind === "op" && ")] }".replace(/ /g, "").includes(t.value)) { if (!depth) break; depth--; }
        }
        const expression = tokens.slice(i + 2, end), value = literal(expression, values), array = arrayLiteral(expression, values, arrays);
        if (value !== undefined) values.set(token.value, value);
        if (array !== undefined) arrays.set(token.value, array);
        if (expression.length === 1 && apis.has(expression[0].value)) apis.set(token.value, apis.get(expression[0].value)!);
      }
      if (token.kind === "string" && token.quote === "`") {
        if (shellTags.has(tokens[i - 1]?.value)) shell(token.value, origin + token.at);
        for (const part of token.value.matchAll(/\$\{([^]*?)\}/g)) js(part[1], origin + token.at);
      }
      if (tokens[i + 1]?.value !== "(") continue;
      const name = apis.get(token.value);
      if (!name) continue;
      // .exec on a RegExp is data matching, not child_process execution.
      if (name === "exec" && tokens[i - 1]?.value === "." && !["cp", "child_process", "childProcess", "process"].includes(tokens[i - 2]?.value)) continue;
      const { args } = argumentsAt(tokens, i + 1, ")");
      if (name === "writeFileSync") {
        const payload = literal(args[1] ?? [], values), opts = args[2] ?? [];
        const modeAt = opts.findIndex(t => t.value === "mode"), mode = opts[modeAt + 2];
        const permissions = modeAt >= 0 && mode ? mode.kind === "string" ? parseInt(mode.value, 8) : Number(mode.value) : 0;
        if (payload !== undefined && (permissions & 0o111)) program(payload, origin + token.at);
        continue;
      }
      const first = literal(args[0] ?? [], values);
      let array = arrayLiteral(args[0] ?? [], values, arrays);
      if (args[0]?.[0]?.value === "{") {
        const cmd = args[0].findIndex(t => t.value === "cmd");
        if (cmd >= 0) array = arrayLiteral(args[0].slice(cmd + (args[0][cmd + 1]?.value === ":" ? 2 : 0), args[0].length - 1), values, arrays);
      }
      if (["exec", "execSync", "system"].includes(name)) { if (first !== undefined) shell(first, origin + token.at); }
      else {
        const argv = arrayLiteral(args[1] ?? [], values, arrays) ?? [];
        if (array) executable(array, origin + token.at);
        else if (first !== undefined) executable([first, ...argv], origin + token.at);
      }
    }
  }
  const javascript = /\.(?:[cm]?[jt]s|tsx|jsx)$/i.test(file);
  // A data suffix is not an exclusion when the file declares code or is executable.
  if (/^#!/.test(text)) program(text, 0);
  else if (isExecutableFile && !javascript) shell(text, 0);
  else if (/\.(?:md|markdown)$/i.test(file)) {
    for (const block of text.matchAll(/^```(bash|sh|shell|console|js|javascript|ts|typescript)\s*\n([^]*?)^```/gm)) {
      const at = block.index! + block[0].indexOf("\n") + 1;
      if (/^(?:js|javascript|ts|typescript)$/.test(block[1])) js(block[2], at); else shell(block[2].replace(/^\$ /gm, ""), at);
    }
  } else if (path.basename(file) === "package.json") {
    const data = JSON.parse(text); for (const value of Object.values(data.scripts ?? {})) if (typeof value === "string") shell(value, 0);
  } else if (/\.(?:json|jsonl|txt|csv|ya?ml|svg|xml|plist|out|err|log|html|css)$/i.test(file)) {
    // Captures, messages and documents are data, not executable programs.
  } else if (javascript) js(text, 0);
  else shell(text, 0);
  return errors;
}

export function auditPythonCalls(root: string): { files: number; errors: string[]; incomplete: boolean } {
  root = fs.realpathSync(root);
  if (!fs.statSync(path.join(root, "seats")).isDirectory()) throw Error(`missing seats directory: ${root}`);
  const top = spawnSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (top.error || top.status !== 0 || fs.realpathSync(top.stdout.replace(/\r?\n$/, "")) !== root) throw Error(`wrong tracked root: ${top.error ?? (top.stderr || root)}`);
  const listed = spawnSync("git", ["-C", root, "ls-files", "-z", "--", "seats"], { encoding: "utf8" });
  if (listed.error || listed.status !== 0) throw Error(`git ls-files failed: ${listed.error ?? listed.stderr}`);
  const files = listed.stdout.split("\0").filter(Boolean);
  if (!files.length) throw Error("no tracked seats files to audit");
  const errors: string[] = []; let examined = 0, incomplete = false;
  function visit(relative: string, seen: Set<string>) {
    const full = path.join(root, relative), real = fs.realpathSync(full);
    if (seen.has(real)) throw Error(`linked source cycle: ${relative}`);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) { const next = new Set(seen); next.add(real); for (const child of fs.readdirSync(full)) visit(path.join(relative, child), next); return; }
    if (!stat.isFile()) throw Error(`not a regular tracked source: ${relative}`);
    const bytes = fs.readFileSync(full); examined++;
    if (bytes.includes(0)) return;
    const text = bytes.toString("utf8");
    // Both names matter: a tracked data-looking link can target a code file.
    for (const sourceName of new Set([relative, real])) for (const result of invocationViolations(text, sourceName, Boolean(stat.mode & 0o111))) {
      const line = text.slice(0, result.offset).split("\n").length;
      const message = `${relative}:${line}: forbidden Python invocation: ${result.why}`;
      if (!errors.includes(message)) errors.push(message);
    }
  }
  for (const file of files) {
    try { visit(file, new Set()); } catch (error: any) { incomplete = true; errors.push(`${file}: cannot audit tracked source: ${error.message}`); }
  }
  return { files: examined, errors, incomplete };
}
if (import.meta.main) {
  try {
    const result = auditPythonCalls(path.resolve(process.argv[2] ?? path.join(import.meta.dir, "..")));
    for (const error of result.errors) console.error(error);
    console.log(`Python invocation guard: ${result.errors.length ? "FAIL" : "PASS"} (${result.files} tracked files)`);
    process.exitCode = result.incomplete ? 2 : result.errors.length ? 1 : 0;
  } catch (error: any) { console.error(`Python invocation guard: cannot audit: ${error.message}`); process.exitCode = 2; }
}
