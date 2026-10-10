#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";
import { HARNESS_VALUES } from "./harness";
import { CREDENTIAL_SHAPE_RE } from "./credential-shapes";

export interface PoolAccount { dir: string; label?: string; authRoute?: "oauth" | "api_key" | "env" }
export interface PoolEntry { harness: "pi" | "claude-code" | "codex"; provider: string; models: string[]; account: PoolAccount; allowedTools?: string; disallowedTools?: string; skills?: string[] }
export interface PoolRole { min: number; max: number; entries: string[]; model: string | Record<string, string> }
export interface Pool { version: 1; entries: Record<string, PoolEntry>; roles: { workers?: PoolRole; reviewers?: PoolRole }; idle_drop_minutes?: number; check_interval_seconds?: number; root: string }
export interface SeatEntry { role: string; harness?: string; provider?: string; model?: string; account?: { dir: string; label?: string; authRoute?: string }; allowedTools?: string; disallowedTools?: string; skills?: string[] }

export class PoolError extends Error { constructor(message: string) { super(message); } }
function stop(reason: string, fix: string): never { throw new PoolError(`STOP: seats/pool.json: ${reason} — fix: ${fix}`); }
export function poolPath(root: string): string { return path.join(root, "seats", "pool.json"); }
export function hasPool(root: string): boolean { return fs.existsSync(poolPath(root)); }
function expandTilde(p: string): string { return p === "~" ? (process.env.HOME ?? p) : p.startsWith("~/") ? path.join(process.env.HOME ?? "", p.slice(2)) : p; }
function namespace(root: string): string { try { const m = fs.readFileSync(path.join(root, "wheelhouse", ".template-source"), "utf8").match(/^namespace=(.+)$/m); if (m?.[1]?.trim()) return m[1].trim(); } catch {} return path.basename(root).replace(/-[a-z0-9]{3,4}$/i, ""); }
function checkKeys(obj: any, allowed: string[], where: string) { for (const k of Object.keys(obj ?? {})) if (!allowed.includes(k)) stop(`unknown key ${where}.${k}`, `remove ${where}.${k} or teach pool.ts that field`); }
function allStrings(o: any, prefix = ""): [string, string][] { if (typeof o === "string") return [[prefix, o]]; if (Array.isArray(o)) return o.flatMap((v, i) => allStrings(v, `${prefix}[${i}]`)); if (o && typeof o === "object") return Object.entries(o).flatMap(([k, v]) => allStrings(v, prefix ? `${prefix}.${k}` : k)); return []; }
function readFixedRoster(root: string): Record<string, SeatEntry> { try { return JSON.parse(fs.readFileSync(path.join(root, "seats", "seats.json"), "utf8")).seats ?? {}; } catch { return {}; } }
function real(p: string): string { return fs.realpathSync(p); }
function commandDirs(): string[] { const home = process.env.HOME ?? ""; return [process.env.CLAUDE_CONFIG_DIR ?? "", path.join(home, ".claude"), path.join(home, ".pi", "agent"), path.join(home, ".codex")].filter(Boolean).map((p) => { try { return real(p); } catch { return path.resolve(p); } }); }
function roleModel(role: PoolRole, entryName: string): string { return typeof role.model === "string" ? role.model : role.model[entryName]; }
export function roleRosterName(role: "workers" | "reviewers"): "worker" | "verifier" { return role === "workers" ? "worker" : "verifier"; }
export function staffedSeatName(role: "workers" | "reviewers", entry: string): string { return `${roleRosterName(role)}-${entry}`; }

