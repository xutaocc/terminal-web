import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export class WorkError extends Error { constructor(readonly status: number, message: string) { super(message); } }
const fail = (status: number, message: string): never => { throw new WorkError(status, message); };
const hash = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');
const uuid = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id);
export function atomicJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), {recursive:true, mode:0o700});
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(tmp, file); } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
function json(file: string): any { return JSON.parse(fs.readFileSync(file, 'utf8')); }
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'start_failed']);
export class AgentTasks {
  constructor(private dir: string) {}
  private location(id: unknown) { if (!uuid(id)) return fail(400,'INVALID_TASK_ID'); return path.join(this.dir,id); }
  private index(): Record<string, {hash: string; deleted?: boolean}> {
    const file=path.join(this.dir,'index.json'); return fs.existsSync(file) ? json(file) : {};
  }
  get(id: string) {
    const dir=this.location(id);
    if (!fs.existsSync(path.join(dir,'state.json'))) return fail(404,'TASK_NOT_FOUND');
    const state=json(path.join(dir,'state.json'));
    if (['starting','running','cancelling'].includes(state.status) && Date.now()-Date.parse(state.heartbeatAt ?? state.createdAt)>15000) {
      return {...state,status:'unknown',lastKnownStatus:state.status,reason:'Worker heartbeat lost; do not rerun or kill a reused PID'};
    }
    return state;
  }
  list() { const ids=Object.entries(this.index()).filter(([,v])=>!v.deleted).map(([id])=>id); return {tasks:ids.map(id=>{const {args,...summary}=this.get(id);return summary;}),total:ids.length}; }
  create(body: any) {
    const {requestId,cwd,executable,args=[],timeoutMs=0}=body;
    if (!uuid(requestId) || typeof executable!=='string' || !executable || executable.length>4096 || executable.includes('\0') || !Array.isArray(args) || args.length>256 || args.some((s:any)=>typeof s!=='string'||s.includes('\0')) || Buffer.byteLength(JSON.stringify(args))>48000 || !Number.isInteger(timeoutMs)||timeoutMs<0||timeoutMs>86400000) return fail(400,'INVALID_TASK');
    if (typeof cwd!=='string'||!path.isAbsolute(cwd)) return fail(400,'ABSOLUTE_CWD_REQUIRED');
    if(Object.keys(body).some(k=>!['requestId','cwd','executable','args','timeoutMs'].includes(k))) return fail(400,'UNSUPPORTED_TASK_OPTION');
    const spec={cwd,executable,args,timeoutMs}, digest=hash(JSON.stringify(spec)), index=this.index();
    if (index[requestId]) {
      if(index[requestId].hash!==digest) return fail(409,'REQUEST_CONFLICT');
      if(index[requestId].deleted) return fail(410,'TASK_DELETED');
      return this.get(requestId);
    }
    try {if(!fs.statSync(cwd).isDirectory()) throw Error();}catch{return fail(400,'INVALID_DIRECTORY');}
    const all=this.list().tasks;
    if(all.filter(s=>!terminal.has(s.status)).length>=4) return fail(429,'TASK_LIMIT');
    if(all.length>=200||Object.keys(index).length>=10000) return fail(429,'TASK_HISTORY_FULL');
    const dir=this.location(requestId), now=new Date().toISOString();
    fs.mkdirSync(dir,{recursive:true,mode:0o700});
    atomicJson(path.join(dir,'spec.json'),spec);
    atomicJson(path.join(dir,'state.json'),{taskId:requestId,status:'starting',cwd,executable,args,createdAt:now,heartbeatAt:now,exitCode:null});
    // Durable idempotency BEFORE launch. Ambiguous launches are never replayed.
    index[requestId]={hash:digest}; atomicJson(path.join(this.dir,'index.json'),index);
    const worker=fileURLToPath(new URL('../remote-agent/task-worker.mjs',import.meta.url));
    const env={...process.env};
    for(const key of Object.keys(env)) if (/^(AUTH_TOKEN|AGENT_|TWSSH_|NODE_OPTIONS)/i.test(key)) delete env[key];
    const child=spawn(process.execPath,[worker,dir],{detached:true,stdio:'ignore',windowsHide:true,env});
    child.on('error',error=>atomicJson(path.join(dir,'state.json'),{...this.get(requestId),status:'start_failed',finishedAt:new Date().toISOString(),error:error.message}));
    child.unref();
    return this.get(requestId);
  }
  cancel(id: string) {
    const state=this.get(id);
    if(terminal.has(state.status)) return state;
    if(state.status==='unknown') return fail(409,'TASK_STATE_UNKNOWN');
    atomicJson(path.join(this.location(id),'cancel.json'),{requestedAt:new Date().toISOString()});
    return {...state,cancelRequested:true};
  }
  logs(id:string, after=0, limit=100) {
    const state=this.get(id);
    if(!Number.isSafeInteger(after)||after<0||!Number.isInteger(limit)||limit<1||limit>200) return fail(400,'INVALID_LOG_CURSOR');
    const file=path.join(this.location(id),'output.jsonl');
    const raw=fs.existsSync(file)?fs.readFileSync(file,'utf8'):'';
    // Ignore a partially written final line. Cursor advances only over complete records.
    const lines=raw.slice(0,raw.lastIndexOf('\n')+1).split('\n').filter(Boolean);
    const rows=lines.map(line=>JSON.parse(line));
    const events:any[]=[];let size=0;
    for(const row of rows.filter(r=>r.seq>after)){const bytes=Buffer.byteLength(JSON.stringify(row));if(events.length&&(events.length>=limit||size+bytes>262144))break;events.push(row);size+=bytes;}
    return {taskId:id,status:state.status,events,nextCursor:events.at(-1)?.seq??after,hasMore:rows.some(r=>r.seq>(events.at(-1)?.seq??after)),truncated:!!state.outputTruncated};
  }
  remove(id:string, forgetUnknown=false) {
    const state=this.get(id);
    if(state.status==='deleted') return {taskId:id,deleted:true};
    if(!terminal.has(state.status)&&!(forgetUnknown&&state.status==='unknown')) return fail(409,'TASK_NOT_FINISHED');
    const dir=this.location(id), index=this.index();
    // Mark first: interrupted cleanup remains retryable and can never relaunch the task.
    index[id].deleted=true; atomicJson(path.join(this.dir,'index.json'),index);
    for(const file of ['output.jsonl','spec.json','cancel.json']) fs.rmSync(path.join(dir,file),{force:true});
    atomicJson(path.join(dir,'state.json'),{taskId:id,status:'deleted',deletedAt:new Date().toISOString()});
    return {taskId:id,deleted:true,processTerminationConfirmed:state.status!=='unknown'};
  }
}

