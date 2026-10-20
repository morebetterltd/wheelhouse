// Inert Node pi stand-in: fd0 comes from the real piLaunch 0<> FIFO holder.
// Frame raw bytes ONLY on LF, as pi 1.2.0's attachJsonlLineReader does.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
const dir=process.env.WHEELHOUSE_FRAMING_CASE,account=process.env.PI_CODING_AGENT_DIR;
const sessionFile=path.join(account,'session.jsonl');fs.appendFileSync(sessionFile,'{"fixture":true}\n');
const socket=net.connect(process.env.WHEELHOUSE_FRAMING_SOCKET);
const send=x=>socket.write(JSON.stringify(x)+'\n'),out=x=>{process.stdout.write(JSON.stringify(x)+'\n');send({type:'out',response:x});};
let control='',pending=Buffer.alloc(0),pauseAfterState=false,streaming=false,reject=false;
const s=fs.fstatSync(0);
socket.on('connect',()=>send({type:'ready',pid:process.pid,ppid:process.ppid,uid:process.getuid(),cwd:process.cwd(),token:process.env.WHEELHOUSE_FRAMING_TOKEN,fd0:{dev:s.dev,ino:s.ino,fifo:s.isFIFO()}}));
socket.on('data',b=>{control+=b;let at;while((at=control.indexOf('\n'))>=0){const c=JSON.parse(control.slice(0,at));control=control.slice(at+1);if(c.type==='pause-after-state'){pauseAfterState=true;send({type:'armed'});}else if(c.type==='drain'){process.stdin.resume();send({type:'draining'});}else if(c.type==='streaming'){streaming=c.value;send({type:'streaming',value:streaming});}else if(c.type==='reject'){reject=true;send({type:'reject-armed'});}else if(c.type==='exit')process.exit(0);}});
process.on('SIGTERM',()=>process.exit(0));
process.stdin.on('data',chunk=>{
 fs.appendFileSync(path.join(dir,'input.bytes'),chunk);
 send({type:'read-chunk',bytes:chunk.length});pending=Buffer.concat([pending,chunk]);let at;
 while((at=pending.indexOf(10))>=0){const bytes=pending.subarray(0,at+1);pending=pending.subarray(at+1);let command,error;try{command=JSON.parse(bytes.toString('utf8'));}catch(e){error='Failed to parse command: '+e.message;}
  const frame={type:'frame',bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),valid:!error,...(command?{id:command.id,command:command.type}:{}),...(error?{error}:{} )};send(frame);
  if(error){out({type:'response',command:'parse',success:false,error});continue;}
  if(command.type==='get_state'){
   if(pauseAfterState){pauseAfterState=false;process.stdin.pause();send({type:'paused'});}
   out({type:'response',command:'get_state',id:command.id,success:true,data:{sessionId:'fixture-session',sessionFile,isStreaming:streaming}});
  }else if(command.type==='prompt'||command.type==='steer'){
   if(reject){reject=false;let reason;try{JSON.parse(' meridian-w');}catch(e){reason='Failed to parse command: '+e.message;}const response={type:'response',command:'parse',success:false,error:reason};out(response);send({type:'rejected',response});}
   else out({type:'response',command:command.type,id:command.id,success:true});
  }
 }
});
