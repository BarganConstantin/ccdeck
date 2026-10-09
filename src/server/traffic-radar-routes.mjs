import { trafficCapture } from "./traffic-radar-capture.mjs";
const BASE = '/api/system/traffic-radar';
const loopback = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
export function isAuthorizedTrafficIngest(req, url) {
  return req.method === 'POST' && url.pathname === BASE + '/ingest' && loopback(req)
    && trafficCapture.accepts(req.headers['x-radar-capture']);
}
function reply(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function body(req, max) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > max) throw new Error('Request too large.'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
export async function handleTrafficCapture(req, res, url, capture = trafficCapture) {
  if (!loopback(req)) return reply(res, 403, { error: 'Telemetry contents are available on this machine only.' });
  const action = url.pathname.slice(BASE.length);
  try {
    if (req.method === 'GET' && action === '/capture') return reply(res, 200, capture.read());
    if (req.method === 'GET' && action === '/capture/event') {
      const detail = capture.detail(Number(url.searchParams.get('id')));
      return reply(res, detail ? 200 : 404, detail ?? { error: 'This event is no longer retained.' });
    }
    if (req.method === 'POST' && action === '/ingest') {
      const token = req.headers['x-radar-capture'];
      if (!capture.accepts(token)) return reply(res, 401, { error: 'Capture session ended or unauthorized.' });
      const data = await body(req, 262_144);
      return reply(res, capture.ingest(token, data, Number(req.headers['x-radar-source'] ?? 0)) ? 200 : 409, { ok: capture.read().state === 'capturing' });
    }
    if (req.method === 'POST' && action === '/capture/prepare') {
      const data = JSON.parse((await body(req, 4096)).toString());
      return reply(res, 200, await capture.prepare(data.destination, req.socket.localPort));
    }
    if (req.method === 'POST' && action === '/capture/stop') { capture.stop(); return reply(res, 200, { ok: true }); }
    if (req.method === 'POST' && action === '/capture/clear') { capture.clear(); return reply(res, 200, { ok: true }); }
    return reply(res, 404, { error: 'Unknown capture action.' });
  } catch { return reply(res, 400, { error: 'Could not complete capture setup. Use a valid IPv4 destination and check its network route.' }); }
}
