import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";

const [parentArg, selected = "all"] = process.argv.slice(2);
const parent = fs.realpathSync(parentArg), runtime = path.join(parent, "runtime/seats");
assert(fs.statSync(path.join(parent, ".wheelhouse-selftest-fixture")).isFile());
assert(fs.statSync(path.join(runtime, "seat-worktree.ts")).isFile());
const invalid = ["", ".", "..", "../victim", "a/b", "a\\b", "with space", "a'", 'a"', "a`", "a\nb"];
const specs: any[] = invalid.map((seat, i) => ({kind: "segment-" + i, group: "worktree", action: "dir", seat}));
specs.push(
  {kind:"worktree-traversal",group:"worktree",action:"worktree",seat:"../victim"},
  {kind:"worktree-symlink",group:"worktree",action:"worktree",seat:"worker-link"},
  {kind:"worktree-fifo",group:"worktree",action:"worktree",seat:"worker-fifo"},
  ...["workers","reviewers"].flatMap(role => [
    {kind:"add-"+role,group:"staffing",action:"add",seat:"../../victim/KEEP",role},
    {kind:"drop-"+role,group:"staffing",action:"drop",seat:"../../victim/KEEP",role},
  ]),
  ...["traversal","run-symlink","leaf-symlink","parent-fifo"].map(variant => ({kind:"state-"+variant,group:"staffing",action:"state",seat:variant==="traversal"?"../../victim/KEEP":"worker-safe"})),
  {kind:"main-drop",group:"staffing",action:"main",seat:"../../victim/KEEP"},
);
const cases = specs.filter(s => selected === "all" || s.group === selected);
assert(cases.length);
function run(command: string, args: string[], cwd: string, env = process.env) {
  const r = spawnSync(command, args, {cwd,env,encoding:"utf8",timeout:30000,maxBuffer:4*1024*1024});
  return {command:[command,...args],code:r.status,signal:r.signal,error:r.error?.message??null,out:r.stdout??"",err:r.stderr??""};
}
function snap(file: string): any {
  try { const st=fs.lstatSync(file); return {dev:st.dev,ino:st.ino,mode:st.mode,nlink:st.nlink,size:st.size,mtime:st.mtimeMs,bytes:st.isFile()?fs.readFileSync(file).toString("base64"):null,link:st.isSymbolicLink()?fs.readlinkSync(file):null,entries:st.isDirectory()?fs.readdirSync(file).sort():null}; }
  catch(e:any){if(e.code==="ENOENT"||e.code==="ENOTDIR")return{missing:true,code:e.code};throw e;}
}
const runner = `import fs from 'node:fs';import path from 'node:path';import {mock} from 'bun:test';
const s=JSON.parse(process.env.PATH_SAFETY_SPEC),root=s.root;let value=null,error=null;
try {
 if(s.action==='dir'||s.action==='worktree') {const m=await import('./seat-worktree.ts');value=s.action==='dir'?m.seatWorktreeDir(root,s.seat):m.removeSeatWorktree(root,s.seat);}
 else {
  if(s.action==='main'){const original=await import('./fleet-snapshot');mock.module('./fleet-snapshot',()=>({...original,fleetSnapshot:()=>s.snapshot}));}
  const m=await import('./staffing.ts'),staff=JSON.parse(fs.readFileSync(root+'/seats/staffing.json','utf8'));
  const d={kind:s.action==='add'?(s.role==='reviewers'?'add-reviewer':'add-worker'):'drop-seat',role:s.role??'workers',seat:s.seat,entry:'e1',reason:'owned fixture',decider:'rule'};
  if(s.action==='add')value=m.applyAdd(root,{},staff,d);
  else if(s.action==='drop')value=m.applyDrop(root,staff,d,s.snapshot);
  else if(s.action==='state')value=m.removeState(root,s.seat);
  else {await m.main(['drop',s.seat,'--json'],root);value=JSON.parse(fs.readFileSync(root+'/seats/staffing.json','utf8')).lastCheck.decision;}
 }
} catch(e){error={name:e.name,message:e.message};}
console.log('PATH_SAFETY_RESULT '+JSON.stringify({value:value??null,error}));\n`;
let failed=0;
for(const spec of cases){
 const root=fs.mkdtempSync(path.join(parent,"case-"));
 fs.cpSync(runtime,path.join(root,"seats"),{recursive:true});
 // Expose private applying helpers ONLY in the disposable copy. Their bodies,
 // imports and callers remain real; no new production API/test-only branch.
 fs.appendFileSync(path.join(root,"seats/staffing.ts"),'\nexport { applyAdd, applyDrop, removeState };\n');
 fs.writeFileSync(path.join(root,"seats/path-safety-runner.mjs"),runner);
 for(const dir of ["seats/run","seats/logs","victim","bin","wheelhouse","home/.pi-seats-safety/e1"])fs.mkdirSync(path.join(root,dir),{recursive:true});
 const victim=path.join(root,"victim/KEEP.stdin"),state=path.join(root,"seats/state.json"),staffing=path.join(root,"seats/staffing.json"),calls=path.join(root,"adapter-calls.jsonl");
 fs.writeFileSync(victim,"KEEP outside seats/run\n");
 fs.writeFileSync(state,JSON.stringify({seats:{[spec.seat]:{pid:null,log:path.join(root,"seats/logs/fixture.jsonl")}}})+"\n");
 fs.writeFileSync(staffing,JSON.stringify({version:1,seats:{[spec.seat]:{role:"worker",entry:"e1",addedAt:"2026-01-01T00:00:00Z"}},rateLimited:{}})+"\n");
 fs.writeFileSync(path.join(root,"wheelhouse/.template-source"),"namespace=safety\nseat_push=off\n");
 fs.writeFileSync(path.join(root,"seats/seats.json"),'{"seats":{}}\n');
 fs.writeFileSync(path.join(root,"seats/pool.json"),JSON.stringify({version:1,entries:{e1:{harness:"pi",provider:"fixture",models:["m"],account:{dir:path.join(root,"home/.pi-seats-safety/e1"),authRoute:"env"}}},roles:{workers:{min:0,max:1,entries:["e1"],model:"m"}}}));
 // Log and delegate real adapter calls: invalid decisions must not reach even
 // the CLI (which already rejects them). No fake successful stop is supplied.
 fs.writeFileSync(path.join(root,"bin/bun"),`#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$PATH_SAFETY_CALLS"\nexec ${JSON.stringify(process.execPath)} "$@"\n`,{mode:0o755});
 const paths=[state,staffing,victim,calls],native:any[]=[];
 let registration:string|undefined;
 if(spec.action==="worktree"){
  const git=(args:string[])=>{const r=run("git",["-C",root,...args],root);native.push(r);assert.equal(r.code,0,JSON.stringify(r));return r.out;};
  git(["init","-q","-b","main"]);git(["config","user.name","Path Safety"]);git(["config","user.email","selftest@example.invalid"]);
  if(spec.kind!=="worktree-fifo"){fs.unlinkSync(victim);fs.rmdirSync(path.join(root,"victim"));}
  fs.writeFileSync(path.join(root,"KEEP"),"KEEP linked worktree\n");fs.writeFileSync(path.join(root,"KEEP.stdin"),"KEEP outside seats/run\n");git(["add","KEEP","KEEP.stdin"]);git(["commit","-qm","owned fixture"]);
  fs.mkdirSync(path.join(root,".wheelhouse-worktrees"));
  const wt=path.join(root,".wheelhouse-worktrees",spec.seat);
  if(spec.kind==="worktree-fifo") {const r=run("mkfifo",[wt],root);native.push(r);assert.equal(r.code,0);assert(fs.lstatSync(wt).isFIFO());paths.push(wt);}
  else {
   // Existing empty victim directory is our allocation, not a foreign path.
   git(["worktree","add","--detach",path.join(root,"victim"),"HEAD"]);
   if(spec.kind==="worktree-symlink")fs.symlinkSync(path.join(root,"victim"),wt);
   paths.push(path.join(root,"victim/KEEP"),path.join(root,"victim/.git"),wt);
  }
  registration=git(["worktree","list","--porcelain"]);
 }
 if(spec.kind==="state-run-symlink"){
  fs.rmdirSync(path.join(root,"seats/run"));fs.symlinkSync(path.join(root,"victim"),path.join(root,"seats/run"));
  fs.writeFileSync(path.join(root,"victim/worker-safe.stdin"),"KEEP aliased run file\n");paths.push(path.join(root,"victim/worker-safe.stdin"),path.join(root,"seats/run"));
 }else if(spec.kind==="state-leaf-symlink"){
  const file=path.join(root,"seats/run/worker-safe.stdin");fs.symlinkSync(victim,file);paths.push(file);
 }else if(spec.kind==="state-parent-fifo"){
  fs.rmdirSync(path.join(root,"seats/run"));const r=run("mkfifo",[path.join(root,"seats/run")],root);native.push(r);assert.equal(r.code,0);assert(fs.lstatSync(path.join(root,"seats/run")).isFIFO());paths.push(path.join(root,"seats/run"));
 }
 const snapshot={at:"now",ready:[],readyCount:0,chainedCount:0,overlapCount:0,reviewBacklog:[],workers:{live:spec.action==="main"?[{name:spec.seat,busy:false,entry:"e1"}]:[],idle:0,busy:0},reviewers:{live:[],idle:0,busy:0},changes:{}};
 const before=[...new Set(paths)].map(file=>({file,data:snap(file)}));
 assert(!snap(victim).missing,"victim subject absent before measurement");
 const env={...process.env,HOME:path.join(root,"home"),PATH:path.join(root,"bin")+":"+process.env.PATH,WHEELHOUSE_SEAT_PUSH:"off",WHEELHOUSE_SKIP_BD:"1",PATH_SAFETY_CALLS:calls,PATH_SAFETY_SPEC:JSON.stringify({...spec,root,snapshot})};
 const result=run(process.execPath,[path.join(root,"seats/path-safety-runner.mjs")],root,env);
 const outputs=result.out.split("\n").filter(l=>l.startsWith("PATH_SAFETY_RESULT "));const outcome=outputs.length===1?JSON.parse(outputs[0].slice(19)):null;
 const after=before.map(({file})=>({file,data:snap(file)}));
 let afterRegistration:string|undefined;
 if(registration!==undefined){const r=run("git",["-C",root,"worktree","list","--porcelain"],root);native.push(r);assert.equal(r.code,0);afterRegistration=r.out;}
 const problems:string[]=[];
 if(result.code!==0||result.error||result.signal||!outcome)problems.push("case runner failed or missing actual result");
 if(result.err)problems.push("unexpected runner stderr");
 if(spec.action==="dir") {if(!outcome?.error?.message.startsWith("invalid seat name "))problems.push("invalid segment accepted");}
 else if(spec.action==="worktree"){
  const expected=spec.kind==="worktree-traversal"?"invalid seat name ":spec.kind==="worktree-fifo"?"not a directory":"direct child";
  if(!outcome?.error?.message.includes(expected))problems.push("missing named worktree refusal");
  if(registration!==afterRegistration)problems.push("worktree registration changed");
 }else if(spec.action==="state") {if(!outcome?.error?.message.includes("seats/run"))problems.push("unsafe state removal not refused");}
 else if(outcome?.value?.kind!=="nothing"||!outcome?.value?.reason?.startsWith("invalid seat name "))problems.push("invalid decision did not become named nothing");
 // main normally writes its own serialized decision/log; it must not reach
 // adapter/removeState/unregister or mutate any external/run/state subject.
 const protectedBefore=spec.action==="main"?before.filter(x=>x.file!==staffing):before;
 const protectedAfter=spec.action==="main"?after.filter(x=>x.file!==staffing):after;
 if(JSON.stringify(protectedBefore)!==JSON.stringify(protectedAfter))problems.push("protected subject changed");
 console.log("MEASUREMENT seat-path "+JSON.stringify({spec,root,before,after,registration,afterRegistration,native,result,outcome,problems}));
 if(problems.length){failed++;console.error("FAIL seat-path "+spec.kind+": "+problems.join("; "));}else console.log("PASS seat-path "+spec.kind);
}
console.log(`seat-path-safety: ${cases.length} cases, ${failed} failures`);
if(failed)process.exitCode=1;
