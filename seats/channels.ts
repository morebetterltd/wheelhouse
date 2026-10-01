#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";

export type ChannelKind = "telegram" | "slack" | "teams";
export type ChannelAudience = "principal" | "stakeholders";
export interface ChannelMember { id: string; name: string }
export interface Channel { name: string; kind: ChannelKind; destination: string; audience: ChannelAudience; members: ChannelMember[]; read: boolean }

export class ChannelsFileError extends Error {
  constructor(message: string) { super(message); this.name = "ChannelsFileError"; }
}

const NAME_RE = /^[a-z0-9-]+$/;
const KINDS = new Set(["telegram", "slack", "teams"]);
const AUDIENCES = new Set(["principal", "stakeholders"]);
const TOP_KEYS = new Set(["version", "channels"]);
const CHANNEL_KEYS = new Set(["kind", "destination", "audience", "members", "read"]);
const MEMBER_KEYS = new Set(["id", "name"]);
const CREDENTIAL_RE = /^(?:xox[abp]-|\d{6,}:[A-Za-z0-9_-]{30,}|eyJ[A-Za-z0-9_-]{20,})/;

function rootFromEnv(): string {
  return path.resolve(process.env.WHEELHOUSE_COMMS_ROOT || process.env.WHEELHOUSE_NEEDS_ROOT || path.join(import.meta.dir, ".."));
}

function fail(reason: string): never { throw new ChannelsFileError(reason); }
function isRecord(v: unknown): v is Record<string, unknown> { return !!v && typeof v === "object" && !Array.isArray(v); }
function unknownKeys(obj: Record<string, unknown>, allowed: Set<string>, where: string): void {
  for (const k of Object.keys(obj)) if (!allowed.has(k)) fail(`${where} has unknown key ${JSON.stringify(k)}`);
}
function scanCredentials(v: unknown, where = "file"): void {
  if (typeof v === "string") {
    if (CREDENTIAL_RE.test(v)) fail(`${where} contains a credential-shaped value`);
    return;
  }
  if (Array.isArray(v)) v.forEach((x, i) => scanCredentials(x, `${where}[${i}]`));
  else if (isRecord(v)) for (const [k, x] of Object.entries(v)) scanCredentials(x, `${where}.${k}`);
}

export function loadChannels(root = rootFromEnv()): Channel[] {
  const file = path.join(root, "seats", "channels.json");
  if (!fs.existsSync(file)) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e: any) { fail(`malformed JSON: ${e.message}`); }
  scanCredentials(parsed);
  if (!isRecord(parsed)) fail("top level must be an object");
  unknownKeys(parsed, TOP_KEYS, "top level");
  if (parsed.version !== undefined && parsed.version !== 1) fail("version must be 1");
  const channelsValue = parsed.channels;
  if (channelsValue === undefined) fail("missing channels object");
  if (!isRecord(channelsValue)) fail("channels must be an object");
  const out: Channel[] = [];
  let principalCount = 0;
  for (const [name, raw] of Object.entries(channelsValue)) {
    if (!NAME_RE.test(name)) fail(`channel name ${JSON.stringify(name)} must match ^[a-z0-9-]+$`);
    if (!isRecord(raw)) fail(`channel ${name} must be an object`);
    unknownKeys(raw, CHANNEL_KEYS, `channel ${name}`);
    if (typeof raw.kind !== "string" || !KINDS.has(raw.kind)) fail(`channel ${name} kind must be telegram|slack|teams`);
    if (typeof raw.destination !== "string" || raw.destination.trim() === "") fail(`channel ${name} destination must be a non-empty string`);
    if (typeof raw.audience !== "string" || !AUDIENCES.has(raw.audience)) fail(`channel ${name} audience must be principal|stakeholders`);
    const membersRaw = raw.members ?? [];
    if (!Array.isArray(membersRaw)) fail(`channel ${name} members must be an array`);
    const members = membersRaw.map((m, i) => {
      if (!isRecord(m)) fail(`channel ${name} member ${i} must be an object`);
      unknownKeys(m, MEMBER_KEYS, `channel ${name} member ${i}`);
      if (typeof m.id !== "string" || m.id.trim() === "") fail(`channel ${name} member ${i} id must be a non-empty string`);
      if (typeof m.name !== "string" || m.name.trim() === "") fail(`channel ${name} member ${i} name must be a non-empty string`);
      return { id: m.id, name: m.name };
    });
    const read = raw.read ?? false;
    if (typeof read !== "boolean") fail(`channel ${name} read must be true or false`);
    if (raw.audience === "principal") principalCount++;
    out.push({ name, kind: raw.kind as ChannelKind, destination: raw.destination, audience: raw.audience as ChannelAudience, members, read });
  }
  if (principalCount > 1) fail("at most one channel may have audience principal");
  return out;
}

export function channelByName(root: string, name: string): Channel | undefined { return loadChannels(root).find((c) => c.name === name); }
export function principalChannel(root = rootFromEnv()): Channel | undefined { return loadChannels(root).find((c) => c.audience === "principal"); }

function stop(e: unknown): never {
  const msg = e instanceof ChannelsFileError ? e.message : e instanceof Error ? e.message : String(e);
  process.stderr.write(`STOP: seats/channels.json: ${msg}\n`);
  process.exit(2);
}

if (import.meta.main) {
  const [cmd, arg] = process.argv.slice(2);
  try {
    if (cmd === "list") {
      for (const c of loadChannels()) console.log(`${c.name} ${c.kind} ${c.audience} ${c.destination} read=${c.read ? "yes" : "no"} members=${c.members.length}`);
    } else if (cmd === "show") {
      if (!arg) { process.stderr.write("usage: channels.ts show <name>\n"); process.exit(2); }
      const c = channelByName(rootFromEnv(), arg);
      if (!c) { process.stderr.write(`STOP: seats/channels.json: no channel named ${arg}\n`); process.exit(2); }
      console.log(JSON.stringify(c, null, 2));
    } else if (cmd === "check") {
      const n = loadChannels().length;
      console.log(n ? `channels: ${n} declared` : "channels: none declared (principal-only)");
    } else {
      process.stderr.write("usage: channels.ts list|show <name>|check\n");
      process.exit(2);
    }
  } catch (e) { stop(e); }
}
