import test from 'node:test';
import assert from 'node:assert/strict';
import { TerminalControl } from '../src/terminal-control.js';

test('agent sessions require explicit takeover and fence delayed writes', () => {
  const locks = new TerminalControl(); locks.setExplicit('agent');
  const join = (admin: boolean) => locks.join('agent', { resume: String(admin), principal: String(admin), label: 'test', admin, valid: () => true, send: () => {} });
  const agent = join(false), browser = join(true);
  locks.action('agent', agent, 'acquire'); const epoch = locks.fence('agent', agent);
  locks.action('agent', browser, 'interact'); assert(locks.owns('agent', agent));
  locks.action('agent', browser, 'takeover'); assert(!locks.accepts('agent', agent, epoch));
  locks.action('agent', agent, 'interact'); assert(locks.owns('agent', browser));
  locks.action('agent', agent, 'acquire'); assert(locks.owns('agent', browser));
  locks.action('agent', browser, 'release'); locks.action('agent', agent, 'acquire'); assert(locks.owns('agent', agent));
});
test('single operator, approved handover, admin takeover and stale input fencing', () => {
  let now = 0; const locks = new TerminalControl(() => now); const messages: any[] = [];
  const join = (admin = false, resume = 'secret') => locks.join('session', { resume, principal: admin ? 'admin' : 'share', label: admin ? '管理员' : '访客', admin, valid: () => true, send: m => messages.push(m) });
  const a = join(true), b = join(), c = join();
  assert(!locks.owns('session',a)); locks.action('session', b, 'acquire'); locks.action('session', a, 'acquire'); assert(!locks.owns('session',a));
  const old = locks.fence('session',b); locks.action('session',c,'takeover'); assert(locks.owns('session',b));
  locks.action('session',a,'request'); locks.action('session',b,'grant',a.id); assert(locks.owns('session',a)); assert(!locks.accepts('session',b,old));
  locks.action('session',a,'release'); locks.action('session',b,'acquire'); assert(!locks.accepts('session',b,old));
  locks.action('session',a,'takeover'); assert(locks.owns('session',a)); assert(!locks.owns('session',b));
  now=14000;locks.action('session',a,'heartbeat');now=20000;locks.sweep();assert(locks.owns('session',a));
  now=30000;locks.sweep();assert(!locks.owns('session',a));
});
test('reconnect reservation is scoped to principal and one transport; revocation releases', () => {
  let now=0, valid=true;const locks=new TerminalControl(()=>now);
  const join=(principal='share',resume='secret')=>locks.join('s',{principal,resume,label:'guest',admin:false,valid:()=>valid,send:()=>{}});
  const a=join();locks.action('s',a,'acquire');const duplicate=join();assert(!locks.owns('s',duplicate));
  locks.leave('s',a);const wrong=join('other');locks.action('s',wrong,'acquire');assert(!locks.owns('s',wrong));
  const back=join();assert(locks.owns('s',back));valid=false;locks.sweep();assert(!locks.owns('s',back));
  valid=true;locks.action('s',wrong,'acquire');assert(locks.owns('s',wrong));locks.leave('s',wrong);now=15001;locks.sweep();locks.action('s',duplicate,'acquire');assert(locks.owns('s',duplicate));
});
