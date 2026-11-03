import { it, expect } from 'vitest';
import WebSocket from 'ws';
// @ts-expect-error server ES module
import { createCodexEngineBridge } from '../../server/codex-engine-bridge.mjs';
it('accepts only one authenticated local non-browser connection', async () => {
  const messages: unknown[] = [];
  const bridge = await createCodexEngineBridge({ onMessage: (m: unknown) => messages.push(m) });
  const rejected = async (headers = {}) => {
    const ws = new WebSocket(bridge.url, { headers });
    await new Promise<void>(resolve => { ws.on('error', () => resolve()); ws.on('open', () => { ws.terminate(); resolve(); }); });
    expect(ws.readyState).not.toBe(WebSocket.OPEN);
  };
  let client: WebSocket | undefined;
  try {
    await rejected();
    await rejected({ authorization: 'Bearer wrong' });
    await rejected({ authorization: `Bearer ${bridge.token}`, origin: 'https://example.invalid' });
    client = new WebSocket(bridge.url, { headers: { authorization: `Bearer ${bridge.token}` } });
    await new Promise<void>((resolve, reject) => { client!.once('open', resolve); client!.once('error', reject); });
    const received = new Promise(resolve => client!.once('message', raw => resolve(JSON.parse(raw.toString()))));
    bridge.send({ id: 1, result: { ok: true } });
    expect(await received).toEqual({ id: 1, result: { ok: true } });
    await rejected({ authorization: `Bearer ${bridge.token}` });
    expect(messages).toEqual([]);
  } finally { client?.terminate(); await bridge.close(); }
});
