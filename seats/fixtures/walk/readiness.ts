// Test-only synchronous-spawn adapter plus external readiness/clock driver.
// Production walk.ts never imports this module. Polls schedule work, not expiry.
import fs from "node:fs";
import path from "node:path";
import {spawn, spawnSync as nativeSpawnSync} from "node:child_process";
import {randomUUID} from "node:crypto";
import assert from "node:assert/strict";

export function instrument(source: string): string {
  for (const [old,next] of [
    ['spawnSync("bash", ["-lc", cmd],', 'fixtureSpawn("gui", "bash", ["-lc", cmd],'],
    ['spawnSync(oneShot.bin, oneShot.args,', 'fixtureSpawn("walk", oneShot.bin, oneShot.args,'],
  ]) {
    assert.equal(source.split(old).length,2,`walk fixture anchor: ${old}`);
    source=source.replace(old,next);
  }
  const end=source.startsWith("#!")?source.indexOf("\n")+1:0;
  return source.slice(0,end)+`import {fixtureSpawn} from ${JSON.stringify(import.meta.path)};\n`+source.slice(end);
}

// Work walks use the asynchronous lock-aware spawn rather than fixtureSpawn.
// Instrument only the copied observer; the same expire/armed/expired protocol
// advances its production timeout callback after the controller sees the queue.
export function instrumentWorkLock(source: string): string {
  const anchor = 'timer = setTimeout(() => {';
  assert.equal(source.split(anchor).length, 2, 'one work-walk policy timer');
  return `import {fixtureWorkTimeout} from ${JSON.stringify(import.meta.path)};\n` + source.replace(anchor, 'timer = fixtureWorkTimeout(() => {');
}
export function fixtureWorkTimeout(expire: () => void, budget: number): ReturnType<typeof setTimeout> {
  const dir = process.env.STUB_WALK_CLOCK_DIR;
  assert(dir && fs.statSync(dir).isDirectory(), 'owned work-walk clock directory');
  put(dir, 'armed', JSON.stringify({ kind: 'work', budget }));
  const timer = setInterval(() => {
    if (!has(dir, 'expire')) return;
    clearInterval(timer); put(dir, 'expired'); expire();
  }, 10);
  return timer;
}

export function namedFailure(output: string, want: string): boolean {
  const lines=output.split(/\r?\n/).filter(line=>line.startsWith("VERDICT:"));
  return lines.length===1 && lines[0].startsWith("VERDICT: COULD-NOT-WALK — ") && lines[0].includes(want);
}

export function fixtureSpawn(kind: string, bin: string, args: string[], opts: any): any {
  const dir=process.env.STUB_WALK_CLOCK_DIR;
  if (!dir) throw new Error("fixture spawn requires its controller state directory");
  const {env,...options}=opts; // Do not serialize credentials/environment into a fixture.
  fs.writeFileSync(path.join(dir,"request.json"),JSON.stringify({kind,bin,args,options}),{flag:"wx"});
  const response=nativeSpawnSync("bun",[import.meta.path,"child",dir],{
    cwd:opts.cwd,env:{...(env??process.env),STUB_WALK_CLOCK_DIR:dir},encoding:"utf8",
    stdio:["inherit","pipe","pipe"],maxBuffer:opts.maxBuffer,
  });
  if(response.error || response.status!==0)throw new Error(`fixture child transport failed: ${response.error?.message??response.stderr}`);
  const result=JSON.parse(response.stdout);
  if(result.error) result.error=Object.assign(new Error(result.error.message),{code:result.error.code});
  return result;
}

const has=(dir:string,name:string)=>fs.existsSync(path.join(dir,name));
const put=(dir:string,name:string,value="yes")=>{const tmp=path.join(dir,`.${name}.${randomUUID()}`);fs.writeFileSync(tmp,value,{flag:"wx"});fs.renameSync(tmp,path.join(dir,name));};
async function until(predicate:()=>boolean,ended:()=>boolean,label:string){
  while(!predicate()) {if(ended())throw new Error(`fixture exited before ${label}`);await Bun.sleep(10);}
}
function killGroup(pid:number,signal:NodeJS.Signals="SIGTERM"){
  assert(Number.isInteger(pid)&&pid>1,"owned child pid");
  try{process.kill(-pid,signal);}catch(e:any){if(e.code!=="ESRCH")throw e;}
}
async function child(dir:string){
  const {kind,bin,args,options}=JSON.parse(fs.readFileSync(path.join(dir,"request.json"),"utf8"));
  const {policyTimeoutMs:timeout,input,...opts}=options; // Only an explicit controller expiry advances this clock.
  // Mirror completed-command's private stdin file, including immediate EOF.
  let inputFd:number|undefined;
  if(input!==undefined){const file=path.join(dir,"stdin");fs.writeFileSync(file,input,{flag:"wx"});inputFd=fs.openSync(file,"r");opts.stdio=[inputFd,"pipe","pipe"];}
  put(dir,"armed",JSON.stringify({kind,budget:timeout}));
  const proc=spawn(bin,args,{...opts,env:process.env,detached:true});
  let stdout="",stderr="",expired=false;
  proc.stdout?.on("data",b=>{stdout+=b;if(Buffer.byteLength(stdout)>options.maxBuffer)killGroup(proc.pid!);});
  proc.stderr?.on("data",b=>{stderr+=b;if(Buffer.byteLength(stderr)>options.maxBuffer)killGroup(proc.pid!);});
  proc.once("spawn",()=>put(dir,"child.json",JSON.stringify({pid:proc.pid,kind})));
  const expire=setInterval(()=>{if(!expired&&has(dir,"expire")){expired=true;put(dir,"expired");killGroup(proc.pid!);}},10);
  const terminate=()=>killGroup(proc.pid!);
  process.once("SIGTERM",terminate);process.once("SIGINT",terminate);
  try{
    const result:any=await new Promise((resolve,reject)=>{proc.once("error",reject);proc.once("close",(status,signal)=>resolve({status,signal,stdout,stderr}));});
    if(expired)result.error={code:"ETIMEDOUT",message:"fixture clock explicitly expired"};
    process.stdout.write(JSON.stringify(result));
  }finally{clearInterval(expire);process.removeListener("SIGTERM",terminate);process.removeListener("SIGINT",terminate);if(inputFd!==undefined)fs.closeSync(inputFd);}
}

