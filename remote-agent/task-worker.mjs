// Independent supervisor: HTTP server restarts do not own this process or its child.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
const dir=process.argv[2], stateFile=path.join(dir,'state.json');
const spec=JSON.parse(fs.readFileSync(path.join(dir,'spec.json'),'utf8'));
let state=JSON.parse(fs.readFileSync(stateFile,'utf8'));
// A per-task exclusive lock prevents an accidental second supervisor launch.
const lock=fs.openSync(path.join(dir,'worker.lock'),'wx',0o600);fs.closeSync(lock);
const forgotten=()=>{try{return JSON.parse(fs.readFileSync(stateFile,'utf8')).status==='deleted';}catch{return false;}};
const save=()=>{if(forgotten())return;state.heartbeatAt=new Date().toISOString();const tmp=stateFile+'.worker.tmp';fs.writeFileSync(tmp,JSON.stringify(state),{mode:0o600});fs.renameSync(tmp,stateFile);};
state.workerPid=process.pid;save();
let seq=0,bytes=0,stopping=false,finished=false,spawnError,stopReason;
let termination=Promise.resolve(false);
const log=(stream,data)=>{
  if(!data||state.outputTruncated||forgotten())return;
  const line=JSON.stringify({seq:seq+1,time:new Date().toISOString(),stream,data})+'\n';
  if(bytes+Buffer.byteLength(line)>4*1024*1024){state.outputTruncated=true;save();return;}
  fs.appendFileSync(path.join(dir,'output.jsonl'),line,{mode:0o600});bytes+=Buffer.byteLength(line);seq++;
};
const child=spawn(spec.executable,spec.args,{cwd:spec.cwd,env:process.env,stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32',windowsHide:true,shell:false});
const decoders={stdout:new StringDecoder('utf8'),stderr:new StringDecoder('utf8')};
for(const stream of ['stdout','stderr']) {
  child[stream].on('data',chunk=>log(stream,decoders[stream].write(chunk)));
  child[stream].on('end',()=>log(stream,decoders[stream].end()));
}
child.on('spawn',()=>{state.status='running';state.pid=child.pid;state.startedAt=new Date().toISOString();save();});
child.on('error',error=>{spawnError=error.message;});
const stop=reason=>{
  if(stopping||finished||!child.pid)return;
  stopping=true;stopReason=reason;state.status='cancelling';save();
  // Only the still-owned live child is addressed; never kill from a persisted PID.
  if(process.platform==='win32') {
    termination=new Promise(resolve=>{
      const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',timeout:10000});
      const result=ok=>{if(!ok){state.cancelError='PROCESS_TREE_TERMINATION_FAILED';save();stopping=false;}resolve(ok);};
      killer.on('error',()=>result(false));killer.on('exit',code=>result(code===0));
    });
  } else {
    try {process.kill(-child.pid,'SIGKILL');termination=Promise.resolve(true);}catch(error){state.cancelError=error.message;save();stopping=false;termination=Promise.resolve(false);}
  }
};
const timer=setInterval(()=>{
  if(fs.existsSync(path.join(dir,'cancel.json')))stop('cancelled');
  if(spec.timeoutMs&&state.startedAt&&Date.now()-Date.parse(state.startedAt)>=spec.timeoutMs)stop('timed_out');
  if(Date.now()-Date.parse(state.heartbeatAt)>=1000)save();
},250);
child.on('close',async(code,signal)=>{
  finished=true;clearInterval(timer);
  const terminated=await termination;
  state.status=spawnError?'start_failed':terminated?stopReason:(code===0?'succeeded':'failed');
  state.exitCode=code;state.signal=signal;state.finishedAt=new Date().toISOString();
  if(spawnError)state.error=spawnError;
  save();
});