const MAX_FILE=1024*1024;
function textFile(file:string) {
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()) return fail(400,'REGULAR_FILE_REQUIRED');
  if(stat.size>MAX_FILE) return fail(413,'FILE_TOO_LARGE');
  const bytes=fs.readFileSync(file);
  let text:string;
  try {text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{return fail(415,'UTF8_REQUIRED');}
  if(text.includes('\0')) return fail(415,'TEXT_FILE_REQUIRED');
  return {text,hash:hash(bytes),mode:stat.mode};
}
export class AgentFiles {
  constructor(private receiptsFile:string) {}
  private resolve(root:unknown,relative:unknown,allowNew=false) {
    if(typeof root!=='string'||!path.isAbsolute(root)||typeof relative!=='string'||!relative||path.isAbsolute(relative)||relative.includes('\0')||relative.includes(':')) return fail(400,'INVALID_FILE_PATH');
    const base=fs.realpathSync(root), file=path.resolve(base,relative), rel=path.relative(base,file);
    if(!rel||rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel)) return fail(403,'PATH_OUTSIDE_ROOT');
    let current=base;
    for(const [i,part] of rel.split(path.sep).entries()) {
      current=path.join(current,part);
      if(allowNew&&i===rel.split(path.sep).length-1&&!fs.existsSync(current)) break;
      if(fs.lstatSync(current).isSymbolicLink()) return fail(403,'SYMLINK_NOT_ALLOWED');
    }
    return file;
  }
  read(body:any) {
    const file=this.resolve(body.root,body.path), value=textFile(file), start=body.startLine??1, count=body.lineCount??200;
    if(!Number.isInteger(start)||start<1||!Number.isInteger(count)||count<1||count>1000) return fail(400,'INVALID_LINE_RANGE');
    const lines=value.text.split('\n');
    const content=lines.slice(start-1,start-1+count).join('\n');
    return {path:body.path,hash:value.hash,startLine:start,totalLines:lines.length,content,hasMore:start-1+count<lines.length};
  }
  async search(body:any) {
    if(typeof body.root!=='string'||!path.isAbsolute(body.root)||typeof body.query!=='string'||!body.query||body.query.length>1024) return fail(400,'INVALID_SEARCH');
    const root=fs.realpathSync(body.root), stack=[root], matches:any[]=[];let visited=0, skipped=0;
    while(stack.length&&visited<2000&&matches.length<200) {
      const dir=stack.pop()!;
      for(const entry of await fs.promises.readdir(dir,{withFileTypes:true})) {
        if(++visited>2000||matches.length>=200) break;
        if(entry.isSymbolicLink()||['.git','node_modules'].includes(entry.name)) {skipped++;continue;}
        const file=path.join(dir,entry.name);
        if(entry.isDirectory()) stack.push(file);
        else if(entry.isFile()) {
          try {const {text}=textFile(this.resolve(root,path.relative(root,file))); const lines=text.split('\n');
            for(let i=0;i<lines.length&&matches.length<200;i++) if(lines[i].includes(body.query)) matches.push({path:path.relative(root,file),line:i+1,text:lines[i].slice(0,1000),truncated:lines[i].length>1000});
          }catch{skipped++;}
        }
      }
    }
    return {matches,visited,skipped,truncated:stack.length>0||visited>=2000||matches.length>=200};
  }
  mutate(body:any, patch=false) {
    const {requestId,expectedHash}=body;
    if(!uuid(requestId)||!(expectedHash===null||typeof expectedHash==='string'&&/^[a-f0-9]{64}$/.test(expectedHash))) return fail(400,'EXPECTED_HASH_AND_REQUEST_ID_REQUIRED');
    const receipts=fs.existsSync(this.receiptsFile)?json(this.receiptsFile):{}, digest=hash(JSON.stringify({patch,body}));
    if(receipts[requestId]) {if(receipts[requestId].hash!==digest) return fail(409,'REQUEST_CONFLICT');return receipts[requestId].result;}
    if(Object.keys(receipts).length>=10000) return fail(429,'FILE_RECEIPTS_FULL');
    const file=this.resolve(body.root,body.path,true), previous=fs.existsSync(file)?textFile(file):null;
    if((previous?.hash??null)!==expectedHash) return fail(409,'FILE_CONFLICT');
    let content=body.content;
    if(patch) {
      if(!previous||!Array.isArray(body.edits)||!body.edits.length||body.edits.length>100) return fail(400,'INVALID_PATCH');
      content=previous.text;
      for(const edit of body.edits) {
        if(typeof edit.oldText!=='string'||!edit.oldText||typeof edit.newText!=='string') return fail(400,'INVALID_PATCH');
        const at=content.indexOf(edit.oldText);
        if(at<0||content.indexOf(edit.oldText,at+1)>=0) return fail(409,'PATCH_NOT_UNIQUE');
        content=content.slice(0,at)+edit.newText+content.slice(at+edit.oldText.length);
      }
    }
    if(typeof content!=='string'||content.includes('\0')||Buffer.byteLength(content)>MAX_FILE) return fail(400,'INVALID_TEXT_CONTENT');
    const result={requestId,path:body.path,beforeHash:previous?.hash??null,hash:hash(content),bytes:Buffer.byteLength(content),time:new Date().toISOString(),state:'unknown'};
    receipts[requestId]={hash:digest,result};atomicJson(this.receiptsFile,receipts);
    const tmp=path.join(path.dirname(file),'.twssh-'+crypto.randomUUID()+'.tmp');
    const fd=fs.openSync(tmp,'wx',previous?previous.mode&0o777:0o600);
    try {
      fs.writeFileSync(fd,content,'utf8');fs.fsyncSync(fd);
    } finally {fs.closeSync(fd);}
    try {
      // Optimistic conflict check immediately before commit; external writers are not locked.
      this.resolve(body.root,body.path,true);
      if((fs.existsSync(file)?textFile(file).hash:null)!==expectedHash) return fail(409,'FILE_CONFLICT');
      if(previous) fs.renameSync(tmp,file);
      else {fs.linkSync(tmp,file);fs.unlinkSync(tmp);} // Exclusive creation, never overwrite a raced new file.
    } finally {fs.rmSync(tmp,{force:true});}
    result.state='written';atomicJson(this.receiptsFile,receipts);return result;
  }
  result(id:string) {if(!uuid(id))return fail(400,'INVALID_REQUEST_ID');const all=fs.existsSync(this.receiptsFile)?json(this.receiptsFile):{};return all[id]?.result??fail(404,'REQUEST_NOT_FOUND');}
}
