// The fresh-seat path remains primary-anchor preparation. Occupied product
// seats and separate umbrella anchors are witnessed in dispatch-umbrella.mjs.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {spawnSync} from './fixture-command.cjs';
const [root,bead,code,mode]=process.argv.slice(2);assert.equal(mode,'fresh-inline');
for(const repo of [root,path.join(root,'template')])assert(fs.statSync(path.join(repo,'.git')).isDirectory());
function git(repo,args){const r=spawnSync('git',['-C',repo,...args],{encoding:'utf8'});assert(!r.error,String(r.error));assert.equal(r.signal,null);return r;}
function hasBranch(repo){const r=git(repo,['show-ref','--verify','--quiet','refs/heads/fleet/'+bead]);assert([0,1].includes(r.status),r.stderr);return r.status===0;}
assert.equal(Number(code),0);assert(hasBranch(root));assert(!hasBranch(path.join(root,'template')),'empty branch created in product repo');
const state=JSON.parse(fs.readFileSync(path.join(root,'seats/state.json'),'utf8')),rec=state.seats['worker-2'];assert.equal(rec.lastBead,bead);assert.equal(rec.cwd,path.join(root,'.wheelhouse-worktrees/worker-2'));
const branch=git(rec.cwd,['branch','--show-current']);assert.equal(branch.status,0,branch.stderr);assert.equal(branch.stdout.trim(),'fleet/'+bead);
const actual=git(rec.cwd,['rev-parse','--path-format=absolute','--git-common-dir']),expected=git(root,['rev-parse','--path-format=absolute','--git-common-dir']);assert.equal(actual.status,0,actual.stderr);assert.equal(expected.status,0,expected.stderr);assert.equal(actual.stdout,expected.stdout);
assert.equal(fs.readFileSync(path.join(process.env.HOME,'.pi-seats-umbrella/worker-2/cwd.txt'),'utf8'),rec.cwd);
console.log('REPO_UMBRELLA_BRANCH '+JSON.stringify({case:mode,stdout:branch.stdout}));console.log('PASS fresh-inline: umbrella branch/worktree prepared and worker launched there; no product branch');
