import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';

export async function verifyAgentViewer({ base, token, session, mux, directory }) {
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
    const point=await evaluate("(()=>{const r=document.querySelector('.term-pane:not(.hidden) .xterm-screen').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
    await cdp('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX:0,deltaY:-400});
    await until(()=>sent.some(m=>m.type==='view-scroll'),'wheel uses watcher scroll protocol');
    await until(()=>mode()==='copy-mode','actual mouse wheel enters history');
    assert(!sent.some(m=>m.type==='control'&&m.action==='takeover'));
    await cdp('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX:0,deltaY:400});
    await until(()=>sent.some(m=>m.type==='view-scroll'&&m.ticks<0),'downward wheel uses watcher scroll');
    await cdp('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
    await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
    await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'PageUp',code:'PageUp',windowsVirtualKeyCode:33});
    await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'PageUp',code:'PageUp',windowsVirtualKeyCode:33});
    await until(()=>sent.some(m=>m.type==='scroll'&&m.action==='up'),'PageUp uses watcher history protocol');
    const screenshot=await cdp('Page.captureScreenshot',{format:'png'});
    await fs.writeFile(path.join(directory,'agent-viewer.png'),Buffer.from(screenshot.data,'base64'));
    console.log('PASS Chrome viewer wheel up/down and PageUp; screenshot: '+path.join(directory,'agent-viewer.png'));
  } finally {socket?.terminate();if(chrome.exitCode===null)chrome.kill();}
}
