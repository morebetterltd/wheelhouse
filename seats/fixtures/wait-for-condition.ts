import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';

const [root, helper] = process.argv.slice(2);
assert(fs.statSync(path.join(root, '.wheelhouse-selftest-fixture')).isFile());
assert(fs.statSync(helper).isFile());
const control = path.join(import.meta.dir, 'drop-watch-events.cjs');
const script = path.join(root, 'dropped-watch.cjs');
fs.writeFileSync(script, `const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const[helper,control,root]=process.argv.slice(2),{waitForCondition,pendingConditions}=require(helper),{stats}=require(control);
const file=path.join(root,'ready');assert(!fs.existsSync(file));
let checks=0;const observed=waitForCondition({site:'unit.dropped-watch',paths:[root],predicate:()=>{checks++;return fs.existsSync(file)&&fs.readFileSync(file,'utf8')==='owned publication\\n';}});
assert.equal(checks,1);assert.equal(stats.subscriptions,1);assert.equal(pendingConditions(),1);
fs.writeFileSync(path.join(root,'setup.json'),JSON.stringify({initialChecks:checks,initiallyHeld:false,subscriptions:stats.subscriptions}));
fs.writeFileSync(file,'owned publication\\n');
observed.promise.then(()=>{assert.equal(fs.readFileSync(file,'utf8'),'owned publication\\n');assert(checks>=2);assert.equal(stats.closed,1);assert.equal(pendingConditions(),0);fs.writeFileSync(path.join(root,'resolved.json'),JSON.stringify({actualCondition:true,checks,subscriptions:stats.subscriptions,closed:stats.closed}));console.log('PASS actual condition reconciled without a watch callback');},error=>{console.error(error);process.exitCode=1;});
`);
for (const runtime of ['node', 'bun']) {
  const dir = path.join(root, runtime); fs.mkdirSync(dir);
  const stdout = fs.openSync(path.join(dir, 'stdout'), 'wx', 0o600), stderr = fs.openSync(path.join(dir, 'stderr'), 'wx', 0o600);
  const args = [runtime === 'node' ? '--require' : '--preload', control, script, helper, control, dir];
  const child = spawn(runtime, args, {env: {...process.env, WHEELHOUSE_CONDITION_TRACE: path.join(dir, 'trace.jsonl')}, stdio: ['ignore', stdout, stderr]});
  const native: any = await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
  fs.closeSync(stdout); fs.closeSync(stderr);
  fs.writeFileSync(path.join(dir, 'native.json'), JSON.stringify({command:[runtime,...args],...native})+'\n');
  // Setup is outside any rejection catch. A watch-only removal can exit0 with
  // a pending Promise: that is NOT completion of the actual condition wait.
  const setup = JSON.parse(fs.readFileSync(path.join(dir, 'setup.json'), 'utf8'));
  assert.deepEqual(setup, {initialChecks:1, initiallyHeld:false, subscriptions:1});
  assert.equal(fs.readFileSync(path.join(dir, 'ready'), 'utf8'), 'owned publication\n');
  assert.equal(native.code,0,fs.readFileSync(path.join(dir,'stderr'),'utf8')); assert.equal(native.signal,null);
  assert(fs.existsSync(path.join(dir,'resolved.json')), `${runtime}: persisted condition was never observed before child exit (watch-only wait)`);
  const result=JSON.parse(fs.readFileSync(path.join(dir,'resolved.json'),'utf8'));
  assert.equal(result.actualCondition,true); assert(result.checks>=2); assert.equal(result.closed,1);
  const trace=fs.readFileSync(path.join(dir,'trace.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert(trace.some(row=>row.event==='pending'&&row.origin==='initial'));
  assert(trace.some(row=>row.event==='resolved'&&row.origin==='recheck'&&row.initiallyPending));
  console.log(`PASS ${runtime}: real publication after initial false; dropped callbacks; observed condition; watcher/timer ownership retired`);
}
