import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';

// Run the REAL site after a pipe acknowledgement lets us inspect a planted
// old name. No elapsed time decides success; the deadline only fails a hang.
const [kind, sourceArg, parentArg] = process.argv.slice(2);
assert(['claude','drift','prune','lsof','push','bootstrap','bootstrap-second-fail'].includes(kind));
const source = fs.realpathSync(sourceArg), parent = fs.realpathSync(parentArg);
assert(fs.statSync(path.join(parent,'.wheelhouse-selftest-fixture')).isFile(), 'owned parent required');
// Cleanup now requires a same-run marker AT its root, not merely an owned
// ancestor. Allocate through the reviewed helper; never forge its metadata or
// weaken cleanup's authorization. The owning shell exports its Git boundary
// immediately, and the caller already inherits the enclosing fixture boundary.
const library=path.resolve(import.meta.dir,'../selftest-lib.sh');
const gitEnv={...process.env};
for(const name of ['GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR','GIT_INDEX_FILE','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES'])delete gitEnv[name];
const allocate=spawnSync('bash',['-c',String.raw`. "$1"
FIX="$(selftest_make_fixture_dir "$2/scratch-ownership.XXXXXX")" || exit 2
selftest_isolate_git "$FIX" || exit 2
printf '%s\n' "$FIX"
`,'scratch-ownership-allocation',library,parent],{cwd:source,env:gitEnv,encoding:'utf8'});
console.log('CAPTURE scratch-ownership allocation '+JSON.stringify({exit:allocate.status,signal:allocate.signal,error:allocate.error?.message??null,stdout:allocate.stdout,stderr:allocate.stderr}));
assert.equal(allocate.error,undefined);assert.equal(allocate.signal,null);assert.equal(allocate.status,0);assert.equal(allocate.stderr,'');
const root=allocate.stdout.trim();
assert.equal(fs.realpathSync(root),root);assert.equal(path.dirname(root),parent);
const caseMarker=fs.readFileSync(path.join(root,'.wheelhouse-selftest-fixture'),'utf8');
assert(caseMarker.includes(`nonce=${process.env.WHEELHOUSE_SELFTEST_FIXTURE_NONCE}\nroot=${root}\n`),'case root is a recorded allocation of this run');
const tmp = path.join(root,'tmp'), bin = path.join(root,'bin');
fs.mkdirSync(tmp); fs.mkdirSync(bin);
const ledger = path.join(root,'allocations'), calls = path.join(root,'mktemp.calls'), pkills = path.join(root,'pkill.calls');
for(const file of [ledger,calls,pkills])fs.writeFileSync(file,'');
function command(cmd: string, args: string[], cwd = root, env = gitEnv) {
  const r=spawnSync(cmd,args,{cwd,env,encoding:'utf8'});
  console.log('CAPTURE scratch-ownership '+JSON.stringify({cmd,args,cwd,exit:r.status,signal:r.signal,error:r.error?.message??null,stdout:r.stdout,stderr:r.stderr}));
  assert.equal(r.error,undefined,`${cmd}: ${r.error}`);assert.equal(r.signal,null,`${cmd}: ${r.signal}`);return r;
}
const realMktemp = command('which',['mktemp']).stdout.trim();
assert(realMktemp && fs.statSync(realMktemp).isFile());
fs.writeFileSync(path.join(bin,'mktemp'),`#!/bin/sh
printf '%s\\n' "$*" >> "$I8SM_CALLS"
n=$(wc -l < "$I8SM_CALLS" | tr -d ' ')
if [ "$I8SM_KIND" = bootstrap-second-fail ] && [ "$n" -eq 2 ]; then echo 'I8SM_SECOND_ALLOCATION_REFUSED' >&2; exit 73; fi
made=$("$I8SM_REAL_MKTEMP" "$@") || exit $?
printf '%s\\n' "$made" >> "$I8SM_LEDGER"
printf '%s\\n' "$made"
`,{mode:0o755});
// Never run old pkill -f against the host. This safety shim changes NO file
// operation. The driver already sends TERM to its three own freshly spawned
// shims; the finally below drains any residual member of our isolated group.
fs.writeFileSync(path.join(bin,'pkill'),'#!/bin/sh\nprintf "%s\\n" "$*" >> "$I8SM_PKILLS"\nexit 0\n',{mode:0o755});
let site='', body='', cwd=root;
if(kind==='claude')site=path.join(source,'seats/drivers/claude-code/selftest.sh');
if(kind==='drift') {
  site=path.join(source,'seats/template-drift.sh');
  const template=path.join(root,'template'), install=path.join(root,'install');
  for(const dir of [template,install])for(const d of ['seats','runbooks','wheelhouse'])fs.mkdirSync(path.join(dir,d),{recursive:true});
  for(const dir of [template,install])fs.writeFileSync(path.join(dir,'seats/probe.ts'),'export const scratchFixture = true;\n');
  assert.equal(command('git',['init','-q','-b','main'],template).status,0);
  assert(fs.lstatSync(path.join(template,'.git')).isDirectory(),'private Git repo exists before add/commit');
  assert.equal(command('git',['rev-parse','--show-toplevel'],template).stdout.trim(),template);
  for(const args of [['add','.'],['-c','user.name=selftest','-c','user.email=selftest@example.invalid','-c','commit.gpgsign=false','commit','-qm','fixture']])assert.equal(command('git',args,template).status,0);
  const commit=command('git',['rev-parse','HEAD'],template).stdout.trim();assert(/^[0-9a-f]{40}$/.test(commit));
  fs.writeFileSync(path.join(install,'wheelhouse/.template-source'),`path=${template}\nsource=${template}\ncommit=${commit}\n`);
  body='exec bash "$I8SM_SITE" "$I8SM_INSTALL"';cwd=install;
}
if(kind==='prune') {
  // Extract the actual hazardous allocation AND its actual owning cleanup,
  // not a reimplementation. Both prune tiers source this exact fixture setup.
  const text=fs.readFileSync(path.join(source,'seats/fixtures/prune-fixture.sh'),'utf8');
  const start=text.indexOf('TMP_ROOT='), end=text.indexOf('\n',text.indexOf('OPEN_TMP_BEFORE=',start));
  assert(start>=0&&end>start,'actual prune tmp allocation block absent');
  const cleanup=text.split('\n').find(line=>line.startsWith('cleanup(){'));
  assert(cleanup,'actual prune cleanup absent');
  body=`. "$I8SM_SITE"\nFIX="$(selftest_make_fixture_dir "$TMPDIR/owned-fixture.XXXXXX")" || exit 2\nselftest_isolate_git "$FIX" || exit 2\nTMP_SCRATCH=()\n${cleanup}\nCLOSED_ID=fixture-closed\nOPEN_ID=fixture-open\nROOT="$I8SM_CASE/install"\nmkdir -p "$ROOT/.wheelhouse-runs/$OPEN_ID-build"\nprintf 'open run fixture\\n' > "$ROOT/.wheelhouse-runs/$OPEN_ID-build/file.txt"\ntest -s "$ROOT/.wheelhouse-runs/$OPEN_ID-build/file.txt" || exit 94\n${text.slice(start,end)}\nprintf '%s\\n' "$CLOSED_TMP" "$OPEN_TMP" > "$I8SM_CASE/children"\nprintf '%s\\n' "$OPEN_RUNS_BEFORE" "$OPEN_TMP_BEFORE" > "$I8SM_CASE/hashes"\ncleanup`;
  site=path.join(source,'seats/selftest-lib.sh');
}
if(kind==='lsof') {
  site=path.join(source,'seats/selftest-lib.sh');fs.mkdirSync(path.join(root,'subject'));
  body='. "$I8SM_SITE"; selftest_fixture_processes "$I8SM_CASE/subject"';
}
if(kind==='push') {
  site=path.join(source,'seats/push-authority-lint.sh');
  fs.mkdirSync(path.join(root,'install/wheelhouse'),{recursive:true});
  fs.writeFileSync(path.join(root,'install/wheelhouse/INTEGRATOR.md'),'# Integrator\n## This project\nThe commander pushes main.\n');
  fs.writeFileSync(path.join(root,'verdict.md'),'VERDICT: APPROVE\nPUSH: OK — recorded project authority\n');
  body='exec bash "$I8SM_SITE" "$I8SM_CASE/install" "$I8SM_CASE/verdict.md"';
}
if(kind.startsWith('bootstrap')) {
  const markdown=fs.readFileSync(path.join(source,'BOOTSTRAP.md'),'utf8'), anchor=markdown.indexOf('- **Contract integrity'), start=markdown.indexOf('```bash\n',anchor)+8, end=markdown.indexOf('\n  ```',start);
  assert(anchor>=0&&start>anchor&&end>start,'actual BOOTSTRAP integrity fence absent');
  // Containment-only relocation of the OLD absolute /tmp prefix; no other old
  // instruction changes. Never plant files in the host's literal shared /tmp.
  const recipe=markdown.slice(start,end).replace(/^  /gm,'').replaceAll('/tmp/wh-','${TMPDIR:-/tmp}/wh-');
  fs.writeFileSync(path.join(root,'integrity.sh'),recipe);site=path.join(root,'integrity.sh');
  const template=path.join(root,'template'), install=path.join(root,'install');fs.mkdirSync(path.join(template,'contracts'),{recursive:true});fs.mkdirSync(path.join(install,'wheelhouse'),{recursive:true});
  const pairs=[...recipe.matchAll(/\b((?:fleet\/|crew\/)?[\w.-]+\.md):([\w.-]+\.md)\b/g)].map(m=>[m[1],m[2]]);
  assert(pairs.length>=9&&pairs.some(p=>p[0]==='fleet/WORKER.md'),'actual recipe pair list required');
  for(const file of fs.readdirSync(path.join(source,'contracts')).filter(f=>f.endsWith('.md'))){const content=fs.readFileSync(path.join(source,'contracts',file),'utf8').split(/^## This project$/m)[0];fs.writeFileSync(path.join(template,'contracts',file),content);}
  for(const [dest,file] of pairs){const content=fs.readFileSync(path.join(template,'contracts',file),'utf8');fs.mkdirSync(path.dirname(path.join(install,'wheelhouse',dest)),{recursive:true});fs.writeFileSync(path.join(install,'wheelhouse',dest),content+'## This project\nOwned fixture project half.\n');}
  fs.writeFileSync(path.join(install,'wheelhouse/.template-source'),`path=${template}\ncommit=0123456789abcdef0123456789abcdef01234567\n`);cwd=install;
}
assert(fs.statSync(site).isFile());
if(!body)body='exec bash "$I8SM_SITE"';
const env={...gitEnv,TMPDIR:tmp,PATH:bin+':'+process.env.PATH,I8SM_KIND:kind,I8SM_CASE:root,I8SM_SITE:site,I8SM_INSTALL:path.join(root,'install'),I8SM_LEDGER:ledger,I8SM_CALLS:calls,I8SM_PKILLS:pkills,I8SM_REAL_MKTEMP:realMktemp,WHEELHOUSE_SCRATCH_COLLISION_CHILD:'1'};
const wrapper=`set -eu
case "$I8SM_KIND" in
 claude) mkdir "$TMPDIR/claude-code-driver.$$"; printf 'KEEP\\n' > "$TMPDIR/claude-code-driver.$$/KEEP";;
 drift) mkdir "$TMPDIR/wheelhouse-template-drift.$$"; printf 'KEEP\\n' > "$TMPDIR/wheelhouse-template-drift.$$/KEEP";;
 prune) mkdir "$TMPDIR/fixture-closed-derivedData" "$TMPDIR/fixture-open-derivedData"; printf 'KEEP\\n' > "$TMPDIR/fixture-closed-derivedData/KEEP"; printf 'KEEP\\n' > "$TMPDIR/fixture-open-derivedData/KEEP";;
 lsof) printf 'KEEP\\n' > "$TMPDIR/wheelhouse-selftest-lsof.$$.out";;
 push) printf 'KEEP\\n' > "$TMPDIR/push-authority-hit.$$";;
 bootstrap*) printf 'KEEP\\n' > "$TMPDIR/wh-a.$$"; printf 'KEEP\\n' > "$TMPDIR/wh-b.$$";;
esac
printf 'I8SM_READY\\n'
IFS= read -r go
[ "$go" = go ] || exit 95
${body}
`;
const child=spawn('bash',['-c',wrapper],{cwd,env,detached:true,stdio:['pipe','pipe','pipe']});
assert(child.pid);let stdout='',stderr='',resolveReady!:()=>void;
const ready=new Promise<void>(resolve=>{resolveReady=resolve;});
child.stdout!.on('data',b=>{stdout+=b;if(stdout.includes('I8SM_READY\n'))resolveReady();});child.stderr!.on('data',b=>stderr+=b);
const closed=new Promise<{code:number|null,signal:string|null}>((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
console.error(`FIXTURE_WAIT scratch ownership: ${kind} wrapper READY, child=${child.pid}`);
let oldNames: string[]=[];
const snapshot=(file:string)=>{const st=fs.lstatSync(file);return {dev:st.dev,ino:st.ino,mode:st.mode,entries:st.isDirectory()?fs.readdirSync(file).sort():null,keep:fs.readFileSync(st.isDirectory()?path.join(file,'KEEP'):file,'utf8')};};
let before: ReturnType<typeof snapshot>[]=[],after: unknown[]=[],allocations:string[]=[],result:unknown,error:unknown;const ownership:unknown[]=[];
try {
  await Promise.race([ready,closed.then(r=>{throw Error('site wrapper exited before planting: '+JSON.stringify(r)+stderr);})]);
  const id=child.pid!;
  oldNames=(kind==='claude'?[`claude-code-driver.${id}`]:kind==='drift'?[`wheelhouse-template-drift.${id}`]:kind==='prune'?['fixture-closed-derivedData','fixture-open-derivedData']:kind==='lsof'?[`wheelhouse-selftest-lsof.${id}.out`]:kind==='push'?[`push-authority-hit.${id}`]:[`wh-a.${id}`,`wh-b.${id}`]).map(n=>path.join(tmp,n));
  before=oldNames.map(snapshot);for(const s of before)assert.equal(s.keep,'KEEP\n','subject exists before execution');
  console.error(`FIXTURE_WAIT scratch ownership: ${kind} native exit and both EOFs, child=${child.pid}`);
  child.stdin!.end('go\n');result=await closed;
  after=oldNames.map(file=>fs.existsSync(file)?snapshot(file):{missing:file});
  allocations=fs.readFileSync(ledger,'utf8').trim().split('\n').filter(Boolean);
  const failures:string[]=[];
  if(JSON.stringify(before)!==JSON.stringify(after))failures.push('OLD predictable name was adopted, changed, or deleted');
  if((result as {code:number|null}).code!==(kind==='bootstrap-second-fail'?1:0))failures.push('unexpected site exit '+JSON.stringify(result));
  if(stderr!==(kind==='bootstrap-second-fail'?'I8SM_SECOND_ALLOCATION_REFUSED\n':''))failures.push('unexpected child stderr (not discarded): '+stderr);
  if(allocations.length===0)failures.push('no exclusive allocation observed');
  if(kind==='claude'&&fs.readFileSync(pkills,'utf8'))failures.push('driver attempted bare pkill -f');
  for(const file of allocations){if(!file.startsWith(tmp+'/'))failures.push('allocation escaped fixture TMPDIR: '+file);if(fs.existsSync(file))failures.push('owned allocation not cleaned: '+file);if(oldNames.includes(file))failures.push('old name adopted as allocation');}
  if(kind==='prune'){
    const children=fs.readFileSync(path.join(root,'children'),'utf8').trim().split('\n');
    for(const file of children)if(oldNames.includes(file)||fs.existsSync(file))failures.push('prune child adopted old name or survived cleanup: '+file);
    const hashes=fs.readFileSync(path.join(root,'hashes'),'utf8').trim().split('\n');
    if(hashes.length!==2||hashes.some(h=>!(/^[a-f0-9]{64}$/).test(h)))failures.push('prune measured an absent run/tmp subject');
  }
  if(kind.startsWith('bootstrap')&&kind!=='bootstrap-second-fail'&&!stdout.includes('INTEGRITY OK'))failures.push('actual integrity recipe did not finish');
  if(kind==='bootstrap-second-fail'&&!stderr.includes('I8SM_SECOND_ALLOCATION_REFUSED'))failures.push('second-allocation failure was not exercised');
  if(failures.length)throw Error(failures.join('; '));
} catch(e){error=e;}
finally {
  if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');
  // Validate every residual candidate's membership in the isolated group
  // before using the shared process drainer. Never signal by argv alone.
  const cleanupEnv={...env,I8SM_KIND:'cleanup',I8SM_LIBRARY:library};
  const inspected=command('bash',['-c','. "$I8SM_LIBRARY"; selftest_fixture_processes "$I8SM_CASE"'],source,cleanupEnv);
  if(inspected.status!==0)error??=Error('cannot inspect owned fixture survivors: '+inspected.stderr);
  let validated=inspected.status===0;
  for(const line of inspected.stdout.trim().split('\n').filter(Boolean)){
    const pid=line.split(/\s+/)[0];if(!/^\d+$/.test(pid)){validated=false;error??=Error('invalid survivor record');continue;}
    const ps=command('ps',['-p',pid,'-o','pgid=']);ownership.push({pid,exit:ps.status,stdout:ps.stdout,stderr:ps.stderr});
    if(ps.status===1&&!ps.stdout.trim())continue;
    if(ps.status!==0||Number(ps.stdout.trim())!==child.pid){validated=false;error??=Error('refuse foreign or ambiguous survivor '+pid);}
  }
  if(validated){const cleanup=command('bash',['-c','. "$I8SM_LIBRARY"; selftest_cleanup_fixture_processes "$I8SM_CASE"'],source,cleanupEnv);if(cleanup.status!==0)error??=Error('owned fixture cleanup failed: '+cleanup.stderr);}
}
console.log('MEASUREMENT scratch-ownership '+JSON.stringify({kind,pid:child.pid,site,caseRoot:root,caseMarker,oldNames,before,after,allocations,result,stdout,stderr,ownership,pkillSafetyShim:fs.readFileSync(pkills,'utf8'),failure:error instanceof Error?error.message:error??null}));
if(error)throw error;
console.log(`PASS scratch ownership ${kind}: old KEEP/identity intact; exclusive allocations cleaned`);
