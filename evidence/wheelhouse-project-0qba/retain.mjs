// Run from the seat worktree, only after the official sweep and rerun finish.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url)), worktree=process.cwd(), container=path.resolve(root,'../..');
function git(...args){const r=spawnSync('git',args,{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
assert.equal(git('symbolic-ref','--short','HEAD'),'fleet/wheelhouse-project-0qba');
assert.equal(git('rev-parse','HEAD'),git('rev-parse','refs/heads/fleet/wheelhouse-project-0qba'));
assert.equal(git('rev-parse','HEAD:seats'),fs.readFileSync(root+'/handoff-runtime-seats-tree.txt','utf8').trim());
assert.equal(fs.readFileSync(root+'/handoff-queue.exit','utf8'),'0\n');
for(const n of [1,2,3])assert.equal(fs.readFileSync(root+`/handoff-sweep-${n}.exit`,'utf8'),'0\n');
assert.equal(fs.readFileSync(root+'/handoff-no-wait-line.exit','utf8'),'1\n');
assert.equal(fs.readFileSync(root+'/digest-worker3.exit','utf8'),'0\n');
assert.equal(fs.readFileSync(root+'/digest-unset.exit','utf8'),'0\n');
assert.equal(fs.readFileSync(root+'/digest-worker1.exit','utf8'),'1\n');
assert.equal(fs.readFileSync(root+'/inventory-check.exit','utf8'),'0\n');
assert.equal(fs.readFileSync(root+'/receipt-control.exit','utf8'),'1\n');
const runs=['handoff-sweep-1','handoff-sweep-2','handoff-sweep-3','handoff-queue','handoff-no-wait-line','queue-frozen','frozen-negative-fifo','frozen-negative-dead','frozen-negative-cancel','frozen-negative-integrity','frozen-negative-integrity-symlink','frozen-negative-integrity-foreign','full-frozen','digest-worker1','digest-unset','digest-worker3','full','full-final','sweep-ownership'];
for(const run of runs.filter(r=>r.startsWith('frozen-negative-')))assert.equal(fs.readFileSync(root+'/'+run+'.exit','utf8'),'1\n');
for(const run of ['full','full-final'])assert.equal(fs.readFileSync(root+'/'+run+'.exit','utf8'),'143\n');
const names=runs.flatMap(run=>['stdout','stderr','exit','before.json','after.json'].map(s=>run+'.'+s));
names.push('execution.md','handoff-runtime-tip.txt','handoff-runtime-seats-tree.txt','covered-source-identity.json','failed-sweep-section.txt','digest-worker1-diagnostic.txt','digest-worker1-diagnostic.stderr','digest-full-receipts.txt','digest-full-receipts.stderr','actor-source-corrected.txt','actor-source-corrected.stderr','own-active-lock.json','acquisition-observation.json','gated-runtime-tip.txt','gated-runtime-seats-tree.txt','suite-inventory.txt','legacy-lock.txt','control-source-check.json','bridge.selftest.sh','assert-sweep.mjs','check-run.cjs','check-controls.mjs','retain.mjs','inventory-check.json','inventory-check.stderr','inventory-check.exit','receipt-control.stdout','receipt-control.stderr','receipt-control.exit','receipt-control.json','full-minus-queue-pass.stdout','queued-cancel.json','queued2-cancel.json','cancel-before-fixture-fix.mjs','cancel-before-poll-barrier.mjs','frozen-own-processes.ps','frozen-own-processes.ps.stderr');
for(const prefix of ['queued','queued2'])for(const suffix of ['wrapper.ps','wrapper.ps.stderr','children.pids','children.stderr','outer.ps','outer.ps.stderr','outer.cwd','outer.cwd.stderr'])names.push(prefix+'-'+suffix);
for(const p of ['wait-line.patch','fifo.patch','dead.patch','cancel.patch','integrity-symlink.patch','integrity-foreign-ticket.patch','preservation-control.sh'])names.push('controls/'+p);
names.push('owned-bun-cwds.txt','owned-bun-cwds.stderr','owned-bun-cwds.exit','owned-heralds.ps','owned-heralds.ps.stderr','owned-herald-stop.json','owned-stop.stdout','owned-stop.stderr','owned-heralds-gone.stdout','owned-heralds-gone.stderr','owned-heralds-gone.exit','stop-owned-heralds.mjs');
for(const pid of [16008,21881])for(const suffix of ['ps','ps.stderr','cwd','cwd.stderr'])names.push(`owned-${pid}.${suffix}`);
assert.equal(new Set(names).size,names.length);
for(const name of names)assert(fs.statSync(path.join(root,name)).isFile(),'missing capture '+name);
const target=path.join(worktree,'evidence/wheelhouse-project-0qba');
assert(fs.statSync(path.join(target,'README.md')).isFile(),'hand-written README committed separately first');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function redact(s){for(const [from,to] of [[root,'[run]'],[worktree,'[worktree]'],[container,'[container]'],[process.env.HOME,'[home]']])if(from)s=s.split(from).join(to);return s;}
const rows=[];
for(const name of names){const raw=fs.readFileSync(path.join(root,name)),retained=Buffer.from(redact(raw.toString('utf8'))),dest=path.join(target,name);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,retained);rows.push({path:name,rawBytes:raw.length,rawSha256:hash(raw),retainedBytes:retained.length,retainedSha256:hash(retained)});}
fs.writeFileSync(path.join(target,'capture-manifest.json'),JSON.stringify({policy:'Only owned run/worktree/container and HOME path prefixes replaced; streams, empty files, PIDs, signals, assertions, exit codes and order retained.',files:rows},null,2)+'\n');
console.log(JSON.stringify({retained:rows.length,sourceRuntime:fs.readFileSync(root+'/handoff-runtime-tip.txt','utf8').trim(),target}));
