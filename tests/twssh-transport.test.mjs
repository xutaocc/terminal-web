import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {request,closeConnections} from '../remote-agent/client/transport.mjs';

test('a waiting output read does not block interactive input on another pooled socket',async t=>{
  let release,observed;
  const reading=new Promise(r=>observed=r);
  const server=http.createServer((req,res)=>{
    if(req.url.endsWith('/events')) {release=()=>res.end('{}');observed();}
    else {res.end('{"mine":true}');release();}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{closeConnections();server.closeAllConnections();server.close();});
  const host={url:`http://127.0.0.1:${server.address().port}`,token:'fixture'};
  const pending=request(host,'/events');
  await reading;
  assert.equal((await request(host,'/control','POST',{action:'acquire'})).mine,true);
  await pending;
});
