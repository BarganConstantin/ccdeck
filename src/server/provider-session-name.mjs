// Native provider metadata only: never submit a prompt or inject terminal keys.
// Claude's documented renameSession operation appends a custom-title entry:
// https://code.claude.com/docs/en/agent-sdk/typescript#renamesession
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { claudeConfigDir } from './claude-dir.mjs';
import { readCodexSelection } from './codex-selection.mjs';
import { resolveCodexLiveEndpoint, connectCodexLiveRpc } from './codex-live-rpc.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const unavailable = () => { throw Object.assign(new Error('provider_name_not_saved'), { code: 'provider_name_not_saved' }); };

export async function renameProviderSession(provider, sessionId, name, options = {}) {
  if (!uuid.test(sessionId) || typeof name !== 'string' || !name.trim()) return unavailable();
  if (provider === 'codex') {
    const selection = await (options.readSelection ?? readCodexSelection)(options);
    const endpoint = await (options.resolveEndpoint ?? resolveCodexLiveEndpoint)(selection.originalHome, options);
    const rpc = await (options.connectRpc ?? connectCodexLiveRpc)(endpoint);
    try {
      const { thread } = await rpc.request('thread/read', { threadId: sessionId, includeTurns: false });
      if (thread?.id !== sessionId) return unavailable();
      await rpc.request('thread/name/set', { threadId: sessionId, name });
      return;
    } finally { rpc.close(); }
  }
  if (provider !== 'claude') return unavailable();
  const root = await realpath(join(claudeConfigDir(options.env, options.home), 'projects'));
  const matches = [];
  // Only immediate project directories; never follow a transcript or project symlink.
  const dirs = await readdir(root, { withFileTypes: true });
  if (dirs.length > 10_000) return unavailable();
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const parent = join(root, dir.name), path = join(parent, `${sessionId}.jsonl`);
    try {
      if (await realpath(parent) !== parent) continue;
      const info = await lstat(path);
      if (!info.isFile() || info.nlink !== 1) continue;
      matches.push({ path, info });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (matches.length !== 1) return unavailable();
  const { path, info } = matches[0];
  const file = await open(path, constants.O_RDWR | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0));
  try {
    const current = await file.stat();
    if (!current.isFile() || current.dev !== info.dev || current.ino !== info.ino || current.nlink !== 1
      || typeof process.getuid === 'function' && current.uid !== process.getuid()) return unavailable();
    if (current.size > 0) {
      const last = Buffer.alloc(1);
      await file.read(last, 0, 1, current.size - 1);
      if (last[0] !== 10) return unavailable(); // Do not splice into an in-flight JSONL write.
    }
    await file.write(JSON.stringify({ type: 'custom-title', customTitle: name, sessionId }) + '\n');
    await file.sync();
  } finally { await file.close(); }
}
