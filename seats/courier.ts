#!/usr/bin/env bun
/** courier.ts — optional needs transport daemon. */
import * as fs from "node:fs";
import * as path from "node:path";
import { appendEvent, answerNeed, addMessage, fold, readEvents, type NeedEvent } from "./needs";
import { NoTelegramTransport, TelegramTransport } from "./transports/telegram";
import type { NeedTransport } from "./transports/transport";

const ROOT = path.resolve(process.env.WHEELHOUSE_COURIER_ROOT || process.env.WHEELHOUSE_NEEDS_ROOT || path.join(import.meta.dir, ".."));
const SEATS = path.join(ROOT, "seats");
const RUN = path.join(SEATS, "run");
const LOGS = path.join(SEATS, "logs");
const LEDGER = path.join(SEATS, "needs.jsonl");
const STATE = path.join(RUN, "courier.state.json");
const PID_FILE = path.join(RUN, "courier.pid");
const OUT_LOG = path.join(LOGS, "courier.out.log");

type State = { offset:number; cursor?:string };
function now(){ return new Date().toISOString(); }
function log(line: string){ fs.mkdirSync(LOGS,{recursive:true}); fs.appendFileSync(OUT_LOG, `${now()} ${line}\n`); }
function loadState(): State { try { const j=JSON.parse(fs.readFileSync(STATE,"utf8")); return { offset:Number(j.offset)||0, cursor:j.cursor ? String(j.cursor) : undefined }; } catch { return { offset:0 }; } }
function saveState(s: State){ fs.mkdirSync(RUN,{recursive:true}); fs.writeFileSync(STATE, JSON.stringify(s,null,2)+"\n"); }
function completeLines(offset: number): { rows:{line:string; start:number; end:number}[]; end:number } {
  if (!fs.existsSync(LEDGER)) return { rows:[], end:offset };
  const buf=fs.readFileSync(LEDGER);
  if (offset > buf.length) offset = 0;
  const text=buf.subarray(offset).toString("utf8");
  const rows:any[]=[]; let pos=offset;
  for (const part of text.split(/(?<=\n)/)) { if (!part.endsWith("\n")) break; const line=part.replace(/\r?\n$/,""); const end=pos+Buffer.byteLength(part); if(line.trim()) rows.push({line,start:pos,end}); pos=end; }
  return { rows, end:pos };
}
function transport(): NeedTransport | null { try { return new TelegramTransport(ROOT); } catch(e:any) { if(e instanceof NoTelegramTransport) return null; throw e; } }
function alreadySent(id: string, transport: string, refType: string): boolean { return (readEvents() as any[]).some(ev => ev?.type==="sent" && ev.id===id && ev.transport===transport && String(ev.ref).startsWith(`${refType}:`)); }
function sentRef(ref: string, kind: string){ return `${kind}:${ref}`; }
function choiceFor(needId: string, text: string): string | undefined { const n=fold().get(needId); if(!n) return undefined; const t=text.trim(); const byNum=t.match(/^\d+$/) ? n.opened.options[Number(t)-1]?.label : undefined; return byNum || n.opened.options.find(o=>o.label===t || o.text===t)?.label; }
async function processOnce(): Promise<string> {
  const tx=transport();
  if(!tx) return "courier skipped: no transport configured";
  const s=loadState();
  const batch=completeLines(s.offset);
  for(const rec of batch.rows){
    let ev:NeedEvent; try { ev=JSON.parse(rec.line); } catch { s.offset=rec.end; continue; }
    if(ev.type==="opened" && !alreadySent(ev.id,tx.name,"opened")) { const r=await tx.send(ev); appendEvent({type:"sent", id:ev.id, at:now(), transport:tx.name, ref:sentRef(r.ref,"opened")} as any); }
    else if(ev.type==="message" && ev.from==="commander") { const r=await tx.send(ev); appendEvent({type:"sent", id:ev.id, at:now(), transport:tx.name, ref:sentRef(r.ref,"message")} as any); }
    else if(ev.type==="closed") { const r=await tx.send(ev); appendEvent({type:"sent", id:ev.id, at:now(), transport:tx.name, ref:sentRef(r.ref,"closed")} as any); }
    s.offset=rec.end; saveState(s);
  }
  const polled=await tx.poll(s.cursor);
  s.cursor=polled.cursor;
  for(const reply of polled.replies){
    const n=fold().get(reply.needRef);
    if(!n) { log(`reply for unknown need ${reply.needRef}`); continue; }
    if(n.state==="open") answerNeed(n.id, reply.text, tx.name, choiceFor(n.id, reply.text));
    else addMessage(n.id, reply.text, "human", tx.name);
  }
  // Move the cursor to EOF after appending local reply events; outbound replies from humans are not sent back out.
  if (fs.existsSync(LEDGER)) s.offset=fs.statSync(LEDGER).size;
  saveState(s);
  return `courier scanned ${batch.rows.length} event(s), ${polled.replies.length} repl${polled.replies.length===1?"y":"ies"}`;
}
function status(){ if(!transport()) { console.log("courier skipped: no transport configured"); return; } const pid=fs.existsSync(PID_FILE)?fs.readFileSync(PID_FILE,"utf8").trim():""; if(pid){ try{ process.kill(Number(pid),0); console.log(`courier RUNNING pid ${pid}`); return; } catch{} } console.log("courier configured but not running"); }
async function main(){ const args=process.argv.slice(2); if(args.includes("--status")){ status(); return; } if(args.includes("--drain-out")){ if(fs.existsSync(OUT_LOG)) process.stdout.write(fs.readFileSync(OUT_LOG)); return; } try { const line=await processOnce(); console.log(line); } catch(e:any){ console.error(`STOP: ${e.message}`); process.exitCode=1; return; } if(args.includes("--once")) return; fs.mkdirSync(RUN,{recursive:true}); fs.writeFileSync(PID_FILE, `${process.pid}\n`); setInterval(()=>processOnce().then(log).catch(e=>log(`STOP: ${e.message}`)), 10000); }

if(import.meta.main) main();
