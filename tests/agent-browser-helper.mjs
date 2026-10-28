import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';

export async function verifyAgentViewer({ base, token, session, mux, directory, write, ordinaryName }) {
  const listener = net.createServer().listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(r => listener.close(r));
  const chrome = spawn(process.env.BROWSER_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(directory, 'chrome')}`, 'about:blank'], {stdio:'ignore'});
  const sleep = ms => new Promise(r=>setTimeout(r, ms));
  async function until(check, message) { for(let i=0;i<100;i++){if(await check())return;await sleep(100);}throw Error(message); }
  let socket, target, index = 0; const pending = new Map(), sent = [];
  const mode = () => execFileSync(mux, ['display-message','-p','-t',`=${session.name}:`,'#{pane_mode}'],{encoding:'utf8'}).trim();
  const cdp = (method, params={}) => new Promise((resolve,reject)=>{const id=++index; pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
  const evaluate = async expression => {const r=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result.value;};
  try {
    await until(async()=>{try{target=(await(await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t=>t.type==='page');return !!target;}catch{return false;}},'Chrome startup');
    socket = new WebSocket(target.webSocketDebuggerUrl); await once(socket,'open');
    socket.on('message', raw=>{
      const m=JSON.parse(raw);
      if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}
      if(m.method==='Network.webSocketFrameSent' && m.params.response.opcode===1){try{sent.push(JSON.parse(m.params.response.payloadData));}catch{}}
    });
    await cdp('Network.enable');await cdp('Page.enable');
    await cdp('Network.setCookie',{name:'tw_auth',value:token,url:base,path:'/',httpOnly:true,sameSite:'Lax'});
    await cdp('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});
    await cdp('Page.navigate',{url:`${base}/?session=${session.name}`});
    await until(()=>evaluate("!!document.querySelector('.term-pane:not(.hidden) .terminal-control:not([hidden])')"),'Agent control bar visible');
    const viewport = "document.querySelector('.term-pane:not(.hidden) .agent-viewer-viewport')";
    await until(()=>evaluate(`${viewport}?.textContent.includes('HISTORY_200')`),'snapshot visible');
    assert.equal(await evaluate("document.querySelector('.terminal-control button') === null"),true);
    const agentChip = `.ps-chip[data-control-session="${session.name}"]`;
    const ordinaryChip = `.ps-chip[data-control-session="${ordinaryName}"]`;
    await until(()=>evaluate(`!!document.querySelector(${JSON.stringify(ordinaryChip)})`),'ordinary fixture in sidebar');
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(agentChip)}).closest('.ps-chip-wrap').querySelector('.ps-chip-close') === null`),true,'Agent has no close button');
    const closePoint=await evaluate(`(()=>{const b=document.querySelector(${JSON.stringify(ordinaryChip)}).closest('.ps-chip-wrap').querySelector('.ps-chip-close');b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await cdp('Input.dispatchMouseEvent',{type:'mousePressed',...closePoint,button:'left',clickCount:1});
    await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',...closePoint,button:'left',clickCount:1});
    await until(()=>evaluate("!!document.querySelector('.confirm-overlay')"),'ordinary close requires confirmation');
    execFileSync(mux,['has-session','-t',`=${ordinaryName}`],{stdio:'ignore'});
    await evaluate("[...document.querySelectorAll('.confirm-overlay button')].find(b=>b.textContent.includes('取消')).click()");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.ps-recent-custom')).display"),'none');
    console.log('PASS merged sidebar close confirmation, Agent protection, hidden custom recent controls; share restore with token rotation');
    const before=await evaluate(`${viewport}.scrollTop`), originalMode=mode();
    const point=await evaluate(`(()=>{const r=${viewport}.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await cdp('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX:0,deltaY:-400});
    await until(async()=>await evaluate(`${viewport}.scrollTop`)<before,'wheel scrolls local history');
    await evaluate(`${viewport}.focus()`);
    const wheelTop=await evaluate(`${viewport}.scrollTop`);
    await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'PageUp',code:'PageUp',windowsVirtualKeyCode:33});
    await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'PageUp',code:'PageUp',windowsVirtualKeyCode:33});
    await until(async()=>await evaluate(`${viewport}.scrollTop`)<wheelTop,'PageUp scrolls locally');
    const frozen=await evaluate(`${viewport}.textContent`), top=await evaluate(`${viewport}.scrollTop`);
    await write("Write-Output ('VIEWER_' + 'CONTINUES')\r");
    await until(()=>evaluate("document.querySelector('.agent-viewer-tools').textContent.includes('有新输出')"),'new output while reading');
    assert.equal(await evaluate(`${viewport}.textContent`),frozen);
    assert.equal(await evaluate(`${viewport}.scrollTop`),top);
    await evaluate("document.querySelector('.agent-viewer-tools button').click()");
    await until(()=>evaluate(`${viewport}.textContent.includes('VIEWER_CONTINUES')`),'return live shows pending output');
    assert.equal(mode(),originalMode);
    assert(!sent.some(m=>['view-scroll','scroll','resize'].includes(m.type)||m.type==='control'&&m.action==='takeover'));
    const screenshot=await cdp('Page.captureScreenshot',{format:'png'});
    await fs.writeFile(path.join(directory,'agent-viewer.png'),Buffer.from(screenshot.data,'base64'));
    console.log('PASS Chrome read-only snapshot, wheel/PageUp, frozen history, concurrent remote input and return live; screenshot: '+path.join(directory,'agent-viewer.png'));
  } finally {socket?.terminate();if(chrome.exitCode===null)chrome.kill();}
}
