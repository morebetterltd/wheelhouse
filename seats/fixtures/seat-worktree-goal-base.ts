// Real fixture commits/worktrees; bd show is the parent suite's startup stub.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {completedCommand} from '../completed-command';
const [here,fixture,kind,control='fixed']=process.argv.slice(2);
assert(['contained','unmerged'].includes(kind));assert(['fixed','no-fallback','always-default'].includes(control));
assert(fs.lstatSync(path.join(fixture,'.wheelhouse-selftest-fixture')).isFile());
let module=path.join(here,'seat-worktree.ts');
if(control!=='fixed'){
 const runtime=path.join(fixture,'goal-module-'+kind+'-'+control);fs.mkdirSync(runtime);
 for(const name of fs.readdirSync(here))if(name.endsWith('.ts'))fs.copyFileSync(path.join(here,name),path.join(runtime,name));
 module=path.join(runtime,'seat-worktree.ts');let source=fs.readFileSync(module,'utf8');
 const decision='if (unique.ok && unique.out === "0")';assert.equal(source.split(decision).length,2);
 source=source.replace(decision,control==='no-fallback'?'if (false)':'if (true)');
 if(control==='always-default'){const ancestry='git(root, ["merge-base", "--is-ancestor", goal, defaultRef]).ok';assert.equal(source.split(ancestry).length,2);source=source.replace(ancestry,'true');}
 fs.writeFileSync(module,source);
}
const {ensureSeatWorktree,resolveBase}=await import(module);
function oracle(ok:unknown,reason:string){if(!ok)fs.writeFileSync(path.join(fixture,'goal-rejection-'+kind+'-'+control+'.json'),JSON.stringify({kind,control,reason}));assert(ok,'GOAL_BASE_ORACLE '+reason);}
const variants=kind==='contained'?['recorded','env','origin-head','origin-main','origin-master','local-main','local-master','head']:['recorded'];
for(const variant of variants){
 const root=path.join(fixture,'goal-'+kind+'-'+control+'-'+variant);fs.mkdirSync(root);fs.mkdirSync(path.join(root,'wheelhouse'));
 const git=(...args:string[])=>{const r=completedCommand('git',args,{cwd:root,timeout:10000});assert.ifError(r.error);assert.equal(r.signal,null);assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
 git('init','-q','-b','main');git('config','user.name','Goal base fixture');git('config','user.email','fixture@example.invalid');
 fs.writeFileSync(path.join(root,'base.txt'),'base\n');git('add','base.txt');git('commit','-qm','base');git('branch','fleet/goal');
 fs.writeFileSync(path.join(root,'default.txt'),'default moved ahead\n');git('add','default.txt');git('commit','-qm','default ahead');
 const defaultSha=git('rev-parse','main');
 if(kind==='unmerged'){git('switch','-q','fleet/goal');fs.writeFileSync(path.join(root,'goal.txt'),'unique goal work\n');git('add','goal.txt');git('commit','-qm','unique goal work');git('switch','-q','main');}
 const goalSha=git('rev-parse','fleet/goal');let expectedRef='main';delete process.env.WHEELHOUSE_WORKTREE_BASE;
 let target='';
 if(variant==='recorded')target='merge-target=main\n';
 if(variant==='env'){git('branch','env-line','main');process.env.WHEELHOUSE_WORKTREE_BASE='env-line';expectedRef='env-line';target='merge-target=fleet/goal\n';}
 if(variant==='origin-head'){git('update-ref','refs/remotes/origin/default',defaultSha);git('symbolic-ref','refs/remotes/origin/HEAD','refs/remotes/origin/default');expectedRef='origin/default';}
 if(variant==='origin-main'){git('update-ref','refs/remotes/origin/main',defaultSha);expectedRef='origin/main';}
 if(variant==='origin-master'){git('update-ref','refs/remotes/origin/master',defaultSha);expectedRef='origin/master';}
 if(variant==='local-master'){git('branch','-m','main','master');expectedRef='master';}
 if(variant==='head'){git('branch','-m','main','trunk');expectedRef='HEAD';}
 fs.writeFileSync(path.join(root,'wheelhouse/.template-source'),target);
 const notes:string[]=[];
 const result=ensureSeatWorktree({root,seat:'worker-1',beadId:'bead-integration',state:{seats:{}},roster:{'worker-1':{}},seatPush:'off',note:line=>notes.push(line)});
 const head=git('-C',result.target,'rev-parse','HEAD'),wanted=kind==='contained'?defaultSha:goalSha;
 console.log('GOAL_BASE '+JSON.stringify({kind,control,variant,goal:'fleet/goal',goalSha,defaultRef:expectedRef,defaultSha,base:result.base,head,notes}));
 oracle(head===wanted&&result.base===(kind==='contained'?expectedRef:'fleet/goal'),kind==='contained'?'contained goal must start at current default tip':'unique goal commit must remain the base');
 const fallback=notes.filter(line=>line.includes('holds nothing the default line lacks'));
 if(kind==='contained'){
  oracle(fallback.length===1&&fallback[0].includes('fleet/goal')&&fallback[0].includes(goalSha)&&fallback[0].includes(expectedRef)&&fallback[0].includes(defaultSha),'setup note must name both refs/SHAs and containment reason');
  const explicitNotes:string[]=[];oracle(resolveBase(root,'bead-integration','fleet/goal',root,line=>explicitNotes.push(line))==='fleet/goal'&&explicitNotes.length===0,'explicit base must win');
  git('branch','equal-default','fleet/goal');process.env.WHEELHOUSE_WORKTREE_BASE='equal-default';
  const equalNotes:string[]=[];oracle(resolveBase(root,'bead-integration',null,root,line=>equalNotes.push(line))==='fleet/goal'&&equalNotes.length===0,'equal tips must not trigger strict-ancestor fallback');
 }
 oracle(git('rev-parse','fleet/goal')===goalSha,'resolver must not move the goal branch');
}
if(control==='fixed'){
 const removal=kind==='contained'?'no-fallback':'always-default';
 const r=completedCommand('bun',[import.meta.path,here,fixture,kind,removal],{timeout:90000});
 assert.ifError(r.error);assert.equal(r.signal,null);assert.equal(r.status,1,r.stderr);
 const record=path.join(fixture,'goal-rejection-'+kind+'-'+removal+'.json');assert(fs.statSync(record).isFile());const rejected=JSON.parse(fs.readFileSync(record,'utf8'));assert.equal(rejected.control,removal);
 console.log('EXPECTED_REJECTION '+JSON.stringify({nativeCode:r.status,...rejected}));
 console.log('PASS goal base '+kind+' (real branch HEAD, note, unchanged goal ref; fix removal native1)');
}
