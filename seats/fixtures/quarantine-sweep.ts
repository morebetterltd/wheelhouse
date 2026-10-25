import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "./fixture-command.cjs";
import { pathToFileURL } from "node:url";
import { parseQuarantine, localDay } from "../quarantine";
const [here, root, runner] = process.argv.slice(2);
assert(fs.statSync(path.join(root,".wheelhouse-selftest-fixture")).isFile());
const source=fs.readFileSync(runner,"utf8"),dir=path.join(root,"quarantine-cases");fs.mkdirSync(dir);
const api=await import(pathToFileURL(path.join(here,"verify.ts")).href);
const future="2099-12-31",today=localDay(),d=new Date();d.setDate(d.getDate()-1);const yesterday=localDay(d);
const one=(s:string,from:string,to:string)=>{assert.equal(s.split(from).length,2);return s.replace(from,to)};
const exemption='if [ "$rc" -ne 0 ] && [ -n "$exemption" ]; then';
const start=source.indexOf('quarantine_records="$(perl'),end=source.indexOf('\nQUARANTINE=();',start);assert(start>0&&end>start);
const noValidation=source.slice(0,start)+'quarantine_records=""'+source.slice(end);
const cases=[
 {name:"quarantined-fail",line:`bad.selftest.sh owner-123 ${future}`,rc:0,kind:"QUARANTINED-FAIL",summary:`bad.selftest.sh owner=owner-123 until=${future} result=FAIL`,mutant:one(source,exemption,'if false; then')},
 {name:"quarantined-timeout",line:`bad.selftest.sh owner-123 ${future}`,rc:0,kind:"QUARANTINED-FAIL",summary:`bad.selftest.sh owner=owner-123 until=${future} result=FAIL`,timeout:true,mutant:one(source,exemption,'if false; then')},
 {name:"quarantined-pass",line:`good.selftest.sh owner-123 ${future}`,rc:0,core:"good",kind:"PASS",summary:`good.selftest.sh owner=owner-123 until=${future} result=PASS`,mutant:source.replace('quarantine_summary="${quarantine_summary}selftest-sweep: quarantine:','quarantine_summary="${quarantine_summary}removed-summary:')},
 ...[["today",`bad.selftest.sh owner-123 ${today}`],["yesterday",`bad.selftest.sh owner-123 ${yesterday}`],["missing",`absent.selftest.sh owner-123 ${future}`],["owner",`bad.selftest.sh bad/id ${future}`],["date",`bad.selftest.sh owner-123 2099-02-30`],["fields",`bad.selftest.sh owner-123 ${future} extra`],["duplicate",`bad.selftest.sh owner-123 ${future}\nbad.selftest.sh owner-123 ${future}`]].map(([name,line])=>({name,line,rc:2,mutant:noValidation})),
];
let serial=0;
function run(c:any,removed:boolean){
 const project=path.join(dir,String(++serial)),seats=path.join(project,"seats"),lock=path.join(project,"fixture.lock");fs.mkdirSync(seats,{recursive:true});
 for(const name of ["selftest-sweep-lock.ts","python-invocations.ts"])fs.copyFileSync(path.join(here,name),path.join(seats,name));
 fs.writeFileSync(path.join(seats,"selftest-sweep.sh"),removed?c.mutant:source);
 for(const [name,code]of [["bad",7],["good",0],["full",0]]as const)fs.writeFileSync(path.join(seats,`${name}.selftest.sh`),`#!/bin/bash\nprintf '${name} ran\\n'\n${c.timeout&&name==="bad"?"sleep 20":"exit "+code}\n`);
 fs.writeFileSync(path.join(seats,"selftest-core.list"),`${c.core??"bad"}.selftest.sh\n`);
 fs.writeFileSync(path.join(seats,"selftest-quarantine.list"),"# fixture qualification evidence is synthetic\n"+c.line+"\n");
 for(const args of [["init","-q","-b","main"],["add","seats"]]){const r=spawnSync("git",["-C",project,...args],{encoding:"utf8"});assert.equal(r.status,0,r.stderr)}
 const r=spawnSync("bash",[path.join(seats,"selftest-sweep.sh"),"--tier","core"],{encoding:"utf8",env:{...process.env,WHEELHOUSE_SELFTEST_SUITE_TIMEOUT_S:"1",WHEELHOUSE_SELFTEST_SUITE_GRACE_S:"1",WHEELHOUSE_SELFTEST_SWEEP_LOCK:lock,WHEELHOUSE_SELFTEST_SWEEP_LOCK_HELPER:path.join(here,"selftest-sweep-lock.ts")}});
 assert.ifError(r.error);assert.equal(r.signal,null);fs.writeFileSync(path.join(project,"stdout"),r.stdout);fs.writeFileSync(path.join(project,"stderr"),r.stderr);
 let ok=r.status===c.rc;
 if(c.rc===2)ok&&=r.stderr.includes("STOP: quarantine line ")&&!r.stdout.includes("selftest-sweep: START")&&!fs.existsSync(lock+".host");
 else if(c.rc===1)ok&&=r.stdout.includes('selftest-sweep: FAIL (1 failure(s)');
 else ok&&=r.stdout.includes(`selftest-sweep: ${c.kind} ${seats}/`)&&r.stdout.includes('selftest-sweep: quarantine: '+c.summary)&&r.stdout.includes('selftest-sweep: PASS (1 suite(s),');
 console.log(JSON.stringify({case:c.name,removed,code:r.status,positiveCriterion:ok}));
 if(!removed&&!ok)console.log(JSON.stringify({stdout:r.stdout,stderr:r.stderr}));
 return {ok,text:r.stdout};
}
for(const c of cases){const fixed=run(c,false);assert(fixed.ok,c.name);assert(!run(c,true).ok,`insensitive ${c.name}`);if(c.rc===0){const t=api.readSweepTimings(fixed.text);assert.equal(t.quarantine.length,1);assert.equal(t.quarantine[0].owner,"owner-123")}console.log(`PASS quarantine runner ${c.name}; fix removal detected`)}
// Inactive valid entries are ignored, ordinary failures still gate.
for(const c of [{name:"inactive",line:`full.selftest.sh owner-123 ${future}`,rc:0,core:"good",kind:"PASS",summary:"none"},{name:"ordinary",line:"",rc:1}]){
 const r=run({...c,mutant:source},false);if(c.name==="inactive")assert(r.ok);else{assert.equal(api.readSweepTimings(r.text).quarantine.length,0);assert(r.text.includes("FAIL (1 failure(s)"))}console.log(`PASS compatibility ${c.name}`);
}
const parserSource=fs.readFileSync(path.join(here,"quarantine.ts"),"utf8"),parserFile=path.join(dir,"parser-removed.ts");
fs.writeFileSync(parserFile,one(parserSource,'throw new Error(`quarantine line ${index+1}: ${why}`)','return undefined as never'));
const removedParser=await import(pathToFileURL(parserFile).href);
for(const [name,line]of [["today",`bad.selftest.sh owner-123 ${today}`],["calendar",`bad.selftest.sh owner-123 2099-02-30`],["missing",`absent.selftest.sh owner-123 ${future}`],["owner",`bad.selftest.sh bad/id ${future}`]]) {
 assert.throws(()=>parseQuarantine(line,["bad.selftest.sh"]),/quarantine line 1:/,name);
 assert.doesNotThrow(()=>removedParser.parseQuarantine(line,["bad.selftest.sh"]));
 console.log(`PASS quarantine TS ${name}; stop removal admits invalid row`);
}
console.log(`quarantine runner: PASS (${cases.length} regression/removal pairs, inactive/ordinary compatibility, strict TS policy parser)`);
