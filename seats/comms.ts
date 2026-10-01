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
  | { type:"sent"; id:string; at:string; channel:string; kind:string; destination:string; ref:string; readBack:"fetched"|"echo"; sha256:string; by:string }
  | { type:"failed"; id:string; at:string; channel:string; kind:string; destination:string; ref?:string; reason:string };

function now(){ return new Date().toISOString(); }
function stop(msg:string, code=1):never{ process.stderr.write(`STOP: ${msg}\n`); process.exit(code); }
function sha256(text:string):string{ return crypto.createHash("sha256").update(text).digest("hex"); }
function readRows():CommsRow[]{
  if (!fs.existsSync(LEDGER)) return [];
  const out:CommsRow[] = [];
  fs.readFileSync(LEDGER,"utf8").split(/\r?\n/).forEach((line,i)=>{ if(!line.trim()) return; try{ out.push(JSON.parse(line)); } catch(e:any){ stop(`cannot parse seats/comms.jsonl line ${i+1}: ${e.message}`, 2); } });
  return out;
}
function appendRow(row:CommsRow){ fs.mkdirSync(path.dirname(LEDGER), { recursive:true }); fs.appendFileSync(LEDGER, JSON.stringify(row)+"\n"); }
function uniqueId():string { const used = new Set(readRows().map((r:any)=>r.id)); for(;;){ const id=`comms-${crypto.randomInt(36**4).toString(36).padStart(4,"0")}`; if(!used.has(id)) return id; } }
function parseArgs(argv:string[]):{pos:string[]; stdin:boolean}{ const pos:string[]=[]; let stdin=false; for(const a of argv){ if(a==="--from-stdin") stdin=true; else pos.push(a); } return {pos, stdin}; }
function textFromArgs(pos:string[], stdin:boolean):string { if(stdin) return fs.readFileSync(0,"utf8").replace(/\r\n/g,"\n"); return pos.join(" "); }

async function cmdSend(argv:string[]) {
  const {pos, stdin} = parseArgs(argv);
  const name = pos.shift();
  if (!name) stop("usage: comms.ts send <channel-name> <text...> | send <channel-name> --from-stdin", 2);
  const channel = channelByName(ROOT, name);
  if (!channel) stop(`channel ${name} is not declared in seats/channels.json`, 2);
  const text = textFromArgs(pos, stdin);
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
    console.log(`sent ${channel.name} ${ref}`);
  } catch (e:any) {
    const reason = e?.message ?? String(e);
    appendRow({ type:"failed", id, at, channel:channel.name, kind:channel.kind, destination:channel.destination, ...(ref ? { ref } : {}), reason });
    stop(reason, 1);
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
  else if (cmd === "status") cmdStatus();
  else stop("usage: comms.ts send|status ...", 2);
}
