// One authenticated local TUI connection. No browser origins, no shared port,
// no credentials in the URL, no public listener. ws handles RFC6455 framing.
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

export async function createCodexEngineBridge({ onMessage, onDisconnect = () => {} }) {
  const token = randomBytes(32).toString('hex');
  const expected = Buffer.from(`Bearer ${token}`);
  const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024, perMessageDeflate: false });
  let client = null, accepted = false;
  server.on('upgrade', (req, socket, head) => {
    const actual = Buffer.from(String(req.headers.authorization ?? ''));
    if (accepted || req.headers.origin || req.url !== '/' || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    accepted = true;
    wss.handleUpgrade(req, socket, head, ws => {
      client = ws;
      ws.on('error', () => {});
      ws.on('close', () => { client = null; onDisconnect(); });
      ws.on('message', (data, binary) => {
        if (binary) { ws.close(1003); return; }
        let message;
        try { message = JSON.parse(data.toString()); } catch { ws.close(1007); return; }
        if (!message || typeof message !== 'object' || Array.isArray(message)) { ws.close(1007); return; }
        Promise.resolve().then(() => onMessage(message)).catch(() => ws.close(1011));
      });
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    url: `ws://127.0.0.1:${server.address().port}/`, token,
    send(message) {
      if (client?.readyState !== WebSocket.OPEN) return;
      if (client.bufferedAmount > 64 * 1024 * 1024) { client.close(1009); return; }
      client.send(JSON.stringify(message));
    },
    async close() {
      client?.terminate();
      await new Promise(resolve => wss.close(resolve));
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
