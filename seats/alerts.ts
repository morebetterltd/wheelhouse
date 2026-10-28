#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { completedSpawnSync as spawnSync, nativeJsonArray } from "./native-command";
import { readQuarantine } from "./quarantine";
import { fleetSnapshot, readyWorkNobodyOnIt, hasUnverifiedWorkers, type Snapshot } from "./fleet-snapshot";
import { pidAlive } from "./seat-activity";
import { observeSettledSeats, type SettledSeat } from "./seat-settled";
import { acquirePidLock, releasePidLock } from "./lock";
import { observeSeatStreams, seatStallNeedMs, type StreamHealth } from "./seat-stream-health";
import { nightlyConditions } from "./nightly-state";
import { observeTestLane } from "./selftest-sweep-lock";

const ROOT = path.resolve(process.env.WHEELHOUSE_ALERTS_ROOT || path.join(import.meta.dir, ".."));
const SEATS = path.join(ROOT, "seats");
const RUN = path.join(SEATS, "run");
const LOGS = path.join(SEATS, "logs");
const SNAP = path.join(RUN, "fleet-snapshot.json");
const LOCK = path.join(RUN, "alerts.lock");
const ALERT_LOG = path.join(LOGS, "alerts.log");
const DEFAULT_INTERVAL_MS = 60_000;
export const TEMPLATE_DRIFT_ALERT_HOLD_MS = Number(process.env.WHEELHOUSE_TEMPLATE_DRIFT_ALERT_HOLD_MS ?? 10 * 60_000);

type AlertName = "test-lane-held"|"idle-fleet-ready-work"|"cold-seats-ready-work"|"inbox-lag"|"untriaged-github-issues"|"capacity-events"|"low-disk"|"docker-cache-pressure"|"commander-pane-invalid"|"template-drift"|"template-drift-check-failed"|"nightly-sweep-red"|"nightly-sweep-missed"|`seat-stalled:${string}`|`seat-unverified:${string}`;
type AlertState = { active:boolean; since:string|null; lastFiredAt:string|null; needId?:string|null; signature?:string; detail?:string };
type SnapshotFile = { at:string; intervalMs:number; snapshot:Snapshot; herald:any; inbox:any; needs:any; capacity:any; disk:any; docker:any; github:any; drift:any; quarantined:{count:number;names:string[]}; seatStreams:Record<string,StreamHealth>; nightly:ReturnType<typeof nightlyConditions>; alerts:Record<string,AlertState>; settledSeats:Record<string,SettledSeat> };

