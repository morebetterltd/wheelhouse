#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { readQuarantine } from "./quarantine";
import { fleetSnapshot, readyWorkNobodyOnIt, type Snapshot } from "./fleet-snapshot";
import { pidAlive } from "./seat-activity";
import { acquirePidLock, releasePidLock } from "./lock";
import { observeSeatStreams, seatStallNeedMs, type StreamHealth } from "./seat-stream-health";

const ROOT = path.resolve(process.env.WHEELHOUSE_ALERTS_ROOT || path.join(import.meta.dir, ".."));
const SEATS = path.join(ROOT, "seats");
const RUN = path.join(SEATS, "run");
const LOGS = path.join(SEATS, "logs");
const SNAP = path.join(RUN, "fleet-snapshot.json");
const LOCK = path.join(RUN, "alerts.lock");
const ALERT_LOG = path.join(LOGS, "alerts.log");
const DEFAULT_INTERVAL_MS = 60_000;
export const TEMPLATE_DRIFT_ALERT_HOLD_MS = Number(process.env.WHEELHOUSE_TEMPLATE_DRIFT_ALERT_HOLD_MS ?? 10 * 60_000);

type AlertName = "idle-fleet-ready-work"|"cold-seats-ready-work"|"inbox-lag"|"untriaged-github-issues"|"capacity-events"|"low-disk"|"commander-pane-invalid"|"template-drift"|"template-drift-check-failed"|`seat-stalled:${string}`;
type AlertState = { active:boolean; since:string|null; lastFiredAt:string|null; needId?:string|null; signature?:string; detail?:string };
type SnapshotFile = { at:string; intervalMs:number; snapshot:Snapshot; herald:any; inbox:any; needs:any; capacity:any; disk:any; github:any; drift:any; quarantined:{count:number;names:string[]}; seatStreams:Record<string,StreamHealth>; alerts:Record<string,AlertState> };

function now(){ return new Date().toISOString(); }
function readJson(file:string):any{ try { return JSON.parse(fs.readFileSync(file,"utf8")); } catch { return null; } }
function writeAtomic(file:string, data:string){ fs.mkdirSync(path.dirname(file),{recursive:true}); const tmp=`${file}.tmp.${process.pid}`; fs.writeFileSync(tmp,data); fs.renameSync(tmp,file); }
function appendLog(s:string){ fs.mkdirSync(LOGS,{recursive:true}); fs.appendFileSync(ALERT_LOG, `${now()} ${s}\n`); }
export function templateValue(key:string, root=ROOT):string{ try { const m=fs.readFileSync(path.join(root,"wheelhouse",".template-source"),"utf8").match(new RegExp(`^${key}=(.*)$`,"m")); return m?.[1]?.trim() ?? ""; } catch { return ""; } }
function minutesValue(key:string, def:number):number{ const n=Number(templateValue(key)); return Number.isFinite(n) ? n : def; }
function gbValue(key:string, def:number):number{ const n=Number(templateValue(key)); return Number.isFinite(n) ? n : def; }
function acquireLock():number|null{ return acquirePidLock(LOCK); }
function releaseLock(fd:number|null){ releasePidLock(LOCK, fd); }
function intervalMs(){ const raw=process.env.WHEELHOUSE_ALERT_INTERVAL_MS; if(raw===undefined||raw.trim()==="") return DEFAULT_INTERVAL_MS; const n=Number(raw); return Number.isFinite(n)&&n>=0?Math.floor(n):DEFAULT_INTERVAL_MS; }

