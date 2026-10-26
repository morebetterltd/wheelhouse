// Real status/floor consumers with only the seat process and bd-ready mocked.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from "./fixture-command.cjs";
const [runtime, base] = process.argv.slice(2);
assert(fs.statSync(path.join(path.dirname(base), '.wheelhouse-selftest-fixture')).isFile());
fs.mkdirSync(base);
const ps = spawnSync('ps', ['-p', String(process.pid), '-o', 'lstart='], {encoding: 'utf8'});
console.log('CAPTURE display fixture ps ' + JSON.stringify({status: ps.status, signal: ps.signal, stdout: ps.stdout, stderr: ps.stderr}));
assert.equal(ps.status, 0); assert.equal(ps.signal, null); assert.equal(ps.error, undefined);
const startedAt = new Date(Date.parse(ps.stdout.trim())).toISOString();
const seed = path.join(base, 'seed'); fs.mkdirSync(seed); fs.cpSync(runtime, path.join(seed, 'seats'), {recursive: true});
function project(name: string, mutate?: (seats: string) => void) {
  const root = path.join(base, name); fs.cpSync(seed, root, {recursive: true});
  for (const dir of ['seats/logs','seats/run','bin']) fs.mkdirSync(path.join(root, dir), {recursive: true});
  fs.writeFileSync(path.join(root, 'seats/seats.json'), JSON.stringify({version:1,seats:{fixture:{role:'worker',harness:'pi',provider:'openai',model:'fixture-model',account:{dir:path.join(root,'account')}}}}));
  fs.writeFileSync(path.join(root,'bin/bd'), '#!/bin/sh\n[ "$1" = ready ] || exit 1\nexit 0\n', {mode:0o755});
  fs.writeFileSync(path.join(root,'seats/run/fleet-snapshot.json'), 'display must not rewrite alert input\n');
  mutate?.(path.join(root,'seats')); return root;
}
function replace(file: string, old: string, next: string) { const s=fs.readFileSync(file,'utf8');assert.equal(s.split(old).length,2,old);fs.writeFileSync(file,s.replace(old,next)); }
const fixed=project('fixed');
type Case = {name:string;events:any[];word:string;floor:string;dead?:boolean;stopped?:boolean;stalled?:boolean};
const cases: Case[] = [
  {name:'mid-tool',events:[{type:'agent_start'},{type:'tool_execution_start'}],word:'RUNNING',floor:'RUNNING — working'},
  ...['agent_end','turn_end','agent_settled'].map(type=>({name:type,events:[{type:'agent_start'},{type}],word:'SETTLED',floor:'SETTLED — idle'})),
  {name:'old-settled',events:[{type:'agent_settled',timestamp:'2000-01-01T00:00:00Z'}],word:'SETTLED',floor:'SETTLED — idle'},
  {name:'settled-with-transport-response',events:[{type:'agent_settled'},{type:'response',command:'get_state',success:true}],word:'SETTLED',floor:'SETTLED — idle'},
  {name:'next-turn',events:[{type:'agent_settled'},{type:'agent_start'},{type:'tool_execution_update'}],word:'RUNNING',floor:'RUNNING — working'},
  {name:'stalled',events:[{type:'agent_settled',state:'stalled'}],word:'STALLED',floor:'STALLED —'},
  {name:'quota',events:[{type:'agent_end',messages:[{role:'assistant',stopReason:'error',errorMessage:'rate limit exhausted',content:[]}]}],word:'PARKED',floor:'PARKED/QUOTA'},
  {name:'dead-settled',events:[{type:'agent_settled'}],dead:true,word:'DIED',floor:'PROCESS GONE'},
  {name:'stopped-settled',events:[{type:'agent_settled'}],stopped:true,word:'STOPPED',floor:'stopped'},
  {name:'empty-live-log',events:[],word:'RUNNING',floor:'RUNNING — working'},
];
function observe(root: string, test: Case) {
  const log=path.join(root,'seats/logs/fixture.jsonl');fs.writeFileSync(log,test.events.map(e=>JSON.stringify(e)).join('\n')+'\n');
  fs.writeFileSync(path.join(root,'seats/state.json'),JSON.stringify({seats:{fixture:{pid:test.stopped?null:test.dead?999999999:process.pid,startedAt,role:'worker',log,lastBead:'still-open-bead',...(test.stopped?{stoppedAt:new Date().toISOString()}:{}),...(test.stalled?{lastStalledEvent:{detail:'fixture stalled'}}:{})}}}));
  const env={...process.env,NO_COLOR:'1',COLUMNS:'240',LINES:'40',PATH:path.join(root,'bin')+path.delimiter+process.env.PATH};
  const run=(file:string,args:string[])=>{const r=spawnSync('bun',[path.join(root,'seats',file),...args],{cwd:root,env,encoding:'utf8'});assert.equal(r.error,undefined);assert.equal(r.signal,null);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
  const status=run('adapter.ts',['status']);
  const before=fs.readFileSync(path.join(root,'seats/state.json'));
  const floor=run('floor.ts',['--once','--pin','0']);
  assert.deepEqual(fs.readFileSync(path.join(root,'seats/state.json')),before,'floor remains read-only');
  assert.equal(fs.readFileSync(path.join(root,'seats/run/fleet-snapshot.json'),'utf8'),'display must not rewrite alert input\n');
  const word=/^fixture\s+worker\s+(\S+)/m.exec(status)?.[1];assert(word,status);
  assert(status.includes('bead still-open-bead'));assert(floor.includes('still-open-bead'));
  return {word,floor,status};
}
function check(observed: ReturnType<typeof observe>, test: Case) {assert.equal(observed.word,test.word,observed.status);assert(observed.floor.includes(test.floor),observed.floor);}
for (const test of cases) {check(observe(fixed,test),test);console.log(`PASS turn display ${test.name}: status=${test.word}; floor=${test.floor}`);}
const adapter=project('old-status',seats=>replace(path.join(seats,'adapter.ts'),'alive ? turnDisplay : died','alive ? "RUNNING" : died'));
const floor=project('old-floor',seats=>replace(path.join(seats,'floor.ts'),'const turnDisplay = seatTurnDisplay(seat.log);','const turnDisplay = "RUNNING";'));
for(const [name,root] of [['adapter',adapter],['floor',floor]]){const test=cases.find(c=>c.name==='agent_settled')!,r=observe(root,test);assert.throws(()=>check(r,test),{code:'ERR_ASSERTION'});console.log(`NEGATIVE restored ${name} RUNNING display fails settlement assertion`);}
const helper=project('missing-settlement',seats=>replace(path.join(seats,'seat-turn-display.ts'),"? 'STALLED' : 'SETTLED'","? 'STALLED' : 'RUNNING'"));
for(const name of ['agent_end','turn_end','agent_settled']){const test=cases.find(c=>c.name===name)!,r=observe(helper,test);assert.equal(r.word,'RUNNING');assert.throws(()=>check(r,test),{code:'ERR_ASSERTION'});console.log(`NEGATIVE ignored ${name} fails both shared settlement displays`);}
const metadata=project('response-is-not-work',seats=>replace(path.join(seats,'seat-turn-display.ts'),"  'agent_start', 'turn_start'","  'response', 'agent_start', 'turn_start'"));
const test=cases.find(c=>c.name==='settled-with-transport-response')!,wrong=observe(metadata,test);assert.equal(wrong.word,'RUNNING');assert.throws(()=>check(wrong,test),{code:'ERR_ASSERTION'});console.log('NEGATIVE treating RPC metadata as work fails settled display assertion');
console.log('turn-display regression: PASS (12 cases; 6 detected fix removals; real status/floor; alert snapshot untouched)');
