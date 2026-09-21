#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
const ROOT = path.resolve(process.env.WHEELHOUSE_NEEDS_ROOT || path.join(import.meta.dir, ".."));
const SEATS_DIR = path.join(ROOT, "seats");
const LEDGER = path.join(SEATS_DIR, "needs.jsonl");
const ROSTER = path.join(SEATS_DIR, "seats.json");
const TEMPLATE_SOURCE = path.join(ROOT, "wheelhouse", ".template-source");
const VALID_KINDS = new Set(["question", "approval", "notify", "task"]);
export type NeedEvent =
 | { type:"opened"; id:string; at:string; kind:string; title:string; body:string; options:Option[]; default?:string; consequence?:string; machine:{ bead?:string; seat?:string; session?:string; source?:string } }
 | { type:"message"; id:string; at:string; from:"commander"|"human"; via:string; text:string }
 | { type:"answered"; id:string; at:string; from:"human"; via:string; text:string; choice?:string }
 | { type:"closed"; id:string; at:string; reason:string };
export interface Option { label:string; text:string }
export interface NeedFold { id:string; state:"open"|"answered"|"closed"; opened:Extract<NeedEvent,{type:"opened"}>; messages:Extract<NeedEvent,{type:"message"}>[]; answer?:Extract<NeedEvent,{type:"answered"}>; closed?:Extract<NeedEvent,{type:"closed"}> }
function die(msg:string, code=1):never{ process.stderr.write(`STOP: ${msg}\n`); process.exit(code); }
function warn(msg:string){ process.stderr.write(`WARN: ${msg}\n`); }
function now(){ return new Date().toISOString(); }
export function appendEvent(ev:NeedEvent){ fs.mkdirSync(SEATS_DIR,{recursive:true}); fs.appendFileSync(LEDGER, JSON.stringify(ev)+"\n"); }
export function readEvents():NeedEvent[]{ if(!fs.existsSync(LEDGER)) return []; const out:NeedEvent[]=[]; fs.readFileSync(LEDGER,"utf8").split(/\r?\n/).forEach((l,i)=>{ if(!l.trim()) return; try{out.push(JSON.parse(l));}catch(e:any){die(`cannot parse ${LEDGER} line ${i+1}: ${e.message}`);} }); return out; }
export function fold(events=readEvents()):Map<string,NeedFold>{ const m=new Map<string,NeedFold>(); for(const ev of events){ if(ev.type==="opened") m.set(ev.id,{id:ev.id,state:"open",opened:ev,messages:[]}); else { const n=m.get(ev.id); if(!n) continue; if(ev.type==="message") n.messages.push(ev); else if(ev.type==="answered"){n.answer=ev; if(n.state!=="closed") n.state="answered";} else {n.closed=ev; n.state="closed";} } } return m; }
export function getNeed(id:string):NeedFold{ const n=fold().get(id); if(!n) die(`no need named ${id}`); return n; }
function esc(s:string){ return s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"); }
function namespace(){ try{ const m=fs.readFileSync(TEMPLATE_SOURCE,"utf8").match(/^namespace=(.+)$/m); if(m?.[1]?.trim()) return m[1].trim(); }catch{} return path.basename(ROOT).replace(/-[a-z0-9]{3,4}$/i, ""); }
function humanTextGuard(text:string, where:string){ const id=text.match(new RegExp(`\\b${esc(namespace())}-[a-z0-9]{3,4}\\b`,"i"))?.[0]; if(id) die(`${where} contains install-local id token ${id}; put it in machine fields, not human-facing text`,2); const bead=text.match(/\bbead\b/i)?.[0]; if(bead) die(`${where} contains forbidden human-facing token ${bead}; say “need”, “request”, or use the machine bead field`,2); }
function seatNames():string[]{ try{return Object.keys(JSON.parse(fs.readFileSync(ROSTER,"utf8")).seats??{});}catch{return [];} }
function warnSeatNames(texts:string[]){ for(const seat of seatNames()){ const re=new RegExp(`(^|[^A-Za-z0-9_-])${esc(seat)}([^A-Za-z0-9_-]|$)`); if(texts.some(t=>re.test(t))) warn(`human-facing text mentions roster seat ${seat}`); } }
function uniqueId(){ const used=new Set(readEvents().map((e:any)=>e.id)); for(;;){ const id=`need-${crypto.randomInt(36**4).toString(36).padStart(4,"0")}`; if(!used.has(id)) return id; } }
function parseArgs(argv:string[]){ const pos:string[]=[], flags:Record<string,string[]>={}, bools=new Set<string>(); for(let i=0;i<argv.length;i++){ const a=argv[i]; if(!a.startsWith("--")){pos.push(a); continue;} const k=a.slice(2); if(["json","all","from-stdin"].includes(k)){bools.add(k); continue;} const v=argv[++i]; if(v===undefined) die(`--${k} requires a value`,2); (flags[k]??=[]).push(v); } return {pos,flags,bools}; }
function one(f:Record<string,string[]>, k:string){ return f[k]?.[f[k].length-1]; }
function req(f:Record<string,string[]>, k:string){ const v=one(f,k); if(!v) die(`open requires --${k}`,2); return v; }
function parseOptions(raw:string[]):Option[]{ return raw.map(s=>{ const m=s.match(/^([^:]+):\s*(.+)$/s); if(!m) die(`--option must be "<label>: <text>", got ${JSON.stringify(s)}`,2); return {label:m[1].trim(), text:m[2].trim()}; }); }
function cmdOpen(argv:string[]){ const {flags,bools}=parseArgs(argv); let title=one(flags,"title")??"", body=one(flags,"body")??""; if(bools.has("from-stdin")){ const lines=fs.readFileSync(0,"utf8").replace(/\r\n/g,"\n").split("\n"); const first=lines.shift()??""; const m=first.match(/^\s*@principal:\s*(.*)$/); if(!m) die("--from-stdin requires first line beginning @principal:",2); title=m[1].trim(); body=lines.join("\n").trim(); } if(!title) title=req(flags,"title"); if(!body) body=req(flags,"body"); const kind=one(flags,"kind")??"question"; if(!VALID_KINDS.has(kind)) die(`--kind must be question|approval|notify|task, got ${kind}`,2); const options=parseOptions(flags.option??[]); const def=one(flags,"default"), consequence=one(flags,"consequence"); const human=[title,body,...options.flatMap(o=>[o.label,o.text]),def??"",consequence??""]; human.filter(Boolean).forEach((t,i)=>humanTextGuard(t,`open text ${i+1}`)); warnSeatNames(human); const source=one(flags,"source"); if(source){ for(const n of fold().values()) if(n.opened.machine.source===source && n.state!=="closed"){ console.log(n.id); return; } } const ev:any={type:"opened",id:uniqueId(),at:now(),kind,title,body,options,machine:{bead:one(flags,"bead"),seat:one(flags,"seat"),session:process.env.WHEELHOUSE_SESSION_ID,source}}; if(def) ev.default=def; if(consequence) ev.consequence=consequence; appendEvent(ev); console.log(ev.id); }
export function addMessage(id:string, text:string, from:"commander"|"human"="commander", via="cli"){ humanTextGuard(text,"message text"); getNeed(id); appendEvent({type:"message",id,at:now(),from,via,text}); }
export function answerNeed(id:string, text:string, via="cli", choiceArg?:string){ const n=getNeed(id); const choice=choiceArg || n.opened.options.find(o=>o.label===text||o.text===text)?.label; appendEvent({type:"answered",id,at:now(),from:"human",via,text,choice}); }
function cmdSay(argv:string[]){ const {pos}=parseArgs(argv); const [id,...rest]=pos; if(!id||!rest.length) die("usage: needs.ts say <id> <text>",2); addMessage(id, rest.join(" "), "commander", "cli"); console.log(id); }
function cmdAnswer(argv:string[]){ const {pos,flags}=parseArgs(argv); const [id,...rest]=pos; if(!id||!rest.length) die("usage: needs.ts answer <id> <text> [--via desk|cli|<transport>]",2); answerNeed(id, rest.join(" "), one(flags,"via")??"cli"); console.log(id); }
function cmdClose(argv:string[]){ const {pos,flags}=parseArgs(argv); const id=pos[0]; if(!id) die("usage: needs.ts close <id> [--reason <r>]",2); getNeed(id); appendEvent({type:"closed",id,at:now(),reason:one(flags,"reason")??"closed"}); console.log(id); }
function cmdShow(argv:string[]){ const {pos}=parseArgs(argv); console.log(JSON.stringify(getNeed(pos[0]??""),null,2)); }
function cmdList(argv:string[]){ const {bools}=parseArgs(argv); let needs=Array.from(fold().values()); if(!bools.has("all")) needs=needs.filter(n=>n.state!=="closed"); needs.sort((a,b)=>(a.state==="open"?0:1)-(b.state==="open"?0:1)||b.opened.at.localeCompare(a.opened.at)); if(bools.has("json")) console.log(JSON.stringify(needs,null,2)); else for(const n of needs) console.log(`${n.id} ${n.state} ${n.opened.kind} — ${n.opened.title}${n.answer?` answer=${n.answer.text}`:""}`); }
if (import.meta.main) { const [cmd,...rest]=process.argv.slice(2); if(cmd==="open") cmdOpen(rest); else if(cmd==="say") cmdSay(rest); else if(cmd==="answer") cmdAnswer(rest); else if(cmd==="show") cmdShow(rest); else if(cmd==="list") cmdList(rest); else if(cmd==="close") cmdClose(rest); else die("usage: needs.ts open|say|answer|show|list|close ...",2); }
