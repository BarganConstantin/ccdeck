// Native Codex protocol/resume probe against a loopback fake model provider.
// No real account, credential, upstream request or production settings are used.
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { runCodexEngineAttempt, transferCodexThread } from '../src/server/codex-engine-adapter.mjs';

const executable = process.argv[2] ?? 'codex';
const root = await mkdtemp(join(tmpdir(), 'ccdeck-native-engine-'));
let resumed = false, requests = 0;
const item = { id: 'msg_probe', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'RESUMED_OK', annotations: [] }] };
const server = createServer((req, res) => {
  req.resume(); requests++;
  if (!resumed) {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'usage_limit_reached', message: "You've hit your usage limit" } }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = data => res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
  send({ type: 'response.created', response: { id: 'resp_probe', status: 'in_progress', output: [] } });
  send({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
  send({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'RESUMED_OK' });
  send({ type: 'response.output_item.done', output_index: 0, item });
  send({ type: 'response.completed', response: { id: 'resp_probe', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
  res.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const controller = new AbortController();
const deadline = setTimeout(() => controller.abort(), 45_000);
let output = '';
const stdout = new Writable({ write(chunk, _encoding, done) { output += chunk; done(); } });
const stderr = new Writable({ write(_chunk, _encoding, done) { done(); } });
try {
  const source = join(root, 'source'), target = join(root, 'target'), workspace = join(root, 'workspace');
  for (const dir of [source, target, workspace]) await mkdir(dir);
  const port = server.address().port;
  const flags = ['exec', '--json', '--skip-git-repo-check', '-C', workspace,
    '-c', 'model_provider="ccdeck_probe"', '-c', 'model="gpt-5.4"',
    '-c', 'model_providers.ccdeck_probe.name="Local verification"',
    '-c', `model_providers.ccdeck_probe.base_url="http://127.0.0.1:${port}/v1"`,
    '-c', 'model_providers.ccdeck_probe.wire_api="responses"',
    '-c', 'model_providers.ccdeck_probe.requires_openai_auth=false',
    '-c', 'model_providers.ccdeck_probe.supports_websockets=false',
    '-c', 'model_providers.ccdeck_probe.request_max_retries=0',
    '-c', 'model_providers.ccdeck_probe.stream_max_retries=0'];
  const env = { ...process.env };
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'CODEX_REFRESH_TOKEN_URL_OVERRIDE']) delete env[key];
  const options = { stdout, stderr, signal: controller.signal, env };
  const first = await runCodexEngineAttempt(executable, [...flags, 'Reply with PROBE only; do not use tools.'], source, options);
  if (first.reason !== 'usage_limit' || !first.threadId) throw new Error(`Native limit event was not recognized: ${JSON.stringify(first)}`);
  await transferCodexThread(source, target, first.threadId);
  resumed = true;
  const next = await runCodexEngineAttempt(executable, [...flags, 'resume', first.threadId, '--', 'Continue; do not use tools.'], target, { ...options, resumed: true });
  if (next.code !== 0 || next.reason !== 'completed' || next.threadId !== first.threadId || !output.includes('RESUMED_OK')) throw new Error(`Native exact-thread resume did not complete: ${JSON.stringify(next)}`);
  console.log(JSON.stringify({ ok: true, requests, nativeExactThreadResume: true, realAccountsUsed: false, authenticatedCrossAccountInference: false }));
} finally {
  clearTimeout(deadline);
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
