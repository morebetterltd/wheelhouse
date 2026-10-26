// Pi RPC peer derived from an isolated real-Pi cutoff/idle capture. It is NOT
// a live model: idle steer only queues, whereas prompt starts another turn.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
const dir=process.env.PI_CODING_AGENT_DIR!,args=process.argv.slice(2),sessionAt=args.indexOf('--session');
const resumed=sessionAt>=0,session=resumed?args[sessionAt+1]:path.join(dir,'sessions',crypto.randomUUID()+'.jsonl');
fs.mkdirSync(path.dirname(session),{recursive:true});if(!resumed)fs.writeFileSync(session,JSON.stringify({type:'session',version:3,id:path.basename(session),cwd:process.cwd()})+'\n');
const saved=path.join(dir,'turn-kind'),kind=()=>fs.existsSync(saved)?fs.readFileSync(saved,'utf8'):'settled';let streaming=false;
const emit=(obj:any)=>process.stdout.write(JSON.stringify(obj)+'\n');
const update=(type:string)=>emit({type:'message_update',assistantMessageEvent:{type,contentIndex:0,id:'cutoff-call',toolName:'bash'}});
// Deliberately replay just the interrupted start, without a live turn. The
// observed incident retained that old tail; neither shape is fresh progress.
if(resumed&&kind()!=='settled')update(kind()==='thinking'?'thinking_start':'toolcall_start');
let buffer='';process.stdin.on('data',chunk=>{buffer+=chunk.toString('utf8');let at;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);if(!line.trim())continue;const cmd=JSON.parse(line);fs.appendFileSync(path.join(dir,'commands.jsonl'),JSON.stringify(cmd)+'\n');
 const reply=()=>emit({id:cmd.id,type:'response',command:cmd.type,success:true});
 if(cmd.type==='get_state'){emit({id:cmd.id,type:'response',command:cmd.type,success:true,data:{isStreaming:streaming,pendingMessageCount:0,sessionId:path.basename(session),sessionFile:session}});continue;}
 if(cmd.type==='steer'){reply();emit({type:'queue_update',steering:[cmd.message],followUp:[]});continue;}
 if(cmd.type!=='prompt'){emit({id:cmd.id,type:'response',command:cmd.type,success:false,error:'unsupported fixture command'});continue;}
 reply();streaming=true;emit({type:'agent_start'});emit({type:'turn_start'});emit({type:'message_start',message:{role:'user',content:cmd.message}});
 if(cmd.message==='CUT_TOOL'||cmd.message==='CUT_THINKING'){const k=cmd.message==='CUT_TOOL'?'tool':'thinking';fs.writeFileSync(saved,k);update(k==='tool'?'toolcall_start':'thinking_start');fs.writeFileSync(path.join(dir,'cutoff-ready'),'ready');continue;}
 if(cmd.message.startsWith('[adapter resume]')){
  fs.writeFileSync(path.join(dir,'wake.json'),JSON.stringify(cmd));
  const timer=setInterval(async()=>{if(!fs.existsSync(path.join(dir,'release')))return;clearInterval(timer);
   update('toolcall_start');emit({type:'tool_execution_start',toolCallId:'continued-call',toolName:'bash',args:{command:'write fixture footprint'}});
   const marker=path.join(dir,'continued');const child=Bun.spawn(['bash','-c','printf continued > "$1"','fixture-tool',marker],{stdin:'ignore',stdout:'ignore',stderr:'inherit'});const code=await child.exited;
   emit({type:'tool_execution_end',toolCallId:'continued-call',toolName:'bash',result:{isError:code!==0,exitCode:code}});finish();
  },10);continue;
 }
 finish();
}});
function finish(){streaming=false;fs.writeFileSync(saved,'settled');emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'continued'}],stopReason:'stop'}});emit({type:'agent_end',messages:[]});emit({type:'agent_settled'});}
process.on('SIGTERM',()=>process.exit(143));
