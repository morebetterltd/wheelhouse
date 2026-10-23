import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const [source, parent] = process.argv.slice(2);
assert(fs.statSync(path.join(parent, '.wheelhouse-selftest-fixture')).isFile());
const cases = ['coalesced', 'late-prompt', 'late-fallback', 'held-ack-only', 'held-status-only', 'idle-before-ack', 'other-terminal-before-ack', 'newer-native-turn', 'newer-no-end', 'late-auth', 'late-resume'];
const selected = process.env.WHEELHOUSE_TEST_CODEX_TURN_CASES?.split(',') ?? cases;
assert(selected.length && selected.every(x => cases.includes(x)), 'known nonempty case selection');
const root = path.join(parent, 'codex-turn-state'); fs.mkdirSync(root);
const shim = path.join(source, 'seats/drivers/codex/shim.ts');
const sourceSha256 = createHash('sha256').update(fs.readFileSync(shim)).digest('hex');
// Shapes are from the captured native RPC/normalized order, not invented
// elapsed successes. Every release below belongs to this fixture's owner.
const server = String.raw`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),root=process.env.TURN_CASE,mode=process.env.TURN_MODE,thread=mode==='late-resume'?'resumed-thread':'thread-fixture';
let buf='',starts=0,live=null,pending=null,finished=new Set();
function record(x){fs.appendFileSync(root+'/native.jsonl',JSON.stringify(x)+'\n');}
function emit(rows){record({kind:'emit',rows});process.stdout.write(rows.map(x=>JSON.stringify(x)).join('\n')+'\n');}
function active(id){return[{jsonrpc:'2.0',method:'thread/status/changed',params:{threadId:thread,status:{type:'active'}}},{jsonrpc:'2.0',method:'turn/started',params:{threadId:thread,turn:{id,status:'inProgress'}}}];}
function terminal(id,auth=false){return[{jsonrpc:'2.0',method:'thread/status/changed',params:{threadId:thread,status:{type:'idle'}}},{jsonrpc:'2.0',method:'turn/completed',params:{threadId:thread,turn:{id,status:auth?'failed':'completed',...(auth?{error:{message:'401 not logged in'}}:{})}}}];}
function releases(){if(pending&&fs.existsSync(root+'/release-ack')){const reply=pending;pending=null;emit([reply]);record({kind:'ack-released',id:reply.id});}if(live){const file=root+'/finish-'+live;if(!finished.has(live)&&fs.existsSync(file)){const id=live;finished.add(id);live=null;emit(terminal(id));record({kind:'finished',id});}}}
const watcher=fs.watch(root,releases);process.stdin.on('end',()=>{watcher.close();process.exit(0);});
process.stdin.on('data',b=>{buf+=b;let i;while((i=buf.indexOf('\n'))>=0){const text=buf.slice(0,i);buf=buf.slice(i+1);if(!text.trim())continue;const x=JSON.parse(text);record({kind:'receive',record:x});if(x.method==='initialize')emit([{jsonrpc:'2.0',id:x.id,result:{}}]);else if(x.method==='thread/start'||x.method==='thread/resume'){const file=root+'/account/session.jsonl';fs.writeFileSync(file,'{}\n');emit([{jsonrpc:'2.0',id:x.id,result:{thread:{id:thread,path:file},model:'fixture-model'}}]);}else if(x.method==='turn/start'){
 const id='turn-'+(++starts),reply={jsonrpc:'2.0',id:x.id,result:{turn:{id,status:'inProgress'}}};
 if(starts>1){live=id;emit([reply,...active(id)]);record({kind:'held',id});}
 else if(mode==='coalesced'){emit([reply,...active(id),...terminal(id)]);record({kind:'first-ended',id});}
 else if(mode==='held-ack-only'||mode==='held-status-only'){live=id;emit([reply,...(mode==='held-status-only'?[{jsonrpc:'2.0',method:'thread/status/changed',params:{threadId:thread,status:{type:'active'}}}]:[])]);record({kind:'held',id});}
 else{pending=reply;if(mode==='idle-before-ack'){live=id;emit([{jsonrpc:'2.0',method:'thread/status/changed',params:{threadId:thread,status:{type:'idle'}}}]);}else if(mode==='other-terminal-before-ack'){live=id;emit([...active('prior-turn'),...terminal('prior-turn')]);}else if(mode==='newer-no-end'){live='turn-2';emit([...active(id),...active(live)]);}else{const rows=[...active(id),...terminal(id,mode==='late-auth')];if(mode==='newer-native-turn'){live='turn-2';emit([...rows,...active(live)]);}else emit(rows);}record({kind:'ack-held',id:x.id,turn:id,newLive:live});}
 }else if(x.method==='turn/steer'){emit([{jsonrpc:'2.0',id:x.id,result:{turn:{id:live,status:'inProgress'}}}]);record({kind:'steered',live,params:x.params});}}});
`;
function rows(file: string): any[] { try { const text = fs.readFileSync(file, 'utf8'); return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(x => JSON.parse(x)); } catch (e: any) { if (e.code === 'ENOENT') return []; throw e; } }
const results: any[] = [];
for (const mode of cases.filter(x => selected.includes(x))) {
  const dir = path.join(root, mode); fs.mkdirSync(dir);
  for (const sub of ['bin', 'account', 'cwd']) fs.mkdirSync(path.join(dir, sub));
  fs.writeFileSync(dir + '/brief', 'isolated turn state fixture');
  fs.writeFileSync(dir + '/bin/codex', server, { mode: 0o755 });
  const log = dir + '/normalized.jsonl', raw = dir + '/raw.jsonl';
  const input = { mode, sourceSha256, shim, schema: 'captured Codex app-server messages; explicit acknowledgement/terminal release; no elapsed pass condition', server };
  fs.writeFileSync(dir + '/input.json', JSON.stringify(input, null, 2));
  const out = fs.openSync(dir + '/stdout', 'wx', 0o600), err = fs.openSync(dir + '/stderr', 'wx', 0o600);
  const argv = [shim, '--log', log, '--raw-log', raw, '--err-log', dir + '/app.stderr', '--account-dir', dir + '/account', '--brief', dir + '/brief', '--model', 'fixture-model', '--cwd', dir + '/cwd', '--actor', 'turn-state-fixture', ...(mode === 'late-resume' ? ['--resume', 'resumed-thread'] : [])];
  const child = spawn(process.execPath, argv, { cwd: dir, env: { ...process.env, PATH: dir + '/bin:' + process.env.PATH, TURN_CASE: dir, TURN_MODE: mode }, stdio: ['pipe', out, err] });
  let closed = false; const close = new Promise<any>((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => { closed = true; resolve({ code, signal }); }); });
  const result: any = { mode, input, argv, checkpoints: [], failure: null };
  const write = (cmd: any) => { fs.appendFileSync(dir + '/commands.jsonl', JSON.stringify(cmd) + '\n'); child.stdin!.write(JSON.stringify(cmd) + '\n'); };
  const normalized = () => rows(log), native = () => rows(dir + '/native.jsonl'), calls = () => native().filter(x => x.kind === 'receive').map(x => x.record), ends = () => normalized().filter(x => x.type === 'agent_end');
  async function wait(label: string, predicate: () => any) { return await new Promise<any>((resolve, reject) => { let previous = ''; const watch = fs.watch(dir, check); child.once('close', check); function finish(error: any, value?: any) { watch.close(); child.removeListener('close', check); error ? reject(error) : resolve(value); } function check() { try { const value = predicate(); if (value) { finish(null, value); return; } const last = { mode, label, pid: child.pid, closed, lastNormalized: normalized().at(-1) ?? null, lastNative: native().at(-1) ?? null, outer: 'canonical suite containment (default3600s)' }; const text = JSON.stringify(last); if (text !== previous) { console.error('CODEX_TURN_WAIT ' + text); previous = text; } if (closed) finish(Error('INCOMPLETE original shim closed before ' + label + ': ' + text)); } catch (error) { finish(error); } } check(); }); }
  async function response(id: string) { return await wait('native response ' + id, () => normalized().find(x => x.type === 'response' && x.id === id)); }
  async function state(id: string) { write({ id, type: 'get_state' }); const x = await response(id); assert(x.success && typeof x.data?.isStreaming === 'boolean', 'complete actual get_state premise'); result.checkpoints.push({ id, response: x, calls: calls(), normalized: normalized() }); return x.data; }
  async function finish(turn: string, expectedEnds: number) { fs.writeFileSync(dir + '/finish-' + turn, 'owner finishes turn\n'); await wait('actual terminal ' + turn, () => ends().length >= expectedEnds); }
  async function steerLive(turn: string, id: string) { write({ id, type: 'steer', message: 'same live turn' }); const reply = await response(id); const wire = calls().filter(x => x.method === 'turn/steer' || x.method === 'turn/start').at(-1); result.checkpoints.push({ id, reply, wire }); assert.equal(wire.method, 'turn/steer', 'live turn must use native steer, not a new start'); assert.equal(wire.params.expectedTurnId, turn, 'native steer must retain current turn identity'); assert.equal(reply.success, true, 'matching native steer acknowledgement remains valid'); }
  try {
    const initial = await state('initial'); assert.equal(initial.isStreaming, false);
    const init = calls().find(x => x.method === 'thread/start' || x.method === 'thread/resume'); assert(init); assert.equal(init.method, mode === 'late-resume' ? 'thread/resume' : 'thread/start'); if (mode === 'late-resume') assert.equal(init.params.threadId, 'resumed-thread');
    const startType = mode === 'late-fallback' ? 'steer' : 'prompt'; write({ id: 'work', type: startType, message: 'first actual work' });
    const held = mode.startsWith('held-'), newer = mode === 'newer-native-turn' || mode === 'newer-no-end';
    if (!held && mode !== 'coalesced') {
      if (mode !== 'idle-before-ack' && mode !== 'newer-no-end') await wait('native first terminal before held ack', () => ends()[0]);
      await wait('matching native ack held', () => native().find(x => x.kind === 'ack-held'));
      assert(!normalized().some(x => x.id === 'work'), 'ack really remains withheld after native lifecycle observation');
      if (newer) await wait('newer native turn started', () => rows(raw).find(x => x.method === 'turn/started' && x.params?.turn?.id === 'turn-2'));
      if (mode === 'idle-before-ack') { assert(rows(raw).some(x => x.method === 'thread/status/changed' && x.params?.status?.type === 'idle')); assert.equal(ends().length, 0); }
      fs.writeFileSync(dir + '/release-ack', 'owner releases valid acknowledgement\n');
    }
    const ack = await response('work'); result.ack = ack;
    if (mode === 'coalesced') await wait('actual coalesced terminal', () => ends()[0]);
    const snapshot = await state('after-work'); result.snapshot = snapshot;
    const firstCalls = calls().filter(x => x.method === 'turn/start' || x.method === 'turn/steer');
    assert.equal(firstCalls.length, 1, 'no additional caller RPC before the lifecycle snapshot'); assert.equal(firstCalls[0].method, 'turn/start'); assert.equal(firstCalls[0].params.threadId, initial.sessionId);
    assert.equal(ack.success, true, 'late matching native acknowledgement must remain successful'); assert.equal(ack.data.delivered, true, 'delivery authority retained'); assert.equal(snapshot.sessionId, initial.sessionId); assert.equal(snapshot.sessionFile, initial.sessionFile); assert(fs.statSync(snapshot.sessionFile).isFile());
    const live = held || newer || mode === 'idle-before-ack' || mode === 'other-terminal-before-ack';
    assert.equal(snapshot.isStreaming, live, live ? 'actual held/newer native work must remain active' : 'completed turn must not reopen after matching acknowledgement');
    assert.equal(ack.data.isStreaming, live, 'acknowledgement snapshot must preserve newer native lifecycle state');
    if (live) {
      const turn = newer ? 'turn-2' : 'turn-1'; await steerLive(turn, 'live-steer'); assert.equal((await state('still-live')).isStreaming, true);
      await finish(turn, mode === 'newer-native-turn' || mode === 'other-terminal-before-ack' ? 2 : 1); assert.equal((await state('settled')).isStreaming, false);
    } else {
      assert.equal(ends().length, 1, 'one actual first terminal, not duplicate ends');
      if (mode === 'late-auth') { assert.equal(ends()[0].authDead, true, 'native auth-dead event retained'); assert.equal(ends()[0].messages[0].stopReason, 'error'); assert(String(ends()[0].error).includes('401')); }
      // New caller work, unlike a late old reply, must really start a new turn.
      write({ id: 'next-work', type: 'steer', message: 'new work after first completion' }); const next = await response('next-work'); const wire = calls().filter(x => x.method === 'turn/start' || x.method === 'turn/steer').at(-1); result.checkpoints.push({ id: 'next-work', reply: next, wire }); assert.equal(wire.method, 'turn/start', 'idle steer must start new work, not steer the ended turn'); assert.equal(Object.hasOwn(wire.params, 'expectedTurnId'), false); assert.equal(next.success, true); assert.equal(next.data.delivered, true); assert.equal((await state('new-live')).isStreaming, true);
      await finish('turn-2', 2); assert.equal((await state('final-settled')).isStreaming, false);
    }
    const expectedEnds = mode === 'newer-native-turn' || mode === 'other-terminal-before-ack' || !live ? 2 : 1; assert.equal(ends().length, expectedEnds, 'exact single terminal for each native completed turn');
    assert.equal(calls().filter(x => x.method === 'turn/start').length, live ? 1 : 2);
  } catch (error: any) {
    result.failure = { kind: error instanceof assert.AssertionError ? 'behavior' : 'incomplete', message: String(error?.message ?? error) };
    // Preserve the intended wrong world BEFORE owned teardown; nonzero alone
    // cannot get planted-break credit.
    result.beforeCleanup = { calls: calls(), normalized: normalized(), raw: rows(raw), commands: rows(dir + '/commands.jsonl') };
    console.error('CODEX_TURN_BEFORE_CLEANUP ' + JSON.stringify(result));
  } finally {
    if (!closed) child.kill('SIGTERM'); result.nativeClose = await close; fs.closeSync(out); fs.closeSync(err);
    result.calls = calls(); result.normalized = normalized(); result.raw = rows(raw); result.commands = rows(dir + '/commands.jsonl'); result.stdout = fs.readFileSync(dir + '/stdout', 'utf8'); result.stderr = fs.readFileSync(dir + '/stderr', 'utf8'); result.appStderr = fs.existsSync(dir + '/app.stderr') ? fs.readFileSync(dir + '/app.stderr', 'utf8') : '';
    const artifact = process.env.WHEELHOUSE_CODEX_TURN_EVIDENCE; if (artifact) { fs.mkdirSync(artifact, { recursive: true }); fs.writeFileSync(path.join(artifact, mode + '.json'), JSON.stringify(result, null, 2)); }
    results.push(result); console.log('CODEX_TURN_RESULT ' + JSON.stringify(result));
  }
}
const passed = results.filter(x => !x.failure).length;
console.log('codex-turn-state: ' + passed + '/' + results.length + ' cases passed (native lifecycle, late acknowledgement, identity, auth, new work, single end)');
if (passed !== results.length) process.exitCode = 1;
