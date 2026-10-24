#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";
import { completedSpawnSync as spawnSync, nativeJsonArray } from "./native-command";
import { templateValue, repoFromRemote } from "./alerts";
import { rosterSeatActors } from "./comms";
import { CREDENTIAL_SHAPE_RE } from "./credential-shapes";

const ROOT = path.resolve(process.env.WHEELHOUSE_REPORT_ROOT || path.join(import.meta.dir, ".."));
const SEATS = path.join(ROOT, "seats");
const RUN = path.join(SEATS, "run");

type Route = { label:string; repo:string };
type Issue = { number?:number; title?:string; body?:string; url?:string };
type Task = { id:string; title:string; description:string; labels:string[]; externalRef:string; route:Route; status?:string };

function stop(msg:string):never{ console.error(`STOP: ${msg}`); process.exit(2); }
function run(bin:string,args:string[],opts:any={}){ return spawnSync(bin,args,{cwd:ROOT,encoding:"utf8",...opts}); }
function gh(args:string[],opts:any={}){ return spawnSync("gh",args,{cwd:ROOT,encoding:"utf8",...opts}); }
function bd(args:string[],opts:any={}){ return spawnSync("bd",args,{cwd:ROOT,encoding:"utf8",...opts}); }
function records(result:any,label:string,required:string[]=[]):any[]{ try{return nativeJsonArray(result,label,required)}catch(e:any){stop(e.message)} }
function ns(){ return templateValue("namespace", ROOT) || path.basename(ROOT); }
function commit(){ return templateValue("commit", ROOT) || "unknown"; }
function installed(){ return templateValue("upgraded", ROOT) || templateValue("installed", ROOT) || "unknown-date"; }
function normTitle(s:string){ return s.trim().replace(/\s+/g," ").toLowerCase(); }
function marker(id:string){ return `<!-- wheelhouse-report namespace=${ns()} bead=${id} -->`; }
function repoOk(repo:string){ return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo); }

function routeConfig():Route[]{
  const raw=templateValue("github-report-routes", ROOT);
  if(raw){
    return raw.split(/[,;]/).map(s=>s.trim()).filter(Boolean).map(pair=>{
      const i=pair.indexOf(":"); if(i<=0) stop(`bad github-report-routes entry ${pair}`);
      const label=pair.slice(0,i).trim(), repo=pair.slice(i+1).trim();
      if(!repoOk(repo)) stop(`bad github-report-routes repo ${repo}`);
      return {label, repo};
    });
  }
  const source=templateValue("source", ROOT);
  const repo=repoFromRemote(source);
  if(!source || !/github\.com[:/]/.test(source) || !repoOk(repo)) stop(`github-report-routes empty and source= is not a github.com owner/repo remote: ${source || "<missing>"}`);
  return [{label:"template-report", repo}];
}

function off(){ return templateValue("github-report", ROOT) !== "on"; }
function enforceCommander(){ const actor=process.env.BEADS_ACTOR||""; if(actor && rosterSeatActors(ROOT).has(actor)) stop("seats do not publish to GitHub; file the finding as a template-report task and the commander publishes"); }
function ghVersionOk(){ return gh(["--version"],{stdio:"ignore"}).status===0; }
function ghAuthOk(){ return gh(["auth","status"],{stdio:"ignore"}).status===0; }
function externalRef(row:any):string{ return String(row.external_ref ?? row.externalRef ?? row.externalReference ?? row.external ?? ""); }
// bd 1.2.2 stores `bd update <id> --external-ref <url>` as external_ref in JSON rows.
function rowLabels(row:any):string[]{ return Array.isArray(row.labels) ? row.labels.map(String) : []; }

