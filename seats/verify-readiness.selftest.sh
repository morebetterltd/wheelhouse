#!/usr/bin/env bash
# Exercise the actual verifier watchdog with readiness and a manual clock.
SELFTEST_LIB="$(cd "$(dirname "$0")" && pwd -P)/selftest-lib.sh"
. "$SELFTEST_LIB"
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
FIX="$(selftest_make_fixture_dir "${TMPDIR:-/tmp}/wheelhouse-verify-readiness.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
cleanup(){ selftest_cleanup_fixture_processes "$FIX" >/dev/null 2>&1 || true; selftest_remove_fixture_dir "$FIX"; }
trap cleanup EXIT INT TERM
selftest_copy_seat_runtime "$FIX" "$HERE"
bun - "$HERE" "$FIX" <<'TS' || exit $?
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
const [here,root] = process.argv.slice(2);
const {instrument,ready,expireSilent,settle} = await import(pathToFileURL(path.join(here,"fixtures/verify-readiness.ts")).href);
const source = fs.readFileSync(path.join(here,"verify.ts"),"utf8");
const testSource = fs.readFileSync(path.join(here,"verify.selftest.sh"),"utf8");
const start = 'cat > "$BIN/pi" <<\'STUB\'\n',end='\nSTUB\n';
assert.equal(testSource.split(start).length,2);
const stub = testSource.split(start)[1].split(end)[0];
assert(stub.includes('"ready"') && stub.includes('"release"'));
const pi = path.join(root,"fixture-pi.cjs");fs.writeFileSync(pi,stub);
const reply = path.join(root,"reply.txt");fs.writeFileSync(reply,"Ready fixture\nVERDICT: APPROVE\nPUSH: NOT CONSIDERED\n");
let failures=0,checks=0;
async function check(name:string,mutant=false){
 checks++;
 const dir=path.join(root,name);fs.mkdirSync(dir);
 const file=path.join(root,"seats",name+".ts");
 let code=source;
 if(mutant){const old='if (!sawOutput) killFor("WHEELHOUSE_FIRST_OUTPUT_TIMEOUT"';assert.equal(code.split(old).length,2);code=code.replace(old,'if (false) killFor("WHEELHOUSE_FIRST_OUTPUT_TIMEOUT"');}
 fs.writeFileSync(file,instrument(code)+'\nexport {runOneShot};\n');
 const {runOneShot}=await import(pathToFileURL(file).href);
 process.env.WHEELHOUSE_TEST_WATCHDOG_DIR=dir;
 const silent=name!=="ready-output";
 const env={...process.env,PI_CODING_AGENT_DIR:path.join(dir,"agent"),STUB_REPLY_FILE:reply,STUB_SILENT:silent?"1":"0"};
 const result=runOneShot("node",[pi,"--mode","json"],{cwd:dir,env,timeoutMs:900000,firstOutputTimeoutMs:1,noEventTimeoutMs:1,maxBuffer:1024*1024,harness:"pi"});
 let ended=false;result.then(()=>{ended=true;});
 try{
  await ready(dir,()=>ended);
  assert(fs.existsSync(path.join(dir,"readiness-observed")));
  if(silent && name!=="ready-silent")await expireSilent(dir,()=>ended);
  const res=name==="ready-silent"?await settle(dir,result,()=>ended):await result;
  if(mutant)throw new Error("disabled watchdog escaped the regression");
  if(silent){assert.equal(res.error?.code,"WHEELHOUSE_FIRST_OUTPUT_TIMEOUT");assert.equal(res.stdout+res.stderr,"");assert(!fs.existsSync(path.join(dir,"output")));}
  else{assert.equal(res.status,0);assert.equal(res.error,undefined);assert(res.stdout.includes("VERDICT: APPROVE"));assert(fs.existsSync(path.join(dir,"output")));assert(!fs.existsSync(path.join(dir,"expired-first")));}
  console.log("PASS "+name+": readiness observed; "+(silent?"explicit expiry STOPs true silence":"output accepted without advancing wall time"));
 }catch(e:any){
  if(mutant && e.message==='fixture silent expiry did not STOP the verifier')console.log("PASS disabled-watchdog mutation: missing silence STOP caught deterministically");
  else{console.log("FAIL "+name+": "+e.message);failures++;}
 }finally{
  if(!ended){const {pid}=JSON.parse(fs.readFileSync(path.join(dir,"ready"),"utf8"));assert(Number.isInteger(pid)&&pid>1);try{process.kill(-pid,"SIGTERM");}catch{}await result;}
 }
}
// One tick is logical fixture time, never a 1ms wall-clock allowance. Removing
// the fixture clock makes the gated readiness/output legs fail before release.
const selected=process.env.WHEELHOUSE_VERIFY_READINESS_CASE;
assert(!selected || ["ready-output","silent-output","ready-silent","disabled-watchdog"].includes(selected));
if(!selected || selected==="ready-output")await check("ready-output");
if(!selected || selected==="silent-output")await check("silent-output");
if(!selected || selected==="ready-silent")await check("ready-silent");
if(!selected || selected==="disabled-watchdog")await check("disabled-watchdog",true);
assert.equal(failures,0,"readiness regressions");
console.log(`verify-readiness.selftest: PASS (${checks} deterministic checks)`);
TS
bun "$HERE/fixtures/verify-h4-publication.ts" "$HERE" "$FIX" || exit $?
bun "$HERE/fixtures/verify-exit-regression.ts" "$HERE" "$FIX"
