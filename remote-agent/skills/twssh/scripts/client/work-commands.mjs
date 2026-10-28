import fs from 'node:fs';
import crypto from 'node:crypto';
const need=(options,key)=>{if(typeof options[key]!=='string'||!options[key])throw Error(`--${key} is required`);return options[key];};
const number=(options,key,fallback,min,max)=>{const value=options[key]===undefined?fallback:Number(need(options,key));if(!Number.isInteger(value)||value<min||value>max)throw Error(`Invalid --${key}`);return value;};
const uuid=value=>{if(!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value))throw Error('Invalid UUID');return value;};
export async function workCommand(command,action,options,call,config,alias,save) {
  const payload=()=>JSON.parse(fs.readFileSync(need(options,'spec'),'utf8'));
  const send=async(route,body)=>{
    const requestId=uuid(options['request-id']||crypto.randomUUID());
    config.lastWork??={};config.lastWork[alias]={requestId,command,action};save();
    process.stderr.write(`requestId=${requestId}\n`);
    return call(route,'POST',{...body,requestId});
  };
  if(command==='task') {
    if(action==='create') return send('/tasks',payload());
    if(action==='list')return call('/tasks');
    const id=uuid(need(options,'task')), route='/tasks/'+id;
    if(action==='status')return call(route);
    if(action==='logs')return call(route+'/logs?'+new URLSearchParams({after:String(number(options,'after',0,0,Number.MAX_SAFE_INTEGER)),limit:String(number(options,'limit',100,1,200))}));
    if(action==='cancel')return call(route+'/cancel','POST',{});
    if(action==='delete')return call(route,'DELETE',{forgetUnknown:options['forget-unknown']===true});
    if(action==='wait') {
      const start=performance.now(), wait=number(options,'wait',5,0,30)*1000;
      let status;
      do {
        status=await call(route);
        if(!['starting','running','cancelling'].includes(status.status))return status;
        const left=wait-(performance.now()-start);if(left<=0)break;
        await new Promise(r=>setTimeout(r,Math.min(left,500)));
      }while(true);
      return {...status,waitExpired:true};
    }
    throw Error('task actions: create/list/status/logs/wait/cancel/delete');
  }
  if(action==='result') {
    const id=uuid(options['request-id']||config.lastWork?.[alias]?.requestId||'');
    return call('/files/result?requestId='+id);
  }
  const root=need(options,'root');
  if(action==='search')return call('/files/search','POST',{root,query:need(options,'query')});
  const path=need(options,'path');
  if(action==='read')return call('/files/read','POST',{root,path,startLine:number(options,'start-line',1,1,Number.MAX_SAFE_INTEGER),lineCount:number(options,'line-count',200,1,1000)});
  const expected=need(options,'expected-hash');
  const expectedHash=expected==='missing'?null:expected;
  if(expectedHash!==null&&!/^[a-f0-9]{64}$/.test(expectedHash))throw Error('Invalid --expected-hash');
  if(action==='write')return send('/files/write',{root,path,expectedHash,content:fs.readFileSync(need(options,'file'),'utf8')});
  if(action==='patch')return send('/files/patch',{root,path,expectedHash,edits:JSON.parse(fs.readFileSync(need(options,'edits'),'utf8'))});
  throw Error('file actions: read/search/write/patch/result');
}
