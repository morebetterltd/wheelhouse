#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { channelByName, loadChannels } from "./channels";
import { humanTextGuard } from "./needs";
import * as transportIndex from "./transports/index";

const ROOT = path.resolve(process.env.WHEELHOUSE_COMMS_ROOT || process.env.WHEELHOUSE_NEEDS_ROOT || path.join(import.meta.dir, ".."));
const LEDGER = path.join(ROOT, "seats", "comms.jsonl");

type CommsRow =
  | { type:"request"; id:string; at:string; channel:string; from:string; text:string; source?:string }
  | { type:"relayed"; id:string; at:string; sentId:string; ref:string }
  | { type:"declined"; id:string; at:string; reason:string }
  | { type:"sent"; id:string; at:string; channel:string; kind:string; destination:string; ref:string; readBack:"fetched"|"echo"; sha256:string; by:string }
  | { type:"failed"; id:string; at:string; channel:string; kind:string; destination:string; ref?:string; reason:string };

function now(){ return new Date().toISOString(); }
function stop(msg:string, code=1):never{ process.stderr.write(`STOP: ${msg}\n`); process.exit(code); }
function sha256(text:string):string{ return crypto.createHash("sha256").update(text).digest("hex"); }
function actorEnvVar(name: string): string { return `WHEELHOUSE_BEADS_ACTOR_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`; }
function readRows():CommsRow[]{
  if (!fs.existsSync(LEDGER)) return [];
  const out:CommsRow[] = [];
  fs.readFileSync(LEDGER,"utf8").split(/\r?\n/).forEach((line,i)=>{ if(!line.trim()) return; try{ out.push(JSON.parse(line)); } catch(e:any){ stop(`cannot parse seats/comms.jsonl line ${i+1}: ${e.message}`, 2); } });
  return out;
}
function appendRow(row:CommsRow){ fs.mkdirSync(path.dirname(LEDGER), { recursive:true }); fs.appendFileSync(LEDGER, JSON.stringify(row)+"\n"); }
function uniqueId(prefix = "comms"):string { const used = new Set(readRows().map((r:any)=>r.id)); for(;;){ const id=`${prefix}-${crypto.randomInt(36**4).toString(36).padStart(4,"0")}`; if(!used.has(id)) return id; } }
function parseArgs(argv:string[]):{pos:string[]; stdin:boolean; from?:string; source?:string; decline?:string}{
  const pos:string[]=[]; let stdin=false; let from: string|undefined; let source: string|undefined; let decline: string|undefined;
  for(let i=0;i<argv.length;i++){
    const a=argv[i];
    if(a==="--from-stdin") stdin=true;
    else if(a==="--from") from=argv[++i] ?? "";
    else if(a==="--source") source=argv[++i] ?? "";
    else if(a==="--decline") decline=argv[++i] ?? "";
    else pos.push(a);
  }
  return {pos, stdin, from, source, decline};
}
function textFromArgs(pos:string[], stdin:boolean):string { if(stdin) return fs.readFileSync(0,"utf8").replace(/\r\n/g,"\n"); return pos.join(" "); }
function isClosedRequest(rows: CommsRow[], id: string): boolean { return rows.some((r:any) => (r.type === "relayed" || r.type === "declined") && r.id === id); }
function rosterSeatActors(): Set<string> {
  const out = new Set<string>();
  const file = path.join(ROOT, "seats", "seats.json");
  if (!fs.existsSync(file)) return out;
  let parsed: any;
  try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); } catch(e:any) { stop(`cannot parse seats/seats.json: ${e.message}`, 2); }
  const seats = parsed?.seats && typeof parsed.seats === "object" ? parsed.seats : {};
  for (const name of Object.keys(seats)) {
    out.add(name);
    const override = process.env[actorEnvVar(name)];
    if (override) out.add(override);
  }
  return out;
}
function enforceSendIdentity(channelName: string): void {
  const actor = process.env.BEADS_ACTOR || "";
  if (actor && rosterSeatActors().has(actor)) stop(`seats cannot send to stakeholders; file a relay request: bun seats/comms.ts request ${channelName} ...`, 2);
}
async function sendText(name: string, text: string): Promise<{ id:string; ref:string }> {
  const channel = channelByName(ROOT, name);
  if (!channel) stop(`channel ${name} is not declared in seats/channels.json`, 2);
  enforceSendIdentity(channel.name);
  if (!text) stop("send requires message text", 2);
  humanTextGuard(text, "comms text", ROOT);
  const id = uniqueId();
  const at = now();
  let ref = "";
  try {
    const transport = transportIndex.transportFor(ROOT, channel.kind);
    const posted = await transport.post(channel.destination, text);
    ref = posted.ref;
    if (!(await transport.readBack(channel.destination, ref, text))) {
      const reason = `read-back did not return ${ref}`;
      appendRow({ type:"failed", id, at, channel:channel.name, kind:channel.kind, destination:channel.destination, ref, reason });
      stop(`send unverified: ${channel.kind} read-back did not return ${ref}`, 1);
    }
    appendRow({ type:"sent", id, at, channel:channel.name, kind:channel.kind, destination:channel.destination, ref, readBack:posted.readBack, sha256:sha256(text), by:process.env.BEADS_ACTOR || "commander" });
    return { id, ref };
  } catch (e:any) {
    const reason = e?.message ?? String(e);
    appendRow({ type:"failed", id, at, channel:channel.name, kind:channel.kind, destination:channel.destination, ...(ref ? { ref } : {}), reason });
    stop(reason, 1);
  }
}