export function inboxStats(root=ROOT){
  const file=path.join(root,"seats","inbox.jsonl"); const cursorFile=path.join(root,"seats","inbox.cursor"); const log=path.join(root,"seats","logs","herald.out.log");
  const size=fs.existsSync(file)?fs.statSync(file).size:0; let cursor=Number((fs.existsSync(cursorFile)?fs.readFileSync(cursorFile,"utf8"):"0").toString().trim()); if(!Number.isFinite(cursor)||cursor<0) cursor=0;
  const body=fs.existsSync(file)?fs.readFileSync(file,"utf8").slice(cursor):""; const rows=body.split(/\r?\n/).filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
  const oldestUndrainedAt=rows.map((r:any)=>r.at).filter(Boolean).sort()[0]??null; const lagMs=oldestUndrainedAt?Math.max(0,Date.now()-Date.parse(oldestUndrainedAt)):0;
  let deferralStreak=0; try { const lines=fs.readFileSync(log,"utf8").trimEnd().split(/\r?\n/).filter(Boolean).slice(-200).reverse(); for(const line of lines){ if(/poke deferred /.test(line)) deferralStreak++; else if(/poke (?:sent|escalated|dropped) /.test(line)) break; } } catch {}
  return { size, cursor, undrainedRows: rows.length, oldestUndrainedAt, lagMs, deferralStreak };
}
export function needCounts(root=ROOT){
  const file=path.join(root,"seats","needs.jsonl"); const needs=new Map<string,any>();
  if(fs.existsSync(file)) for(const line of fs.readFileSync(file,"utf8").split(/\r?\n/)){ if(!line.trim()) continue; let ev:any; try{ev=JSON.parse(line)}catch{continue}; if(!ev.id) continue; const n=needs.get(ev.id)??{state:null,human:null,read:null}; needs.set(ev.id,n); if(ev.type==="opened") n.state="open"; else if(ev.type==="message"&&ev.from==="human") n.human=ev.at||""; else if(ev.type==="answered"){ n.state="answered"; n.human=ev.at||""; } else if(ev.type==="closed") n.state="closed"; else if(ev.type==="read") n.read=ev.at||""; }
  let open=0, unread=0; for(const n of needs.values()){ if(n.state==="open") open++; if(n.state!=="closed"&&n.human&&(!n.read||n.read<n.human)) unread++; } return {open, unread};
}
function heraldInfo(){ const pid=Number((readText(path.join(RUN,"herald.pid"))||"").trim()); const target=readJson(path.join(RUN,"herald.target.json")); return { pid:Number.isFinite(pid)?pid:null, alive:Number.isFinite(pid)?pidAlive(pid):false, target:target??null }; }
function readText(f:string):string|null{ try{return fs.readFileSync(f,"utf8")}catch{return null} }
function capacitySeats(){ const state=readJson(path.join(SEATS,"state.json"))?.seats??{}; return Object.entries<any>(state).filter(([,r])=>r?.lastCapacityEvent).map(([n])=>n).sort(); }
function diskInfo(){ const thresholdBytes=Math.floor(gbValue("alert-low-disk-gb",10)*1024*1024*1024); let freeBytes:null|number=null; try{ const s=(fs as any).statfsSync(ROOT); freeBytes=Number(s.bavail??s.bfree)*Number(s.bsize); }catch{ const r=spawnSync("df",["-k",ROOT],{encoding:"utf8"}); const cols=r.stdout.trim().split(/\n/).pop()?.split(/\s+/); if(cols?.[3]) freeBytes=Number(cols[3])*1024; } return {freeBytes, thresholdBytes}; }
export function repoFromRemote(s:string){ return s.replace(/.*github\.com[:/]/,"").replace(/\.git$/,""); }
function githubIssueRepos(){ const raw=templateValue("github-issue-repos"); if(raw) return raw.split(/[,;]/).map(s=>s.trim()).filter(Boolean); try{ const url=spawnSync("git",["remote","get-url","origin"],{cwd:ROOT,encoding:"utf8"}).stdout.trim(); return url?[repoFromRemote(url)]:[]; }catch{return []} }
function stringArray(raw:string){ return raw.split(/[,;]/).map(s=>s.trim()).filter(Boolean); }
function githubInfo(){ const watch=templateValue("github-issue-watch"); const repos=githubIssueRepos(); if(["off","false","disabled","none","0"].includes(watch)) return {untriaged:null,repos}; if(spawnSync("gh",["--version"],{stdio:"ignore"}).status!==0) return {untriaged:null,repos}; const include=new Set(stringArray(templateValue("github-issue-include-labels"))); const exclude=new Set(stringArray(templateValue("github-issue-exclude-labels"))); const author=templateValue("github-issue-author"); const traced=(spawnSync("bd",["list","--status","open","--limit","0","--json"],{cwd:ROOT,encoding:"utf8"}).stdout||"")+"\n"+(spawnSync("bd",["list","--status","in_progress","--limit","0","--json"],{cwd:ROOT,encoding:"utf8"}).stdout||"")+"\n"+(spawnSync("bd",["list","--status","deferred","--limit","0","--json"],{cwd:ROOT,encoding:"utf8"}).stdout||""); const out:string[]=[]; for(const repo of repos){ const r=spawnSync("gh",["issue","list","-R",repo,"--state","open","--limit","100","--json","url,labels,author"],{encoding:"utf8",timeout:30000}); if(r.status!==0) return {untriaged:null,repos}; let issues:any[]=[]; try{issues=JSON.parse(r.stdout||"[]")}catch{} for(const issue of issues){ const labels=(issue.labels||[]).map((l:any)=>typeof l==="string"?l:l?.name).filter(Boolean); if(author&&issue.author?.login!==author) continue; if(include.size&&!labels.some((l:string)=>include.has(l))) continue; if(labels.some((l:string)=>exclude.has(l))) continue; if(issue.url&&!traced.includes(issue.url)) out.push(issue.url); } } return {untriaged:out.sort(),repos}; }
function driftInfo(){
  const script=path.join(SEATS,"template-drift.sh");
  const failed=(reason:string, result:any={})=>({status:"check-failed",reason,error:reason,modified:[],localOnly:[],missing:[],aheadBy:null,...result});
  if(!fs.existsSync(script)) return failed("template-drift.sh missing");
  // Completion/protocol, not elapsed time, decides whether drift was measured.
  let r; try { r=spawnSync("bash",[script,"--json",ROOT],{cwd:ROOT,encoding:"utf8"}); }
  catch(e:any){ return failed(`could not run template-drift.sh: ${e.message}`); }
  const result={exitCode:r.status,signal:r.signal,stdout:r.stdout??"",stderr:r.stderr??""};
  if(r.error) return failed(`template-drift.sh could not complete: ${r.error.message}`,result);
  if(r.signal || (r.status!==0 && r.status!==1)) return failed(`template-drift.sh exited ${r.status??"without status"}${r.signal?` (signal ${r.signal})`:""}: ${result.stderr.trim()||result.stdout.trim()||"no diagnostic output"}`,result);
  let data; try { data=JSON.parse(result.stdout); }
  catch(e:any){ return failed(`template-drift.sh returned invalid JSON: ${e.message}`,result); }
  if(data?.error) return failed(`template-drift.sh could not compare: ${String(data.error)}`,result);
  const paths=(v:any)=>Array.isArray(v)&&v.every((p:any)=>typeof p==="string"&&p.length>0);
  if(!data || typeof data!=="object" || !paths(data.modified) || !paths(data.localOnly) || !paths(data.missing) || !(data.aheadBy===null || (Number.isSafeInteger(data.aheadBy)&&data.aheadBy>=0))) return failed("template-drift.sh returned an invalid drift result schema",result);
  const hasDrift=!!(data.modified.length||data.localOnly.length||data.missing.length||(data.aheadBy??0)>0);
  if(r.status===1&&!hasDrift) return failed("template-drift.sh exited 1 without reporting drift",result);
  return {...data,...result,status:hasDrift?"drift":"clean",reason:null};
}
function alertRow(active:boolean, prior:AlertState|undefined, signature=""):AlertState{ const n=now(); if(active){ if(prior?.active&&prior.signature===signature) return {...prior, active:true}; return {active:true,since:n,lastFiredAt:n,needId:prior?.needId??null,signature}; } return {active:false,since:null,lastFiredAt:prior?.lastFiredAt??null,needId:prior?.needId??null,signature}; }
// The set is the sorted, de-duplicated union of modified, localOnly and
// missing paths. Reordering, duplicates, category moves and aheadBy changes
// don't re-raise. Ahead-only drift keeps its first hold as an empty-path-set
// condition. Each changed set waits its own 10-minute hold; a full clear
// resets the clock. Failed checks remain a separate, immediate alert.
function driftFileSetSignature(drift:any):string {
  const candidates=Array.isArray(drift) ? drift : [drift.modified??drift.m, drift.localOnly??drift.l, drift.missing??drift.mi].flatMap(xs=>Array.isArray(xs)?xs:[]);
  return JSON.stringify([...new Set(candidates.filter(p=>typeof p==="string"&&p.length>0))].sort());
}
function priorDriftSignature(signature:string|undefined):string {
  if(!signature) return "";
  try { const parsed=JSON.parse(signature); if(parsed && typeof parsed==="object") return driftFileSetSignature(parsed); } catch {}
  return signature;
}
function heldAlertRow(active:boolean, prior:AlertState|undefined, signature:string, holdMs:number):AlertState {
  const n=now();
  if(!active) return {active:false,since:null,lastFiredAt:prior?.lastFiredAt??null,needId:prior?.needId??null,signature};
  const sameSet=prior?.signature===signature;
  if(sameSet&&prior?.active) return {...prior,active:true,signature};
  const firstSeen=sameSet ? prior?.since??n : n;
  if(Date.now()-Date.parse(firstSeen)<holdMs) return {active:false,since:firstSeen,lastFiredAt:prior?.lastFiredAt??null,needId:prior?.needId??null,signature};
  return {active:true,since:firstSeen,lastFiredAt:n,needId:prior?.needId??null,signature};
}
function appendInboxAlert(name:AlertName|"quarantine", detail:string, stream?:StreamHealth){
  fs.mkdirSync(SEATS,{recursive:true});
  const row={id:`alert-${name}-${Date.now()}`,at:now(),seat:"herald",class:"alert",state:"input-required",title:title(name),detail,source:{type:"alerts",name,...(stream?{seat:stream.seat,bead:stream.bead,lastEventAt:stream.lastEventAt,lastEvent:stream.lastEvent}:{})}};
  fs.appendFileSync(path.join(SEATS,"inbox.jsonl"),JSON.stringify(row)+"\n");
}
function needOpen(name:AlertName, title:string, body:string, stream?:StreamHealth):string|null{ const machine=stream?["--seat",stream.seat,...(stream.bead?["--bead",stream.bead]:[])]:[]; const source=`alerts:${name}${stream?`:${stream.processKey}:${stream.bead??""}:${stream.progressKey}`:""}`; const r=spawnSync("bun",["seats/needs.ts","open","--kind","notify","--source",source,"--title",title,"--body",body,...machine],{cwd:ROOT,encoding:"utf8",env:{...process.env,BEADS_ACTOR:"alerts"}}); if(r.status!==0){ appendLog(`alert need open failed ${name}: ${(r.stderr||r.stdout).trim()}`); return null; } return r.stdout.trim().split(/\s+/)[0]||null; }
function needClose(id:string){ spawnSync("bun",["seats/needs.ts","close",id,"--reason","cleared"],{cwd:ROOT,encoding:"utf8",env:{...process.env,BEADS_ACTOR:"alerts"}}); }
function title(name:string){ return `alert — ${name.replace(/-/g," ")}`; }
function bodyFor(name:AlertName, detail:string){ return `Alert ${name}: ${detail}. ${remedyFor(name)}`; }
function remedyFor(name:AlertName){ if(name.startsWith("seat-stalled:")) return "Cost: delivery is waiting, even though the process is alive. Next: inspect the seat's own stream and redispatch after diagnosis; never interrupt a legitimate tool wait. No automatic abort or restart was performed."; if(name==="template-drift-check-failed") return "Cost: $0 directly; template drift is unknown. Next: inspect the retained drift failure in seats/run/fleet-snapshot.json and repair/retry the check."; if(name==="commander-pane-invalid") return "The commander pane target is invalid. Cost: $0 while noticed, but alerts and wakes may not reach the commander. Next: run seats/cockpit.sh to re-aim the commander pane and restart the herald."; if(name==="inbox-lag") return "The fleet inbox has undrained rows for longer than the alert threshold. Cost: $0 directly, but workers may wait for attention. Next: run bun seats/herald.ts --drain in the commander pane."; if(name==="idle-fleet-ready-work") return "Ready work exists while nobody is on it. Cost: $0 directly, but delivery is stalled. Next: spawn or resume seats and dispatch work; this clears itself once a worker is busy."; return "A fleet alert became active. Cost: $0. Next: inspect seats/run/fleet-snapshot.json; no action needed when the condition clears itself."; }
function maybeHuman(name:AlertName, st:AlertState, stream?:StreamHealth){ const age=Date.now()-Date.parse(st.since||now()); const humanAfter=minutesValue("alert-human-after-minutes",15)*60_000; if(stream && age>=seatStallNeedMs(ROOT)){ if(!st.needId) st.needId=needOpen(name,"A model stream needs attention",`An assigned worker's model stream remains silent. Its last own event was at ${stream.lastEventAt}. Cost: delivery is waiting while its process remains alive. Next: ask the commander to inspect the stream and recover or redispatch the work after diagnosis. No automatic restart was performed.`,stream); } else if(name==="commander-pane-invalid" || ((name==="inbox-lag"||name==="idle-fleet-ready-work") && age>=humanAfter)){ if(!st.needId) st.needId=needOpen(name,title(name),st.detail??bodyFor(name,"condition remains active")); } }