export function loadPool(root: string): Pool {
  const file = poolPath(root);
  let raw: any;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e: any) { stop(`cannot read ${file}`, "write seats/pool.json or remove it for fixed roster mode"); }
  checkKeys(raw, ["version", "entries", "roles", "idle_drop_minutes", "check_interval_seconds"], "top level");
  if (raw.version !== 1) stop("version must be 1", "set version to 1");
  if (!raw.entries || typeof raw.entries !== "object" || Array.isArray(raw.entries)) stop("entries must be an object", "add entries keyed by subscription name");
  if (!raw.roles || typeof raw.roles !== "object" || Array.isArray(raw.roles)) stop("roles must be an object", "add roles.workers and/or roles.reviewers");
  checkKeys(raw.roles, ["workers", "reviewers"], "roles");
  for (const [key, value] of allStrings(raw)) if (new RegExp(CREDENTIAL_SHAPE_RE).test(value)) stop(`credential-shaped value at ${key}`, `remove the secret from ${key} and keep credentials in login dirs or env`);
  const ns = namespace(root), home = process.env.HOME ?? "";
  const nsRoot = path.join(home, `.pi-seats-${ns}`);
  const entries: Record<string, PoolEntry> = {};
  const seenDirs = new Map<string, string>();
  const commanderDirs = new Set(commandDirs());
  const fixed = readFixedRoster(root);
  for (const [name, e] of Object.entries<any>(raw.entries)) {
    if (!/^[a-z0-9-]+$/.test(name)) stop(`entry name ${name} is invalid`, "use lowercase letters, digits and hyphens only");
    checkKeys(e, ["harness", "provider", "models", "account", "allowedTools", "disallowedTools", "skills"], `entries.${name}`);
    if (!HARNESS_VALUES.includes(e.harness)) stop(`entries.${name}.harness is unknown`, `use one of ${HARNESS_VALUES.join(", ")}`);
    if (typeof e.provider !== "string" || e.provider.length === 0) stop(`entries.${name}.provider is empty`, "set a provider id");
    if (!Array.isArray(e.models) || e.models.length === 0 || e.models.some((m: any) => typeof m !== "string" || !m)) stop(`entries.${name}.models is invalid`, "list at least one model string");
    if (!e.account || typeof e.account !== "object" || Array.isArray(e.account)) stop(`entries.${name}.account is missing`, "set account.dir under the namespace root");
    checkKeys(e.account, ["dir", "label", "authRoute"], `entries.${name}.account`);
    if (e.account.authRoute === "default") stop(`entries.${name}.account.authRoute default is not allowed`, "use oauth, api_key, or env");
    if (!["oauth", "api_key", "env"].includes(e.account.authRoute)) stop(`entries.${name}.account.authRoute is invalid`, "use oauth, api_key, or env");
    const dir = expandTilde(String(e.account.dir ?? ""));
    if (!dir || !fs.existsSync(dir)) stop(`login folder for entry ${name} is missing`, `run seats/seat-env.sh ${ns} --pool ${name} and log in`);
    const rdir = real(dir);
    if (commanderDirs.has(rdir)) stop(`entry ${name} uses the commander login folder`, "create a separate pool login");
    let rns = ""; try { rns = real(nsRoot); } catch { rns = path.resolve(nsRoot); }
    if (!(rdir === rns || rdir.startsWith(rns + path.sep))) stop(`entry ${name} login folder is outside namespace root`, `put it under ${nsRoot}`);
    if (seenDirs.has(rdir)) stop(`entries ${seenDirs.get(rdir)} and ${name} share a login folder`, "give every pool entry its own account.dir");
    seenDirs.set(rdir, name);
    for (const [seat, s] of Object.entries(fixed)) if (!s.external && s.account?.dir) {
      let fixedDir: string | null = null;
      try { fixedDir = real(expandTilde(s.account.dir)); } catch {}
      if (fixedDir === rdir) stop(`entry ${name} shares a login with roster seat ${seat}`, "move one account.dir so every seat is distinct");
    }
    entries[name] = { harness: e.harness, provider: e.provider, models: e.models, account: e.account, allowedTools: e.allowedTools, disallowedTools: e.disallowedTools, skills: e.skills };
  }
  const roles: Pool["roles"] = {};
  for (const roleName of ["workers", "reviewers"] as const) if (raw.roles[roleName] !== undefined) {
    const r = raw.roles[roleName];
    checkKeys(r, ["min", "max", "entries", "model"], `roles.${roleName}`);
    if (!Number.isInteger(r.min) || !Number.isInteger(r.max) || r.min < 0 || r.max < 1 || r.min > r.max) stop(`roles.${roleName} min/max is invalid`, "use integers with 0 <= min <= max and max >= 1");
    if (!Array.isArray(r.entries) || r.entries.some((e: any) => typeof e !== "string" || !entries[e])) stop(`roles.${roleName}.entries names an unknown entry`, "list only entries declared under entries");
    if (r.max > r.entries.length) stop(`roles.${roleName}.max exceeds subscription count`, "lower max or add entries");
    if (typeof r.model === "object" && !Array.isArray(r.model)) { for (const e of r.entries) if (typeof r.model[e] !== "string") stop(`roles.${roleName}.model is missing ${e}`, "provide a model for every listed entry"); }
    else if (typeof r.model !== "string") stop(`roles.${roleName}.model is invalid`, "use a model string or an object keyed by entry");
    for (const e of r.entries) { const m = typeof r.model === "string" ? r.model : r.model[e]; if (!entries[e].models.includes(m)) stop(`roles.${roleName}.model for ${e} is not offered`, "choose one of that entry's models"); }
    roles[roleName] = { min: r.min, max: r.max, entries: r.entries, model: r.model };
  }
  return { version: 1, entries, roles, idle_drop_minutes: raw.idle_drop_minutes, check_interval_seconds: raw.check_interval_seconds, root };
}

export function seatEntryFor(pool: Pool, role: "workers" | "reviewers", entryName: string): SeatEntry {
  const entry = pool.entries[entryName]; const roleDef = pool.roles[role];
  if (!entry || !roleDef) throw new PoolError(`STOP: seats/pool.json: staffing entry ${entryName} for ${role} is not in the pool — fix: update seats/staffing.json or seats/pool.json`);
  const model = roleModel(roleDef, entryName);
  return { role: roleRosterName(role), harness: entry.harness, provider: entry.provider, model, account: entry.account, allowedTools: entry.allowedTools, disallowedTools: entry.disallowedTools, skills: entry.skills };
}

function collapseHome(p: string): string { const h = process.env.HOME; return h && p.startsWith(h + path.sep) ? `~/${p.slice(h.length + 1)}` : p; }
function publicPool(pool: Pool): any { const p: any = { ...pool, root: undefined }; for (const e of Object.values<any>(p.entries)) if (e.account?.dir) e.account.dir = collapseHome(e.account.dir); return p; }

if (import.meta.main) {
  const root = path.resolve(path.join(import.meta.dir, ".."));
  const cmd = process.argv[2] ?? "check";
  try {
    if (!hasPool(root)) { console.log(cmd === "show" ? JSON.stringify({ pool: null }, null, 2) : "pool: none (fixed roster)"); process.exit(0); }
    const pool = loadPool(root);
    if (cmd === "show") console.log(JSON.stringify(publicPool(pool), null, 2));
    else if (cmd === "check") console.log(`pool: ${Object.keys(pool.entries).length} entries, workers ${pool.roles.workers?.min ?? 0}..${pool.roles.workers?.max ?? 0} (${pool.roles.workers?.entries.length ?? 0} entries), reviewers ${pool.roles.reviewers?.min ?? 0}..${pool.roles.reviewers?.max ?? 0} (${pool.roles.reviewers?.entries.length ?? 0} entries)`);
    else { console.error("usage: pool.ts check|show"); process.exit(2); }
  } catch (e: any) { if (e instanceof PoolError) { console.error(e.message); process.exit(2); } throw e; }
}