async function cmdSend(argv:string[]) {
  const {pos, stdin} = parseArgs(argv);
  const name = pos.shift();
  if (!name) stop("usage: comms.ts send <channel-name> <text...> | send <channel-name> --from-stdin", 2);
  const text = textFromArgs(pos, stdin);
  const sent = await sendText(name, text);
  console.log(`sent ${name} ${sent.ref}`);
}

function cmdRequest(argv:string[]) {
  const {pos, stdin, from, source} = parseArgs(argv);
  const name = pos.shift();
  if (!name) stop("usage: comms.ts request <channel-name> <text...> | request <channel-name> --from-stdin [--from <identity>] [--source <opaque>]", 2);
  const channel = channelByName(ROOT, name);
  if (!channel) stop(`channel ${name} is not declared in seats/channels.json`, 2);
  const text = textFromArgs(pos, stdin);
  if (!text) stop("request requires message text", 2);
  humanTextGuard(text, "comms text", ROOT);
  const rows = readRows();
  if (source) {
    const existing = rows.find((r:any) => r.type === "request" && r.source === source && !isClosedRequest(rows, r.id)) as Extract<CommsRow,{type:"request"}>|undefined;
    if (existing) { console.log(existing.id); return; }
  }
  const row: CommsRow = { type:"request", id:uniqueId("relay"), at:now(), channel:channel.name, from:from || process.env.BEADS_ACTOR || "unknown", text, ...(source ? { source } : {}) };
  appendRow(row);
  console.log(row.id);
}

async function cmdRelay(argv:string[]) {
  const {pos, decline} = parseArgs(argv);
  const id = pos.shift();
  if (!id) stop("usage: comms.ts relay <relay-id> [--decline <reason>]", 2);
  const rows = readRows();
  const req = rows.find((r:any) => r.type === "request" && r.id === id) as Extract<CommsRow,{type:"request"}>|undefined;
  if (!req) stop(`unknown relay request ${id}`, 2);
  const prior = rows.find((r:any) => (r.type === "relayed" || r.type === "declined") && r.id === id);
  if (prior) stop(`already ${prior.type}`, 2);
  if (decline !== undefined) {
    if (!decline) stop("decline requires a reason", 2);
    appendRow({ type:"declined", id, at:now(), reason:decline });
    console.log(`declined ${id}`);
    return;
  }
  const sent = await sendText(req.channel, req.text);
  appendRow({ type:"relayed", id, at:now(), sentId:sent.id, ref:sent.ref });
  console.log(`relayed ${id} ${sent.ref}`);
}

function cmdRequests(argv:string[]) {
  const all = argv.includes("--all");
  const rows = readRows();
  for (const r of rows) {
    if (r.type !== "request") continue;
    const state = rows.find((x:any) => (x.type === "relayed" || x.type === "declined") && x.id === r.id)?.type ?? "pending";
    if (!all && state !== "pending") continue;
    const suffix = all ? ` [${state}]` : "";
    console.log(`${r.id} ${r.channel} ${r.from} — ${r.text.slice(0, 80)}${suffix}`);
  }
}

function lastSent(rows:CommsRow[], channel: string): Extract<CommsRow,{type:"sent"}> | undefined {
  return rows.filter((r): r is Extract<CommsRow,{type:"sent"}> => r.type === "sent" && r.channel === channel).at(-1);
}
function cmdStatus(){
  const channels = loadChannels(ROOT);
  if (channels.length === 0) { console.log("channels: none declared (principal-only)"); return; }
  const rows = readRows();
  for (const c of channels) {
    const last = lastSent(rows, c.name);
    console.log(`${c.name} ${c.kind} ${c.audience} ${last ? `${last.ref} ${last.at}` : "never"}`);
  }
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "send") await cmdSend(rest);
  else if (cmd === "request") cmdRequest(rest);
  else if (cmd === "relay") await cmdRelay(rest);
  else if (cmd === "requests") cmdRequests(rest);
  else if (cmd === "status") cmdStatus();
  else stop("usage: comms.ts send|request|relay|requests|status ...", 2);
}