export function buildSnapshot(root=ROOT):SnapshotFile{
  const entries=readQuarantine(root); const quarantined={count:entries.length,names:entries.map(e=>e.suite)};
  const prior=readJson(SNAP) as SnapshotFile|null; const priorAlerts=prior?.alerts??{}; const snap=fleetSnapshot(root); const inbox=inboxStats(root); const needs=needCounts(root); const herald=heraldInfo(); const capacity={seats:capacitySeats()}; const disk=diskInfo(); const github=githubInfo(); const drift=driftInfo();
  const seatStreams=observeSeatStreams(root,prior?.seatStreams??{});
  const active:Record<AlertName,{on:boolean; sig:string; detail:string}>={
    "idle-fleet-ready-work":{on:readyWorkNobodyOnIt(snap),sig:"",detail:`ready=${snap.readyCount}; busy workers=${snap.workers.busy}; ready beads=${snap.ready.map(r=>r.id).join(", ")}`},
    "cold-seats-ready-work":{on:snap.readyCount>0&&snap.workers.live.length===0,sig:"",detail:`ready=${snap.readyCount}; live workers=${snap.workers.live.length}; ready beads=${snap.ready.map(r=>r.id).join(", ")}`},
    "inbox-lag":{on:inbox.undrainedRows>0&&inbox.lagMs>=minutesValue("alert-inbox-lag-minutes",10)*60_000,sig:"",detail:`undrained rows=${inbox.undrainedRows}; oldest=${inbox.oldestUndrainedAt}; lagMs=${inbox.lagMs}`},
    "untriaged-github-issues":{on:Array.isArray(github.untriaged)&&github.untriaged.length>0,sig:Array.isArray(github.untriaged)?github.untriaged.join("\n"):"",detail:`untriaged issues=${(github.untriaged??[]).join(", ")}`},
    "capacity-events":{on:capacity.seats.length>0,sig:capacity.seats.join("\n"),detail:`capacity seats=${capacity.seats.join(", ")}`},
    "low-disk":{on:disk.freeBytes!==null&&disk.freeBytes<disk.thresholdBytes,sig:"",detail:`free bytes=${disk.freeBytes}; threshold bytes=${disk.thresholdBytes}`},
    "commander-pane-invalid":{on:herald.target?.status?herald.target.status!=="ok":false,sig:String(herald.target?.status??""),detail:`commander target status=${herald.target?.status??"unknown"}`},
    "template-drift":{on:drift.status==="drift",sig:driftFileSetSignature(drift),detail:`modified=${JSON.stringify(drift.modified)}; localOnly=${JSON.stringify(drift.localOnly)}; missing=${JSON.stringify(drift.missing)}; aheadBy=${drift.aheadBy??"unknown"}`},
    "template-drift-check-failed":{on:drift.status==="check-failed",sig:drift.reason??"",detail:drift.reason??"drift check failed without a reason"},
  };
  // Keep old keys long enough to clear their persistent condition/need when a
  // seat settles, stops, resumes progress, parks on capacity, or is removed.
  for(const name of Object.keys(priorAlerts)) if(name.startsWith("seat-stalled:")) active[name as AlertName]={on:false,sig:"",detail:""};
  for(const stream of Object.values(seatStreams)) active[`seat-stalled:${stream.seat}`]={on:stream.stalled,sig:`${stream.processKey}:${stream.bead??""}:${stream.progressKey}`,detail:`seat=${stream.seat}; task=${stream.bead??"unassigned"}; last own event=${stream.lastEvent} at ${stream.lastEventAt}; quietMs=${stream.quietForMs}; phase=${stream.phase}`};
  const alerts:Record<string,AlertState>={};
  for(const name of Object.keys(active) as AlertName[]){
    const stored=priorAlerts[name], stream=name.startsWith("seat-stalled:")?seatStreams[name.slice("seat-stalled:".length)]:undefined;
    let was=name==="template-drift"&&stored ? {...stored,signature:priorDriftSignature(stored.signature)} : stored;
    if(stream?.stalled && was?.active && was.signature!==active[name].sig){ if(was.needId) needClose(was.needId); was=undefined; }
    const next=name==="template-drift" ? heldAlertRow(active[name].on,was,active[name].sig,TEMPLATE_DRIFT_ALERT_HOLD_MS) : alertRow(active[name].on,was,active[name].sig);
    next.detail=was?.detail;
    const shouldFire = next.active&&(!was?.active||was.signature!==next.signature);
    if(shouldFire){ next.detail=bodyFor(name,active[name].detail); appendLog(`alert fired ${name}: ${next.detail}`); appendInboxAlert(name,next.detail,stream); }
    if(!next.active&&was?.active){ appendLog(`alert cleared ${name}`); if(was.needId) needClose(was.needId); next.needId=null; }
    if(next.active) maybeHuman(name,next,stream);
    alerts[name]=next;
  }
  if(quarantined.count!==(prior?.quarantined?.count??0)) appendInboxAlert("quarantine",`Alert quarantine: count=${quarantined.count}; suites=${quarantined.names.join(", ")||"none"}. Cost: these suites keep running but their failures do not block review. Next: inspect each owner task and deadline in seats/selftest-quarantine.list.`);
  return {at:now(),intervalMs:intervalMs(),snapshot:snap,herald,inbox,needs,capacity,disk,github,drift,quarantined,seatStreams,alerts};
}
export function check(json=false){ const fd=acquireLock(); if(fd===null){ console.log(json?JSON.stringify({ok:false,locked:true}):"alerts: check already running"); return; } try{ const data=buildSnapshot(ROOT); writeAtomic(SNAP,JSON.stringify(data,null,2)+"\n"); console.log(json?JSON.stringify(data):`snapshot ${data.at} alerts=${Object.values(data.alerts).filter(a=>a.active).length}`); } catch(e:any){ appendLog(`STOP alerts check failed: ${e?.message??e}`); console.error(`STOP: alerts check failed: ${e?.message??e}`); process.exitCode=2; } finally { releaseLock(fd); } }
if(import.meta.main){ const [cmd,...rest]=process.argv.slice(2); if(cmd==="check") check(rest.includes("--json")); else { console.error("usage: alerts.ts check [--json]"); process.exit(2); } }
