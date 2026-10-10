#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";

export interface JevOption { id: string; label: string }
export interface JevConfig { configured: boolean; why?: string; base?: string; key?: string }
export interface JevChoiceOk { ok: true; choice: string; confidence: number; probabilities: Record<string, number> }
export interface JevChoiceErr { ok: false; why: string }
export type JevChoice = JevChoiceOk | JevChoiceErr;

function root(): string { return path.resolve(process.env.WHEELHOUSE_JEV_ROOT || path.join(import.meta.dir, "..")); }
function cleanBase(s: string): string { return s.replace(/\/+$/, ""); }
function modeOf(file: string): number { return fs.statSync(file).mode & 0o777; }
function underRoot(file: string, r: string): boolean {
  const abs = path.resolve(file);
  const rr = path.resolve(r);
  return abs === rr || abs.startsWith(rr + path.sep);
}
function scrub(s: unknown, key?: string): string {
  let out = String(s instanceof Error ? (s.message || s.name) : s ?? "error");
  if (key) out = out.split(key).join("[redacted]");
  return out.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
}

export function jevConfig(env: NodeJS.ProcessEnv = process.env, installRoot = root()): JevConfig {
  const base = env.JEV_BASE_URL?.trim();
  if (!base) return { configured: false, why: "JEV_BASE_URL unset" };
  let key = env.JEV_API_KEY?.trim() ?? "";
  const keyFile = env.JEV_API_KEY_FILE?.trim() ?? "";
  if (!key && keyFile) {
    const file = path.resolve(keyFile.startsWith("~/") ? path.join(env.HOME ?? "", keyFile.slice(2)) : keyFile);
    if (underRoot(file, installRoot)) return { configured: false, why: "JEV_API_KEY_FILE under install root refused" };
    try {
      const mode = modeOf(file);
      if (mode !== 0o600) return { configured: false, why: "JEV_API_KEY_FILE must be mode 0600" };
      key = fs.readFileSync(file, "utf8").trim();
    } catch (e: any) { return { configured: false, why: `JEV_API_KEY_FILE unreadable: ${scrub(e)}` }; }
  }
  if (!key) return { configured: false, why: "JEV_API_KEY unset" };
  return { configured: true, base: cleanBase(base), key };
}

function validateProbabilities(v: any): Record<string, number> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v)) {
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1) return null;
    out[String(k)] = n;
  }
  return out;
}

async function postOnce(cfg: JevConfig & { configured: true }, body: any, timeoutMs: number): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error("timeout")), timeoutMs);
  try {
    return await fetch(`${cfg.base}/v1/systemone`, { method: "POST", headers: { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ac.signal });
  } finally { clearTimeout(t); }
}

export async function askChoice(input: { text: string; options: JevOption[]; context: any }, opts: { timeoutMs?: number } = {}): Promise<JevChoice> {
  const cfg = jevConfig();
  if (!cfg.configured) return { ok: false, why: cfg.why ?? "not configured" };
  const timeoutMs = opts.timeoutMs ?? Number(process.env.JEV_TIMEOUT_MS || 30_000);
  const options = [...input.options.filter((o) => o.id !== "other"), { id: "other", label: "other" }];
  if (options.length > 255) return { ok: false, why: "too many options" };
  const sent = new Set(options.map((o) => o.id));
  const body = { model: "jev-latest", state: input.context, questions: { "": { type: "choice", instructions: input.text, criteria: Object.fromEntries(options.map((o) => [o.id, o.label])) } } };
  let res: Response;
  try {
    res = await postOnce(cfg as JevConfig & { configured: true }, body, timeoutMs);
    if ((res.status === 429 || res.status === 529)) {
      const retry = Math.max(1, Math.min(8, Number(res.headers.get("retry-after") || 1)));
      await new Promise((resolve) => setTimeout(resolve, retry * 1000));
      res = await postOnce(cfg as JevConfig & { configured: true }, body, timeoutMs);
    }
  } catch (e: any) {
    const why = e?.name === "AbortError" || /timeout/i.test(String(e?.message ?? e)) ? "timeout" : scrub(e, cfg.key);
    return { ok: false, why };
  }
  if (!res.ok) return { ok: false, why: `http ${res.status}` };
  let json: any;
  try { json = await res.json(); } catch { return { ok: false, why: "malformed response" }; }
  const ans = json?.answers?.[""];
  if (!ans || ans.type !== "choice") return { ok: false, why: "malformed response" };
  const choice = String(ans.choice ?? "");
  const confidence = ans.confidence;
  const probabilities = validateProbabilities(ans.probabilities);
  if (!sent.has(choice)) return { ok: false, why: "unknown choice" };
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return { ok: false, why: "invalid confidence" };
  if (!probabilities) return { ok: false, why: "invalid probabilities" };
  return { ok: true, choice, confidence, probabilities };
}
