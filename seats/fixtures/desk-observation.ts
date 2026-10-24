// Fixture-only completion observations; production desk policies stay unchanged.
import fs from 'node:fs';import path from 'node:path';
export function observeDesk(source:string):string {
 if(source.includes('function fixtureDeskEvent('))return source;
 const replace=(old:string,value:string)=>{if(source.split(old).length!==2)throw Error('desk observation anchor changed: '+old);source=source.replace(old,value);};
 replace('type Issue =',`function fixtureDeskEvent(kind:string,key:string,success:boolean,details:Record<string,unknown>={}) { fs.appendFileSync(path.join(RUN,"fixture-desk-events.jsonl"),JSON.stringify({kind,key,success,...details})+String.fromCharCode(10)); }\ntype Issue =`);
 replace('finally { boardRefreshing=false; }','finally { boardRefreshing=false; fixtureDeskEvent("board","",boardSnapshot.generatedAt!==new Date(0).toISOString()); }');
 replace('const worker = new Worker(','fixtureDeskEvent("digest-start",win.key,true,{since:win.since,until:win.until}); const worker = new Worker(');
 replace('const mod = await import(event.data.module); self.postMessage',`const mod = await import(event.data.module); const fixtureFs = await import("node:fs"); fixtureFs.appendFileSync(event.data.root+"/seats/run/fixture-desk-events.jsonl",JSON.stringify({kind:"worker-enter",since:event.data.since,until:event.data.until})+String.fromCharCode(10)); self.postMessage`);
 replace('if(!next) return;','fixtureDeskEvent("digest",win.key,!!next); if(!next) return;');
 replace('fetch:handle','fetch:async(req)=>{ fixtureDeskEvent("request-enter",new URL(req.url).pathname,true,{boardRefreshing,digestKeys:[...digestRefreshing]}); const result=await handle(req); fixtureDeskEvent("request-return",new URL(req.url).pathname,true); return result; }');
 replace('function start(){ fs.mkdirSync(RUN,{recursive:true});','function start(){ fs.mkdirSync(RUN,{recursive:true}); fs.writeFileSync(path.join(RUN,"fixture-desk-events.jsonl"),"");');
 return source;
}
export function events(root:string):any[]{try{const s=fs.readFileSync(path.join(root,'seats/run/fixture-desk-events.jsonl'),'utf8'),lines=s.split('\n');lines.pop();return lines.filter(Boolean).map(JSON.parse);}catch(e:any){if(e.code==='ENOENT')return [];throw e;}}
function alive(pid:number){try{process.kill(pid,0);return true;}catch(e:any){if(e.code==='ESRCH')return false;throw e;}}
export async function completion(root:string,kind:string,key:string,pid:number){for(;;){const row=events(root).find(x=>x.kind===kind&&x.key===key);if(row){if(row.success===false)throw Error('observed desk background failure '+kind+' '+key);return row;}if(!alive(pid))throw Error('desk exited before '+kind+' completion');await Bun.sleep(50);}}
export async function http(url:string,file:string,pid:number){for(;;){try{const response=await fetch(url,{signal:AbortSignal.timeout(1000)});if(response.ok){const data=Buffer.from(await response.arrayBuffer()),temp=file+'.pending';fs.writeFileSync(temp,data);fs.renameSync(temp,file);return;}}catch{}if(!alive(pid))throw Error('desk exited before HTTP readiness');await Bun.sleep(50);}}
if(import.meta.main){
 const [mode,...args]=process.argv.slice(2);
 if(mode==='install'){const p=path.join(args[0],'seats/desk.ts');fs.writeFileSync(p,observeDesk(fs.readFileSync(p,'utf8')));}
 else if(mode==='http')await http(args[0],args[1],Number(args[2]));
 else if(mode==='event')await completion(args[0],args[1],args[2],Number(args[3]));
 else if(mode==='board'||mode==='digest'){
  const [root,url,file,pidText]=args,pid=Number(pidText);await http(url,file,pid);
  let key='';if(mode==='digest'){const u=new URL(url),since=u.searchParams.get('since'),until=u.searchParams.get('until');if(since&&until)key=new Date(since).toISOString()+'\0'+new Date(until).toISOString();else if(!since&&!until)key='hours:'+Number(u.searchParams.get('hours')||24);else throw Error('fixture requires both explicit window endpoints');}
  await completion(root,mode,key,pid);await http(url,file,pid);
 }else throw Error('unknown desk observation mode');
}
