#!/usr/bin/env bun
/** Durable signal data. Only this module writes intake.jsonl; no text is interpreted. */
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { CREDENTIAL_SHAPE_RE } from "./credential-shapes";
import { acquirePidLock, releasePidLock } from "./lock";

const ROOT = path.resolve(process.env.WHEELHOUSE_INTAKE_ROOT || path.join(import.meta.dir, ".."));
const LEDGER = path.join(ROOT, "seats", "intake.jsonl");
const LOCK = path.join(ROOT, "seats", "run", "intake.lock");
// CLI busy-reporting policy; never expires an owner's lock or starts a write.
const INTAKE_BUSY_REPORT_MS = 5000;
export const INTAKE_KINDS = ["goal", "isa-change", "report", "error", "finding"] as const;
export type IntakeKind = typeof INTAKE_KINDS[number];
export type Posted = { type: "posted"; id: string; at: string; kind: IntakeKind; source: string; title: string; text: string; ref?: string };
export type Disposed = { type: "disposed"; id: string; at: string; disposition: "produced" | "parked" | "dropped"; work?: string; reason?: string; revive?: string; by: string };
export type IntakeEvent = Posted | Disposed;
export interface IntakeRow { id: string; posted: Posted; disposition: Disposed | null }
const credential = new RegExp(CREDENTIAL_SHAPE_RE);
function refuse(message: string): never { throw new Error(message); }
function guard(field: string, value: string): string {
  if (credential.test(value)) refuse(`credential-shaped string in ${field}`);
  return value;
}
export function readEvents(): IntakeEvent[] {
  if (!fs.existsSync(LEDGER)) return [];
  return fs.readFileSync(LEDGER, "utf8").split("\n").filter(Boolean).map((line, i) => {
    let ev: any;
    try { ev = JSON.parse(line); } catch { refuse(`invalid intake JSON at line ${i + 1}`); }
    if (!ev || !["posted", "disposed"].includes(ev.type) || typeof ev.id !== "string") refuse(`invalid intake event at line ${i + 1}`);
    return ev;
  });
}
export function fold(events = readEvents()): Map<string, IntakeRow> {
  const rows = new Map<string, IntakeRow>();
  for (const ev of events) {
    if (ev.type === "posted") {
      if (rows.has(ev.id)) refuse("duplicate posted id in intake ledger");
      rows.set(ev.id, { id: ev.id, posted: ev, disposition: null });
    } else {
      const row = rows.get(ev.id);
      if (!row || row.disposition) refuse("invalid disposition history in intake ledger");
      row.disposition = ev;
    }
  }
  return rows;
}
function append(ev: IntakeEvent): void {
  const fd = fs.openSync(LEDGER, "a", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(ev) + "\n");
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}
function write<T>(action: () => T): T {
  let fd: number | null = null;
  const until = performance.now() + INTAKE_BUSY_REPORT_MS;
  while ((fd = acquirePidLock(LOCK)) === null) {
    if (performance.now() >= until) refuse(`intake writer busy; retry; last observation: acquisition refused at ${LOCK}; no write started and owner left untouched`);
    Bun.sleepSync(10);
  }
  try { return action(); } finally { releasePidLock(LOCK, fd); }
}
function args(argv: string[], values: string[], switches: string[] = []) {
  const pos: string[] = [], flags: Record<string, string> = {}, bools = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { pos.push(a); continue; }
    const k = a.slice(2);
    if (k in flags || bools.has(k)) refuse("duplicate option");
    if (switches.includes(k)) { bools.add(k); continue; }
    if (!values.includes(k)) refuse("unknown option");
    const v = argv[++i];
    if (v === undefined) refuse(`--${k} requires a value`);
    flags[k] = guard(k, v);
  }
  return { pos, flags, bools };
}
function required(flags: Record<string, string>, name: string): string {
  const value = flags[name];
  if (!value?.trim()) refuse(`requires --${name}`);
  return value;
}
function bodyFromStdin(): string {
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(0, buf, 0, buf.length, null);
    if (!n) break;
    size += n;
    if (size > 64 * 1024) refuse("text exceeds 64 KB");
    chunks.push(buf.subarray(0, n));
  }
  return Buffer.concat(chunks).toString("utf8");
}
function post(argv: string[]): void {
  const { pos, flags, bools } = args(argv, ["kind", "source", "title", "text", "ref"], ["from-stdin"]);
  if (pos.length) refuse("post takes options only");
  const kind = required(flags, "kind");
  if (!(INTAKE_KINDS as readonly string[]).includes(kind)) refuse(`kind must be ${INTAKE_KINDS.join(", ")}`);
  const source = required(flags, "source"), title = required(flags, "title");
  if (/[\r\n]/.test(title)) refuse("title must be one line");
  if (bools.has("from-stdin") && flags.text !== undefined) refuse("use --text or --from-stdin, not both");
  const text = guard("text", bools.has("from-stdin") ? bodyFromStdin() : flags.text ?? "");
  if (Buffer.byteLength(text) > 64 * 1024) refuse("text exceeds 64 KB");
  const id = write(() => {
    const used = fold();
    let id: string;
    do { id = `sig-${crypto.randomInt(36 ** 4).toString(36).padStart(4, "0")}`; } while (used.has(id));
    const ev: Posted = { type: "posted", id, at: new Date().toISOString(), kind: kind as IntakeKind, source, title, text };
    if (flags.ref !== undefined) ev.ref = flags.ref;
    append(ev);
    return id;
  });
  console.log(id);
}
function dispose(argv: string[]): void {
  const { pos, flags } = args(argv, ["work", "reason", "revive"]);
  if (pos.length !== 2) refuse("usage: dispose <id> produced|parked|dropped [options]");
  const id = guard("id", pos[0]), disposition = guard("disposition", pos[1]);
  if (!["produced", "parked", "dropped"].includes(disposition)) refuse("disposition must be produced, parked, dropped");
  const fields: Partial<Disposed> = {};
  if (disposition === "produced") fields.work = required(flags, "work");
  if (disposition === "parked" || disposition === "dropped") fields.reason = required(flags, "reason");
  if (disposition === "parked") fields.revive = required(flags, "revive");
  const by = guard("by", process.env.BEADS_ACTOR || process.env.USER || "unknown");
  write(() => {
    const row = fold().get(id);
    if (!row) refuse("unknown intake id");
    if (row.disposition) refuse(`already disposed: ${row.disposition.disposition}`);
    append({ type: "disposed", id, at: new Date().toISOString(), disposition, ...fields, by } as Disposed);
  });
  console.log(id);
}
function main(argv: string[]): void {
  const [command, ...rest] = argv;
  if (command === "post") return post(rest);
  if (command === "dispose") return dispose(rest);
  if (command === "show") {
    if (rest.length !== 1) refuse("usage: show <id>");
    const row = fold().get(guard("id", rest[0]));
    if (!row) refuse("unknown intake id");
    console.log(JSON.stringify(row, null, 2));
    return;
  }
  if (command === "list") {
    const { pos, bools } = args(rest, [], ["open", "all", "json"]);
    if (pos.length || (bools.has("open") && bools.has("all"))) refuse("usage: list [--open|--all] [--json]");
    const rows = Array.from(fold().values()).reverse().filter(row => bools.has("all") || !row.disposition);
    if (bools.has("json")) console.log(JSON.stringify(rows, null, 2));
    else for (const row of rows) console.log(`${row.id} ${row.posted.kind} ${row.disposition?.disposition ?? "open"} — ${row.posted.title}`);
    return;
  }
  if (command === "audit") {
    if (rest.length) refuse("audit takes no options");
    const open = Array.from(fold().values()).filter(row => !row.disposition);
    for (const row of open) console.log(`${row.id} ${row.posted.kind} age=${Math.max(0, Math.floor((Date.now() - Date.parse(row.posted.at)) / 1000))}s ${row.posted.title}`);
    process.exitCode = open.length ? 1 : 0;
    return;
  }
  refuse("usage: intake.ts post|dispose|list|show|audit ...");
}
if (import.meta.main) {
  try { main(process.argv.slice(2)); }
  catch (e: any) { console.error(`STOP: ${e.message}`); process.exitCode = 2; }
}
