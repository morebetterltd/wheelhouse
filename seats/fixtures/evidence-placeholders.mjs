// Real scrubber entry points, owned HOME/TMPDIR, and adversarial basenames.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const [scrub,root]=process.argv.slice(2);
assert(fs.statSync(scrub).isFile());
assert(fs.statSync(path.join(root,'.wheelhouse-selftest-fixture')).isFile());
const user=spawnSync('id',['-un'],{encoding:'utf8'});assert.equal(user.status,0,user.stderr);const rawUser=user.stdout.trim();assert(rawUser);
let failures=0;
for(const base of ['home','tmpdir','user','h','x[ho']){
 const dir=path.join(root,'placeholders-'+base),home=path.join(dir,base),tmp=path.join(dir,'scratch');fs.mkdirSync(home,{recursive:true});fs.mkdirSync(tmp);
 const env={...process.env,HOME:home,TMPDIR:tmp};
 const input=`p0=${tmp}/planted.log\np1=${home}/Library/planted\np2=${rawUser}\np3=/var/folders/zz/planted/file.log\np4=x[home]|[tmpdir]|[home]|[user]\np5=${base}\n`;
 const expected='p0=[tmpdir]/planted.log\np1=[home]/Library/planted\np2=[user]\np3=[tmpdir]\np4=x[home]|[tmpdir]|[home]|[user]\np5=[user]\n';
 function run(args,text){const r=spawnSync('bash',args,{env,input:text,encoding:'utf8'});assert.ifError(r.error);assert.equal(r.signal,null);assert.equal(r.status,0,r.stderr);return r.stdout;}
 try{
  const first=run([scrub],input);fs.writeFileSync(path.join(dir,'first.txt'),first);assert.equal(first,expected,'stdin redaction or opaque tokens');
  const second=run([scrub],first);assert.equal(second,first,'second scrub changed placeholders');
  const sourced=run(['-c','. "$1"; scrub_evidence','source-scrubber',scrub],input);assert.equal(sourced,expected,'sourced API differs');
  const output=path.join(dir,'capture.txt');run([scrub,'-o',output,'--','bash','-c','printf "%s" "$1"','planted',input],'');assert.equal(fs.readFileSync(output,'utf8'),expected,'capture API differs');
  console.log(`PASS opaque placeholders HOME=${base}: stdin/source/capture match, raw values redacted, second pass byte-identical`);
 }catch(e){failures++;console.error(`FAIL opaque placeholders HOME=${base}: ${e.message}`);}
}
assert.equal(failures,0,`${failures} placeholder basename cases failed`);
