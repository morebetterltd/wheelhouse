import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
assert(root.endsWith('/.wheelhouse-runs/wheelhouse-project-0qba'));
const expected=fs.readFileSync(root+'/owned-heralds.ps','utf8').trim().split('\n');
const results=[];
for(const [pid,leaf] of [[16008,'project'],[21881,'canary-herald']]){
 const ps=spawnSync('ps',['-p',String(pid),'-o','pid=,ppid=,pgid=,lstart=,command='],{encoding:'utf8'});
 assert.equal(ps.status,0,ps.stderr);
 const old=expected.find(row=>Number(row.trim().split(/\s+/)[0])===pid);assert(old);
 assert.deepEqual(ps.stdout.trim().split(/\s+/),old.trim().split(/\s+/));
 assert.match(ps.stdout,/bun seats\/herald\.ts\n$/);
 const cwd=spawnSync('lsof',['-a','-p',String(pid),'-d','cwd','-Fn'],{encoding:'utf8'});assert.equal(cwd.status,0,cwd.stderr);
 assert.equal(cwd.stdout,`p${pid}\nfcwd\nn${root}/tmp/wheelhouse-staffing-live.OYcsOi/${leaf}\n`);
 fs.writeFileSync(root+`/owned-${pid}.ps`,ps.stdout);fs.writeFileSync(root+`/owned-${pid}.ps.stderr`,ps.stderr);
 fs.writeFileSync(root+`/owned-${pid}.cwd`,cwd.stdout);fs.writeFileSync(root+`/owned-${pid}.cwd.stderr`,cwd.stderr);
 process.kill(pid,'SIGTERM');results.push({pid,signal:'SIGTERM',ps:ps.stdout,cwd:cwd.stdout});
}
fs.writeFileSync(root+'/owned-herald-stop.json',JSON.stringify(results,null,2)+'\n');console.log('TERM sent only to freshly matched owned fixture heralds16008/21881');
