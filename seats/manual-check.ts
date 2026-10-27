#!/usr/bin/env bun
/** Read-only product maintenance. Only the coordinator posts findings. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { completedSpawnSync as completedCommand } from "./native-command";
import { readManual } from "./manual";
import { makeScratchCwd, readonlyBdPath, expandTilde } from "./verify";
import { linkFactorySkills } from "./seat-worktree";
import { hasPool } from "./pool";
import { effectiveRoster } from "./roster";
import { harnessNameForSeat, oneShotCommandForHarness, oneShotEnvForHarness } from "./harness";
import { finalAssistantText } from "./final-assistant-message";
import { hostBudgetPath } from "./host-budget";
import { acquirePidLock, releasePidLock } from "./lock";
import { CREDENTIAL_SHAPE_RE } from "./credential-shapes";
import { manualCheckChild } from "./manual-check-child";

const ROOT = path.resolve(process.env.WHEELHOUSE_MANUAL_CHECK_ROOT || path.join(import.meta.dir,".."));
const HELPER_MS = 10000;
export interface Finding { kind: "drift"|"unmapped"|"break"; feature: string; text: string }
export function parseFindings(text: string): Finding[] {
  const lines = text.trim().split(/\r?\n/);let fenced=false;const headers:number[]=[];
  for(let i=0;i<lines.length;i++) { if(/^\s*(```|~~~)/.test(lines[i])) fenced=!fenced;else if(!fenced && /^FINDINGS:/.test(lines[i])) headers.push(i); }
  if(headers.length!==1)throw new Error("expected one trailing unfenced FINDINGS block");
  const i=headers[0];
  if(lines[i]==="FINDINGS: none") {if(lines.length!==1)throw new Error("FINDINGS: none must be the entire final answer");return [];}
  if(lines[i]!=="FINDINGS:" || i===lines.length-1)throw new Error("empty or malformed FINDINGS block");
  const findings=lines.slice(i+1).map(line=>{
    const m=/^- (drift|unmapped|break) — (\S(?:.*?\S)?) — (\S.*)$/.exec(line);
    if(!m || /[\x00-\x1f]/.test(line) || line.length>8192)throw new Error("malformed FINDINGS row");
    return {kind:m[1] as Finding['kind'],feature:m[2],text:m[3]};
  });
  if(findings.length>100)throw new Error("too many findings");
  const keys=findings.map(f=>`${f.kind}:${f.feature}`);if(new Set(keys).size!==keys.length)throw new Error("duplicate finding source in answer");
  return findings;
}
function fail(message:string,code=3):never { throw Object.assign(new Error(message),{code}); }
function command(bin:string,args:string[],cwd=ROOT,env:NodeJS.ProcessEnv=process.env) {
  const r=completedCommand(bin,args,{cwd,env,encoding:"utf8",policyTimeoutMs:HELPER_MS});
  if(r.error || r.signal || r.status!==0)fail(`${path.basename(bin)} helper failed: ${r.error?.message ?? `status=${r.status} signal=${r.signal}`} ${r.stderr}`,3);
  return r.stdout.trim();
}
function git(repo:string,...args:string[]){return command("git",args,repo);}
function snapshot(repo:string){return JSON.stringify({head:git(repo,"rev-parse","HEAD"),status:git(repo,"status","--porcelain","--untracked-files=all"),refs:git(repo,"for-each-ref","--format=%(refname):%(objectname)"),diff:git(repo,"diff","--binary","HEAD")});}
function productRepos(explicit:string[]) {
  if(explicit.length)return [...new Set(explicit.map(x=>fs.realpathSync(path.resolve(ROOT,expandTilde(x)))))];
  let config="";try{config=fs.readFileSync(path.join(ROOT,"wheelhouse/.template-source"),"utf8");}catch(e:any){if(e.code!=="ENOENT")throw e;}
  const row=config.split("\n").find(x=>/^(product-repo|product-repos|product_repo|product_repos)=/.test(x));
  return [...new Set((row?row.slice(row.indexOf("=")+1).split(/[,;]/):[ROOT]).map(x=>fs.realpathSync(path.resolve(ROOT,expandTilde(x.trim())))))];
}
function pickSeat(explicit?:string) {
  let roster:any;
  try { roster=hasPool(ROOT)?effectiveRoster(ROOT):JSON.parse(fs.readFileSync(path.join(ROOT,"seats/seats.json"),"utf8")).seats; }
  catch { fail('no verifier roster available',2); }
  const live=(name:string)=>{for(const prefix of ['walk.','manual-check.'])try{const x=JSON.parse(fs.readFileSync(path.join(ROOT,"seats/run",prefix+name+".json"),"utf8"));process.kill(x.pid,0);return true;}catch(e:any){if(!['ENOENT','ESRCH'].includes(e.code))throw e;}return false;};
  const candidates=Object.entries(roster).filter(([name,e]:any)=>(!explicit || name===explicit)&&e.role==='verifier'&&!e.external&&!live(name));
  if(!candidates.length)fail("no free non-external verifier seat; retry after the active walk or configure a verifier",2);
  const [name,entry]=candidates[0] as [string,any];
  const harness=harnessNameForSeat(name,entry),dir=path.resolve(expandTilde(entry.account?.dir||""));
  if(!entry.account?.dir || !fs.existsSync(dir))fail(`verifier ${name} has no account directory`,2);
  const envKey=entry.provider==='openai-codex'?'OPENAI_CODEX_API_KEY':`${String(entry.provider).toUpperCase().replace(/-/g,'_')}_API_KEY`;
  const file=path.join(dir,harness==='claude-code'?'.claude.json':'auth.json');let authenticated=false;
  try {const raw=fs.readFileSync(file,'utf8');authenticated=harness==='claude-code'?!!JSON.parse(raw).oauthAccount:!!raw.replace(/[{}\s]/g,'');}catch{}
  if(entry.account.authRoute==='env'? !process.env[envKey]:!authenticated)fail(`verifier ${name} has no resolved credential`,2);
  return {name,entry,dir,harness};
}
function readonlyTools(out:string,cwd:string) {
  const bin=path.join(out,"readonly-bin");fs.mkdirSync(bin,{recursive:true});
  const real=command("sh",["-c","command -v git"]);
  fs.writeFileSync(path.join(bin,"git"),`#!/usr/bin/env bash\ncase "\u0024{1:-}" in\nstatus|log|show|diff|rev-parse|ls-files|ls-tree|cat-file) exec ${JSON.stringify(real)} "\u0024@";;\nbranch) [ "\u0024#" = 2 ] && [ "\u0024{2:-}" = --list ] && exec ${JSON.stringify(real)} "\u0024@";;\nesac\necho 'manual-check: read-only version-control command refused' >&2\nexit 2\n`,{mode:0o755});
  fs.writeFileSync(path.join(bin,"gh"),'#!/bin/sh\necho "manual-check: publication unavailable" >&2\nexit 2\n',{mode:0o755});
  return readonlyBdPath(ROOT,`${bin}${path.delimiter}${hostBudgetPath(ROOT)}`,out);
}
function failure(message:string) {
  fs.mkdirSync(path.join(ROOT,'seats'),{recursive:true});
  fs.appendFileSync(path.join(ROOT,'seats/inbox.jsonl'),JSON.stringify({id:crypto.randomUUID(),at:new Date().toISOString(),seat:'manual-check',class:'manual-check-failed',state:'failed',title:'manual check stopped',detail:message})+'\n');
}
async function main(argv:string[]) {
  const repos:string[]=[];let outArg:string|undefined,seatArg:string|undefined;
  for(let i=0;i<argv.length;i++){const key=argv[i],value=argv[++i];if(!value||value.startsWith('--'))fail('usage: manual-check.ts [--repo <path>] [--verifier <seat>] [--out <path>]',2);if(key==='--repo')repos.push(value);else if(key==='--verifier'&&!seatArg)seatArg=value;else if(key==='--out'&&!outArg)outArg=value;else fail('unknown or duplicate option',2);}
  const budget=Number(process.env.WHEELHOUSE_MANUAL_CHECK_TIMEOUT_MS||1800000);if(!Number.isSafeInteger(budget)||budget<=0||budget>1800000)fail('manual-check timeout must be 1..1800000ms',2);
  fs.mkdirSync(path.join(ROOT,'seats/run'),{recursive:true});fs.mkdirSync(path.join(ROOT,'seats/logs'),{recursive:true});
  const lock=path.join(ROOT,'seats/run/manual-check.lock'),fd=acquirePidLock(lock);if(fd===null)fail('manual check already running',2);
  try {const lastFile=path.join(ROOT,'seats/run/manual-check.last.json');let previous:any={};try{previous=JSON.parse(fs.readFileSync(lastFile,'utf8'));}catch(e:any){if(e.code!=='ENOENT')throw e;}
  const out=path.resolve(ROOT,outArg||path.join('seats/verdicts/manual-check',new Date().toISOString().replace(/[:.]/g,'-')));
  let posted=0,deduped=0,checked=0;const results:any[]=[];
  for(const product of productRepos(repos)) {
    const skills=path.join(product,'.agents/skills');
    const present=fs.existsSync(skills)&&fs.readdirSync(skills).some(name=>name.startsWith('verify-')&&fs.existsSync(path.join(skills,name,'SKILL.md')));
    // A loose factory fixture must not borrow an ancestor repository. Real
    // product roots still inspect their DEFAULT tip even if the current branch
    // predates the committed manual.
    if(!present&&!fs.existsSync(path.join(product,'.git'))){results.push({repo:product,skipped:'no manual'});continue;}
    const repo=git(product,'rev-parse','--show-toplevel'),relative=path.relative(repo,product);
    const outRelative=path.relative(repo,out);
    if(outRelative===''||(!outRelative.startsWith('..')&&!path.isAbsolute(outRelative))) {
      const ignored=completedCommand('git',['check-ignore','--',outRelative],{cwd:repo,encoding:'utf8',policyTimeoutMs:HELPER_MS});
      if(ignored.error||ignored.signal||ignored.status!==0)fail('--out must be outside product source or explicitly git-ignored',2);
    }
    fs.mkdirSync(out,{recursive:true});
    const refs=git(repo,'for-each-ref','--format=%(refname)');const origin=refs.split('\n').includes('refs/remotes/origin/HEAD')?git(repo,'symbolic-ref','--short','refs/remotes/origin/HEAD'):undefined;
    const line=origin||(['main','master'].find(x=>refs.split('\n').includes('refs/heads/'+x)));if(!line)fail('cannot identify product default line (origin/HEAD, main or master)',2);
    const tip=git(repo,'rev-parse',`${line}^{commit}`),original=snapshot(repo),scratch=makeScratchCwd(repo,'verify',tip,{throwOnError:true,coordinatedSignals:true}),cwd=path.join(scratch,relative);
    linkFactorySkills(ROOT,scratch);
    let manual;try{manual=readManual(cwd);}catch(e:any){if(String(e.message).includes('no verification manual')){results.push({repo:product,tip,skipped:'no manual'});continue;}throw e;}
    if(manual.surface==='none'){results.push({repo:product,tip,skipped:'surface: none'});continue;}
    const before=snapshot(scratch);if(JSON.parse(before).status)fail('scratch product tree is not clean before maintenance');
    const selected=pickSeat(seatArg),dir=path.join(out,crypto.createHash('sha256').update(product).digest('hex').slice(0,12));if(fs.existsSync(path.join(dir,'native.json')))fail('evidence already exists; use a fresh --out',2);fs.mkdirSync(dir,{recursive:true});
    const since=previous.repos?.[product]?.at||new Date(Date.now()-7*86400000).toISOString();
    const recent=git(scratch,'log',`--since=${since}`,'--format=%H %s','--name-status',tip);
    const skillFile=path.join(ROOT,'.agents/skills/maintain-verification/SKILL.md'),skill=fs.readFileSync(skillFile,'utf8');
    const brief=path.join(dir,'maintain-brief.md');fs.writeFileSync(brief,skill.replace(/^---[\s\S]*?---\s*/, '')+'\nRead-only pass. No repository edits, graph writes, version-control mutations or publication. The coordinator alone posts findings. Never detach helpers from their owning process group. Stop every instance/helper you start before returning.\n');
    const prompt=[`Manual: ${manual.file}`,`Pinned default-line tip: ${tip}`,`Recent changes since ${since}:`,recent,`Mapped features (attempt EVERY named entry, retain each result):`,...manual.features.map(f=>`${f.slug}: ${f.file}`),`Use the manual's Launch, Doctor, Drive, Evidence and Cleanup. A failed mapped journey is a finding, not permission to skip the remaining entries or alter the recipe.`, `Caller-owned RUN_DIR: ${path.join(dir,'runtime')}`,`Caller-owned EVIDENCE_DIR and --out: ${path.join(dir,'evidence')}`,`Keep all runtime state and evidence there, outside product source; use an isolated non-production port/socket.`, `For mapped findings use the exact inventory slug; for unmapped findings use the concrete route, command or source path.`, `This brief body comes from ${skillFile}; resolve its source/notice links relative to that file. Findings concern the product, not factory metadata.`, `Read product source/recent changes for unmapped features, but no fleet history, private logs or author reports. End with the skill's exact FINDINGS block.`].join('\n');
    fs.writeFileSync(path.join(dir,'prompt.txt'),prompt);fs.writeFileSync(path.join(dir,'before.json'),JSON.stringify({tip,original:JSON.parse(original),scratch:JSON.parse(before),cwd,manual:manual.file,manualVersion:manual.version,skillVersion:skill.match(/^version:\s*(.+)$/m)?.[1],since,features:manual.features.map(f=>f.slug)},null,2));
    const one=oneShotCommandForHarness(selected.harness,brief,selected.entry.provider,selected.entry.model,prompt,selected.harness==='claude-code'?'Read,Bash,Glob,Grep':'read,bash',selected.entry.disallowedTools);
    if(selected.harness==='pi')one.args.splice(one.args.length-1,0,'--tools','read,bash');
    const marker=path.join(ROOT,`seats/run/manual-check.${selected.name}.json`);fs.writeFileSync(marker,JSON.stringify({pid:process.pid,repo:product,at:new Date().toISOString()})+'\n');
    let run;try {run=await manualCheckChild(one.bin,one.args,cwd,oneShotEnvForHarness(selected.harness,selected.dir,{...process.env,PATH:readonlyTools(dir,cwd),WHEELHOUSE_ROOT:ROOT,RUN_DIR:path.join(dir,'runtime'),EVIDENCE_DIR:path.join(dir,'evidence')}),budget);}finally{fs.unlinkSync(marker);}
    fs.writeFileSync(path.join(dir,'native.json'),JSON.stringify(run,null,2)+'\n');fs.writeFileSync(path.join(dir,'stdout.txt'),run.stdout);fs.writeFileSync(path.join(dir,'stderr.txt'),run.stderr);
    fs.appendFileSync(path.join(ROOT,'seats/logs/manual-check.out.log'),`tip=${tip} repo=${product}\n--- stdout ---\n${run.stdout}\n--- stderr ---\n${run.stderr}\n`);
    const after=snapshot(scratch),afterOriginal=snapshot(repo);fs.writeFileSync(path.join(dir,'after.json'),JSON.stringify({scratch:JSON.parse(after),original:JSON.parse(afterOriginal)},null,2));
    if(after!==before||afterOriginal!==original)fail('edited tree, changed HEAD or branch/ref list; refusing all findings');
    if(run.policy||run.spawnError||run.signal||run.status!==0||!run.stdoutEOF||!run.stderrEOF)fail(`maintain helper failed: ${run.policy||run.spawnError||`status=${run.status} signal=${run.signal}`}`);
    const findings=parseFindings(finalAssistantText(run.stdout,selected.harness));
    const plan=findings.map(f=>({...f,source:`manual-check:${f.kind}:${f.feature}`,title:`${f.kind}: ${f.feature}`,text:`${f.text}\nManual: ${manual.file}\nTip: ${tip}`}));
    for(const row of plan)for(const value of [row.source,row.title,row.text,row.feature])if(new RegExp(CREDENTIAL_SHAPE_RE).test(value))fail('credential-shaped finding refused');
    const intakeEnv={...process.env,WHEELHOUSE_INTAKE_ROOT:ROOT};const open=JSON.parse(command('bun',[path.join(ROOT,'seats/intake.ts'),'list','--open','--json'],ROOT,intakeEnv));
    const sources=new Set(open.map((r:any)=>r.posted.source));let count=0;
    for(const f of plan) {if(sources.has(f.source)){deduped++;continue;}const id=command('bun',[path.join(ROOT,'seats/intake.ts'),'post','--kind','finding','--source',f.source,'--title',f.title,'--ref',f.feature,'--text',f.text],ROOT,intakeEnv);console.log(`${id} finding ${f.source} — ${f.text.split('\n')[0]}`);posted++;count++;sources.add(f.source);}
    checked++;results.push({repo:product,tip,manual:manual.file,at:new Date().toISOString(),findings,posted:count,out:dir});
  }
  const state={at:new Date().toISOString(),tip:results.at(-1)?.tip,counts:{checked,posted,deduped},repos:{...(previous.repos||{}),...Object.fromEntries(results.map(r=>[r.repo,r]))}};
  const tmp=lastFile+`.${process.pid}.tmp`;fs.writeFileSync(tmp,JSON.stringify(state,null,2)+'\n');fs.renameSync(tmp,lastFile);
  console.log(`manual-check: checked=${checked} posted=${posted} deduped=${deduped}`);
  } finally {releasePidLock(lock,fd);}
}
if(import.meta.main) main(process.argv.slice(2)).catch((e:any)=>{failure(String(e.message));console.error(`STOP: ${e.message}`);process.exitCode=e.code===2?2:3;});