function now(){ return new Date().toISOString(); }
function readJson(file:string):any{ try { return JSON.parse(fs.readFileSync(file,"utf8")); } catch { return null; } }
function writeAtomic(file:string, data:string){ fs.mkdirSync(path.dirname(file),{recursive:true}); const tmp=`${file}.tmp.${process.pid}`; fs.writeFileSync(tmp,data); fs.renameSync(tmp,file); }
function appendLog(s:string){ fs.mkdirSync(LOGS,{recursive:true}); fs.appendFileSync(ALERT_LOG, `${now()} ${s}\n`); }
export function templateValue(key:string, root=ROOT):string{ try { const m=fs.readFileSync(path.join(root,"wheelhouse",".template-source"),"utf8").match(new RegExp(`^${key}=(.*)$`,"m")); return m?.[1]?.trim() ?? ""; } catch { return ""; } }
function minutesValue(key:string, def:number):number{ const raw=templateValue(key); if(raw==="") return def; const n=Number(raw); return Number.isFinite(n) ? n : def; }
function gbValue(key:string, def:number):number{ const raw=templateValue(key); if(raw==="") return def; const n=Number(raw); return Number.isFinite(n) ? n : def; }
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
function diskInfo(){
  const thresholdBytes=Math.floor(gbValue("alert-low-disk-gb",10)*1024*1024*1024);
  let freeBytes:number|null=null, unavailable:string|undefined;
  try{ const s=fs.statfsSync(ROOT), n=Number(s.bavail??s.bfree)*Number(s.bsize); if(Number.isFinite(n)&&n>=0) freeBytes=n; }catch{}
  if(freeBytes===null){
    const r=spawnSync("df",["-Pk",ROOT],{encoding:"utf8"});
    if(r.error||r.signal||r.status!==0) unavailable=`native df unavailable (${r.status??r.signal??r.error?.message}): ${String(r.stderr??"").trim()}`;
    else { const lines=r.stdout.trim().split(/\n/), cols=lines.at(-1)?.split(/\s+/), n=Number(cols?.[3])*1024; if(lines.length>=2&&Number.isFinite(n)&&n>=0) freeBytes=n; else unavailable="native df returned no parseable filesystem record"; }
  }
  return {freeBytes,thresholdBytes,...(unavailable?{unavailable}:{})};
}
// Every sourced selftest exports a fixture nonce, including suites that invoke
// alerts indirectly. Never resolve host PATH there without an explicit fixture.
function fixtureDocker(executable:string):string|null {
  try {
    if(!path.isAbsolute(executable)) return null;
    const root=fs.realpathSync(ROOT), actual=fs.realpathSync(executable);
    if(actual!==executable||!actual.startsWith(root+path.sep)||!fs.statSync(actual).isFile()) return null;
    return actual;
  } catch { return null; }
}
function dockerCommand(executable:string):Promise<any> {
  return new Promise(resolve=>{
    let output:any, native:any;
    const finish=()=>{ if(output&&native) resolve({...native,...output,error:typeof output.error?.code==="string"?output.error:undefined}); };
    // This optional host probe has its own budget, not a deadline on drift,
    // graph reads or the shared native-command observer. Kill only this client.
    const child=execFile(executable,["system","df","--format","{{json .}}"],{
      cwd:ROOT,encoding:"utf8",timeout:5000,killSignal:"SIGKILL",maxBuffer:65536,
    },(error,stdout,stderr)=>{ output={error,stdout,stderr}; finish(); });
    child.stdin?.end();
    child.once("close",(status,signal)=>{ native={status,signal}; finish(); });
  });
}
async function dockerCacheInfo(){
  const raw=templateValue("alert-docker-build-cache-gib");
  const value=raw===""?10:Number(raw), gib=Number.isFinite(value)&&value>=0&&value*1024**3<=Number.MAX_SAFE_INTEGER?value:10;
  const thresholdBytes=Math.floor(gib*1024**3);
  const unavailable=(reason:string,r?:any)=>({status:"unavailable",cacheBytes:null,cacheSize:null,thresholdBytes,reason,...(r?{exitCode:r.status,signal:r.signal,errorCode:r.error?.code??null,error:r.error?.message??null,stdout:r.stdout??"",stderr:r.stderr??""}:{})});
  if(thresholdBytes===0) return {status:"disabled",cacheBytes:null,cacheSize:null,thresholdBytes};
  const selftest=process.env.WHEELHOUSE_SELFTEST_FIXTURE_NONCE!==undefined;
  const fixture=process.env.WHEELHOUSE_ALERTS_FIXTURE_DOCKER;
  if(selftest&&!fixture) return {status:"disabled",cacheBytes:null,cacheSize:null,thresholdBytes,reason:"Docker probe off in selftests without an explicit fixture"};
  const dockerBin=selftest?fixtureDocker(fixture!):Bun.which("docker");
  if(!dockerBin) return unavailable("docker not on PATH or fixture executable unavailable");
  let r; try { r=await dockerCommand(dockerBin); }
  catch { return unavailable("docker observation unavailable"); }
  if(r.error||r.signal||r.status!==0) return unavailable("docker observation did not complete successfully",r);
  let rows:any[]; try { rows=r.stdout.trim().split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)); }
  catch { return unavailable("invalid Docker JSONL",r); }
  if(!rows.length||rows.some(row=>!row||typeof row!=="object"||typeof row.Type!=="string")) return unavailable("invalid Docker rows",r);
  const cache=rows.filter(row=>row.Type==="Build Cache");
  if(cache.length!==1||typeof cache[0].Size!=="string") return unavailable("Docker Build Cache row unavailable",r);
  // Docker's human-readable Size uses decimal SI units, not GiB. Reclaimable's
  // percentage is object reclaimability, never VM disk fullness.
  const size=cache[0].Size, match=size.match(/^([0-9]+(?:\.[0-9]+)?)\s*(B|kB|KB|MB|GB|TB|PB)$/);
  const units:Record<string,number>={B:1,kB:1000,KB:1000,MB:1000**2,GB:1000**3,TB:1000**4,PB:1000**5};
  const bytes=match?Number(match[1])*units[match[2]]:NaN;
  if(!Number.isFinite(bytes)||bytes<0||bytes>Number.MAX_SAFE_INTEGER) return unavailable("invalid Docker cache size",r);
  return {status:"ok",cacheBytes:Math.floor(bytes),cacheSize:size,thresholdBytes};
}
export function repoFromRemote(s:string){ return s.replace(/.*github\.com[:/]/,"").replace(/\.git$/,""); }
function githubIssueRepos(){ const raw=templateValue("github-issue-repos"); if(raw) return raw.split(/[,;]/).map(s=>s.trim()).filter(Boolean); try{ const r=spawnSync("git",["remote","get-url","origin"],{cwd:ROOT,encoding:"utf8"}); if(r.error||r.signal||r.status!==0) return []; const url=r.stdout.trim(); return url?[repoFromRemote(url)]:[]; }catch{return []} }
function stringArray(raw:string){ return raw.split(/[,;]/).map(s=>s.trim()).filter(Boolean); }
function githubInfo():{untriaged:string[]|null;repos:string[];disabled?:boolean;unavailable?:string}{
  const watch=templateValue("github-issue-watch"), repos=githubIssueRepos();
  if(["off","false","disabled","none","0"].includes(watch)) return {untriaged:null,repos,disabled:true};
  const unknown=(unavailable:string)=>({untriaged:null,repos,unavailable});
  if(!repos.length) return unknown("GitHub repositories could not be observed");
  const version=spawnSync("gh",["--version"],{encoding:"utf8"});
  if(version.error||version.signal||version.status!==0) return unknown(`native gh unavailable: ${version.error?.message??version.stderr??version.status}`);
  const include=new Set(stringArray(templateValue("github-issue-include-labels"))), exclude=new Set(stringArray(templateValue("github-issue-exclude-labels"))), author=templateValue("github-issue-author");
  try{
    const traced:string[]=[];
    for(const status of ["open","in_progress","deferred"]){ const r=spawnSync("bd",["list","--status",status,"--limit","0","--json"],{cwd:ROOT,encoding:"utf8"}); traced.push(JSON.stringify(nativeJsonArray(r,`bd issue traces ${status}`,["id"]))); }
    const trace=traced.join("\n"), out:string[]=[];
    for(const repo of repos){
      const r=spawnSync("gh",["issue","list","-R",repo,"--state","open","--limit","100","--json","url,labels,author"],{encoding:"utf8"});
      for(const issue of nativeJsonArray(r,`gh issue list ${repo}`,["url","labels","author"])){
        if(!Array.isArray(issue.labels)) return unknown("gh issue labels were not an array");
        const labels=issue.labels.map((l:any)=>typeof l==="string"?l:l?.name).filter(Boolean);
        if(author&&issue.author?.login!==author) continue;
        if(include.size&&!labels.some((l:string)=>include.has(l))) continue;
        if(labels.some((l:string)=>exclude.has(l))) continue;
        if(issue.url&&!trace.includes(issue.url)) out.push(issue.url);
      }
    }
    return {untriaged:out.sort(),repos};
  }catch(e:any){ return unknown(e.message); }
}
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
// Only the default host lane is watched in production. Generic selftests must
// not observe the real host queue; opt-in fixtures relocate the endpoint under
// their own alerts root, never by changing the host admission lock domain.
function testLaneInfo(){
  const configured=minutesValue("alert-test-lane-held-minutes",60);
  const thresholdMs=(configured>=0?configured:60)*60_000;
  let lock="/tmp/wheelhouse-selftest-sweep.lock";
  if(process.env.WHEELHOUSE_SELFTEST_FIXTURE_NONCE!==undefined){
    const fixture=process.env.WHEELHOUSE_ALERTS_FIXTURE_TEST_LOCK;
    if(!fixture) return {status:"disabled",on:false,sig:"",detail:"",thresholdMs};
    try {
      const root=fs.realpathSync(ROOT), parent=fs.realpathSync(path.dirname(fixture));
      if(!path.isAbsolute(fixture)||path.join(parent,path.basename(fixture))!==fixture||!parent.startsWith(root+path.sep)) throw Error("fixture lane must be physically inside alerts root");
      lock=fixture;
    } catch(e:any){ return {status:"unavailable",on:false,sig:"",detail:e.message,thresholdMs}; }
  }
  const observed=observeTestLane(lock);
  if(observed.status!=="held") return {...observed,on:false,sig:"",detail:"",thresholdMs};
  const heldMs=Date.now()-Date.parse(observed.started);
  const on=heldMs>thresholdMs&&observed.waiting>0;
  const sig=JSON.stringify([observed.pid,observed.token,observed.started]);
  if(!on) return {...observed,on,sig,detail:"",thresholdMs,heldMs};
  // One bounded native table supplies the command and ancestry. An unreadable
  // table is unknown, never evidence of release or a made-up holder command.
  // An opt-in fixture still reads the real native table. Invalid overrides
  // fail closed, with the same physical containment checks as fixtureDocker.
  const fixturePs=process.env.WHEELHOUSE_SELFTEST_FIXTURE_NONCE!==undefined?process.env.WHEELHOUSE_ALERTS_FIXTURE_PS:undefined;
  const psBin=fixturePs===undefined?"ps":fixtureDocker(fixturePs);
  const ps=psBin?spawnSync(psBin,["-axo","pid=,ppid=,lstart=,command="],{encoding:"utf8",policyTimeoutMs:2000}):{status:null,error:{message:"fixture ps executable unavailable"},stdout:"",stderr:""};
  const rows=new Map<number,{parent:number;started:number;command:string}>();
  const tableSkipped={count:0,sample:""};
  let holderAmbiguous=false;
  const skip=(line:string)=>{ tableSkipped.count++; if(tableSkipped.count===1) tableSkipped.sample=line.slice(0,160); };
  for(const line of String(ps.stdout??"").slice(0,4*1024*1024).trimEnd().split("\n").filter(Boolean)){
    const m=/^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(line);
    if(!m||!Number.isFinite(Date.parse(m[3]))){ skip(line); continue; }
    const pid=Number(m[1]), row={parent:Number(m[2]),started:Date.parse(m[3]),command:m[4]}, prior=rows.get(pid);
    if(prior){
      // Never replace the holder's good row with a duplicate. Conflicting
      // parsed holder identities are unknown, not an arbitrary first/last win.
      if(pid===observed.pid&&(prior.parent!==row.parent||prior.started!==row.started||prior.command!==row.command)) holderAmbiguous=true;
      skip(line); continue;
    }
    rows.set(pid,row);
  }
  const table={tableRows:rows.size,tableSkipped};
  const unavailable=(reason:string,pid=observed.pid)=>({status:"unavailable",on:false,sig,thresholdMs,...table,
    detail:`${reason}: pid=${pid}; rows=${table.tableRows}; skipped=${tableSkipped.count}; first skipped=${tableSkipped.sample}`});
  if(ps.error||ps.signal||ps.status!==0||ps.stderr||String(ps.stdout??"").length>4*1024*1024) return unavailable("holder process table unavailable");
  if(holderAmbiguous) return unavailable("holder process row ambiguous");
  const holder=rows.get(observed.pid);
  if(!holder) return unavailable("holder process row absent");
  if(!rows.has(process.pid)) return unavailable("alert process row absent",process.pid);
  const state=readJson(path.join(SEATS,"state.json"))?.seats??{};
  let seat="unknown", cursor=observed.pid;
  const seen=new Set<number>();
  while(cursor>1&&!seen.has(cursor)){
    seen.add(cursor);
    for(const [name,record] of Object.entries<any>(state)){
      if(record.pid===cursor&&Math.abs((rows.get(cursor)?.started??NaN)-Date.parse(record.startedAt))<=2000){seat=name;break;}
    }
    if(seat!=="unknown") break;
    cursor=rows.get(cursor)?.parent??0;
  }
  if(seat==="unknown"){
    const lsof=spawnSync(Bun.which("lsof")||"/usr/sbin/lsof",["-a","-p",String(observed.pid),"-d","cwd","-Fn"],{encoding:"utf8",policyTimeoutMs:2000});
    if(!lsof.error&&!lsof.signal&&lsof.status===0){
      const cwd=lsof.stdout.split("\n").find((s:string)=>s.startsWith("n"))?.slice(1);
      const names=new Set([...Object.keys(state),...Object.keys(readJson(path.join(SEATS,"seats.json"))?.seats??{})]);
      for(const name of names){
        const candidates=[state[name]?.cwd,path.join(ROOT,".wheelhouse-worktrees",name)].filter(Boolean);
        for(const candidate of candidates) try {
          const worktree=fs.realpathSync(candidate);
          if(cwd&&(cwd===worktree||cwd.startsWith(worktree+path.sep))) seat=name;
        } catch {}
      }
    }
  }
  return {...observed,on,sig,thresholdMs,heldMs,seat,command:holder.command,...table,
    detail:`pid=${observed.pid}; command=${holder.command}; admitted=${observed.started}; heldMs=${heldMs}; waiting=${observed.waiting}; seat=${seat}`};
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
function remedyFor(name:AlertName){
  if(name==="test-lane-held") return "Cost: queued tests cannot start. Next: inspect the holder and decide deliberately whether intervention is needed. This alert never signals, stops, releases or renews the holder.";
  // Report nightly coverage; never auto-stop or change the installed fleet.
  if(name==="nightly-sweep-red") return "Cost: reviews require the full tier until a later nightly is green. Next: inspect the named sweep log and failed suites, repair them, and rerun the nightly; no core-only receipt may merge while the brake is on.";
  if(name==="nightly-sweep-missed") return "Cost: nightly full coverage is unknown; an earlier red brake remains in force. Next: inspect the reason, pause marker and host sweep holder, and schedule a retry when available; do not bypass or signal another sweep.";
 if(name==="docker-cache-pressure") return "Cost: cache pressure can prevent Docker builds and benches. Next: inspect the cache and run docker builder prune -f to remove regenerable build cache when appropriate. No automatic prune was performed."; if(name.startsWith("seat-stalled:")) return "Cost: delivery is waiting, even though the process is alive. Next: inspect the seat's own stream and redispatch after diagnosis; never interrupt a legitimate tool wait. No automatic abort or restart was performed."; if(name==="template-drift-check-failed") return "Cost: $0 directly; template drift is unknown. Next: inspect the retained drift failure in seats/run/fleet-snapshot.json and repair/retry the check."; if(name==="commander-pane-invalid") return "The commander pane target is invalid. Cost: $0 while noticed, but alerts and wakes may not reach the commander. Next: run seats/cockpit.sh to re-aim the commander pane and restart the herald, or run seats/cockpit.sh --claim-commander inside the pane your commander uses."; if(name==="inbox-lag") return "The fleet inbox has undrained rows for longer than the alert threshold. Cost: $0 directly, but workers may wait for attention. Next: inspect the commander's SessionStart, UserPromptSubmit and PostToolUse Bash inbox hooks (seats/inbox-hook.sh), their pane identity guard and delivery-failed log; restore hook delivery, then read the delivered records."; if(name==="idle-fleet-ready-work") return "Ready work exists while nobody is on it. Cost: $0 directly, but delivery is stalled. Next: spawn or resume seats and dispatch work; this clears itself once a worker is busy."; return "A fleet alert became active. Cost: $0. Next: inspect seats/run/fleet-snapshot.json; no action needed when the condition clears itself."; }
function maybeHuman(name:AlertName, st:AlertState, stream?:StreamHealth){ const age=Date.now()-Date.parse(st.since||now()); const humanAfter=minutesValue("alert-human-after-minutes",15)*60_000; if(stream && age>=seatStallNeedMs(ROOT)){ if(!st.needId) st.needId=needOpen(name,"A model stream needs attention",`An assigned worker's model stream remains silent. Its last own event was at ${stream.lastEventAt}. Cost: delivery is waiting while its process remains alive. Next: ask the commander to inspect the stream and recover or redispatch the work after diagnosis. No automatic restart was performed.`,stream); } else if(name==="commander-pane-invalid" || ((name==="inbox-lag"||name==="idle-fleet-ready-work") && age>=humanAfter)){ if(!st.needId) st.needId=needOpen(name,title(name),st.detail??bodyFor(name,"condition remains active")); } }

// Independent namespace/state from the unfinished-model-stream watchdog.
// No automatic dispatch, abort, capacity change or human need is created here.
function settledTaskAlerts(observations:Record<string,SettledSeat>, prior:Record<string,AlertState>, alerts:Record<string,AlertState>, unverified:Record<string,unknown>={}){
  const prefix="seat-settled-task:";
  const names=new Set([...Object.keys(observations).map(seat=>prefix+seat),...Object.keys(prior).filter(name=>name.startsWith(prefix))]);
  for(const name of names){
    if(unverified[name.slice(prefix.length)]) { if(prior[name]) alerts[name]=prior[name]; continue; }
    const observation=observations[name.slice(prefix.length)], was=prior[name];
    const signature=observation?JSON.stringify([observation.contextKey,observation.mode==="review"?null:observation.eventKey,observation.mode]):was?.signature??"";
    const next=alertRow(!!observation?.due,was,signature); next.detail=was?.detail;
    const raiseSettled=next.active&&(!was?.active||was.signature!==next.signature);
    if(raiseSettled){
      const o=observation, remedy=o.mode==="review"?"seat free for new work; redispatch when appropriate":"check the background work or redispatch";
      const detail=`Alert ${name}: seat=${o.seat}; task=${o.bead}; last event=${o.lastEvent} at ${o.lastEventAt} (${o.eventTimeSource}); quiet since=${o.quietSince}; thresholdMs=${o.quietMs}. Cost: $0 directly; a settled seat may be waiting unnecessarily. Next: ${remedy}.`;
      next.detail=detail; appendLog(`alert fired ${name}: ${detail}`);
      fs.mkdirSync(SEATS,{recursive:true});
      fs.appendFileSync(path.join(SEATS,"inbox.jsonl"),JSON.stringify({id:`alert-${name}-${crypto.randomUUID()}`,at:now(),seat:"herald",class:"alert",state:"input-required",title:o.mode==="review"?`seat free for new work — ${o.seat}`:`settled task needs attention — ${o.seat}`,detail,source:{type:"alerts",name},workerSeat:o.seat,bead:o.bead,lastEvent:o.lastEvent,lastEventAt:o.lastEventAt,mode:o.mode,quietSince:o.quietSince})+"\n");
    }
    if(!next.active&&was?.active) appendLog(`alert cleared ${name}`);
    alerts[name]=next;
  }
}

export async function buildSnapshot(root=ROOT):Promise<SnapshotFile>{
  const entries=readQuarantine(root); const quarantined={count:entries.length,names:entries.map(e=>e.suite)};
  const prior=readJson(SNAP) as SnapshotFile|null; const priorAlerts=prior?.alerts??{}; const snap=fleetSnapshot(root);
  const unverified=snap.unverified??={};
  const unknown=(seat:string,rec:any,reason:string)=>{
    const worker=snap.workers.live.find(w=>w.name===seat),reviewer=snap.reviewers.live.find(w=>w.name===seat);
    unverified[seat]={pid:rec.pid??null,role:worker?"worker":reviewer?"reviewer":rec.role??unverified[seat]?.role??"unknown",status:"UNVERIFIED",reason};
    for(const entry of [worker,reviewer]) if(entry){entry.busy=true;entry.identity="UNVERIFIED";}
  };
  const settledSeats=observeSettledSeats(root,snap.workers.live,prior?.settledSeats,Date.now(),unknown); const inbox=inboxStats(root); const needs=needCounts(root); const herald=heraldInfo(); const capacity={seats:capacitySeats()}; const disk=diskInfo(); const docker=await dockerCacheInfo(); const github=githubInfo(); const drift=driftInfo();
  const nightly=nightlyConditions(root);
  const testLane=testLaneInfo();
  const seatStreams=observeSeatStreams(root,prior?.seatStreams??{},Date.now(),unknown);
  for(const seat of Object.keys(unverified)){delete seatStreams[seat];delete settledSeats[seat];}
  snap.workers.busy=snap.workers.live.filter(w=>w.busy).length;snap.workers.idle=snap.workers.live.length-snap.workers.busy;
  snap.reviewers.busy=snap.reviewers.live.filter(w=>w.busy).length;snap.reviewers.idle=snap.reviewers.live.length-snap.reviewers.busy;
  const active:Record<AlertName,{on:boolean; sig:string; detail:string}>={
    "test-lane-held":testLane,
    "idle-fleet-ready-work":{on:readyWorkNobodyOnIt(snap),sig:"",detail:`ready=${snap.readyCount}; busy workers=${snap.workers.busy}; ready beads=${snap.ready.map(r=>r.id).join(", ")}`},
    "cold-seats-ready-work":{on:!hasUnverifiedWorkers(snap)&&snap.readyCount>0&&snap.workers.live.length===0,sig:"",detail:`ready=${snap.readyCount}; live workers=${snap.workers.live.length}; ready beads=${snap.ready.map(r=>r.id).join(", ")}`},
    "inbox-lag":{on:inbox.undrainedRows>0&&inbox.lagMs>=minutesValue("alert-inbox-lag-minutes",10)*60_000,sig:"",detail:`undrained rows=${inbox.undrainedRows}; oldest=${inbox.oldestUndrainedAt}; lagMs=${inbox.lagMs}`},
    "untriaged-github-issues":{on:Array.isArray(github.untriaged)&&github.untriaged.length>0,sig:Array.isArray(github.untriaged)?github.untriaged.join("\n"):"",detail:`untriaged issues=${(github.untriaged??[]).join(", ")}`},
    "capacity-events":{on:capacity.seats.length>0,sig:capacity.seats.join("\n"),detail:`capacity seats=${capacity.seats.join(", ")}`},
    "low-disk":{on:disk.freeBytes!==null&&disk.freeBytes<disk.thresholdBytes,sig:"",detail:`free bytes=${disk.freeBytes}; threshold bytes=${disk.thresholdBytes}`},
    "docker-cache-pressure":{on:docker.status==="ok"&&docker.cacheBytes!==null&&docker.cacheBytes>=docker.thresholdBytes,sig:"",detail:`cache pressure: build cache=${docker.cacheSize}; threshold bytes=${docker.thresholdBytes}`},
    "commander-pane-invalid":{on:herald.target?.status?herald.target.status!=="ok":false,sig:String(herald.target?.status??""),detail:`commander target status=${herald.target?.status??"unknown"}; pane=${herald.target?.target??"unknown"}`},
    "template-drift":{on:drift.status==="drift",sig:driftFileSetSignature(drift),detail:`modified=${JSON.stringify(drift.modified)}; localOnly=${JSON.stringify(drift.localOnly)}; missing=${JSON.stringify(drift.missing)}; aheadBy=${drift.aheadBy??"unknown"}`},
    "template-drift-check-failed":{on:drift.status==="check-failed",sig:drift.reason??"",detail:drift.reason??"drift check failed without a reason"},
    // Stable signatures refresh detail without another wake until a clear.
    "nightly-sweep-red":nightly.red,
    "nightly-sweep-missed":nightly.unavailable,
  };
  // Keep old keys long enough to clear their persistent condition/need when a
  // seat settles, stops, resumes progress, parks on capacity, or is removed.
  for(const name of Object.keys(priorAlerts)) if(name.startsWith("seat-stalled:")) active[name as AlertName]={on:false,sig:"",detail:""};
  for(const stream of Object.values(seatStreams)) active[`seat-stalled:${stream.seat}`]={on:stream.stalled,sig:`${stream.processKey}:${stream.bead??""}:${stream.progressKey}`,detail:`seat=${stream.seat}; task=${stream.bead??"unassigned"}; last own event=${stream.lastEvent} at ${stream.lastEventAt}; quietMs=${stream.quietForMs}; phase=${stream.phase}`};
  for(const name of Object.keys(priorAlerts)) if(name.startsWith("seat-unverified:")) active[name as AlertName]={on:false,sig:"",detail:""};
  for(const [seat,proof] of Object.entries(unverified)) active[`seat-unverified:${seat}`]={on:true,sig:proof.reason,detail:`seat=${seat}; pid=${proof.pid}; UNVERIFIED: ${proof.reason}; left untouched; repair/retry identity inspection, do not restart or reclaim`};
  const alerts:Record<string,AlertState>={};
  for(const name of Object.keys(active) as AlertName[]){
    if(name.startsWith("seat-stalled:")&&unverified[name.slice("seat-stalled:".length)]){if(priorAlerts[name])alerts[name]=priorAlerts[name];continue;}
    // Unknown observations cannot clear a last-known condition or reset its
    // pending hold. A confirmed clean drift result still follows the clear path.
    if((name==="untriaged-github-issues"&&github.untriaged===null&&!github.disabled)||(name==="low-disk"&&disk.freeBytes===null)||(name==="template-drift"&&drift.status==="check-failed")||(name==="docker-cache-pressure"&&docker.status==="unavailable")){ alerts[name]=priorAlerts[name]??alertRow(false,undefined,""); continue; }
    if(name==="test-lane-held"&&testLane.status==="unavailable"){alerts[name]=priorAlerts[name]??alertRow(false,undefined,"");continue;}
    const stored=priorAlerts[name], stream=name.startsWith("seat-stalled:")?seatStreams[name.slice("seat-stalled:".length)]:undefined;
    let was=name==="template-drift"&&stored ? {...stored,signature:priorDriftSignature(stored.signature)} : stored;
    if(stream?.stalled && was?.active && was.signature!==active[name].sig){ if(was.needId) needClose(was.needId); was=undefined; }
    const next=name==="template-drift" ? heldAlertRow(active[name].on,was,active[name].sig,TEMPLATE_DRIFT_ALERT_HOLD_MS) : alertRow(active[name].on,was,active[name].sig);
    next.detail=was?.detail;
    if((name.startsWith("nightly-sweep-")||name==="test-lane-held") && active[name].on) next.detail=bodyFor(name,active[name].detail);
    const shouldFire = next.active&&(!was?.active||was.signature!==next.signature);
    if(shouldFire){ next.detail=bodyFor(name,active[name].detail); appendLog(`alert fired ${name}: ${next.detail}`); appendInboxAlert(name,next.detail,stream); }
    if(!next.active&&was?.active){ appendLog(`alert cleared ${name}`); if(was.needId) needClose(was.needId); next.needId=null; }
    if(next.active) maybeHuman(name,next,stream);
    alerts[name]=next;
  }
  if(quarantined.count!==(prior?.quarantined?.count??0)) appendInboxAlert("quarantine",`Alert quarantine: count=${quarantined.count}; suites=${quarantined.names.join(", ")||"none"}. Cost: these suites keep running but their failures do not block review. Next: inspect each owner task and deadline in seats/selftest-quarantine.list.`);
  settledTaskAlerts(settledSeats,priorAlerts,alerts,unverified);
  return {at:now(),intervalMs:intervalMs(),snapshot:snap,herald,inbox,needs,capacity,disk,docker,github,drift,quarantined,seatStreams,nightly,alerts,settledSeats};
}
export async function check(json=false){ const fd=acquireLock(); if(fd===null){ console.log(json?JSON.stringify({ok:false,locked:true}):"alerts: check already running"); return; } try{ const data=await buildSnapshot(ROOT); writeAtomic(SNAP,JSON.stringify(data,null,2)+"\n"); console.log(json?JSON.stringify(data):`snapshot ${data.at} alerts=${Object.values(data.alerts).filter(a=>a.active).length}`); } catch(e:any){ appendLog(`STOP alerts check failed: ${e?.message??e}`); console.error(`STOP: alerts check failed: ${e?.message??e}`); process.exitCode=2; } finally { releaseLock(fd); } }
if(import.meta.main){ const [cmd,...rest]=process.argv.slice(2); if(cmd==="check") await check(rest.includes("--json")); else { console.error("usage: alerts.ts check [--json]"); process.exit(2); } }
