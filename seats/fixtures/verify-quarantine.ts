import fs from "node:fs";import path from "node:path";import assert from "node:assert/strict";import {execFileSync,spawnSync}from"./fixture-command.cjs";import{pathToFileURL}from"node:url";
const[here,root,base,home,runPath]=process.argv.slice(2);assert(fs.statSync(path.join(root,".wheelhouse-selftest-fixture")).isFile());
const source=fs.readFileSync(path.join(here,"verify.ts"),"utf8"),runner=fs.readFileSync(path.join(here,"selftest-sweep.sh"),"utf8"),dir=path.join(root,"review-quarantine");fs.mkdirSync(dir);
const env={...process.env,HOME:home,PATH:runPath,GIT_AUTHOR_DATE:"2000-01-01T00:00:00Z",GIT_COMMITTER_DATE:"2000-01-01T00:00:00Z"};
const git=(r:string,...args:string[])=>execFileSync("git",["-C",r,"-c","user.name=fixture","-c","user.email=fixture@local","-c","commit.gpgsign=false",...args],{env,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
const commit=(r:string)=>{git(r,"add",".");git(r,"commit","-qm","quarantine fixture");return git(r,"rev-parse","HEAD")};
const once=(s:string,a:string,b:string)=>{assert.equal(s.split(a).length,2,a);return s.replace(a,b)};
let serial=0;
function world(code=source,shell=runner){
 const r=path.join(dir,String(++serial));fs.cpSync(base,r,{recursive:true});git(r,"checkout","-q","main");
 fs.writeFileSync(path.join(r,"seats/verify.ts"),code);fs.writeFileSync(path.join(r,"seats/selftest-sweep.sh"),shell);
 fs.writeFileSync(path.join(r,"seats/full-only.selftest.sh"),"exit 0\n");
 fs.writeFileSync(path.join(r,"seats/selftest-quarantine.list"),"fixture.selftest.sh owner-123 2099-12-31\nfull-only.selftest.sh other-owner 2099-12-31\n");commit(r);
 git(r,"checkout","-qb","candidate");fs.appendFileSync(path.join(r,"seats/fixture.selftest.sh"),"exit 7\n");const tip=commit(r);
 return{r,tip};
}
function cli(w:any){const bead="quarantine-"+serial,reply=path.join(dir,bead+".reply");fs.writeFileSync(reply,"VERDICT: APPROVE\nPUSH: NOT CONSIDERED\n");
 const r=spawnSync("bun",[path.join(w.r,"seats/verify.ts"),bead,"candidate","worker-1","reviewer"],{cwd:w.r,env:{...env,STUB_REPLY_FILE:reply,STUB_SWEEP_PROMPT_CHECK:"1",STUB_SWEEP_FORCE_APPROVE:"1",WHEELHOUSE_SELFTEST_SWEEP_LOCK:path.join(dir,bead+".lock")},encoding:"utf8"});assert.ifError(r.error);assert.equal(r.signal,null);fs.writeFileSync(path.join(dir,bead+".stdout"),r.stdout);fs.writeFileSync(path.join(dir,bead+".stderr"),r.stderr);
 const file=path.join(w.r,"seats/verdicts",bead+".md");return{...r,record:fs.existsSync(file)?fs.readFileSync(file,"utf8"):""};}
const w=world(),r=cli(w);assert.equal(r.status,0,r.stderr+r.stdout);const expected="fixture.selftest.sh owner=owner-123 until=2099-12-31";assert(r.record.includes(expected));assert(!r.record.includes("other-owner"));
const argv=JSON.parse(fs.readFileSync(path.join(home,".pi-seats-alpha/reviewer/argv.json"),"utf8")),prompt=argv.at(-1);assert(prompt.includes(expected));assert(prompt.includes("a quarantined failure does not block APPROVE; read it and BOUNCE if it looks caused by this change"));
const log=r.record.match(/^- log: (.+)$/m)![1],captured=fs.readFileSync(log,"utf8");assert(captured.includes("QUARANTINED-FAIL"));assert(captured.includes("result=FAIL\nselftest-sweep: PASS"));
const native=await import(pathToFileURL(path.join(w.r,"seats/verify.ts")).href);assert.equal(native.readBatchSweep(w.r,w.tip,log).timings.quarantine.length,1);
console.log("PASS quarantine CLI: native failing suite APPROVE, prompt/verdict owner/deadline and warning, inactive tier ignored; same captured log accepted for batch");
for(const[name,code,shell]of[
 ["runner exemption",source,once(runner,'if [ "$rc" -ne 0 ] && [ -n "$exemption" ]; then','if false; then')],
 ["QFAIL reader",once(source,'["PASS", "FAIL", "QUARANTINED-FAIL"].some(kind','["PASS", "FAIL"].some(kind'),runner],
]as const){const bad=cli(world(code,shell));assert.equal(bad.status,1,bad.stderr+bad.stdout);assert.equal(bad.record,"");assert((bad.stdout+bad.stderr).includes("INCOMPLETE review"));console.log(`PASS quarantine ${name} removal blocks native approval`)}
const omitted=cli(world(once(source,"    ...quarantineLines(sweep),","")));assert.equal(omitted.status,0,omitted.stderr);assert(!omitted.record.includes(expected));console.log("PASS quarantine receipt emission removal loses required metadata criterion");
// Build corrupt fixtures only after capturing the real dispatcher output.
const corrupt=path.join(dir,"wrong-owner.log");fs.writeFileSync(corrupt,captured.replace("owner=owner-123","owner=wrong-owner"));assert.throws(()=>native.readBatchSweep(w.r,w.tip,corrupt),/policy\/summary mismatch/);
const unsafeFile=path.join(w.r,"seats/verify-no-quarantine-guard.ts");fs.writeFileSync(unsafeFile,once(source,'throw new Error("dispatcher quarantine policy/summary mismatch")','void 0'));const unsafe=await import(pathToFileURL(unsafeFile).href);assert.equal(unsafe.readBatchSweep(w.r,w.tip,corrupt).rc,0);
for(const [name,text]of[["missing-summary",captured.replace(/^selftest-sweep: quarantine: .+\n/gm,"")],["summary-result",captured.replace("result=FAIL","result=PASS")]]){const file=path.join(dir,name+".log");fs.writeFileSync(file,text);assert.throws(()=>native.readBatchSweep(w.r,w.tip,file),/quarantine/)}
console.log("PASS quarantine batch: committed policy binds owner/date/results, missing/false summaries refuse; binding removal admits forged owner");
console.log("verify quarantine: PASS (actual CLI/dispatcher/batch captures and sensitive removal controls)");
