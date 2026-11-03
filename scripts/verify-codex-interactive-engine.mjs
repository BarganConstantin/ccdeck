// Native app-server/optional TUI against a loopback model provider. No real
// accounts or external inference. --tui requires an actual terminal.
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import { createInteractiveCodexSession, runInteractiveCodex } from '../src/server/codex-interactive-engine.mjs';
import { transferCodexThread } from '../src/server/codex-engine-adapter.mjs';

const executable = process.argv[2] ?? 'codex', tui = process.argv.includes('--tui');
const root = await mkdtemp(join(tmpdir(), 'ccdeck-native-interactive-'));
let switched = false, requests = 0, continued = false, session, ws;
const item = { id: 'msg_probe', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'INTERACTIVE_RESUMED_OK', annotations: [] }] };
const server = createServer((req, res) => {
  req.resume(); requests++;
  if (!switched) {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'usage_limit_reached', message: "You've hit your usage limit" } })); return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = data => res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
  send({ type: 'response.created', response: { id: 'resp_probe', status: 'in_progress', output: [] } });
  send({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
  send({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'INTERACTIVE_RESUMED_OK' });
  send({ type: 'response.output_item.done', output_index: 0, item });
  send({ type: 'response.completed', response: { id: 'resp_probe', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
  res.end(); continued = true;
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let timer;
try {
  const source = join(root, 'source'), target = join(root, 'target'), cwd = join(root, 'workspace');
  for (const dir of [source, target, cwd]) await mkdir(dir);
  const hash = async home => createHash('sha256').update(await realpath(home)).digest('hex').slice(0, 20);
  const a = await hash(source), b = await hash(target);
  const config = `model_provider="ccdeck_probe"\nmodel="gpt-5.4"\n[model_providers.ccdeck_probe]\nname="Local verification"\nbase_url="http://127.0.0.1:${server.address().port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\nrequest_max_retries=0\nstream_max_retries=0\n`;
  for (const home of [source, target]) await writeFile(join(home, 'config.toml'), config);
  const adapter = {
    settings: async () => ({ enabled: true, threshold: 90, heldOut: [] }),
    accounts: async () => [{ id: a, available: true, signedIn: true }, { id: b, available: true, signedIn: true }],
    quota: async () => ({ ok: true, windows: [{ usedPercent: 10, seconds: 18000, resetAt: Date.now() / 1000 + 3600 }] }),
    async prepare({ threadId }) { await transferCodexThread(source, target, threadId); switched = true; return { id: b, home: target, threadId }; },
    close: async () => {},
  };
  const env = { ...process.env };
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'CODEX_REFRESH_TOKEN_URL_OVERRIDE']) delete env[key];
  if (tui) {
    // The native UI is exercised through the caller's PTY; type a prompt, then
    // /quit after INTERACTIVE_RESUMED_OK. Never touches the user's own home.
    const states = [];
    const result = await runInteractiveCodex(join(root, 'registry.json'), executable, ['--no-alt-screen', '-C', cwd], source, { adapter, env, onState: state => { states.push(state); } });
    console.log(JSON.stringify({ states }));
    if (result.code !== 0 || !switched || !continued) throw new Error('The native TUI probe did not complete a continuation.');
  } else {
    session = await createInteractiveCodexSession(join(root, 'registry.json'), executable, [], source, { adapter, env });
    ws = new WebSocket(session.url, { headers: { authorization: `Bearer ${session.token}` } });
    const pending = new Map();
    let resolveDone, rejectDone;
    const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    timer = setTimeout(() => rejectDone(new Error('Native interactive probe timed out.')), 40_000);
    ws.on('message', raw => {
      const m = JSON.parse(raw.toString());
      const p = pending.get(m.id);
      if (p) { pending.delete(m.id); if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result); }
      if (m.method === 'turn/completed' && m.params.turn.status === 'completed') resolveDone(m.params.threadId);
    });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const call = (method, params) => new Promise((resolve, reject) => { const id = String(pending.size) + Math.random(); pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
    await call('initialize', { clientInfo: { name: 'ccdeck_engine_probe', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    ws.send(JSON.stringify({ method: 'initialized', params: {} }));
    const started = await call('thread/start', { cwd, model: 'gpt-5.4', modelProvider: 'ccdeck_probe', sandbox: 'read-only', approvalPolicy: 'never' });
    await call('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: 'Reply PROBE only; do not use tools.' }] });
    if (await done !== started.thread.id || !switched || !continued) throw new Error('The resumed conversation identity changed.');
  }
  console.log(JSON.stringify({ ok: true, nativeInteractiveTui: tui, sameThreadResumed: true, requests, realAccountsUsed: false }));
} finally {
  clearTimeout(timer); ws?.terminate(); await session?.close();
  server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
