// Selective fix removals must reach the real case's own assertion, not a
// missing module, dead actor or setup failure. Only copied runtime is mutated.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { completedCommand } from '../completed-command';
const [here, root] = process.argv.slice(2);
assert(fs.statSync(path.join(root,'.wheelhouse-selftest-fixture')).isFile());
const adapter=fs.readFileSync(path.join(here,'adapter.ts'),'utf8');
const worktree=fs.readFileSync(path.join(here,'seat-worktree.ts'),'utf8');
const brief=fs.readFileSync(path.join(here,'../contracts/WORKER.md'),'utf8');
const rule=brief.split('\n').find(line=>line.startsWith('- Work ONLY'))!;assert(rule.includes("adapter's dispatch context"));
const controls=[
 {name:'brief-path',case:'legacy',env:'WHEELHOUSE_DISPATCH_ADAPTER_SOURCE',source:adapter,old:'Worktree: ${targetCwd}',next:'Worktree: ${seatCwdFor(name, entry())}',message:'brief must name the actual adopted worktree'},
 {name:'native-cwd',case:'recorded-cwd',env:'WHEELHOUSE_DISPATCH_ADAPTER_SOURCE',source:adapter,old:'!samePath(actualCwd ?? rec.cwd, targetCwd)',next:'!samePath(rec.cwd, targetCwd)',message:'native cwd'},
 {name:'stale-branch',case:'recorded-task',env:'WHEELHOUSE_DISPATCH_WORKTREE_SOURCE',source:worktree,old:'if (atTarget?.branch && legacyTaskBranch === atTarget.branch) branch = atTarget.branch;',next:'if (atTarget?.branch && (path.basename(target) === o.beadId || rec?.lastBead === o.beadId)) branch = atTarget.branch;',message:'prepared worktree must be on the task branch'},
 {name:'associated-collision',case:'associated-collision',env:'WHEELHOUSE_DISPATCH_WORKTREE_SOURCE',source:worktree,old:'(w.branch === branch || w.branch === beadBranch(o.beadId))',next:'w.branch === branch',message:'branch occupied elsewhere must refuse'},
 {name:'both-paths',case:'collision',env:'WHEELHOUSE_DISPATCH_WORKTREE_SOURCE',source:worktree,old:'; cannot prepare target ${target}: a branch can be in one worktree at a time',next:'; a branch can be in one worktree at a time',message:'refusal must name both target and branch-owner paths'},
 {name:'stopped-record',case:'stopped-record',env:'WHEELHOUSE_DISPATCH_WORKTREE_SOURCE',source:worktree,old:'if (other === o.seat || !otherRec?.cwd || !pidAlive(otherRec.pid ?? null)) continue;',next:'if (other === o.seat || !otherRec?.cwd) continue;',message:'occupied by seat worker-stopped'},
 {name:'brief-rule',case:'legacy',env:'WHEELHOUSE_DISPATCH_BRIEF_SOURCE',source:brief,old:rule,next:'- Work ONLY in your seat\'s canonical worktree (`.wheelhouse-worktrees/<seat>`), on the task branch.',message:'brief must name the actual adopted worktree'},
];
const dir=path.join(root,'controls');fs.mkdirSync(dir);
for(const c of controls){
 assert.equal(c.source.split(c.old).length,2,'unique removal anchor '+c.name);
 const file=path.join(dir,c.name+(c.env.endsWith('BRIEF_SOURCE')?'.md':'.ts'));fs.writeFileSync(file,c.source.replace(c.old,c.next));
 const env={...process.env,[c.env]:file};
 const r=completedCommand('bun',[path.join(here,'fixtures/dispatch-worktree.ts'),here,root,c.case,'control-'+c.name],{env});
 if(process.env.WHEELHOUSE_DISPATCH_WORKTREE_EVIDENCE){const prefix=path.join(process.env.WHEELHOUSE_DISPATCH_WORKTREE_EVIDENCE,'control-'+c.name);fs.writeFileSync(prefix+'.stdout',r.stdout);fs.writeFileSync(prefix+'.stderr',r.stderr);fs.writeFileSync(prefix+'.result.json',JSON.stringify({status:r.status,signal:r.signal??null,error:r.error?.message??null}));}
 assert(!r.error&&!r.signal,'removal must complete natively');assert.equal(r.status,1,r.stdout+'\n'+r.stderr);
 assert(r.stdout.includes('DISPATCH_WORKTREE '),'real dispatch setup must execute');
 assert(r.stderr.includes('CASE_ASSERTION '+c.case)&&r.stderr.includes('AssertionError')&&r.stderr.includes(c.message),'intended case assertion, not setup/import failure: '+r.stderr);
 console.log('REJECT dispatch-worktree '+c.name+': native1, intended assertion after real setup');
}
console.log(`dispatch-worktree controls: PASS (${controls.length} meaningful removals)`);
