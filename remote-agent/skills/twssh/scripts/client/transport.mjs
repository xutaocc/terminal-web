import tls from 'node:tls';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import { createHash, timingSafeEqual } from 'node:crypto';

let httpAgent;
export function closeConnections() { httpAgent?.destroy(); httpAgent = undefined; }

/** HTTP for trusted networks; HTTPS authenticates the peer before sending credentials. */
export async function request(host, route, method = 'GET', body, client) {
  const url = new URL(host.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error('An http://host:port or https://host:port origin is required');
  const secure = url.protocol === 'https:';
  const pin = host.pin?.replace(/^SHA256:/i, '').replaceAll(':', '').toLowerCase();
  if (pin && !/^[a-f0-9]{64}$/.test(pin)) throw Error('Invalid SHA256 certificate fingerprint');
  if (!secure && pin) throw Error('Certificate fingerprints only apply to HTTPS; configure the HTTP host without --pin');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const socket = secure ? await new Promise((resolve, reject) => {
    const s = tls.connect({ host: hostname, port: Number(url.port || 443), servername: net.isIP(hostname) ? undefined : hostname, rejectUnauthorized: !pin });
    s.setTimeout(10000, () => s.destroy(Error('TLS connection timeout')));
    s.once('error', reject);
    s.once('secureConnect', () => {
      try {
        if (pin) {
          const raw = s.getPeerCertificate().raw;
          if (!raw || !timingSafeEqual(createHash('sha256').update(raw).digest(), Buffer.from(pin, 'hex'))) throw Error('TLS fingerprint mismatch; token was not sent');
        } else if (!s.authorized) throw Error('TLS certificate is not trusted');
        s.setTimeout(0); resolve(s);
      } catch (e) { s.destroy(); reject(e); }
    });
  }) : undefined;
  const transport = secure ? https : http;
  const agent = secure ? new transport.Agent({ keepAlive: false }) : (httpAgent ??= new http.Agent({ keepAlive: true, maxSockets: 4 }));
  if (socket) agent.createConnection = () => socket;
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = transport.request(url.origin + '/api/agent/v1' + route, {
      agent, method, headers: { Authorization: `Bearer ${host.token}`, ...(client ? { 'X-Terminal-Client': client } : {}),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) },
    }, res => {
      const chunks = []; let size = 0;
      res.on('data', b => { size += b.length; if (size > 4 * 1024 * 1024) res.destroy(Error('Response too large')); else chunks.push(b); });
      res.on('error', reject);
      res.on('end', () => {
        try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.statusCode !== 200) { const error = Error(`${res.statusCode}: ${value.error ?? 'request rejected'}`); error.status = res.statusCode; throw error; }
          resolve(value);
        } catch (e) { reject(e); } finally { if (secure) agent.destroy(); }
      });
    });
    req.setTimeout(15000, () => req.destroy(Error('Request timeout; query request ID before retrying')));
    req.on('error', e => { if (secure) agent.destroy(); reject(e); }); req.end(payload);
  });
}