async function drive(source:string,dir:string,mode:string,args:string[]){
  assert(["gui","eof","timeout","interrupt"].includes(mode));
  assert(fs.statSync(dir).isDirectory()&&fs.readdirSync(dir).length===0,"fresh owned clock directory");
  const copy=path.join(path.dirname(source),`.walk-readiness-${randomUUID()}.ts`);
  fs.writeFileSync(copy,instrument(fs.readFileSync(source,"utf8")),{flag:"wx"});
  const proc=spawn("bun",[copy,...args],{env:{...process.env,STUB_WALK_CLOCK_DIR:dir,STUB_WALK_CLOCK_MODE:mode},detached:true,stdio:["pipe","pipe","pipe"]});
  // Keep this pipe OPEN until completion. Inheriting it must never yield EOF.
  proc.stdout!.pipe(process.stdout);proc.stderr!.pipe(process.stderr);
  let ended=false;
  const result=new Promise<number>((resolve,reject)=>{proc.once("error",reject);proc.once("close",(code,signal)=>{ended=true;resolve(code??(signal?130:1));});});
  const cleanChildren=()=>{if(has(dir,"child.json"))killGroup(JSON.parse(fs.readFileSync(path.join(dir,"child.json"),"utf8")).pid);if(!ended)killGroup(proc.pid!);};
  process.once("SIGTERM",cleanChildren);process.once("SIGINT",cleanChildren);
  try{
    if(mode!=="gui"){
      await until(()=>has(dir,"verifier.json")&&has(dir,"armed"),()=>ended,"verifier readiness and armed clock");
      const info=JSON.parse(fs.readFileSync(path.join(dir,"verifier.json"),"utf8"));
      assert.equal(info.stdin,"prompt-file","fixture verifier stdin must be the completed-command private input file (whose EOF is checked), not ignored or the caller pipe");
      put(dir,"readiness-observed");put(dir,"release");
      if(mode==="timeout"||mode==="interrupt")await until(()=>has(dir,"holding"),()=>ended,"verifier holding after output");
      if(mode==="timeout")put(dir,"expire");
      if(mode==="interrupt"){
        assert(fs.statSync(info.cwd).isDirectory(),"scratch exists before interrupt");
        killGroup(proc.pid!,"SIGINT");
      }
    }
    const rc=await result;
    if(mode==="gui")assert(has(dir,"armed")&&has(dir,"child.json"),"GUI command actually spawned");
    if(mode==="eof")assert(has(dir,"eof"),"verifier actually received stdin EOF");
    if(mode==="timeout")assert(has(dir,"expired"),"explicit timeout actually fired");
    if(mode==="interrupt"){
      const info=JSON.parse(fs.readFileSync(path.join(dir,"verifier.json"),"utf8"));
      assert(!fs.existsSync(info.cwd),"interrupt left scratch cwd");put(dir,"scratch-removed");
    }
    put(dir,"result.json",JSON.stringify({rc,mode,ready:has(dir,"readiness-observed"),eof:has(dir,"eof"),expired:has(dir,"expired")}));
    process.exitCode=rc;
  }finally{
    cleanChildren();if(!ended)await result;proc.stdin?.destroy();
    process.removeListener("SIGTERM",cleanChildren);process.removeListener("SIGINT",cleanChildren);
    fs.unlinkSync(copy); // Only the unique source copy created by this driver.
  }
}
if(import.meta.main){
  const [command,...args]=process.argv.slice(2);
  (async()=>{
    if(command==="child")await child(args[0]);
    else if(command==="match")process.exitCode=namedFailure(await Bun.stdin.text(),args[0])?0:1;
    else if(command==="drive")await drive(args[0],args[1],args[2],args.slice(3));
    else throw new Error("walk readiness fixture usage: child | match | drive");
  })().catch(error=>{console.error(error.message);process.exitCode=1;});
}
