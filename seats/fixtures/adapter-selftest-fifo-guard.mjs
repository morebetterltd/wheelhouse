// A negative control must fail BEFORE entering a blocking FIFO syscall.
import * as original from 'node:fs';
import {mock} from 'bun:test';
const fs={...original},target=process.env.ADAPTER_FIFO_TARGET;
function unsafe(){
  if(process.env.ADAPTER_FIFO_THROW==='1')throw Object.assign(new Error('blocking FIFO open'),{code:'ADAPTER_BLOCKING_FIFO_OPEN'});
  console.error('ADAPTER_BLOCKING_FIFO_OPEN');process.exit(86);
}
const openSync=(file,flags,...args)=>{
  if(String(file)===target&&(typeof flags!=='number'||!(flags&fs.constants.O_NONBLOCK)))unsafe();
  return fs.openSync(file,flags,...args);
};
mock.module('node:fs',()=>({...fs,openSync,default:{...fs.default,openSync}}));
