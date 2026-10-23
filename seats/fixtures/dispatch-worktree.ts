// Real isolated dispatch/legacy worktrees; no installed seats or real login.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { completedCommand } from '../completed-command';
const [here, root, selected = 'all'] = process.argv.slice(2);
assert(fs.statSync(path.join(root, '.wheelhouse-selftest-fixture')).isFile());
const evidence = process.env.WHEELHOUSE_DISPATCH_WORKTREE_EVIDENCE;
if (evidence) assert(fs.statSync(evidence).isDirectory());
const seat = 'worker-sample', task = 'task-alpha';
const stub = `#!/usr/bin/env bun
import fs from 'node:fs';import path from 'node:path';
const dir=process.env.PI_CODING_AGENT_DIR;fs.mkdirSync(dir,{recursive:true});
const sessionFile=path.join(dir,'sessions','sample.jsonl');fs.mkdirSync(path.dirname(sessionFile),{recursive:true});
if(!fs.existsSync(sessionFile))fs.writeFileSync(sessionFile,'{"type":"session"}\\n');
fs.writeFileSync(path.join(dir,'launched.json'),JSON.stringify({pid:process.pid,cwd:process.cwd(),argv:process.argv}));
let pending='';const send=row=>process.stdout.write(JSON.stringify(row)+'\\n');
process.stdin.on('data',b=>{pending+=b;let at;while((at=pending.indexOf('\\n'))>=0){const line=pending.slice(0,at);pending=pending.slice(at+1);if(!line.trim())continue;const c=JSON.parse(line);
fs.appendFileSync(path.join(dir,'commands.jsonl'),JSON.stringify({...c,actualCwd:process.cwd()})+'\\n');
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
    const name = String(++commandId).padStart(4, '0');
    fs.writeFileSync(path.join(evidence, name + '.stdout'), result.stdout);
    fs.writeFileSync(path.join(evidence, name + '.stderr'), result.stderr);
    fs.writeFileSync(path.join(evidence, name + '.json'), JSON.stringify({ file, args, cwd, status: result.status, signal: result.signal ?? null }));
  }
  return result;
}
function git(repo: string, args: string[]) { const r = run('git', ['-C', repo, ...args], root); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); }
const cases = ['legacy', 'recorded-cwd', 'collision', 'recorded-task-collision', 'stopped-record'];
assert(selected === 'all' || cases.includes(selected));
let failures = 0;
for (const name of cases.filter(x => selected === 'all' || x === selected)) {
  const dir = path.join(root, name), project = path.join(dir, 'project'), home = path.join(dir, 'home'), bin = path.join(dir, 'bin');
  const account = path.join(home, 'sample-account'), stateFile = path.join(project, 'seats/state.json');
  const canonical = path.join(project, '.wheelhouse-worktrees', seat), legacy = path.join(project, '.wheelhouse-worktrees', 'legacy-topic');
  fs.mkdirSync(project, { recursive: true }); fs.mkdirSync(account, { recursive: true }); fs.mkdirSync(bin);
  // The shell copied runtime once into root/runtime; reuse it without touching source.
  fs.cpSync(path.join(root, 'runtime/seats'), path.join(project, 'seats'), { recursive: true });
  fs.mkdirSync(path.join(project, 'contracts')); fs.copyFileSync(path.join(here, '../contracts/WORKER.md'), path.join(project, 'contracts/WORKER.md'));
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
    if (name === 'recorded-task-collision') state.seats[seat].lastBead = task;
    if (name === 'stopped-record') state.seats['worker-stopped'] = { pid: null, cwd: legacy, lastBead: 'old-task' };
    fs.writeFileSync(stateFile, JSON.stringify(state));
    const other = path.join(project, '.wheelhouse-worktrees', 'other-task');
    const collision = name.includes('collision');
    if (collision) git(project, ['worktree', 'add', '-q', other, '-b', 'fleet/' + task, 'main']);
    const result = adapter('dispatch', seat, task, 'Synthetic dispatch fixture', '--base', 'main');
    const listing = git(project, ['worktree', 'list', '--porcelain']); // Real native output retained before interpretation.
    const branch = git(legacy, ['symbolic-ref', '--short', 'HEAD']);
    const commands = fs.readFileSync(path.join(account, 'commands.jsonl'), 'utf8').trim().split('\n').map(x => JSON.parse(x));
    const prompt = commands.filter(x => x.type === 'prompt').at(-1);
    const named = prompt?.message.match(/^Worktree: (.+)$/m)?.[1] ?? canonical;
    console.log('DISPATCH_WORKTREE ' + JSON.stringify({ case: name, native: result.status, prepared: legacy, named, actualCwd: prompt?.actualCwd ?? null, stateCwd: readState().seats[seat].cwd, branch, canonicalBranch: git(canonical, ['symbolic-ref', '--short', 'HEAD']), other: collision ? other : null, stdout: result.stdout, stderr: result.stderr, listing }));
    if (collision) {
      assert.notEqual(result.status, 0, 'branch occupied elsewhere must refuse, not preserve an unrelated recorded branch');
      assert(result.stderr.includes(legacy) && result.stderr.includes(other), 'refusal must name both target and branch-owner paths');
      assert(!result.stdout.includes('dispatched '), 'refusal must print no success line'); assert(!prompt, 'refused dispatch must not prompt the seat');
      assert.equal(branch, 'fleet/legacy-topic');
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert(prompt, 'dispatch must reach the actual seat');
      assert.equal(named, legacy, 'brief must name the actual adopted worktree, not the canonical anchor');
      assert.equal(prompt.actualCwd, legacy, 'actual worker cwd must match the brief, not merely state.json');
      assert.equal(readState().seats[seat].cwd, legacy);
      assert.equal(branch, 'fleet/' + task);
      assert(listing.includes('worktree ' + named + '\n') && listing.includes('branch refs/heads/fleet/' + task + '\n'));
      assert(prompt.message.includes('Branch: fleet/' + task), 'brief must name the prepared branch');
    }
    console.log('PASS dispatch-worktree ' + name);
  } catch (error) { failures++; console.error('CASE_ASSERTION ' + name); console.error(error); }
  finally { const stopped = adapter('stop', seat); assert.equal(stopped.status, 0, stopped.stderr); }
}
console.log(`dispatch-worktree: ${failures ? 'FAIL' : 'PASS'} (${cases.filter(x => selected === 'all' || x === selected).length} cases, ${failures} failures)`);
process.exitCode = failures ? 1 : 0;
