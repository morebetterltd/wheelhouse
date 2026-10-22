// Real tmux clients and native post-hook completion, with a missing-sizing fault.
import fs from "node:fs";import path from "node:path";import assert from "node:assert/strict";import {createHash} from "node:crypto";
const [fixture,seats]=process.argv.slice(2);assert(fs.statSync(path.join(fixture,".wheelhouse-selftest-fixture")).isFile());const real=Bun.which("tmux");assert(real);
async function until(test:()=>Promise<boolean>,label:string){const end=performance.now()+20000;while(!await test()){if(performance.now()>=end)throw Error("INCOMPLETE "+label);await Bun.sleep(25);}}
for(const broken of [false,true]){
 const root=path.join(fixture,broken?"attach-no-sizing":"attach-sized"),bin=path.join(root,"bin");fs.mkdirSync(path.join(root,"seats"),{recursive:true});fs.mkdirSync(bin);
 for(const name of ["cockpit.sh","bridge-guard.sh","daemons.sh"])fs.copyFileSync(path.join(seats,name),path.join(root,"seats",name));fs.writeFileSync(path.join(root,"seats/floor.ts"),'setInterval(()=>{},1000);\n');
 // AF_UNIX absolute paths exceed Darwin's socket length beneath some task
 // roots. Translate only the address: real tmux binds a short relative -S
 // socket beneath the same owned cwd. Never use a production/default socket.
 const wrapper='#!/usr/bin/env bash\nif [ "${1:-}" = -L ]; then socket="$2"; shift 2; exec '+JSON.stringify(real)+' -S "./$socket.sock" "$@"; fi\nexec '+JSON.stringify(real)+' "$@"\n';fs.writeFileSync(path.join(bin,"tmux"),wrapper,{mode:0o755});
 const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,WHEELHOUSE_COCKPIT_DAEMONS:"0",SHELL:"/bin/sh"},socket="attach-"+process.pid,client=socket+"-client",records:any[]=[];
 async function command(args:string[]){const child=Bun.spawn(args,{cwd:root,env,stdin:"ignore",stdout:"pipe",stderr:"pipe"}),[code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);const row={args,code,stdout,stderr};records.push(row);fs.appendFileSync(path.join(root,"native-commands.jsonl"),JSON.stringify(row)+"\n");return row;}
 const tmux=(sock:string,args:string[])=>command([path.join(bin,"tmux"),"-L",sock,...args]);
 const success=async(sock:string,args:string[])=>{const r=await tmux(sock,args);assert.equal(r.code,0,r.stderr);return r.stdout.trim();};
 let server=0,clientServer=0;
 console.log("ATTACH_INPUT "+JSON.stringify({broken,clientWidth:152,forcedWrongWidth:15,sourceSha256:createHash("sha256").update(fs.readFileSync(path.join(seats,"cockpit.sh"))).digest("hex"),socketAddress:"relative beneath owned cwd; real tmux, no response emulation"}));
 try{
  const launch=await command(["env","WHEELHOUSE_TMUX_SOCKET="+socket,"bash",path.join(root,"seats/cockpit.sh"),"probe"]);assert.equal(launch.code,0,launch.stderr);assert(fs.statSync(path.join(root,socket+".sock")).isSocket(),"actual socket beneath owned root");
  server=Number(await success(socket,["display-message","-p","#{pid}"]));assert(server>1);
  await success(socket,["resize-pane","-t","wh-probe:bridge.0","-x","15"]);
  if(broken)await success(socket,["set-hook","-u","-t","wh-probe","client-attached"]);
  const mark=path.join(root,"attach-completed");await success(socket,["set-hook","-a","-t","wh-probe","client-attached",`run-shell 'printf done > ${mark}'`]);
  await success(client,["new-session","-d","-x","152","-y","40","-s","wh-client","-c",root,`tmux -L '${socket}' attach-session -t wh-probe`]);clientServer=Number(await success(client,["display-message","-p","#{pid}"]));
  await until(async()=>fs.existsSync(mark)&&await success(socket,["display-message","-p","-t","wh-probe:bridge.0","#{window_width}"])==="152","real attached client and completed native hook");
  const width=Number(await success(socket,["display-message","-p","-t","wh-probe:bridge.0","#{window_width}"])),commander=Number(await success(socket,["display-message","-p","-t","wh-probe:bridge.0","#{pane_width}"]));
  const accepted=Math.abs(commander-width*0.55)<=2;let assertionRejected=false;try{assert(accepted,"native attached pane did not restore configured ratio");}catch(e){if(!(e instanceof assert.AssertionError))throw e;assertionRejected=true;}assert.equal(assertionRejected,broken,"same geometry assertion must reject missing sizing");
  console.log((broken?"EXPECTED_REJECTION ":"PASS ")+"ATTACH "+JSON.stringify({broken,checkerAccepted:accepted,assertionRejected,inputComplete:true,width,commander,targetPercent:55,commands:records}));
 }finally{
  await tmux(client,["kill-server"]);await tmux(socket,["kill-server"]);
  for(const pid of [clientServer,server].filter(x=>x>1))await until(async()=>{try{process.kill(pid,0);return false;}catch(e:any){if(e.code==='ESRCH')return true;throw e;}},"original private tmux server exit");
 }
}
console.log("cockpit-attachment: real attach observation and missing-sizing rejection complete");
