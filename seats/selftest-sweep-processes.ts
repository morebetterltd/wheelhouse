// Per-suite ownership boundary: isolated process group + private scratch tree.
// Inspect native records, not an EOF (which a leaked child can hold forever).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {spawnSync} from "node:child_process";

const MARKER = ".wheelhouse-selftest-suite";
type Row = {pid:number; parent:number; group:number; started:string; state:string; command:string};
function native(command:string,args:string[]) {
  const r=spawnSync(command,args,{encoding:"utf8",env:{...process.env,LC_ALL:"C"},maxBuffer:64*1024*1024,timeout:10000});
  if(r.error || r.status!==0) throw new Error(`${command} failed (${r.status}): ${r.error ?? r.stderr}`);
  if(r.stderr) process.stderr.write(r.stderr);
  return r.stdout;
}
function processes():Row[] {
  const text=native("ps",["axww","-o","pid=,ppid=,pgid=,lstart=,stat=,command="]);
  const rows=text.trimEnd().split("\n").filter(Boolean).map(line=>{
    const m=/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(\S+)\s+(.*)$/.exec(line);
    if(!m) throw new Error("unrecognized native ps record");
    return {pid:+m[1],parent:+m[2],group:+m[3],started:m[4],state:m[5],command:m[6]};
  });
  if(!rows.some(r=>r.pid===process.pid)) throw new Error("ps did not examine the checker");
  return rows;
}
function cwds() {
  const bin=fs.existsSync("/usr/sbin/lsof")?"/usr/sbin/lsof":"lsof";
  const text=native(bin,["-nP","-d","cwd","-Fpn"]),result=new Map<number,string>();let pid=0;
  for(const line of text.split("\n")) {
    if(line.startsWith("p")) pid=Number(line.slice(1));
    else if(line.startsWith("n") && pid) result.set(pid,line.slice(1));
  }
  if(!result.has(process.pid)) throw new Error("lsof did not examine the checker's cwd");
  return result;
}
function inside(root:string,file:string) {return file===root || file.startsWith(root+path.sep);}
function scratch(root:string,suite:string) {
  const st=fs.lstatSync(root,{bigint:true}),marker=path.join(root,MARKER),ms=fs.lstatSync(marker);
  if(!st.isDirectory() || fs.realpathSync(root)!==root || !ms.isFile() || ms.isSymbolicLink()) throw new Error("changed suite scratch directory/marker");
  const m=JSON.parse(fs.readFileSync(marker,"utf8"));
  if(m.kind!=="wheelhouse-selftest-suite" || m.version!==1 || m.owner!==process.ppid || m.suite!==path.resolve(suite) || m.dev!==String(st.dev) || m.ino!==String(st.ino)) throw new Error("unowned suite scratch directory");
  return m;
}
function make(suite:string,owner:number) {
  if(!Number.isSafeInteger(owner) || owner<=1 || (process.ppid!==owner && !processes().some(r=>r.pid===process.ppid && r.parent===owner))) throw new Error("scratch owner is not the calling runner");
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),"wheelhouse-selftest-suite-")),st=fs.statSync(root,{bigint:true});
  fs.writeFileSync(path.join(root,MARKER),JSON.stringify({kind:"wheelhouse-selftest-suite",version:1,owner,suite:path.resolve(suite),dev:String(st.dev),ino:String(st.ino)})+"\n",{flag:"wx",mode:0o600});
  console.log(root);
}
async function check(suite:string,group:number,root:string) {
  if(!Number.isSafeInteger(group) || group<=1) throw new Error("invalid suite process group");
  scratch(root,suite);
  function survivors() {
    const rows=processes(),dirs=cwds();
    return rows.map(r=>({...r,cwd:dirs.get(r.pid)??""})).filter(r=>r.pid!==process.pid && r.pid!==process.ppid && !r.state.startsWith("Z") && (r.group===group || inside(root,r.cwd)));
  }
  const leaked=survivors();
  for(const r of leaked) console.error(`selftest-sweep: LEAK ${suite} pid=${r.pid} pgid=${r.group} via=${r.group===group?"group":"scratch"} started=${r.started} cwd=${r.cwd} command=${r.command}`);
  // A leak remains a failure even when containment succeeds. Fresh native
  // identity AND current membership must match before each individual signal.
  function signal(r:Row,kind:NodeJS.Signals) {
    const current=survivors().find(x=>x.pid===r.pid);
    if(!current) return;
    if(current.group!==r.group || current.started!==r.started || current.command!==r.command) throw new Error(`changed leaked pid ${r.pid}; not signaled`);
    try {process.kill(r.pid,kind);} catch(e:any) {if(e.code!=="ESRCH") throw e;}
  }
  for(const r of leaked) signal(r,"SIGTERM");
  if(leaked.length) {
    await Bun.sleep(100);
    for(const r of leaked) signal(r,"SIGKILL");
    for(let n=0;n<40 && survivors().length;n++) await Bun.sleep(25);
  }
  const left=survivors();
  if(left.length) throw new Error(`survivors remain for ${suite}: ${left.map(r=>r.pid).join(",")}; scratch retained at ${root}`);
  // Recheck the ownership record after all outside tools, before recursive rm.
  scratch(root,suite);
  fs.rmSync(root,{recursive:true});
  if(!leaked.length) console.log(`selftest-sweep: CLEAN ${suite} pgid=${group} scratch=${root}`);
  return leaked.length?1:0;
}
if(import.meta.main) {
  try {
    const [mode,suite,a,b]=process.argv.slice(2);
    if(!suite || !fs.statSync(suite).isFile()) throw new Error("suite file missing");
    if(mode==="make") make(suite,Number(a));
    else if(mode==="check") process.exitCode=await check(suite,Number(a),b);
    else throw new Error("expected make/check");
  } catch(e) {console.error(`STOP: selftest-sweep survivor check: ${e instanceof Error?e.message:String(e)}`);process.exitCode=2;}
}
