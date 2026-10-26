// digest-bd-fixture: real fixture JSON, one deliberately late native completion.
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),root=process.env.DIGEST_BD_DIAG;
const closed=args.includes('--status')&&args[args.indexOf('--status')+1]==='closed';
const review=args.includes('--label')&&args[args.indexOf('--label')+1]==='needs-review';
const file=closed?process.env.WHEELHOUSE_FIXTURE_CLOSED:review?process.env.WHEELHOUSE_FIXTURE_REVIEW:null;
const event=(event,extra={})=>fs.appendFileSync(path.join(root,'producer.jsonl'),JSON.stringify({event,pid:process.pid,args,at:new Date().toISOString(),...extra})+'\n',{mode:0o600});
let slow=false;if(closed&&process.env.DIGEST_BD_SLOW_FIRST==='1'){try{fs.closeSync(fs.openSync(path.join(root,'slow.claim'),'wx',0o600));slow=true;}catch(e){if(e.code!=='EEXIST')throw e;}}
const done=()=>{const payload=file?fs.readFileSync(file):Buffer.from('[]\n');process.stdout.write(payload);event('payload-written',{bytes:payload.length});};
event('started',{closed,review,slow});if(slow){process.stderr.write('digest fixture: closed list awaiting deliberately late completion\n');setTimeout(done,6100);}else done();
