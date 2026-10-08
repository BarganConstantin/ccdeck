import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { trafficRadar } from '../src/server/traffic-radar.mjs';
import { handleTrafficCapture, isAuthorizedTrafficIngest } from '../src/server/traffic-radar-routes.mjs';
import { GUARDED_READS, OPEN_MUTATIONS, isAuthorizedDataRead, isAuthorizedMutation, isTrustedMutation, isTrustedRead } from '../src/server/request-gates.mjs';

const root = resolve('dist/web');
const send = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:4329');
  const facts = { origin: req.headers.origin, host: req.headers.host, secFetchSite: req.headers['sec-fetch-site'], referer: req.headers.referer, token: req.headers['x-ccdeck-token'] };
  if (!isTrustedRead(facts) || (req.method !== 'GET' && !isTrustedMutation(facts))) return send(res, 403, { error: 'cross-site request blocked' });
  if (req.method !== 'GET' && !OPEN_MUTATIONS.has(url.pathname) && !isAuthorizedMutation(req) && !isAuthorizedTrafficIngest(req, url)) return send(res, 401, { error: 'unauthenticated' });
  if (req.method === 'GET' && GUARDED_READS.has(url.pathname) && !isAuthorizedDataRead(req)) return send(res, 401, { error: 'unauthenticated' });
  try {
    if (url.pathname === '/api/system/traffic-radar') return send(res, 200, await trafficRadar.read());
    if (url.pathname.startsWith('/api/system/traffic-radar/')) return await handleTrafficCapture(req, res, url);
    if (url.pathname === '/api/health') return send(res, 200, { ok: true, workspace: process.cwd(), providers: { claude: false, codex: false }, scoped: true });
    if (url.pathname === '/api/events') return send(res, 200, []);
    if (url.pathname === '/api/prefs') return send(res, 200, {});
    if (url.pathname === '/api/cswap-auto') return send(res, 200, { ok: false, enabled: false, settings: {}, accounts: [] });
    if (url.pathname === '/api/claude-accounts') return send(res, 200, { ok: false, accounts: [] });
    if (url.pathname === '/api/version') return send(res, 200, { current: '3.38.6', latest: '3.38.6' });
    if (url.pathname === '/api/system') return send(res, 200, { ok: true, probe: false });
    if (url.pathname === '/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' }); res.write(': preview\n\n'); return; }
    if (url.pathname.startsWith('/api/')) return send(res, 200, {});
    const path = resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
    if (!path.startsWith(root + '/')) return send(res, 403, {});
    const content = await readFile(path);
    res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' })[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(content);
  } catch { send(res, 404, { error: 'Preview resource unavailable' }); }
});
server.listen(4329, '127.0.0.1', () => process.stdout.write('Traffic Radar preview http://127.0.0.1:4329 — no agent hooks, watchers, LAN or reports.\n'));
