import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {completedSpawnSync} from '../native-command';
const [source,root]=process.argv.slice(2);fs.mkdirSync(root+'/seats/run',{recursive:true});fs.mkdirSync(root+'/seats/logs',{recursive:true});fs.mkdirSync(root+'/wheelhouse',{recursive:true});
fs.copyFileSync(source,root+'/seats/supervisor.sh');
fs.writeFileSync(root+'/seats/daemons.sh','daemon_alive(){ return 0; }\ndaemon_starting(){ return 1; }\nprincipal_channel_declared(){ return 1; }\nrecover_dead_seats(){ :; }\n');
fs.writeFileSync(root+'/seats/manual-check.ts',`import fs from 'node:fs'; if(process.env.WHEELHOUSE_MANUAL_CHECK_ROOT!==${JSON.stringify(root)})throw new Error('wrong manual root');fs.appendFileSync(${JSON.stringify(root+'/seats/run/calls')},'manual\\n');`);
fs.writeFileSync(root+'/seats/run/calls','');
const count=()=>fs.readFileSync(root+'/seats/run/calls','utf8').trim().split('\n').filter(Boolean).length;
async function tick(at:string,expected:number,enabled='on',hour='05'){
 fs.writeFileSync(root+'/wheelhouse/.template-source','cleanup=off\ndigest=off\nsweep=off\nmanual_check='+enabled+'\n');
 const r=completedSpawnSync('bash',[root+'/seats/supervisor.sh','--once'],{cwd:root,encoding:'utf8',policyTimeoutMs:10000,env:{...process.env,TZ:'UTC',WHEELHOUSE_SUPERVISOR_ROOT:root,WHEELHOUSE_SUPERVISOR_NOW:at,WHEELHOUSE_MANUAL_CHECK_HOUR:hour}});
 assert(!r.error&&r.signal===null&&r.status===0,r.stderr);
 const log=fs.existsSync(root+'/seats/logs/supervisor.out.log')?fs.readFileSync(root+'/seats/logs/supervisor.out.log','utf8'):'';
 assert.equal(log.split('\n').filter(x=>/manual check started for/.test(x)).length,expected,'parent launch count at '+at);
 const until=performance.now()+10000;while(count()<expected&&performance.now()<until)await Bun.sleep(20);
 assert.equal(count(),expected,'scheduled calls at '+at);
}
await tick('2026-01-01T04:59:00Z',0);assert(!JSON.parse(fs.readFileSync(root+'/seats/run/supervisor.state.json','utf8')).lastManualCheckDay);
await tick('2026-01-01T05:00:00Z',1);await tick('2026-01-01T05:30:00Z',1);await tick('2026-01-02T05:00:00Z',2);
console.log('PASS manual check tick once per local day at default 05');
await tick('2026-01-03T05:00:00Z',2,'off');console.log('PASS manual_check=off suppresses tick');
await tick('2026-01-03T05:00:00Z',2,'on','09');await tick('2026-01-03T09:00:00Z',3,'on','09');console.log('PASS configured manual check hour');
