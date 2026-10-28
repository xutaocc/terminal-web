/** Temporary, authenticated maintenance channel. Never shares the main session registry. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {AgentApi} from '../src/agent-api.js';
import {TerminalControl} from '../src/terminal-control.js';
const port=Number(process.env.MAINTENANCE_PORT),host=process.env.MAINTENANCE_HOST,dir=process.env.MAINTENANCE_STATE_DIR;
const lifetime=Number(process.env.MAINTENANCE_SECONDS??1800);
if(!Number.isInteger(port)||port<1024||port>65535||!host||!dir||!path.isAbsolute(dir)||!Number.isInteger(lifetime)||lifetime<60||lifetime>3600)throw Error('Explicit MAINTENANCE_PORT, HOST, absolute STATE_DIR and lifetime 60..3600 seconds required');
const env={...process.env};
// Match application .env parsing without printing credentials or executing it.
if(fs.existsSync('.env')) for(const line of fs.readFileSync('.env','utf8').split(/\r?\n/)){
 const entry=line.trim();if(!entry||entry.startsWith('#'))continue;
 const m=/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(entry);if(!m)throw Error('Invalid .env');
 let value=m[2].trim();if(value.length>=2&&((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'"))))value=value.slice(1,-1);
 env[m[1]]=value;
}
const token=process.env.MAINTENANCE_TOKEN_FILE?fs.readFileSync(process.env.MAINTENANCE_TOKEN_FILE,'utf8').trim():env.AUTH_TOKEN||fs.readFileSync(env.AUTH_TOKEN_FILE||path.join(os.homedir(),'.config/terminal-web/auth-token'),'utf8').trim();
if(!token)throw Error('Existing credential required');
const api=new AgentApi({enabled:true,token,file:path.join(dir,'sessions.json'),control:new TerminalControl(),spawn:async()=>{throw Error('TERMINALS_DISABLED');},prepareInput:async()=>{},register(){},remove:async()=>{throw Error('TERMINALS_DISABLED');}});
const server=http.createServer((req,res)=>{
 const url=new URL(req.url!,'http://localhost');
 if(!/^\/api\/agent\/v1\/(info|tasks(?:\/.*)?|files\/[^/]+)$/.test(url.pathname)){res.writeHead(404);res.end();return;}
 void api.http(req,res,url);
});
server.listen(port,host,()=>console.log(JSON.stringify({maintenance:true,pid:process.pid,port,expiresInSeconds:lifetime})));
const stop=()=>{api.flushHistory();server.closeAllConnections();server.close(()=>process.exit(0));};
setTimeout(stop,lifetime*1000);process.on('SIGTERM',stop);process.on('SIGINT',stop);
