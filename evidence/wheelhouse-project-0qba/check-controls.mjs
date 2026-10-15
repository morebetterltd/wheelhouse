import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const variants=[
 ['fifo','seats/selftest-sweep-lock.ts','no-fifo.ts','if (snapshot || current[0].token !== token) {','if (snapshot) { // removed FIFO head eligibility'],
 ['dead','seats/selftest-sweep-lock.ts','no-reap.ts','for (const ticket of all) if (!alive(ticket.pid)) {','for (const ticket of all) if (false && !alive(ticket.pid)) { // removed dead PID reap'],
 ['cancel','seats/selftest-sweep.sh','no-cancel.sh','if [ "$ENROLLED" = 1 ]; then','if [ -n "$OWNED_LOCK" ]; then # removed pre-acquisition cancellation'],
 ['wait-line','seats/selftest-sweep.sh','no-wait-line.sh','      info "selftest-sweep: waiting for host-wide lock $LOCK $result"','      : # removed only the wait diagnostic']
];
const results=[];
for(const [leg,source,variant,before,after] of variants){
 const original=fs.readFileSync(source,'utf8'), changed=fs.readFileSync(root+'/controls/'+variant,'utf8');
 assert.equal(original.split(before).length,2,'unique mutation subject'); assert.equal(changed,original.replace(before,after),'exactly the intended edit');
 const diff=spawnSync('git',['diff','--no-index','--unified=0','--',source,root+'/controls/'+variant],{encoding:'utf8'});assert.equal(diff.status,1,diff.stderr);
 fs.writeFileSync(root+'/controls/'+leg+'.patch',diff.stdout);
 results.push({leg,source,sourceSha256:sha(original),variantSha256:sha(changed),exactOneEdit:true});
}
const baseline=spawnSync('git',['show','c43b08be360b8902dcc7df1978d444e4e4cc71ef:seats/selftest-sweep-lock.ts']);assert.equal(baseline.status,0,baseline.stderr.toString());
assert.deepEqual(baseline.stdout,fs.readFileSync(root+'/controls/baseline-helper.ts'));
results.push({leg:'integrity',baseline:'c43b08b:seats/selftest-sweep-lock.ts',sha256:sha(baseline.stdout),byteIdentical:true});
for(const [kind,file] of [['symlink','integrity-symlink.ts'],['foreign-ticket','integrity-foreign.ts']]){
 const original=fs.readFileSync('seats/fixtures/sweep-queue.ts','utf8'), selected=fs.readFileSync(root+'/controls/'+file,'utf8');
 const before='for (const kind of ["unmarked", "symlink", "foreign-ticket"]) {';
 assert.equal(original.split(before).length,2);
 assert.equal(selected,original.replace(before,`for (const kind of ["${kind}"]) { // select only this unchanged assertion group`));
 const diff=spawnSync('git',['diff','--no-index','--unified=0','--','seats/fixtures/sweep-queue.ts',root+'/controls/'+file],{encoding:'utf8'});assert.equal(diff.status,1,diff.stderr);
 fs.writeFileSync(root+'/controls/integrity-'+kind+'.patch',diff.stdout);
 results.push({leg:'integrity-'+kind,sourceSha256:sha(original),selectedSha256:sha(selected),onlyCaseSelectionChanged:true});
}
fs.writeFileSync(root+'/control-source-check.json',JSON.stringify(results,null,2)+'\n');console.log(JSON.stringify(results));
