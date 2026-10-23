#!/usr/bin/env bun
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fold, humanTextGuard } from "./needs";

const DEFAULT_ROOT = fs.existsSync(path.join(process.cwd(), "wheelhouse", ".template-source")) ? process.cwd() : path.join(import.meta.dir, "..");
const ROOT = path.resolve(process.env.WHEELHOUSE_DIGEST_ROOT || DEFAULT_ROOT);
const SEATS = path.join(ROOT, "seats");
const TEMPLATE_SOURCE = path.join(ROOT, "wheelhouse", ".template-source");
const INBOX = path.join(SEATS, "inbox.jsonl");
const RUN = path.join(SEATS, "run");
const DIGEST_LAST = path.join(RUN, "digest.last");
const DESK_PORT = path.join(RUN, "desk.port");
const VERDICTS = path.join(SEATS, "verdicts");
const ALERTS_LOG = path.join(SEATS, "logs", "alerts.log");
const BD_TIMEOUT_MS = 5000;

type Any = Record<string, any>;
export type Digest = { window:{since:string;until:string}; namespace:string; seats:{role:string;provider:string;model:string}[]; shipped:Any[]; blocked:Any[]; cleared:Any[]; inReview:Any[]; sentBack:Any[]; failed:{summary:{events:number;stillFailing:number};items:Any[]}; alerts:Any[] };

