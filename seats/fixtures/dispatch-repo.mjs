// Observe real adapter dispatch effects in manufactured umbrella/product repos.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from "./fixture-command.cjs";
const [root,bead,code,mode,beforeFile,outputFile]=process.argv.slice(2);
for(const repo of [root,path.join(root,'template')])assert(fs.statSync(path.join(repo,'.git')).isDirectory());
function git(repo,args){const r=spawnSync('git',['-C',repo,...args],{encoding:'utf8'});assert(!r.error,String(r.error));assert.equal(r.signal,null);return r;}
function hasBranch(repo){const r=git(repo,['show-ref','--verify','--quiet','refs/heads/fleet/'+bead]);assert([0,1].includes(r.status),r.stderr);return r.status===0;}
const state=JSON.parse(fs.readFileSync(path.join(root,'seats/state.json'),'utf8'));
const witness={case:mode,code:Number(code),umbrellaBranchCreated:hasBranch(root),productBranchCreated:hasBranch(path.join(root,'template'))};
console.log('REPO_DISPATCH_WITNESS '+JSON.stringify(witness));
// Measure an existing product-owned seat, never a missing fresh-seat directory.
const productSeat=state.seats['worker-1'].cwd;assert(fs.statSync(productSeat).isDirectory());
const productCommon=git(path.join(root,'template'),['rev-parse','--path-format=absolute','--git-common-dir']),seatCommon=git(productSeat,['rev-parse','--path-format=absolute','--git-common-dir']);assert.equal(productCommon.status,0,productCommon.stderr);assert.equal(seatCommon.status,0,seatCommon.stderr);assert.equal(seatCommon.stdout,productCommon.stdout);
const productRootList=git(path.join(root,'template'),['branch','--list','fleet/'+bead]),productSeatList=git(productSeat,['branch','--list','fleet/'+bead]);assert.equal(productRootList.status,0,productRootList.stderr);assert.equal(productSeatList.status,0,productSeatList.stderr);
console.log('REPO_BRANCH_LIST_WITNESS '+JSON.stringify({case:mode,productRootStdout:productRootList.stdout,productSeatStdout:productSeatList.stdout}));
assert.equal(productRootList.stdout,'','product root has a wrong-repo branch');assert.equal(productSeatList.stdout,'','product seat has a wrong-repo branch');
if(mode.startsWith('occupied-')){
 assert.equal(Number(code),1,'foreign-repo target must be refused');
 const output=fs.readFileSync(outputFile,'utf8');assert(output.includes(bead)&&output.includes('Repo: UMBRELLA')&&output.includes('belongs to another repository')&&output.includes('refusing to create or switch'),'refusal must name task and explain repository mismatch');console.log('REPO_REFUSAL_OUTPUT '+JSON.stringify({case:mode,output}));
 assert.equal(witness.umbrellaBranchCreated,false);assert.equal(witness.productBranchCreated,false,'empty branch created in product repo');
 const before=JSON.parse(fs.readFileSync(beforeFile,'utf8')).seats['worker-1'],after=state.seats['worker-1'];
 for(const key of ['pid','cwd','lastBead','sessionFile','sessionId'])assert.deepEqual(after[key],before[key],key+' changed during refused dispatch');
 const branch=git(after.cwd,['symbolic-ref','--short','HEAD']);assert.equal(branch.status,0,branch.stderr);assert.equal(branch.stdout.trim(),'fleet/bead-product-b');
 process.kill(after.pid,0);
 console.log('PASS '+mode+': clear refusal; no branch in either repo; product worktree, live seat and dispatch record preserved');
}else{
 assert.equal(mode,'fresh-inline');assert.equal(Number(code),0);assert.equal(witness.umbrellaBranchCreated,true);assert.equal(witness.productBranchCreated,false,'empty branch created in product repo');
 const rec=state.seats['worker-2'];assert.equal(rec.lastBead,bead);assert.equal(rec.cwd,path.join(root,'.wheelhouse-worktrees/worker-2'));
 const branch=git(rec.cwd,['branch','--show-current']);assert.equal(branch.status,0,branch.stderr);assert.equal(branch.stdout.trim(),'fleet/'+bead);console.log('REPO_UMBRELLA_BRANCH '+JSON.stringify({case:mode,stdout:branch.stdout}));
 const actual=git(rec.cwd,['rev-parse','--path-format=absolute','--git-common-dir']),expected=git(root,['rev-parse','--path-format=absolute','--git-common-dir']);assert.equal(actual.status,0,actual.stderr);assert.equal(expected.status,0,expected.stderr);assert.equal(actual.stdout,expected.stdout);
 const cwdFile=path.join(process.env.HOME,'.pi-seats-umbrella/worker-2/cwd.txt');assert.equal(fs.readFileSync(cwdFile,'utf8'),rec.cwd);
 console.log('PASS fresh-inline: umbrella branch/worktree prepared and worker launched there; no product branch');
}
