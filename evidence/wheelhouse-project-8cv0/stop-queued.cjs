const fs=require('node:fs'),{spawnSync}=require('node:child_process');const root=__dirname;
if(fs.existsSync(root+'/full.exit'))throw Error('already completed; no signal');
const log=fs.readFileSync(root+'/full.stdout','utf8');
const starts=[...log.matchAll(/^selftest-sweep: START .*\/seats\/[^\n]+\.selftest\.sh$/gm)];
if(starts.length)throw Error('inner suites already started; leave active gate to explicit 23:00 guard');
function probe(command,args){const r=spawnSync(command,args,{encoding:'utf8'});if(r.status!==0||r.stderr||r.error)throw Error('probe failed '+JSON.stringify({status:r.status,stderr:r.stderr,error:String(r.error)}));return r.stdout.trim();}
const checks=[['full-wrapper-process.txt',probe('ps',['-p','39321','-o','pid=,ppid=,lstart=,command='])],['full-outer-process.txt',probe('ps',['-p','39836','-o','pid=,ppid=,lstart=,command='])],['full-outer-cwd.txt',probe('lsof',['-a','-p','39836','-d','cwd','-Fn'])]];
for(const [file,actual]of checks)if(actual!==fs.readFileSync(root+'/'+file,'utf8').trim())throw Error('ownership changed '+file);
process.kill(39836,'SIGTERM');
const result={at:new Date().toISOString(),action:'TERM validated owned outer official runner; scheduling pause after 22:30, before any inner suite starts',outer:39836,wrapper:39321,innerStartsBeforeSignal:0,checks};fs.writeFileSync(root+'/queued-stop.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
