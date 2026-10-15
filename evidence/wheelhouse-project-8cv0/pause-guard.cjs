// Enforce the user's explicit 23:00 policy, not a guessed test timeout.
const fs=require('node:fs'),{spawnSync}=require('node:child_process');
const root=__dirname,wrapper=39321,outer=39836;
const expectedWrapper=fs.readFileSync(root+'/full-wrapper-process.txt','utf8').trim();
const expectedOuter=fs.readFileSync(root+'/full-outer-process.txt','utf8').trim();
const expectedCwd=fs.readFileSync(root+'/full-outer-cwd.txt','utf8').trim();
if(!expectedWrapper.includes(root+'/check-run.cjs full bash seats/selftest-sweep.sh')||!/^39836\s+39321\s+/.test(expectedOuter)||!expectedCwd.includes('n'+process.cwd()))throw Error('ownership baseline mismatch');
const deadline=new Date();deadline.setHours(23,0,0,0);if(deadline<=new Date())throw Error('not scheduling after cutoff');
function probe(command,args){const r=spawnSync(command,args,{encoding:'utf8'});return {status:r.status,stdout:r.stdout,stderr:r.stderr,error:r.error?String(r.error):null};}
const result={deadline:deadline.toISOString(),outer,wrapper};
function save(){fs.writeFileSync(root+'/pause-result.json',JSON.stringify(result,null,2)+'\n');}
const watch=fs.watch(root,()=>{if(fs.existsSync(root+'/full.exit')){clearTimeout(timer);watch.close();result.action='already completed; no signals';save();console.log(result.action);}});
const timer=setTimeout(()=>{
  watch.close();
  if(fs.existsSync(root+'/full.exit')){result.action='already completed; no signals';save();return;}
  result.wrapperProbe=probe('ps',['-p',String(wrapper),'-o','pid=,ppid=,lstart=,command=']);
  result.outerProbe=probe('ps',['-p',String(outer),'-o','pid=,ppid=,lstart=,command=']);
  result.cwdProbe=probe('lsof',['-a','-p',String(outer),'-d','cwd','-Fn']);
  const valid=result.wrapperProbe.status===0&&!result.wrapperProbe.stderr&&!result.wrapperProbe.error&&result.wrapperProbe.stdout.trim()===expectedWrapper&&result.outerProbe.status===0&&!result.outerProbe.stderr&&!result.outerProbe.error&&result.outerProbe.stdout.trim()===expectedOuter&&result.cwdProbe.status===0&&!result.cwdProbe.stderr&&!result.cwdProbe.error&&result.cwdProbe.stdout.trim()===expectedCwd;
  if(!valid){result.action='REFUSED: ownership changed; no signal';save();console.error(result.action);return;}
  process.kill(outer,'SIGTERM');result.action='TERM validated owned official outer runner at 23:00; incomplete, not green';save();console.log(result.action);
},deadline-Date.now());
if(fs.existsSync(root+'/full.exit')){clearTimeout(timer);watch.close();result.action='already completed; no signals';save();}
console.log('Pause guard armed for '+deadline.toISOString());
