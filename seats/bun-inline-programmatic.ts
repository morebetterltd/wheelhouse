// Bounded, non-evaluating JS/TS source inspection for child_process and Bun APIs.
// Resolve literal argv/options and transparent named bindings; do not execute
// templates, functions, split-string probe data, or other runtime computation.
import type { InlineProgram } from "./bun-inline";

type Token = { text: string; start: number; end: number; literal?: string };
type Range = [number, number];
type Value = { text?: string; array?: Value[]; object?: Map<string, Value>; alternatives?: Value[] };
const empty = (): Value => ({});
const families = new Set(["spawn", "spawnSync", "execFile", "execFileSync"]);
const decode = (s: string) => s.replace(/\\(\r?\n|x[\da-fA-F]{2}|u[\da-fA-F]{4}|[nrtbfv0\\'"`])/g, (_, c: string) => {
  if (c.startsWith("x") || c.startsWith("u")) return String.fromCharCode(parseInt(c.slice(1), 16));
  return ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" } as Record<string, string>)[c] ?? (c.includes("\n") ? "" : c);
});

function quoteEnd(s: string, start: number): number {
  const quote = s[start];
  for (let i = start + 1; i < s.length; i++) {
    if (s[i] === "\\") { i++; continue; }
    if (s[i] === quote) return i + 1;
    if (quote === "`" && s.startsWith("${", i)) {
      let depth = 1; i += 2;
      for (; i < s.length && depth; i++) {
        if (s[i] === "'" || s[i] === '"' || s[i] === "`") { i = quoteEnd(s, i) - 1; continue; }
        if (s[i] === "{") depth++;
        if (s[i] === "}") depth--;
      }
      i--;
    }
  }
  return s.length; // An unrelated shell fragment need not be valid JS.
}
function tokens(s: string): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < s.length;) {
    if (/\s/.test(s[i])) { i++; continue; }
    if (s.startsWith("//", i) || s[i] === "#") { const n = s.indexOf("\n", i); i = n < 0 ? s.length : n + 1; continue; }
    if (s.startsWith("/*", i)) { const n = s.indexOf("*/", i + 2); i = n < 0 ? s.length : n + 2; continue; }
    const start = i;
    if ("'\"`".includes(s[i])) {
      i = quoteEnd(s, i); out.push({ text: s.slice(start, i), start, end: i, literal: decode(s.slice(start + 1, i - 1)) }); continue;
    }
    // Regexes can themselves contain quotes, parentheses and source examples.
    const previous = out.at(-1)?.text;
    if (s[i] === "/" && (!previous || /^(?:[=(:,!\[{};?]|return|=>|&&|\|\|)$/.test(previous))) {
      i++; let bracket = false;
      for (; i < s.length; i++) {
        if (s[i] === "\\") { i++; continue; }
        if (s[i] === "[") bracket = true;
        if (s[i] === "]") bracket = false;
        if (s[i] === "/" && !bracket) { i++; while (/[a-z]/i.test(s[i] || "") && i < s.length) i++; break; }
        if (s[i] === "\n") break;
      }
      out.push({ text: "<regex>", start, end: i }); continue;
    }
    const word = /^[\w$]+/.exec(s.slice(i));
    if (word) i += word[0].length;
    else if (s.startsWith("...", i)) i += 3;
    else if (/^(?:=>|===|!==|==|!=|&&|\|\||\?\?)/.test(s.slice(i))) i += /^(?:=>|===|!==|==|!=|&&|\|\||\?\?)/.exec(s.slice(i))![0].length;
    else i++;
    out.push({ text: s.slice(start, i), start, end: i });
  }
  return out;
}

export function programmaticPrograms(source: string): InlineProgram[] {
  const t = tokens(source), ends = new Map<number, number>(), stack: number[] = [];
  const opening: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  for (let i = 0; i < t.length; i++) {
    if (opening[t[i].text]) stack.push(i);
    else if ([")", "]", "}"].includes(t[i].text) && stack.length && opening[t[stack.at(-1)!].text] === t[i].text) ends.set(stack.pop()!, i);
  }
  const split = (start: number, end: number, separator = ","): Range[] => {
    const parts: Range[] = []; let at = start;
    for (let i = start; i < end; i++) {
      if (ends.has(i) && ends.get(i)! < end) { i = ends.get(i)!; continue; }
      if (t[i].text === separator) { parts.push([at, i]); at = i + 1; }
    }
    if (at < end) parts.push([at, end]); return parts;
  };
  const scopes: number[] = [], until: number[] = [];
  for (let i = 0; i < t.length; i++) {
    if (scopes.at(-1) === i) scopes.pop();
    until[i] = scopes.at(-1) ?? t.length;
    if (t[i].text === "{" && ends.has(i)) scopes.push(ends.get(i)!);
  }
  const declarations: { name: string; value: Range; from: number; until: number }[] = [];
  for (let i = 0; i < t.length; i++) {
    if (!["const", "let", "var"].includes(t[i].text)) continue;
    let at = i + 1;
    while (at < t.length && /^[\w$]+$/.test(t[at].text)) {
      const name = t[at++].text;
      // Skip a simple TS type annotation before the initializer.
      if (t[at]?.text === ":") while (at < t.length && !["=", ";"].includes(t[at].text)) at++;
      if (t[at]?.text !== "=") break;
      const start = ++at;
      while (at < t.length && ![",", ";"].includes(t[at].text)) {
        if (ends.has(at)) at = ends.get(at)!;
        at++;
      }
      declarations.push({ name, value: [start, at], from: i, until: until[i] });
      if (t[at]?.text !== ",") break;
      at++;
    }
  }
  const choices = (v: Value): Value[] => v.alternatives ? v.alternatives.flatMap(choices) : [v];
  function value(range: Range, before: number, seen = new Set<string>()): Value {
    let [a, b] = range;
    while (t[a]?.text === "(" && ends.get(a) === b - 1) { a++; b--; }
    if (a >= b) return empty();
    if (b === a + 1 && t[a].literal !== undefined) return { text: t[a].literal };
    if (t.slice(a, b).map(x => x.text).join("") === "process.execPath") return { text: "bun" };
    if (b === a + 1 && /^[\w$]+$/.test(t[a].text)) {
      const name = t[a].text;
      if (seen.has(name)) return empty();
      const decl = declarations.filter(d => d.name === name && d.from < before && before < d.until).at(-1);
      if (!decl) return empty();
      return value(decl.value, decl.from, new Set([...seen, name]));
    }
    if (t[a].text === "[" && ends.get(a) === b - 1) {
      const array: Value[] = [];
      for (const r of split(a + 1, b - 1)) {
        if (t[r[0]]?.text === "...") array.push(...(value([r[0] + 1, r[1]], before, seen).array ?? [empty()]));
        else array.push(value(r, before, seen));
      }
      return { array };
    }
    if (t[a].text === "{" && ends.get(a) === b - 1) {
      const object = new Map<string, Value>();
      for (const [x, y] of split(a + 1, b - 1)) {
        if (t[x]?.text === "...") { for (const [k, v] of value([x + 1, y], before, seen).object ?? []) object.set(k, v); continue; }
        const key = t[x].literal ?? t[x].text;
        object.set(key, value([t[x + 1]?.text === ":" ? x + 2 : x, y], before, seen));
      }
      return { object };
    }
    // Branches are inspected as alternatives, never executed.
    for (let i = a; i < b; i++) {
      if (ends.has(i)) { i = ends.get(i)!; continue; }
      if (t[i].text !== "?") continue;
      let depth = 0;
      for (let j = i + 1; j < b; j++) {
        if (ends.has(j)) { j = ends.get(j)!; continue; }
        if (t[j].text === "?") depth++;
        if (t[j].text === ":" && depth-- === 0) return { alternatives: [value([i + 1, j], before, seen), value([j + 1, b], before, seen)] };
      }
    }
    // Buffer.from / new Blob / TextEncoder.encode wrap a literal payload.
    const wrapper = t.slice(a, Math.min(b, a + 5)).map(x => x.text).join("");
    if (/^(?:Buffer\.from\(|newBlob\(|newTextEncoder\(|TextEncoder\.)/.test(wrapper)) {
      const at = t.findIndex((x, i) => i >= a && i < b && x.text === "(");
      if (at >= 0 && ends.has(at)) return { alternatives: split(at + 1, ends.get(at)!).map(r => value(r, before, seen)) };
    }
    return empty();
  }
  function texts(v: Value): string[] {
    return choices(v).flatMap(x => x.text !== undefined ? [x.text] : x.array ? x.array.flatMap(texts) : []);
  }
  const programs: InlineProgram[] = [];
  // Imported child_process aliases are equivalent to their original names.
  const aliases = new Map<string, string>();
  for (let i = 0; i < t.length - 2; i++) if (families.has(t[i].text) && t[i + 1].text === "as") aliases.set(t[i + 2].text, t[i].text);
  for (let i = 0; i < t.length; i++) {
    if (!families.has(aliases.get(t[i].text) ?? t[i].text) || t[i + 1]?.text !== "(" || !ends.has(i + 1)) continue;
    const args = split(i + 2, ends.get(i + 1)!);
    const bunAPI = t[i - 1]?.text === "." && t[i - 2]?.text === "Bun";
    let commands: Value[], options: Value;
    if (bunAPI) {
      const first = value(args[0] ?? [0, 0], i);
      commands = choices(first).flatMap(x => choices(x.object?.get("cmd") ?? x));
      options = first.object ? first : value(args[1] ?? [0, 0], i);
    } else {
      const command = value(args[0] ?? [0, 0], i);
      if (!texts(command).some(x => /(?:^|\/)bun$/.test(x))) continue; // node -e is deliberately exempt.
      const second = value(args[1] ?? [0, 0], i);
      commands = second.object || args.length < 2 ? [{ array: [] }] : choices(second);
      options = second.object ? second : value(args[2] ?? [0, 0], i);
    }
    const add = (v: Value, mode: string) => { for (const code of new Set(texts(v))) programs.push({ offset: t[i].start, code, mode: `programmatic ${mode}` }); };
    for (const command of commands) {
      let argv = command.array;
      if (!argv) continue;
      if (bunAPI) {
        if (!texts(argv[0] ?? empty()).some(x => /(?:^|\/)bun$/.test(x))) continue;
        argv = argv.slice(1);
      }
      let stdin = argv.length === 0;
      for (let n = 0; n < argv.length; n++) {
        const arg = argv[n].text;
        if (["-e", "-p", "--eval", "--print"].includes(arg ?? "")) { add(argv[n + 1] ?? empty(), arg!); stdin = false; break; }
        if (arg?.startsWith("--eval=") || arg?.startsWith("--print=")) { add({ text: arg.slice(arg.indexOf("=") + 1) }, "eval/print"); break; }
        if (arg === "-") { stdin = true; break; }
        if (["--preload", "-r", "--cwd", "--env-file", "--loader"].includes(arg ?? "")) { n++; if (n === argv.length - 1) stdin = true; continue; }
        if (arg?.startsWith("-")) { if (n === argv.length - 1) stdin = true; continue; }
        // An entry file ends Bun's flags. A script's own '-e' is not eval.
        break;
      }
      if (!stdin) continue;
      for (const opt of choices(options)) {
        const input = opt.object?.get(bunAPI ? "stdin" : "input");
        if (input) for (const code of texts(input).filter(x => !["pipe", "inherit", "ignore"].includes(x))) add({ text: code }, "stdin");
      }
      const owner = declarations.filter(d => d.value[0] <= i && d.value[1] > i && d.from < i).at(-1);
      if (!owner) continue;
      for (let j = ends.get(i + 1)! + 1; j < owner.until; j++) {
        if (t[j].text !== owner.name || t[j + 1]?.text !== "." || t[j + 2]?.text !== "stdin" || t[j + 3]?.text !== "." || !["write", "end"].includes(t[j + 4]?.text) || t[j + 5]?.text !== "(" || !ends.has(j + 5)) continue;
        const written = split(j + 6, ends.get(j + 5)!)[0];
        if (written) for (const code of texts(value(written, j))) programs.push({ offset: t[j].start, code, mode: "programmatic stdin write" });
      }
    }
  }
  return programs;
}