function arg(name:string){ const i=process.argv.indexOf(name); return i>=0 ? process.argv[i+1] : undefined; }
function has(name:string){ return process.argv.includes(name); }
function iso(d:Date){ return d.toISOString(); }
function parseTime(s:any){ const t=Date.parse(String(s||"")); return Number.isFinite(t) ? t : 0; }
function inWindow(at:any, since:number, until:number){ const t=parseTime(at); return t>=since && t<=until; }
function local(at:any){ const d=new Date(String(at)); if(!Number.isFinite(d.getTime())) return "unknown time"; return d.toLocaleString(undefined,{month:"short",day:"2-digit",hour:"2-digit",minute:"2-digit",timeZoneName:"short"}); }
function short(s:any){ return String(s||"").slice(0,7); }
function templateValue(k:string){ try{ const m=fs.readFileSync(TEMPLATE_SOURCE,"utf8").match(new RegExp(`^${k.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}=(.*)$`,"m")); return m ? m[1].trim() : ""; }catch{return "";} }
function namespace(){ return templateValue("namespace") || path.basename(ROOT); }
function readJsonl(file:string):Any[]{ if(!fs.existsSync(file)) return []; return fs.readFileSync(file,"utf8").split(/\r?\n/).filter(Boolean).map((l,i)=>{ try{return JSON.parse(l)}catch(e:any){ return {at:"", title:`parse error line ${i+1}`, detail:e.message}; } }); }
function run(cmd:string[], cwd=ROOT, opts:{input?:string; timeout?:number; env?:NodeJS.ProcessEnv}={}){ try{ return spawnSync(cmd[0],cmd.slice(1),{cwd,encoding:"utf8",timeout:opts.timeout??BD_TIMEOUT_MS,input:opts.input,env:opts.env}); }catch(e:any){ return {status:127, stdout:"", stderr:String(e?.message||e)} as any; } }
function bdList(args:string[]):{rows:Any[]; unavailable:boolean}{ const r=run(["bd","list","--json","--limit","0",...args]); if(r.status!==0) return {rows:[], unavailable:true}; try{ const j=JSON.parse(r.stdout||"[]"); return {rows:Array.isArray(j)?j:[], unavailable:false}; }catch{return {rows:[], unavailable:false};} }
function repoFromRemote(raw:string){ const s=String(raw||"").trim(); let m=s.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/); return m ? `${m[1]}/${m[2]}` : ""; }
function productRepo(){ const p=templateValue("product-repo"); return p ? path.resolve(ROOT,p) : ROOT; }
function defaultBranch(repo:string){ const r=run(["git","symbolic-ref","--short","refs/remotes/origin/HEAD"],repo); return r.status===0 && r.stdout.trim() ? r.stdout.trim() : "main"; }
function commitBase(repo:string){ const r=run(["git","remote","get-url","origin"],repo); const rr=repoFromRemote(r.stdout.trim()); return rr ? `https://github.com/${rr}/commit/` : ""; }
function gitMerges(since:string, until:string){ const repo=productRepo(); const br=defaultBranch(repo); const r=run(["git","log","--first-parent","--format=%H%x09%P%x09%aI%x09%s","--since",since,"--until",until,br],repo); if(r.status!==0) return [] as Any[]; const base=commitBase(repo); return r.stdout.split(/\r?\n/).filter(Boolean).map(l=>{ const [sha,parents,at,subject]=l.split("\t"); const ps=(parents||"").split(/\s+/).filter(Boolean); return {sha, parents:ps, secondParent:ps[1], at, subject, branch:br.replace(/^origin\//,"") , links:{commit:base?base+sha:undefined}}; }); }
function taskIdOf(row:Any){ return String(row.id||row.bead||row.task||""); }
function titleOf(row:Any){ return String(row.title||row.summary||row.subject||taskIdOf(row)||"Untitled"); }
function descOf(row:Any){ return String(row.description||row.desc||row.body||""); }
function closedAt(row:Any){ return String(row.closed_at||row.closedAt||row.closed||row.updated_at||row.updatedAt||""); }
function createdAt(row:Any){ return String(row.created_at||row.createdAt||row.created||""); }
function closeReason(row:Any){ return String(row.close_reason||row.closeReason||row.reason||row.resolution||row.notes||""); }
function verdictFile(id:string){ const f=path.join(VERDICTS,`${id}.md`); return fs.existsSync(f) ? f : undefined; }
function verdictLine(id:string){ const f=verdictFile(id); if(!f) return {}; const s=fs.readFileSync(f,"utf8"); const v=s.match(/(?:^|\n)\s*(?:[-*]\s*)?verdict\s*:\s*([^\n]+)/i) || s.match(/(?:^|\n)\s*VERDICT\s*:\s*([^\n]+)/i); const p=s.match(/(?:^|\n)\s*(?:[-*]\s*)?push\s*:\s*([^\n]+)/i) || s.match(/(?:^|\n)\s*PUSH\s*:\s*([^\n]+)/i); return {verdict:v?.[1]?.trim(), push:p?.[1]?.trim(), path:path.relative(ROOT,f)}; }
function inboxId(r:Any){ const blob=`${r.title||""} ${r.detail||""} ${r.text||""}`; return blob.match(/([A-Za-z0-9_.-]+-[A-Za-z0-9_.-]+|demo-[a-z0-9]+)/)?.[1] || String(r.id||r.bead||""); }
function detail(r:Any){ return String(r.detail||r.text||r.body||r.message||""); }
function firstLine(s:string){ return s.split(/\r?\n/)[0]||""; }
function afterDash(s:string){ const m=s.match(/[—-]\s*(.+)$/); return m ? m[1].trim() : ""; }
function verdictRows(inbox:Any[], id?:string){ return inbox.filter(r=>String(r.seat||"")==="verifier-gate" && String(r.class||"")==="settle" && /verifier gate verdict/i.test(String(r.title||"")) && (!id || inboxId(r)===id)); }
function bounceRows(inbox:Any[]){ return verdictRows(inbox).filter(r=>/^\s*VERDICT:\s*BOUNCE\b/i.test(detail(r))); }
function verdictAfter(inbox:Any[], id:string, at=0){ return verdictRows(inbox,id).find(r=>parseTime(r.at)>at && /^\s*VERDICT:\s*(APPROVE|BOUNCE|DISCOVER)\b/i.test(detail(r))); }
function verdictWord(r:Any){ return (detail(r).match(/^\s*VERDICT:\s*(APPROVE|BOUNCE|DISCOVER)\b/i)||[])[1]?.toUpperCase() || "VERDICT"; }
function approveAfter(inbox:Any[], id:string, at=0){ return verdictRows(inbox,id).find(r=>parseTime(r.at)>at && /^\s*VERDICT:\s*APPROVE\b/i.test(detail(r))); }
function workerSettleAfter(inbox:Any[], id:string, at:number){ return inbox.find(r=>parseTime(r.at)>at && String(r.class||"")==="settle" && /seat turn settled/i.test(String(r.title||"")) && inboxId(r)===id); }
function deliveryFor(inbox:Any[], id:string){ return inbox.filter(r=>String(r.class||"")==="settle" && /seat turn settled/i.test(String(r.title||"")) && inboxId(r)===id).sort((a,b)=>parseTime(b.at)-parseTime(a.at))[0]; }
function seatsLine(){ try{ const j=JSON.parse(fs.readFileSync(path.join(SEATS,"seats.json"),"utf8")); const rows=Object.values(j.seats||{}) as Any[]; return rows.map(r=>({role:String(r.role||""),provider:String(r.provider||""),model:String(r.model||"")})); }catch{return [];} }
function accountLabels(){ const labels=new Set<string>(); const visit=(x:any)=>{ if(!x||typeof x!=="object") return; if(x.account?.label&&typeof x.account.label==="string") labels.add(x.account.label); for(const v of Object.values(x)) visit(v); }; for(const f of [path.join(SEATS,"seats.json"),path.join(SEATS,"pool.json")]){ try{ visit(JSON.parse(fs.readFileSync(f,"utf8"))); }catch{} } return Array.from(labels).filter(Boolean).sort((a,b)=>b.length-a.length); }
function scrubAccountLabels(s:string, labels=accountLabels()){ let out=String(s||""); for(const label of labels) out=out.split(label).join("[account-label]"); return out; }
function scrubAccountLabelsDeep<T>(v:T, labels=accountLabels()):T{ if(typeof v==="string") return scrubAccountLabels(v,labels) as T; if(Array.isArray(v)) return v.map(x=>scrubAccountLabelsDeep(x,labels)) as T; if(v&&typeof v==="object"){ const o:any={}; for(const [k,x] of Object.entries(v as any)) o[k]=scrubAccountLabelsDeep(x,labels); return o; } return v; }
function summarizeSeats(rows:{role:string;provider:string;model:string}[]){ const by=new Map<string,{n:number;vals:Set<string>}>(); for(const r of rows){ const e=by.get(r.role)||{n:0,vals:new Set<string>()}; e.n++; e.vals.add(`${r.provider||"unknown"}/${r.model||"unknown"}`); by.set(r.role,e); } return Array.from(by.entries()).map(([role,e])=>`${e.n} ${role}${e.n===1?"":"s"} (${Array.from(e.vals).join(", ")})`).join(", ") || "no rostered seats"; }
function branchFromReason(reason:string, defaultBranch="main"){ const m=String(reason||"").match(/\b(?:origin\/)?(fleet\/[A-Za-z0-9_.-]+)\b/); if(!m) return ""; const b=m[1].replace(/^origin\//,""); return b===defaultBranch || b.endsWith(`/${defaultBranch}`) ? "" : b; }
function ageText(minutes:any){ const m=Math.max(0, Math.floor(Number(minutes)||0)); const h=Math.floor(m/60), mm=m%60; return h ? `${h}h${mm?` ${mm}m`:""}` : `${m}m`; }
function withId(title:any, id:any, human=false){ const t=String(title||""), i=String(id||""); return human||!i||t.includes(i) ? t : `${t} (${i})`; }
export function buildDigest(sinceIso:string, untilIso:string):Digest{
  const since=parseTime(sinceIso), until=parseTime(untilIso), inbox=readJsonl(INBOX);
  const closed=bdList(["--status","closed"]), review=bdList(["--label","needs-review"]);
  const merges=gitMerges(sinceIso, untilIso);
  const shipped:Any[]=[];
  for(const row of closed.rows.filter(r=>inWindow(closedAt(r),since,until))){
    const ca=parseTime(createdAt(row)), cl=parseTime(closedAt(row));
    if(!descOf(row).trim() && cl-ca>=0 && cl-ca<60000) continue;
    const id=taskIdOf(row), cr=closeReason(row); let merge=merges.find(m=>cr.includes(short(m.sha))||cr.includes(m.sha)||m.subject.includes(id)||m.subject.includes(titleOf(row)));
    const goalBranch=branchFromReason(cr, merge?.branch||"main");
    const namesTask=!!id&&(cr.includes(id)||cr.includes(titleOf(row))||!!merge||!!goalBranch);
    if(!namesTask) continue;
    const vf=verdictLine(id); const rounds=verdictRows(inbox,id).length;
    shipped.push({id,title:titleOf(row),at:closedAt(row),branch:goalBranch || merge?.branch || "main", sha:merge?.sha||cr.match(/[a-f0-9]{7,40}/)?.[0], secondParent:merge?.secondParent, verdict:vf.verdict, push:vf.push, rounds, links:{commit:merge?.links?.commit, verdict:vf.path}});
  }
  for(const m of merges){ if(shipped.some(s=>s.sha && m.sha.startsWith(s.sha))) continue; const id=(m.subject.match(/([A-Za-z0-9_.-]+-[A-Za-z0-9_.-]+)/)||[])[1]||""; if(!id) continue; const vf=id?verdictLine(id):{} as Any; shipped.push({id,title:m.subject.replace(/^Merge\s+/i,""),at:m.at,branch:m.branch,sha:m.sha,secondParent:m.secondParent,verdict:vf.verdict,push:vf.push,rounds:id?verdictRows(inbox,id).length:0,links:{commit:m.links.commit,verdict:vf.path}}); }
  const needs=Array.from(fold().values());
  const blocked=needs.filter(n=>n.opened&&parseTime(n.opened.at)<=until && n.state==="open").map(n=>({id:n.id,title:n.opened.title,kind:n.opened.kind,at:n.opened.at,ageMinutes:Math.floor((until-parseTime(n.opened.at))/60000),links:{need:n.id}}));
  const cleared=needs.filter(n=>(n.answer&&inWindow(n.answer.at,since,until))||(n.closed&&inWindow(n.closed.at,since,until))).map(n=>({id:n.id,title:n.opened.title,kind:n.opened.kind,at:n.answer?.at||n.closed?.at,links:{need:n.id}}));
  const shippedIds=new Set(shipped.map(s=>s.id).filter(Boolean));
  const sentBackRows=new Map<string,Any>();
  for(const r of bounceRows(inbox).filter(r=>inWindow(r.at,since,until)).filter(r=>!approveAfter(inbox,inboxId(r),parseTime(r.at))&&!shippedIds.has(inboxId(r)))){ const id=inboxId(r); if(!sentBackRows.has(id)||parseTime(r.at)>parseTime(sentBackRows.get(id)!.at)) sentBackRows.set(id,r); }
  const taskTitles=new Map<string,string>();
  for(const r of [...closed.rows,...review.rows]){ const id=taskIdOf(r); if(id) taskTitles.set(id,titleOf(r)); }
  const sentBack=Array.from(sentBackRows.values()).map(r=>{ const id=inboxId(r), at=parseTime(r.at), later=workerSettleAfter(inbox,id,at); return {id,title:taskTitles.get(id)||id||"Untitled",at:r.at,reason:afterDash(firstLine(detail(r)))||"no reason given",round:verdictRows(inbox,id).filter(x=>parseTime(x.at)<=at).length,rework:later?`rework delivered ${local(later.at)}`:"rework not started"}; });
  const sentIds=new Set(sentBack.map(x=>x.id));
  const inReview=review.rows.filter(r=>!sentIds.has(taskIdOf(r))).map(r=>{ const d=deliveryFor(inbox,taskIdOf(r)); return {id:taskIdOf(r),title:titleOf(r),at:d?.at||r.updated_at||r.created_at,deliveryAt:d?.at,links:{verdict:verdictFile(taskIdOf(r))?path.relative(ROOT,verdictFile(taskIdOf(r))!):undefined}}; });
  const failedItems:Any[]=[];
  for(const r of inbox.filter(r=>String(r.class||"")==="distress"&&String(r.state||"")==="failed"&&inWindow(r.at,since,until))){ const id=inboxId(r), laterVerdict=verdictAfter(inbox,id,parseTime(r.at)); const elapsed=String(detail(r)).match(/elapsed\s+(\d+)\s*ms/i)?.[1]||String(r.elapsed||"").match(/(\d+)/)?.[1]; failedItems.push({kind:"stop",id,seat:r.seat,title:r.title,at:r.at,first:firstLine(detail(r)),elapsedMinutes:elapsed?Math.round(Number(elapsed)/60000):undefined,recovered:laterVerdict?`→ ${verdictWord(laterVerdict)} ${local(laterVerdict.at)}`:undefined}); }
  for(const r of inbox.filter(r=>String(r.class||"")==="settle"&&String(r.state||"")==="stalled"&&inWindow(r.at,since,until))){ const next=inbox.find(x=>String(x.seat||"")===String(r.seat||"")&&String(x.class||"")==="settle"&&String(x.state||"")!=="stalled"&&parseTime(x.at)>parseTime(r.at)); failedItems.push({kind:"stalled",seat:r.seat,title:r.title,at:r.at,resumedAt:next?.at}); }
  const anomalies=new Map<string,Any[]>();
  for(const r of closed.rows){ const ca=parseTime(createdAt(r)), cl=parseTime(closedAt(r)); if(cl>=since&&cl<=until&&cl-ca>=0&&cl-ca<60000&&!descOf(r).trim()){ const k=titleOf(r); (anomalies.get(k)??anomalies.set(k,[]).get(k)!).push(r); } }
  for(const [title,rows] of anomalies){ rows.sort((a,b)=>parseTime(closedAt(a))-parseTime(closedAt(b))); if(rows.length>=3 && parseTime(closedAt(rows.at(-1)))-parseTime(closedAt(rows[0]))<=5*60000) failedItems.push({kind:"bulk-close",title,count:rows.length,at:closedAt(rows[0]),until:closedAt(rows.at(-1))}); }
  const alerts=[...inbox.filter(r=>String(r.class||"")==="alert"&&inWindow(r.at,since,until)).map(r=>({at:r.at,title:r.title,detail:detail(r)}))];
  if(fs.existsSync(ALERTS_LOG)) for(const l of fs.readFileSync(ALERTS_LOG,"utf8").split(/\r?\n/).filter(Boolean)){ const m=l.match(/^(\S+)/); if(m&&inWindow(m[1],since,until)) alerts.push({at:m[1],title:l}); }
  return scrubAccountLabelsDeep({window:{since:sinceIso,until:untilIso},namespace:namespace(),seats:seatsLine(),shipped:closed.unavailable?[{unavailable:true}]:shipped,blocked,cleared,inReview:review.unavailable?[{unavailable:true}]:inReview,sentBack,failed:{summary:{events:failedItems.length,stillFailing:failedItems.filter(i=>i.kind==="stop"&&!i.recovered).length},items:failedItems},alerts});
}
function escapeRegExp(s:string){ return s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"); }
function scrubLocalPaths(s:string){ let out=String(s||""); for(const p of [os.homedir(),ROOT].filter(Boolean).sort((a,b)=>b.length-a.length)){ out=out.split(p).join("[local-path]"); } return out; }
function truncate(s:string,n=220){ const t=String(s||""); return t.length>n ? t.slice(0,n-1)+"…" : t; }
function humanText(s:string, ns:string){ return scrubLocalPaths(scrubAccountLabels(String(s||""))).replace(new RegExp(`\\b${escapeRegExp(ns)}-[a-z0-9_.-]+\\b`,"ig"),"work item").replace(/\bbead\b/ig,"task"); }
function humanTitle(s:string, ns:string){ return humanText(s,ns).replace(/verifier gate verdict\s*[—-]\s*/i,"").replace(/verifier gate STOP\s*[—-]\s*/i,"review stopped: ").trim(); }
function safeWord(s:any){ return String(s||"unknown").trim().split(/\s+/)[0].replace(/[^A-Za-z]/g,"") || "unknown"; }
function md(d:Digest, human=false){ const labels=accountLabels(); const safe=(s:string)=>scrubLocalPaths(scrubAccountLabels(s,labels)); const t=(s:string)=>human?humanTitle(safe(s),d.namespace):safe(s); const h=(s:string)=>human?humanText(safe(s),d.namespace):safe(s); const lines:string[]=[]; lines.push(`# Fleet digest — ${human?d.namespace.replace(/[-_]/g," "):d.namespace} — ${local(d.window.since)} → ${local(d.window.until)}`); lines.push(`Seats: ${summarizeSeats(d.seats)}`); lines.push(""); lines.push("## Shipped"); if(d.shipped.some((x:any)=>x.unavailable)) lines.push("[bd unavailable]"); else if(!d.shipped.length) lines.push("[Nothing merged.]"); else for(const s of d.shipped){ const goal=s.branch&&s.branch!=="main"?`On goal branch ${s.branch}: `:""; const vv=human?safeWord(s.verdict):s.verdict||"unknown", pp=human?h(String(s.push||"unknown")):s.push||"unknown"; lines.push(`- ${goal}${t(s.title)}${human?"":` (${s.id})`} — ${s.sha?`merged ${short(s.sha)}`:"closed"}${s.secondParent?` (${short(s.secondParent)})`:""}, ${local(s.at)}; verdict: ${vv}; push: ${pp}; rounds=${s.rounds||0}${s.links?.commit?`; ${s.links.commit}`:""}${s.links?.verdict&&!human?`; ${s.links.verdict}`:""}`); }
  lines.push(""); lines.push("## Blocked on you"); if(!d.blocked.length) lines.push("[Nothing open.]"); else for(const n of d.blocked) lines.push(`- ${t(n.title)} — ${n.kind}, age ${ageText(n.ageMinutes)}${human?"":` (${n.id})`}`); if(d.cleared.length){ lines.push("Cleared:"); for(const n of d.cleared) lines.push(`- ${t(n.title)} — ${n.kind}, ${local(n.at)}${human?"":` (${n.id})`}`); }
  lines.push(""); lines.push("## In review"); if(d.inReview.some((x:any)=>x.unavailable)) lines.push("[bd unavailable]"); else if(!d.inReview.length) lines.push("[Nothing waiting.]"); else for(const r of d.inReview) lines.push(`- ${t(r.title)}${human?"":` (${r.id})`} — delivered ${local(r.deliveryAt||r.at)}${r.links?.verdict&&!human?`; ${r.links.verdict}`:""}`);
  lines.push(""); lines.push("## Sent back"); if(!d.sentBack.length) lines.push("[Nothing sent back.]"); else for(const r of d.sentBack) lines.push(`- ${t(r.title)}${human?"":` (${r.id})`} — BOUNCE round ${r.round}: ${h(r.reason)}; ${r.rework}`);
  lines.push(""); lines.push("## Failed and why"); if(!d.failed.items.length) lines.push("[Nothing failed.]"); else { lines.push(`${d.failed.summary.events} events, ${d.failed.summary.stillFailing} still failing`); for(const f of d.failed.items){ if(f.kind==="stop") lines.push(`- ${f.seat}: ${t(withId(f.title,f.id,human))} — ${truncate(h(f.first))}${f.elapsedMinutes?`, ${f.elapsedMinutes} min`:""}${f.recovered?` ${f.recovered}`:""}`); else if(f.kind==="stalled") lines.push(`- ${f.seat}: stalled ${local(f.at)}${f.resumedAt?`, resumed ${local(f.resumedAt)}`:""}`); else lines.push(`- ${f.count} tasks titled "${t(f.title)}" closed within seconds (${local(f.at)} → ${local(f.until)})`); } }
  lines.push(""); lines.push("## Alerts"); if(!d.alerts.length) lines.push("[None.]"); else for(const a of d.alerts) lines.push(`- ${local(a.at)} — ${t(a.title)}${a.detail?`: ${truncate(h(firstLine(a.detail)))}`:""}`);
  return lines.join("\n")+"\n";
}
export function renderHuman(d:Digest){ const out=md(d,true); for(const line of out.split(/\r?\n/).filter(Boolean)) humanTextGuard(line,"digest human line",ROOT); return out; }
function readDigestLast(): string { try { return fs.readFileSync(DIGEST_LAST, "utf8").trim(); } catch { return ""; } }
function writeAtomic(file:string, data:string){ fs.mkdirSync(path.dirname(file),{recursive:true}); const tmp=`${file}.tmp.${process.pid}`; fs.writeFileSync(tmp,data); fs.renameSync(tmp,file); }
function deskDigestUrl(): string {
  let raw: string;
  try { raw = fs.readFileSync(DESK_PORT, "utf8").trim(); }
  catch (e: any) { if (e.code === "ENOENT") return ""; throw e; }
  let u: URL;
  try {
    u = new URL(raw);
    if (!raw.startsWith("http://") || u.protocol !== "http:" || u.pathname !== "/needs" || u.username || u.password || u.search || u.hash) throw Error("not a desk URL");
  } catch { throw Error(`Invalid desk.port: expected a complete http://host[:port]/needs URL (${DESK_PORT})`); }
  u.pathname = "/digest";
  return u.toString();
}
function windowArgs(useDigestLast=false){ const rawUntil=arg("--until"), rawSince=arg("--since"), rawHours=arg("--hours"); const until=rawUntil ? new Date(rawUntil) : new Date(); let since: Date; if(rawSince) since=new Date(rawSince); else if(rawHours!==undefined) since=new Date(until.getTime()-Number(rawHours)*3600000); else if(useDigestLast) { const last=readDigestLast(); since=last ? new Date(last) : new Date(until.getTime()-24*3600000); } else since=new Date(until.getTime()-24*3600000); try { until.toISOString(); since.toISOString(); } catch { throw new Error("invalid digest window"); } return { since, until }; }
function notifyTitle(until:Date){ return `Fleet digest — ${until.toLocaleDateString(undefined,{month:"short",day:"2-digit",year:"numeric"})}`; }
function notifyBody(d:Digest){ let body=renderHuman(d).trimEnd(); const desk=deskDigestUrl(); if(desk) body += `\n\nFull page: ${desk}`; return body + "\n"; }
function notifyDigest(d:Digest): number {
  const title=notifyTitle(new Date(d.window.until));
  const body=notifyBody(d);
  const source=`digest:${d.window.until}`;
  const r=run(["bun","seats/needs.ts","open","--kind","notify","--source",source,"--title",title,"--body",body],ROOT,{timeout:BD_TIMEOUT_MS,env:{...process.env,WHEELHOUSE_NEEDS_ROOT:ROOT}});
  if(r.status!==0){ process.stderr.write(r.stderr||r.stdout||"needs.ts open failed\n"); return 2; }
  process.stdout.write(String(r.stdout||"").trim()+"\n");
  writeAtomic(DIGEST_LAST, d.window.until+"\n");
  return 0;
}
if(import.meta.main){ try { const notify=has("--notify"); const {since,until}=windowArgs(notify); const d=buildDigest(iso(since),iso(until)); if(notify) process.exit(notifyDigest(d)); if(has("--json")) console.log(JSON.stringify(d,null,2)); else process.stdout.write(has("--human")?renderHuman(d):md(d,false)); } catch(e:any){ process.stderr.write(`${e?.message||e}\n`); process.exit(2); } }
