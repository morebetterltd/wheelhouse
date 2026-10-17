// Timer-free owned holder. A referenced anonymous MessagePort keeps Node alive;
// unlike a named control FIFO it does not add a fixture pathname to argv/fds.
import fs from 'node:fs';
import {MessageChannel} from 'node:worker_threads';
const channel=new MessageChannel();
channel.port1.on('message',()=>{});
channel.port1.ref();
if(process.env.ADAPTER_HOLDER_TITLE)process.title=process.env.ADAPTER_HOLDER_TITLE;
if(process.env.ADAPTER_HOLDER_IGNORE_TERM)process.on('SIGTERM',()=>{});
if(process.env.ADAPTER_HOLDER_READY)fs.writeFileSync(process.env.ADAPTER_HOLDER_READY,String(process.pid)+'\n');
