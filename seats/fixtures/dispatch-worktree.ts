// Real isolated dispatch/legacy worktrees; no installed seats or real login.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { completedCommand } from '../completed-command';
const [here, root, selected = 'all', group = 'positive'] = process.argv.slice(2);
assert(/^[a-z][a-z-]*$/.test(group));
assert(fs.statSync(path.join(root, '.wheelhouse-selftest-fixture')).isFile());
const evidence = process.env.WHEELHOUSE_DISPATCH_WORKTREE_EVIDENCE;
if (evidence) assert(fs.statSync(evidence).isDirectory());
const seat = 'worker-sample', task = 'task-alpha';
const stub = `#!/usr/bin/env bun
import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
const briefArg=process.argv.indexOf('--append-system-prompt');
const loadedBrief=fs.readFileSync(process.argv[briefArg+1],'utf8');
const loadedBriefHash=createHash('sha256').update(loadedBrief).digest('hex');
const loadedBriefUsesContext=loadedBrief.includes("adapter's dispatch context");
const dir=process.env.PI_CODING_AGENT_DIR;fs.mkdirSync(dir,{recursive:true});
const sessionFile=path.join(dir,'sessions','sample.jsonl');fs.mkdirSync(path.dirname(sessionFile),{recursive:true});
if(!fs.existsSync(sessionFile))fs.writeFileSync(sessionFile,'{"type":"session"}\\n');
fs.writeFileSync(path.join(dir,'launched.json'),JSON.stringify({pid:process.pid,cwd:process.cwd(),argv:process.argv,loadedBriefHash,loadedBriefUsesContext}));
let pending='';const send=row=>process.stdout.write(JSON.stringify(row)+'\\n');
process.stdin.on('data',b=>{pending+=b;let at;while((at=pending.indexOf('\\n'))>=0){const line=pending.slice(0,at);pending=pending.slice(at+1);if(!line.trim())continue;const c=JSON.parse(line);
fs.appendFileSync(path.join(dir,'commands.jsonl'),JSON.stringify({...c,actualCwd:process.cwd(),loadedBriefUsesContext})+'\\n');
if(c.type==='get_state')send({id:c.id,type:'response',command:c.type,success:true,data:{isStreaming:false,sessionFile,sessionId:'sample',messageCount:0}});
else if(c.type==='prompt'){send({id:c.id,type:'response',command:c.type,success:true});send({type:'agent_end',messages:[]});}
else send({id:c.id,type:'response',command:c.type,success:false,error:'unsupported synthetic command'});}});
process.on('SIGTERM',()=>process.exit(0));
`;
let commandId = 0;
function run(file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
  const result = completedCommand(file, args, { cwd, env });
  assert(!result.error && !result.signal, `native command failed: ${file}: ${result.error?.message ?? result.signal}`);
  if (evidence) {
    const name = group + '-' + String(++commandId).padStart(4, '0');
    fs.writeFileSync(path.join(evidence, name + '.stdout'), result.stdout);
    fs.writeFileSync(path.join(evidence, name + '.stderr'), result.stderr);
    fs.writeFileSync(path.join(evidence, name + '.json'), JSON.stringify({ file, args, cwd, status: result.status, signal: result.signal ?? null }));
  }
  return result;
}
function git(repo: string, args: string[]) { const r = run('git', ['-C', repo, ...args], root); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); }
const cases = ['legacy', 'recorded-cwd', 'collision', 'recorded-task-collision', 'associated-collision', 'recorded-task', 'stopped-record', 'stale-brief', 'unknown-brief'];
assert(selected === 'all' || cases.includes(selected));
let failures = 0;
for (const name of cases.filter(x => selected === 'all' || x === selected)) {
  console.log('AMBIENT dispatch-worktree ' + JSON.stringify({case:name,group,nice:os.getPriority(0),cores:os.cpus().length,load:os.loadavg(),at:new Date().toISOString()}));
  const dir = path.join(root, group, name), project = path.join(dir, 'project'), home = path.join(dir, 'home'), bin = path.join(dir, 'bin');
  const account = path.join(home, 'sample-account'), stateFile = path.join(project, 'seats/state.json');
  const canonical = path.join(project, '.wheelhouse-worktrees', seat), legacy = path.join(project, '.wheelhouse-worktrees', name === 'associated-collision' ? task : 'legacy-topic');
  fs.mkdirSync(project, { recursive: true }); fs.mkdirSync(account, { recursive: true }); fs.mkdirSync(bin);
  // The shell copied runtime once into root/runtime; reuse it without touching source.
  fs.cpSync(path.join(root, 'runtime/seats'), path.join(project, 'seats'), { recursive: true });
  for (const [key, file] of [['WHEELHOUSE_DISPATCH_ADAPTER_SOURCE','adapter.ts'],['WHEELHOUSE_DISPATCH_WORKTREE_SOURCE','seat-worktree.ts']]) {
    const source = process.env[key]; if (source) { assert(fs.statSync(source).isFile()); fs.copyFileSync(source,path.join(project,'seats',file)); }
  }
  const roleBrief = fs.readFileSync(process.env.WHEELHOUSE_DISPATCH_BRIEF_SOURCE ?? path.join(here, '../contracts/WORKER.md'),'utf8');
  const stale = ['stale-brief','unknown-brief'].includes(name);
  const initialBrief = stale ? roleBrief.replace(/^- Work ONLY.*$/m, '- Work ONLY in your canonical seat worktree (`.wheelhouse-worktrees/<seat>`).') : roleBrief;
  fs.mkdirSync(path.join(project, 'contracts')); fs.writeFileSync(path.join(project, 'contracts/WORKER.md'),initialBrief);
  fs.mkdirSync(path.join(project, 'wheelhouse')); fs.writeFileSync(path.join(project, 'wheelhouse/.template-source'), 'seat_push=off\ncleanup=off\nmerge-target=main\n');
  fs.writeFileSync(path.join(account, 'auth.json'), '{"fixture":"synthetic"}\n'); fs.writeFileSync(path.join(account, 'trust.json'), JSON.stringify({ [project]: true }));
  fs.writeFileSync(path.join(bin, 'pi'), stub, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'bd'), '#!/bin/sh\nif [ "$1" = list ]; then printf "[]\\n"; else printf "{}\\n"; fi\n', { mode: 0o755 });
  fs.writeFileSync(path.join(project, 'seats/seats.json'), JSON.stringify({ seats: { [seat]: { role: 'worker', provider: 'anthropic', model: 'fixture-model', account: { dir: account } } } }));
  git(project, ['init', '-q', '-b', 'main']); fs.writeFileSync(path.join(project, 'README.md'), 'synthetic fixture\n');
  fs.writeFileSync(path.join(project, '.gitignore'), 'seats/\ncontracts/\nwheelhouse/\n.wheelhouse-worktrees/\n.wheelhouse-runs/\n');
  git(project, ['add', 'README.md', '.gitignore']); git(project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
  git(project, ['worktree', 'add', '-q', canonical, '-b', 'fleet/anchor-old', 'main']);
  git(project, ['worktree', 'add', '-q', legacy, '-b', 'fleet/legacy-topic', 'main']);
  const env = { ...process.env, HOME: home, PATH: bin + path.delimiter + process.env.PATH, WHEELHOUSE_SKIP_BD: '1', WHEELHOUSE_SKIP_REAL_PI: '1', WHEELHOUSE_CONTRACT_FIXTURE: path.join(here, 'fixtures/contracts/valid.md') };
  const adapter = (...args: string[]) => run('bun', [path.join(project, 'seats/adapter.ts'), ...args], project, env);
  const readState = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const initial = name === 'recorded-cwd' ? canonical : legacy;
  fs.mkdirSync(path.join(account, 'sessions')); fs.writeFileSync(path.join(account, 'sessions/sample.jsonl'), '{"type":"session"}\n');
  fs.writeFileSync(stateFile, JSON.stringify({ seats: { [seat]: { pid: null, cwd: initial, lastBead: 'legacy-topic', sessionFile: path.join(account, 'sessions/sample.jsonl'), log: path.join(project, 'seats/logs', seat + '.jsonl') } } }));
  try {
    const resumed = adapter('resume', seat); assert.equal(resumed.status, 0, resumed.stderr);
    const launched = JSON.parse(fs.readFileSync(path.join(account, 'launched.json'), 'utf8')); assert.equal(launched.cwd, initial, 'real process must start in seeded worktree');
    const nativeCwd = run('lsof', ['-a', '-p', String(launched.pid), '-d', 'cwd', '-Fpn'], project);
    assert.equal(nativeCwd.status, 0, nativeCwd.stderr); assert(nativeCwd.stdout.split('\n').includes('n' + initial), 'native cwd agrees before dispatch');
    const state = readState(); state.seats[seat].cwd = legacy;
    if (stale) {
      assert.equal(state.seats[seat].roleBriefHash,launched.loadedBriefHash,'stale case must begin with a real Pi launch digest');
      assert.equal(launched.loadedBriefUsesContext,false,'live seat actually loaded the old canonical guidance');
      fs.writeFileSync(path.join(project,'contracts/WORKER.md'),roleBrief);
      if (name === 'unknown-brief') delete state.seats[seat].roleBriefHash;
    }
    if (['recorded-task-collision','associated-collision','recorded-task'].includes(name)) state.seats[seat].lastBead = task;
    if (name === 'stopped-record') state.seats['worker-stopped'] = { pid: null, cwd: legacy, lastBead: 'old-task' };
    fs.writeFileSync(stateFile, JSON.stringify(state));
    const other = path.join(project, '.wheelhouse-worktrees', 'other-task');
    const collision = name.includes('collision');
    if (collision) git(project, ['worktree', 'add', '-q', other, '-b', 'fleet/' + task, 'main']);
    const beforeDispatch = fs.readFileSync(stateFile,'utf8'), sessionBefore = fs.readFileSync(state.seats[seat].sessionFile,'utf8');
    const result = adapter('dispatch', seat, task, 'Synthetic dispatch fixture', '--base', 'main');
    const listing = git(project, ['worktree', 'list', '--porcelain']); // Real native output retained before interpretation.
    const branch = git(legacy, ['symbolic-ref', '--short', 'HEAD']);
    const commands = fs.readFileSync(path.join(account, 'commands.jsonl'), 'utf8').trim().split('\n').map(x => JSON.parse(x));
    const prompt = commands.filter(x => x.type === 'prompt').at(-1);
    // The system brief must authorize this context too, not still require the
    // stale anchor while a lower-priority message names a different path.
    const named = prompt?.loadedBriefUsesContext ? (prompt?.message.match(/^Worktree: (.+)$/m)?.[1] ?? canonical) : canonical;
    console.log('DISPATCH_WORKTREE ' + JSON.stringify({ case: name, native: result.status, prepared: legacy, named, actualCwd: prompt?.actualCwd ?? null, stateCwd: readState().seats[seat].cwd, branch, canonicalBranch: git(canonical, ['symbolic-ref', '--short', 'HEAD']), other: collision ? other : null, stdout: result.stdout, stderr: result.stderr, listing }));
    if (stale) {
      assert.notEqual(result.status,0,'stale brief dispatch must refuse without resetting the session');
      assert(result.stderr.includes(seat)&&result.stderr.includes(canonical)&&result.stderr.includes(legacy),'stale brief remedy names the seat and both worktrees');
      assert(result.stderr.includes('reset instead of resume'),'stale brief needs the existing reset remedy');
      assert(!result.stdout.includes('dispatched ')&&!prompt,'stale brief sends no prompt or success');
      assert.equal(fs.readFileSync(stateFile,'utf8'),beforeDispatch,'refusal must preserve all session/state fields');
      assert.equal(fs.readFileSync(state.seats[seat].sessionFile,'utf8'),sessionBefore,'refusal must not discard or rewrite the session');
      assert.equal(branch,'fleet/legacy-topic','stale guidance refuses before switching the worktree');
      const reset=adapter('reset',seat);assert.equal(reset.status,0,reset.stderr);
      assert.equal(readState().seats[seat].roleBriefHash,createHash('sha256').update(roleBrief).digest('hex'),'explicit reset loads the current brief hash');
      const retry=adapter('dispatch',seat,task,'Synthetic reset retry','--base','main');assert.equal(retry.status,0,retry.stderr);
      const retried=fs.readFileSync(path.join(account,'commands.jsonl'),'utf8').trim().split('\n').map(x=>JSON.parse(x)).filter(x=>x.type==='prompt').at(-1);
      assert(retried?.loadedBriefUsesContext&&retried.message.includes('Worktree: '+legacy));assert.equal(retried.actualCwd,legacy);assert.equal(git(legacy,['symbolic-ref','--short','HEAD']),'fleet/'+task);
      console.log('RESET_REMEDY '+JSON.stringify({case:name,refused:result.status,reset:reset.status,retry:retry.status,sessionPreservedBeforeExplicitReset:true}));
    } else if (collision) {
      assert.notEqual(result.status, 0, 'branch occupied elsewhere must refuse, not preserve an unrelated recorded branch');
      assert(result.stderr.includes(legacy) && result.stderr.includes(other), 'refusal must name both target and branch-owner paths');
      assert(!result.stdout.includes('dispatched '), 'refusal must print no success line'); assert(!prompt, 'refused dispatch must not prompt the seat');
      assert.equal(branch, 'fleet/legacy-topic');
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert(prompt, 'dispatch must reach the actual seat');
      assert.equal(named, legacy, 'brief must name the actual adopted worktree, not the canonical anchor');
      assert.equal(prompt.actualCwd, legacy, 'actual worker cwd must match the brief, not merely state.json');
      const latest = JSON.parse(fs.readFileSync(path.join(account, 'launched.json'), 'utf8'));
      const afterCwd = run('lsof', ['-a', '-p', String(latest.pid), '-d', 'cwd', '-Fpn'], project);
      assert.equal(afterCwd.status,0,afterCwd.stderr); assert(afterCwd.stdout.split('\n').includes('n'+named),'native process cwd must match the dispatched brief');
      assert.equal(readState().seats[seat].cwd, legacy);
      assert.equal(readState().seats[seat].roleBriefHash,latest.loadedBriefHash,'Pi launch record must carry the loaded brief digest');
      assert.equal(branch, 'fleet/' + task, 'prepared worktree must be on the task branch');
      assert(listing.includes('worktree ' + named + '\n') && listing.includes('branch refs/heads/fleet/' + task + '\n'));
      assert(prompt.message.includes('Branch: fleet/' + task), 'brief must name the prepared branch');
    }
    console.log('PASS dispatch-worktree ' + name);
  } catch (error) { failures++; console.error('CASE_ASSERTION ' + name); console.error(error); }
  finally { const stopped = adapter('stop', seat); assert.equal(stopped.status, 0, stopped.stderr); }
}
console.log(`dispatch-worktree: ${failures ? 'FAIL' : 'PASS'} (${cases.filter(x => selected === 'all' || x === selected).length} cases, ${failures} failures)`);
process.exitCode = failures ? 1 : 0;
