import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import net from 'node:net';
import { once } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { request } from '../remote-agent/client/transport.mjs';
import WebSocket from 'ws';

const plain = process.env.TW_AGENT_TEST_HTTP === '1';
const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tw-agent-')));
const key = path.join(dir, 'key.pem'), cert = path.join(dir, 'cert.pem');
execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost'], {stdio: 'ignore'});
const pin = new X509Certificate(await fs.readFile(cert)).fingerprint256.replaceAll(':','');
const tmp = net.createServer().listen(0, '127.0.0.1'); await once(tmp,'listening'); const port = tmp.address().port; await new Promise(r=>tmp.close(r));
const token = randomBytes(32).toString('hex'), client = randomBytes(24).toString('hex');
const host = {url:`${plain ? 'http' : 'https'}://127.0.0.1:${port}`,token,...(plain ? {} : {pin})};
const env = {...process.env, HOST:'127.0.0.1', PORT:String(port), AUTH_TOKEN:token, TLS_CERT_FILE:cert, TLS_KEY_FILE:key, AGENT_ENABLED:'1', AGENT_STATUS_MODE:'hooks'};
if (plain) { delete env.TLS_CERT_FILE; delete env.TLS_KEY_FILE; }
for (const name of ['SESSIONS_FILE','SHARES_FILE','REMOTES_FILE','PREFS_FILE','AGENT_STATUS_FILE','VIEWER_STATE_FILE','PROJECTS_FILE','QUICK_COMMANDS_FILE','CLOSED_SESSIONS_FILE','AGENT_SESSIONS_FILE','AUTH_TOKEN_FILE']) env[name]=path.join(dir,name+'.json');
let proc, log='', session, browser;
const sleep = ms=>new Promise(r=>setTimeout(r,ms));
async function start() {
  proc=spawn(process.execPath,['--import','tsx','src/server.ts'],{env,stdio:['ignore','pipe','pipe']});
  proc.stdout.on('data',b=>log+=b);proc.stderr.on('data',b=>log+=b);
  for(let i=0;i<100;i++) {if(proc.exitCode!==null)throw Error(log);try{await request(host,'/info');return;}catch{}await sleep(100);}
  throw Error('server startup timeout '+log);
}
async function stop() {if(proc&&proc.exitCode===null){proc.kill();await once(proc,'exit');}}
async function cli(...args) {
  const child = spawn(process.execPath, ['remote-agent/client/twssh.mjs', ...args], {env: {...process.env, TWSSH_HOME: path.join(dir, 'client')}, stdio:['ignore','pipe','pipe']});
  let out='', err=''; child.stdout.on('data', b=>out+=b); child.stderr.on('data',b=>err+=b);
  const [code] = await once(child,'exit'); assert.equal(code,0,err); return JSON.parse(out);
}
const call=(suffix,method,body)=>request(host,`/sessions/${session.sessionId}${suffix}`,method,body,client);
let cursor=0,epoch;
async function readUntil(text) {
  let output='';
  for(let i=0;i<30;i++) {
    const r=await call(`/events?after=${cursor}&waitMs=1000${epoch?'&epoch='+epoch:''}`);
    cursor=r.cursor;epoch=r.epoch;output+=r.events.filter(e=>e.type==='output').map(e=>e.data).join('');
    if(output.includes(text))return output;
  }
  throw Error('Missing output '+text+' got '+JSON.stringify(output)+'\n'+log);
}
async function input(text, id=randomUUID()) {
  const owner=await call('/control','POST',{generation:session.generation,action:'acquire'});assert(owner.mine);
  const body={requestId:id,generation:session.generation,controlEpoch:owner.epoch,text};
  return {body,result:await call('/input','POST',body)};
}
try {
  await start();
  assert.equal((await request(host,'/info')).completion,false);
  const tokenFile=path.join(dir,'cli-token');await fs.writeFile(tokenFile,token,{mode:0o600});
  assert.equal((await cli('host','add','test','--url',host.url,'--token-file',tokenFile,...(plain ? [] : ['--pin',pin]))).version,1);
  assert.equal((await cli('doctor','test')).completion,false);
  await assert.rejects(request({...host,pin:'00'.repeat(32)},'/info'),/fingerprint/);
  await assert.rejects(request({...host,token:''},'/info'),/401/);
  await assert.rejects(request({...host,token:'wrong'},'/info'),/401/);
  const create={requestId:randomUUID(),label:'integration · Codex',cwd:dir};
  session=await request(host,'/sessions','POST',create);
  assert.deepEqual(await request(host,'/sessions','POST',create),session);
  await readUntil('>');
  await input("$env:TW_AGENT_TEST='persist'\r");await sleep(300);
  const sent=await input("Write-Output ('VALUE=' + $env:TW_AGENT_TEST)\r");
  await readUntil('VALUE=persist');
  assert.deepEqual(await call('/input','POST',sent.body),sent.result);
  await assert.rejects(call('/input','POST',{...sent.body,text:'bad'}),/REQUEST_CONFLICT/);
  await assert.rejects(call('/input','POST',{...sent.body,requestId:randomUUID(),generation:randomUUID()}),/GENERATION_MISMATCH/);
  // Cookie-authenticated browser watches the exact same psmux session, then explicitly takes control.
  browser=new WebSocket(host.url.replace(/^http/, 'ws')+`/ws?session=${session.name}`,{rejectUnauthorized:false,headers:{Cookie:`tw_auth=${token}`}});
  let controls=[];browser.on('message',(data,binary)=>{if(!binary){try{const m=JSON.parse(data.toString());if(m.type==='control')controls.push(m);}catch{}}});
  await once(browser,'open');
  for(let i=0;i<50&&!controls.length;i++)await sleep(100);
  assert(controls.at(-1)?.explicit);assert.equal(controls.at(-1)?.mine,false);
  // A watcher can browse server scrollback without acquiring control. Agent input
  // must leave copy-mode again so that the next command reaches the original Shell.
  const mux = path.resolve('.psmux/tmux.exe');
  const paneMode = () => execFileSync(mux, ['display-message','-p','-t',`=${session.name}:`,'#{pane_mode}'], {encoding:'utf8'}).trim();
  const until = async (check, message) => { for(let i=0;i<50;i++){if(check())return;await sleep(100);}throw Error(message); };
  await input("1..200 | ForEach-Object { Write-Output ('HISTORY_' + $_) }\r");
  await until(()=>execFileSync(mux,['capture-pane','-p','-t',`=${session.name}:`],{encoding:'utf8'}).includes('HISTORY_200'),'history output must finish');
  if(process.env.AGENT_BROWSER_TEST==='1') {
    const {verifyAgentViewer}=await import('./agent-browser-helper.mjs');
    await verifyAgentViewer({base:host.url,token,session,mux,directory:dir});
  }
  browser.send(JSON.stringify({type:'view-scroll',ticks:8,col:40,row:15}));
  await until(()=>paneMode()==='copy-mode','watcher wheel must enter scrollback');
  assert.equal(controls.at(-1).mine,false,'scrolling must not acquire control');
  browser.send(Buffer.from("$env:WATCHER_BAD='bad'\r"));await sleep(100);
  await input("Write-Output ('WATCHER_BLOCKED=' + [string]::IsNullOrEmpty($env:WATCHER_BAD))\r");
  await readUntil('WATCHER_BLOCKED=True');assert.notEqual(paneMode(),'copy-mode');
  browser.send(JSON.stringify({type:'scroll',action:'top'}));
  await until(()=>paneMode()==='copy-mode','watcher history-top must enter scrollback');
  browser.send(JSON.stringify({type:'scroll',action:'bottom'}));
  await until(()=>paneMode()!=='copy-mode','watcher history-bottom must return to live screen');
  browser.send(JSON.stringify({type:'control',action:'takeover'}));
  for(let i=0;i<30&&!controls.at(-1)?.mine;i++)await sleep(100);
  assert(controls.at(-1).mine);
  await assert.rejects(call('/input','POST',{...sent.body,requestId:randomUUID()}),/CONTROL_LOST/);
  browser.send(JSON.stringify({type:'control',action:'release'}));await sleep(200);browser.close();browser=undefined;
  await call('/control','POST',{generation:session.generation,action:'release'});
  await input("Write-Output ('AFTER=' + $env:TW_AGENT_TEST)\r");await readUntil('AFTER=persist');
  const oldEpoch=epoch;
  await stop();await start();
  const resumed=await call(`/events?after=${cursor}&epoch=${oldEpoch}`);assert(resumed.gap);cursor=resumed.cursor;epoch=resumed.epoch;
  await input("Write-Output ('RESTART=' + $env:TW_AGENT_TEST)\r");await readUntil('RESTART=persist');
  await call('','DELETE',{generation:session.generation});
  await assert.rejects(call('/events'),/SESSION_GONE/);
  const cliSession=await cli('session','create','test','--name','CLI test','--cwd',dir);
  try {
    await sleep(1500);
    assert.equal((await cli('exec','test','--session',cliSession.sessionId,'--command',"$env:CLI_TEST='cli'")).state,'sent');
    assert.equal((await cli('result','test','--session',cliSession.sessionId)).state,'sent');
    const data=await cli('read','test','--session',cliSession.sessionId,'--wait','1');assert(Array.isArray(data.events));
    await cli('detach','test','--session',cliSession.sessionId);
  } finally { await cli('session','close','test','--session',cliSession.sessionId); }
  assert(!log.includes(token),'startup log must not contain token');
  // Transport must verify pin before sending any HTTP request, including Authorization.
  let received=0;const trap=https.createServer({key:await fs.readFile(key),cert:await fs.readFile(cert)},(_q,r)=>{received++;r.end('{}');});
  trap.listen(0,'127.0.0.1');await once(trap,'listening');
  await assert.rejects(request({...host,url:`https://127.0.0.1:${trap.address().port}`,pin:'00'.repeat(32)},'/info'),/fingerprint/);
  assert.equal(received,0);await new Promise(r=>trap.close(r));
  console.log(`PASS ${plain ? 'HTTP + Token' : 'HTTPS + Token'}, CLI, authentication, persistence, dedupe, browser takeover, restart, close; TLS pin protection`);
} finally {
  browser?.terminate();
  if(session){try{execFileSync(path.resolve('.psmux/tmux.exe'),['kill-session','-t',`=${session.name}`],{stdio:'ignore'});}catch{}}
  await stop();
  // Keep the isolated test directory for diagnosing failures; it contains only generated test credentials.
}
