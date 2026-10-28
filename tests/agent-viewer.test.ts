import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { AgentViewerHub } from '../src/agent-viewer.js';
class Socket extends EventEmitter {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  messages: any[] = [];
  send(text: string) { this.messages.push(JSON.parse(text)); }
  close() { this.emit('close'); }
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('output wakes a shared viewer promptly, coalesces floods and retains idle fallback', async t => {
  t.mock.timers.enable({apis:['Date','setTimeout'], now: 10000});
  let captures = 0;
  const hub = new AgentViewerHub(async () => ({text:String(++captures), truncated:false, limit:2000}));
  const a = new Socket(), b = new Socket();
  hub.attach(a as unknown as WebSocket, 'task');
  hub.attach(b as unknown as WebSocket, 'task');
  await flush();
  assert.equal(captures, 1);
  for (let i=0;i<100;i++) hub.notifyOutput('task');
  t.mock.timers.tick(199); await flush(); assert.equal(captures, 1);
  t.mock.timers.tick(1); await flush(); assert.equal(captures, 2);
  assert.equal(b.messages.at(-1).text, '2');
  // Browser control/input cannot trigger a capture or acquire control.
  a.emit('message', Buffer.from('{"type":"control","action":"takeover"}'), false);
  a.emit('message', Buffer.from('echo bad\r'), true);
  t.mock.timers.tick(1999); await flush(); assert.equal(captures, 2);
  t.mock.timers.tick(1); await flush(); assert.equal(captures, 3);
  a.close(); b.close();
  hub.notifyOutput('task'); t.mock.timers.tick(5000); await flush();
  assert.equal(captures, 3);
});

test('slow captures never overlap and closing suppresses their late results', async t => {
  t.mock.timers.enable({apis:['Date','setTimeout'], now: 10000});
  let finish!: (value: {text:string; truncated:boolean; limit:number}) => void;
  let captures = 0;
  const hub = new AgentViewerHub(() => { captures++; return new Promise(resolve => {finish=resolve;}); });
  const a = new Socket(); hub.attach(a as unknown as WebSocket, 'task');
  for (let i=0;i<20;i++) {hub.notifyOutput('task'); t.mock.timers.tick(1000);}
  assert.equal(captures, 1);
  a.close(); finish({text:'late',truncated:false,limit:2000}); await flush();
  t.mock.timers.tick(5000); await flush();
  assert.equal(captures, 1);
  assert.equal(a.messages.filter(m=>m.type==='agent-snapshot').length, 0);
});

test('output arriving during capture triggers one trailing refresh', async t => {
  t.mock.timers.enable({apis:['Date','setTimeout'], now:10000});
  let finish!: (value: {text:string; truncated:boolean; limit:number}) => void;
  let captures = 0;
  const hub = new AgentViewerHub(() => {captures++; return new Promise(resolve => {finish=resolve;});});
  const a = new Socket(); hub.attach(a as unknown as WebSocket, 'task');
  hub.notifyOutput('task'); hub.notifyOutput('task');
  finish({text:'first',truncated:false,limit:2000}); await flush();
  t.mock.timers.tick(200); await flush(); assert.equal(captures, 2);
  finish({text:'last',truncated:false,limit:2000}); await flush();
  assert.equal(a.messages.at(-1).text, 'last');
  a.close();
});
