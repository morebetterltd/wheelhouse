// Real ps/cwd observations, no network push. Direct mode needs no graph.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {completedCommand} from '../completed-command';
const [root, worktree, sourceFile, mode = 'cleanup'] = process.argv.slice(2);
assert(fs.statSync(root).isDirectory() && fs.statSync(worktree).isDirectory());
const evidence = path.join(root, 'seats/run/push-separator-proof'); fs.mkdirSync(evidence, {recursive:true});
const runDir = path.join(root, 'seats/run');
assert(!fs.readdirSync(runDir).some(n => /^push\..+\.json$/.test(n)), 'no push marker may authorize this proof');
const env = {...process.env, LC_ALL:process.platform==='darwin'?'en_US.UTF-8':'C.UTF-8'};
const child = spawn('/bin/sleep',['120'],{cwd:worktree,argv0:'git \u2028 push fixture-no-network',stdio:'ignore'});
const started = new Promise<void>((r,j)=>{child.once('spawn',()=>r());child.once('error',j);});
const done = new Promise(r=>child.once('close',r));
try {
  await started;
  const ps = completedCommand('ps',['axo','pid=,command='],{env});
  assert.equal(ps.status,0); assert.equal(ps.stderr,'');
  fs.writeFileSync(path.join(evidence,'native-ps.stdout'),ps.stdout,{mode:0o600});
  const row = ps.stdout.split('\n').find(l=>new RegExp(`^\\s*${child.pid}\\s+`).test(l));
  assert(row?.includes('\u2028') && row.includes('push'), 'native UTF-8 row must contain the owned git-push title');
  console.log('CAPTURE ps axo pid=,command= exit=0 subject='+JSON.stringify(row));
  if(mode==='direct') {
    let source=fs.readFileSync(sourceFile,'utf8');
    assert.equal(source.split('function pushInProgress(').length,2);
    // Add only an export to a private copy, preserving the actual parser,
    // native capture and per-PID cwd reader. import.meta.main stays false.
    source=source.replace('function pushInProgress(','export function pushInProgress(')
      .replace(/from "(\.\/[^"\n]+)"/g,(_,name)=>'from '+JSON.stringify(path.resolve(path.dirname(sourceFile),name)));
    const copy=path.join(evidence,'prune-probe.ts'); fs.writeFileSync(copy,source);
    const api=await import(copy); const saved=process.env.LC_ALL; process.env.LC_ALL=env.LC_ALL;
    let reason; try {reason=api.pushInProgress(root,worktree,null);} finally {if(saved===undefined)delete process.env.LC_ALL;else process.env.LC_ALL=saved;}
    assert.equal(reason,`pid ${child.pid} is running git push`);
    assert(fs.statSync(worktree).isDirectory());
    console.log('PASS direct pushInProgress: '+reason+'; marker absent; real cwd inside fixture; no graph or cleanup invoked');
  } else {
    assert.equal(mode,'cleanup');
    const lsof=Bun.which('lsof'); assert(lsof);
    const wrapper=path.join(evidence,'aggregate-lsof');
    // Earlier aggregate cwd protection would mask the push-reader regression.
    // Remove only this owned PID from that aggregate view; per-PID lsof used
    // by production processCwd is unmodified. Record native bytes first.
    fs.writeFileSync(wrapper,`#!/usr/bin/env bun
import fs from 'node:fs';import {completedCommand} from ${JSON.stringify(path.join(path.dirname(sourceFile),'completed-command.ts'))};
const r=completedCommand(${JSON.stringify(lsof)},process.argv.slice(2));
if(r.status!==0||r.error||r.signal||r.stderr){process.stderr.write(r.stderr||'lsof failed');process.exit(r.status||2);}
fs.writeFileSync(${JSON.stringify(path.join(evidence,'native-lsof.stdout'))},r.stdout);
let omit=false;const lines=[];for(const line of r.stdout.split('\\n')){if(line.startsWith('p'))omit=line==='p${child.pid}';if(!omit)lines.push(line);}process.stdout.write(lines.join('\\n'));
`,{mode:0o700});
    const result=completedCommand('bun',[sourceFile,'cleanup','--root',root,'--bead',path.basename(worktree)],{cwd:root,env:{...env,WHEELHOUSE_LSOF:wrapper}});
    fs.writeFileSync(path.join(evidence,'cleanup.json'),JSON.stringify(result));
    console.log('cleanup stdout:\n'+result.stdout); console.log('cleanup stderr:\n'+result.stderr); console.log('cleanup exit='+result.status);
    assert.equal(result.status,0,result.stderr);
    assert(result.stdout.split('\n').some(l=>l.includes(worktree)&&l.includes('reason=deferred: push in progress')));
    assert(!result.stdout.split('\n').some(l=>l.includes('removed merged-worktree '+worktree+' ')));
    assert(fs.statSync(worktree).isDirectory());
  }
} finally {
  if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');
  await done;
}
