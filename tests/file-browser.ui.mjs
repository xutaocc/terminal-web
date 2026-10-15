// Optional browser regression: uses installed Chrome, temporary files and its own service.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import net from 'node:net';
import { once } from 'node:events';
import WebSocket from 'ws';
const chromeBinary = process.env.BROWSER_BIN || '/usr/bin/google-chrome';
if (!fs.existsSync(chromeBinary)) { console.log('SKIP: set BROWSER_BIN to installed Chrome'); process.exit(0); }
async function port() { const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening'); const value = listener.address().port; await new Promise(resolve => listener.close(resolve)); return value; }
const folder = await mkdtemp(path.join(os.tmpdir(), 'terminal-files-ui-'));
const fixture = path.join(folder, 'workspace'); await mkdir(fixture); await mkdir(path.join(fixture, 'subfolder')); await mkdir(path.join(fixture, '.hidden-directory'));
await mkdir(path.join(fixture, 'destination'));
await writeFile(path.join(fixture, 'subfolder', 'keep.txt'), 'keep');
await writeFile(path.join(fixture, 'subfolder', 'exclude.txt'), 'exclude');
await mkdir(path.join(fixture, 'subfolder', 'grandchild')); await writeFile(path.join(fixture, 'subfolder', 'grandchild', '深层很长的文件名称_用于验证手机横向滚动_完整名称.txt'), 'deep');
await writeFile(path.join(fixture, 'readme.md'), '# 标题\n\n![图](img/a.png)\n\n- 列表'); await writeFile(path.join(fixture, 'page.html'), '<h1>page</h1>');
const textPath = path.join(fixture, 'notes.txt'); await writeFile(textPath, Array.from({length:80}, (_, i) => `line ${i+1}`).join('\n'));
const name = `files_ui_${process.pid}`, token = crypto.randomBytes(32).toString('hex');
const appPort = await port(), debugPort = await port(), base = `http://127.0.0.1:${appPort}`;
const service = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/server.ts'], { env: { ...process.env, HOST:'127.0.0.1',PORT:String(appPort),AUTH_TOKEN:token }, stdio:'ignore' });
let chrome, socket; const pending = new Map(); let nextId = 0; const errors = []; const newSessions = [];
async function cdp(method, params={}) { const id=++nextId; return new Promise((resolve,reject)=>{ pending.set(id,{resolve,reject}); socket.send(JSON.stringify({id,method,params})); }); }
async function evaluate(expression) { const result=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true}); if(result.exceptionDetails) throw new Error(result.exceptionDetails.text+' '+result.exceptionDetails.exception?.description);return result.result.value; }
const frame = code => evaluate(`(() => { const w=document.querySelector('#file-browser-frame')?.contentWindow; if(!w) return null; return w.eval(${JSON.stringify(code)}); })()`);
async function wait(check, label) { for(let i=0;i<160;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,50));}throw new Error('Timeout: '+label); }
async function click(selector, inside=false) {
  const getRect=`(() => {const x=document.querySelector(${JSON.stringify(selector)});if(!x)throw new Error('Missing selector'); x.scrollIntoView({block:'nearest',inline:'nearest'});const r=x.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`;
  const point=await (inside?frame(getRect):evaluate(getRect));
  if(inside){const rect=await evaluate("document.querySelector('#file-browser-frame').getBoundingClientRect().toJSON()");point.x+=rect.x;point.y+=rect.y;}
  await cdp('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
  await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
}
try {
  await wait(async()=>{try{return(await fetch(base)).status===401}catch{return false}},'service');
  execFileSync('tmux',['new-session','-d','-s',name,'-c',fixture,'sleep 300']);
  chrome=spawn(chromeBinary,['--headless=new','--no-sandbox','--disable-dev-shm-usage',`--remote-debugging-port=${debugPort}`,`--user-data-dir=${path.join(folder,'chrome')}`,'about:blank'],{stdio:'ignore'});
  let targets;await wait(async()=>{try{targets=await(await fetch(`http://127.0.0.1:${debugPort}/json`)).json();return targets.some(t=>t.type==='page')}catch{return false}},'Chrome');
  socket=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await once(socket,'open');
  socket.on('message',raw=>{const msg=JSON.parse(raw);if(msg.id){const callback=pending.get(msg.id);pending.delete(msg.id);msg.error?callback.reject(new Error(msg.error.message)):callback.resolve(msg.result)}else if(msg.method==='Runtime.exceptionThrown')errors.push(msg.params.exceptionDetails.exception?.description||msg.params.exceptionDetails.text)});
  await cdp('Runtime.enable'); await cdp('Network.enable');
  await cdp('Network.setCookie',{name:'tw_auth',value:token,url:base,path:'/',httpOnly:true,sameSite:'Lax'});
  await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await cdp('Page.navigate',{url:`${base}/?session=${name}`});
  await wait(()=>evaluate("!!document.querySelector('.tab.active')"),'terminal initialization');
  const panePid=execFileSync('tmux',['display-message','-p','-t',`=${name}:`,'#{pane_pid}'],{encoding:'utf8'}).trim();
  await click('#mobilebar button[aria-label="文件管理"]');
  await wait(()=>frame("!!document.querySelector('.tree-content')"),'embedded file tree');
  assert.equal(await frame("document.querySelector('#hidden').checked"),false);
  assert.equal(await frame("document.querySelector('#breadcrumbs').textContent.includes('workspace')"),true);
  assert.equal(await frame("[...document.querySelectorAll('.name')].some(n=>n.firstChild.textContent==='.hidden-directory')"),false);
  await click('.toggle',true);
  await wait(()=>frame("[...document.querySelectorAll('.name')].some(n=>n.firstChild.textContent==='.hidden-directory')"),'hidden directories visible');
  await click('.toggle',true);
  await frame("document.querySelector('#tree').scrollTop=30; [...document.querySelectorAll('.name')].find(n=>n.firstChild.textContent==='subfolder').click();");
  await wait(()=>frame("document.querySelector('#footer-label').textContent.includes('subfolder')"),'folder selected only');
  assert.equal(await frame("document.querySelector('#breadcrumbs').textContent.includes('subfolder')"),false);
  const beforeScroll=await frame("document.querySelector('#tree').scrollTop");
  await click('#footer-actions button:first-child',true);
  await wait(()=>frame("document.querySelector('#breadcrumbs').textContent.includes('subfolder')"),'explicit enter');
  await click('#directory-back',true);
  await wait(()=>frame("!document.querySelector('#breadcrumbs').textContent.includes('subfolder')"),'back restores parent');
  assert.equal(await frame("document.querySelector('#tree').scrollTop"),beforeScroll);
  assert.equal(await frame("document.querySelector('#footer-label').textContent.includes('subfolder')"),true);
  await frame("[...document.querySelectorAll('.name')].find(n=>n.firstChild.textContent==='notes.txt').click();");
  await wait(()=>frame("document.querySelector('#footer-label').textContent.includes('notes.txt')"),'file selection');
  assert.equal(await frame("document.querySelector('#preview').open"),false);
  await click('#footer-actions button:first-child',true);
  await wait(()=>frame("document.querySelector('#preview').open"),'text preview');
  assert.equal(await frame("document.querySelector('.preview-numbers').textContent.split('\\n').length"),80);
  await click('#edit',true);
  await wait(()=>frame("!!document.querySelector('.editor-input')"),'text editing');
  await frame("const editor=document.querySelector('.editor-input');editor.value+='\\nnew line';editor.dispatchEvent(new Event('input',{bubbles:true}));editor.scrollTop=120;editor.dispatchEvent(new Event('scroll'));true");
  assert.equal(await frame("document.querySelector('.editor-numbers').textContent.split('\\n').length"),81);
  assert.equal(await frame("document.querySelector('#editor-status').textContent.includes('81 行')"),true);
  assert.match(await frame("document.querySelector('.editor-numbers').style.transform"),/translateY\(-/);
  await click('#edit',true);
  await wait(()=>frame("document.querySelector('#edit').textContent==='编辑'"),'save');
  assert.ok((await readFile(textPath,'utf8')).endsWith('new line'));
  const screenshot=await cdp('Page.captureScreenshot',{format:'png'});await writeFile('/tmp/terminal-file-browser-mobile.png',Buffer.from(screenshot.data,'base64'));
  await click('#preview .close',true);
  // Markdown renders in the dialog with relative images routed through /site; HTML opens as a site page.
  await frame("[...document.querySelectorAll('.name')].find(n=>n.firstChild.textContent==='readme.md').click();");
  await click('#footer-actions button:first-child',true);
  await wait(()=>frame("!!document.querySelector('.markdown-body h1')"),'markdown render');
  assert.equal(await frame("document.querySelector('.markdown-body h1').textContent"),'标题');
  assert.ok((await frame("document.querySelector('.markdown-body img').src")).endsWith('/workspace/img/a.png'));
  await click('#render-toggle',true);
  await wait(()=>frame("!!document.querySelector('.preview-numbers')"),'markdown source');
  await click('#preview .close',true);
  await frame("[...document.querySelectorAll('.name')].find(n=>n.firstChild.textContent==='page.html').click();");
  assert.equal(await frame("document.querySelector('#footer-actions button:first-child').textContent"),'浏览器打开');
  await click('#footer-actions button:nth-child(2)',true);
  await wait(()=>frame("document.querySelector('#preview').open && !!document.querySelector('.preview-numbers')"),'html source view');
  assert.equal(await frame("document.querySelector('#edit').hidden"),true);
  await click('#preview .close',true);
  // Copy requires a typed absolute path and a second confirmation.
  await frame("[...document.querySelectorAll('.name')].find(n=>n.firstChild.textContent==='notes.txt').click();");
  await click('#footer-actions button:last-child',true);
  await wait(()=>frame("document.querySelector('#sheet').open"),'file menu');
  await frame("[...document.querySelectorAll('#sheet-body button')].find(n=>n.textContent.includes('复制') && !n.textContent.includes('路径')).click();");
  await wait(()=>frame("!!document.querySelector('#sheet-body form')"),'copy input');
  await frame("const input=document.querySelector('#sheet-body input');input.value='/missing-directory-ui-test';document.querySelector('#sheet-body form').requestSubmit();");
  await wait(()=>frame("document.querySelector('.transfer-error')?.textContent.includes('不存在')"),'missing target error');
  const destinationPath = path.join(fixture,'destination');
  await frame(`document.querySelector('#sheet-body input').value=${JSON.stringify(destinationPath)};document.querySelector('#sheet-body form').requestSubmit();`);
  await wait(()=>frame("document.querySelector('#sheet-title').textContent==='确认复制'"),'copy confirmation');
  assert.equal(fs.existsSync(path.join(destinationPath,'notes.txt')),false);
  await frame("[...document.querySelectorAll('#sheet-body button')].find(n=>n.textContent==='确认执行').click();");
  await wait(async()=>fs.existsSync(path.join(destinationPath,'notes.txt')),'copy result');
  await wait(()=>frame("!document.querySelector('#sheet').open"),'copy completion');
  // Compression checklist exclusions must be visible before explicit execution.
  await frame("[...document.querySelectorAll('.name')].find(n=>n.firstChild.textContent==='subfolder').click();");
  await click('#footer-actions button:last-child',true);
  await frame("[...document.querySelectorAll('#sheet-body button')].find(n=>n.textContent.includes('压缩')).click();");
  await wait(()=>frame("document.querySelector('#sheet-title').textContent==='压缩配置'"),'compression checklist');
  await frame("document.querySelector('.archive-name').value='ui-bundle.zip';[...document.querySelectorAll('.archive-entry')].find(n=>n.textContent.endsWith('/exclude.txt')).querySelector('input').click();[...document.querySelectorAll('#sheet-body button')].find(n=>n.textContent.includes('下一步')).click();");
  await wait(()=>frame("document.querySelector('#sheet-title').textContent==='确认压缩'"),'compression confirmation');
  assert.equal(fs.existsSync(path.join(fixture,'ui-bundle.zip')),false);
  assert.equal(await frame("document.querySelector('#sheet-body').textContent.includes('排除的文件和目录（1 项）')"),true);
  assert.equal(await frame(`document.querySelector('#sheet-body').textContent.includes(${JSON.stringify(path.join(fixture,'ui-bundle.zip'))})`),true);
  await frame("[...document.querySelectorAll('#sheet-body button')].find(n=>n.textContent==='确认并压缩').click();");
  await wait(async()=>fs.existsSync(path.join(fixture,'ui-bundle.zip')),'ZIP created');
  await wait(()=>frame("!document.querySelector('#sheet').open"),'compression completion');
  const zipEntries=execFileSync('unzip',['-Z1',path.join(fixture,'ui-bundle.zip')],{encoding:'utf8'});
  assert.ok(zipEntries.includes('keep.txt'));assert.ok(!zipEntries.includes('exclude.txt'));
  await click('#select',true);await wait(()=>frame("document.querySelector('#select').textContent==='取消多选'"),'multiselect');
  await click('#select',true);assert.equal(await frame("document.querySelectorAll('.check').length"),0);
  const treeShot=await cdp('Page.captureScreenshot',{format:'png'});await writeFile('/tmp/terminal-file-browser-tree-mobile.png',Buffer.from(treeShot.data,'base64'));
  await frame("[...document.querySelectorAll('.name')].find(n=>n.firstChild.textContent==='subfolder').click();");
  await click('#footer-actions button:last-child',true);
  await wait(()=>frame("document.querySelector('#sheet').open"),'folder menu');
  await frame("[...document.querySelectorAll('#sheet-body button')].find(n=>n.textContent.includes('立即打开对应终端目录')).click();");
  await wait(()=>evaluate("document.querySelector('#file-browser-frame').hidden"),'switch back to new terminal');
  const activeName=await evaluate("document.querySelector('.tab.active .tab-label')?.textContent || document.querySelector('.tab.active').textContent.replace('×','')");
  assert.match(activeName,/^subfolder\d{17}$/);
  const created=execFileSync('tmux',['list-sessions','-F','#{session_name}'],{encoding:'utf8'}).split('\n').find(n=>n.startsWith('subfolder') && /\d{17}$/.test(n));assert.ok(created);newSessions.push(created);
  assert.equal(execFileSync('tmux',['display-message','-p','-t',`=${created}:`,'#{pane_current_path}'],{encoding:'utf8'}).trim(),path.join(fixture,'subfolder'));
  assert.equal(execFileSync('tmux',['display-message','-p','-t',`=${name}:`,'#{pane_pid}'],{encoding:'utf8'}).trim(),panePid);
  await cdp('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});
  await click('#controls button[aria-label="文件管理"]');await wait(()=>frame("!!document.querySelector('.tree-content')"),'desktop file view');
  assert.equal(await frame("getComputedStyle(document.querySelector('aside')).display"),'block');
  assert.equal(await frame("document.documentElement.scrollWidth > innerWidth"),false);
  assert.deepEqual(errors,[]);
  console.log('PASS: mobile/desktop embedded switching, hidden folders, select/enter/back, live line numbers, real save, copy confirmation/errors, compression exclusions, multiselect exit, directory terminal and preserved original pane');
  console.log('Screenshot: /tmp/terminal-file-browser-mobile.png');
} finally {
  socket?.close();chrome?.kill('SIGTERM');
  for(const session of [name,...newSessions])try{execFileSync('tmux',['kill-session','-t',`=${session}`])}catch{}
  if(service.exitCode===null){const exited=once(service,'exit');service.kill('SIGTERM');await exited;}
  await new Promise(resolve=>setTimeout(resolve,200)); await rm(folder,{recursive:true,force:true,maxRetries:3,retryDelay:100});
}