function listTasksForRoute(route:Route, bead?:string):Task[]{
  const rows:any[]=[];
  for(const st of ["open","in_progress"]){
    const r=bd(["list","--label",route.label,"--status",st,"--limit","0","--json"]);
    rows.push(...records(r,`bd list ${route.label}/${st}`,["id"]).map(x=>({...x,status:st})));
  }
  const seen=new Set<string>(); const out:Task[]=[];
  for(const row of rows){
    const id=String(row.id||""); if(!id || seen.has(id)) continue; seen.add(id);
    if(bead && id!==bead) continue;
    out.push({id,title:String(row.title||""),description:String(row.description||""),labels:rowLabels(row),externalRef:externalRef(row),route,status:row.status});
  }
  return out;
}
function candidates(routes:Route[], bead?:string){ return routes.flatMap(r=>listTasksForRoute(r,bead)); }
function bdShow(id:string):any{ const rows=records(bd(["show",id,"--json"]),`bd show ${id}`,["id"]); if(rows.length!==1||rows[0].id!==id) stop(`bd show ${id} did not return the requested task`); return rows[0]; }
function comments(id:string):any[]{ return records(bd(["comments",id,"--json"]),`bd comments ${id}`); }
function scrub(body:string):string{
  const script=path.join(SEATS,"evidence-scrub.sh");
  const r=spawnSync("bash",["-c",`. ${JSON.stringify(script)}; scrub_evidence`],{input:body,encoding:"utf8",env:{...process.env, WHEELHOUSE_ROOT:ROOT}});
  if(r.status!==0) stop(`evidence scrub failed: ${(r.stderr||r.stdout).trim()}`);
  return r.stdout;
}
function bodyFor(t:Task):string{
  const full=bdShow(t.id); const desc=String(full?.description ?? t.description ?? "");
  const notes=String(full?.notes ?? full?.note ?? "");
  const parts=[`Description\n\n${desc||"(none)"}`];
  if(notes) parts.push(`Notes\n\n${notes}`);
  const cs=comments(t.id); if(cs.length) parts.push(`Comments\n\n`+cs.map(c=>`### ${c.author||"unknown"}\n\n${c.text||c.body||""}`).join("\n\n"));
  parts.push(`Filed by wheelhouse install ${ns()} from template commit ${commit()} (${installed()}).`);
  parts.push(marker(t.id));
  return scrub(parts.join("\n\n"));
}
function credentialShaped(body:string){ return new RegExp(CREDENTIAL_SHAPE_RE).test(body); }
function issueList(repo:string):Issue[]{ const r=gh(["issue","list","-R",repo,"--state","open","--limit","200","--json","number,title,body,url"]); return records(r,`gh issue list ${repo}`,["title","url"]); }
function dedupe(t:Task, issues:Issue[]):string|undefined{ const m=marker(t.id), nt=normTitle(t.title); return issues.find(i=>(i.body||"").includes(m)||normTitle(i.title||"")===nt)?.url; }
function updateRef(id:string,url:string){ const r=bd(["update",id,"--external-ref",url]); if(r.status!==0) stop(`bd update ${id} --external-ref failed: ${(r.stderr||r.stdout).trim()}`); }
function createIssue(t:Task, body:string):string{
  fs.mkdirSync(RUN,{recursive:true}); const f=path.join(RUN,`report-issue.${process.pid}.${t.id.replace(/[^A-Za-z0-9_.-]/g,"_")}.md`);
  try{ fs.writeFileSync(f,body); const r=gh(["issue","create","-R",t.route.repo,"--title",t.title,"--body-file",f]); if(r.status!==0) stop(`gh issue create failed for ${t.id}`); const lines=(r.stdout||"").split(/\r?\n/).filter(Boolean); const url=lines.reverse().find(l=>/^https:\/\/github\.com\//.test(l.trim()))?.trim(); if(!url) stop(`gh issue create for ${t.id} printed no GitHub URL`); return url; }
  finally{ try{fs.unlinkSync(f)}catch{} }
}

function status(){
  const sw=templateValue("github-report", ROOT)||"<missing>";
  console.log(`github-report=${sw}`);
  if(off()){ console.log("report-issues: off (set github-report=on in wheelhouse/.template-source to enable)"); return; }
  let routes:Route[]=[]; try{routes=routeConfig()}catch(e:any){ console.log(`report-issues: ${e.message}`); routes=[]; }
  console.log(`routes=${routes.map(r=>`${r.label}->${r.repo}`).join(",")||"<none>"}`);
  const gv=ghVersionOk(); console.log(`gh=${gv?"present":"missing"}`); console.log(`gh-auth-status=${gv ? gh(["auth","status"],{stdio:"ignore"}).status : "skipped"}`);
  for(const r of routes){ let n=0; try{n=listTasksForRoute(r).length}catch{} console.log(`candidates ${r.label}->${r.repo}: ${n}`); }
}
function publish(argv:string[]){
  enforceCommander();
  const yes=argv.includes("--yes"); const bi=argv.indexOf("--bead"); const bead=bi>=0?argv[bi+1]:undefined;
  if(off()){ console.log("report-issues: off (set github-report=on in wheelhouse/.template-source to enable)"); return; }
  if(!ghVersionOk()){ console.log("report-issues: skipped, gh is not installed"); return; }
  if(!ghAuthOk()) stop("gh is not signed in");
  const routes=routeConfig(); const byRepo=new Map<string,Issue[]>(); let refused=0;
  for(const t of candidates(routes,bead)){
    if(t.externalRef.startsWith("https://github.com/")){ console.log(`skip ${t.id}: external-ref already ${t.externalRef}`); continue; }
    if(!byRepo.has(t.route.repo)) byRepo.set(t.route.repo, issueList(t.route.repo));
    const body=bodyFor(t);
    if(credentialShaped(body)){ console.log(`skip ${t.id}: credential-shaped text in body`); refused=2; continue; }
    const hit=dedupe(t, byRepo.get(t.route.repo)!);
    if(hit){ if(yes){ updateRef(t.id,hit); console.log(`linked ${t.id} ${hit}`); } else console.log(`would link ${t.id} -> ${hit}`); continue; }
    if(!yes){ console.log(`would file ${t.id} -> ${t.route.repo}: ${t.title}`); continue; }
    const url=createIssue(t,body); updateRef(t.id,url); console.log(`filed ${t.id} ${url}`);
  }
  if(refused) process.exitCode=refused;
}

if(import.meta.main){ const [cmd,...rest]=process.argv.slice(2); if(cmd==="status") status(); else if(cmd==="publish") publish(rest); else { console.error("usage: seats/report-issues.ts status|publish [--yes] [--bead <id>]"); process.exit(2); } }
