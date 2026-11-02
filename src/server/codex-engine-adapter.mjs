// Codex adapter for supervised exec sessions. Authentication remains in each
// Codex home; a handoff transfers only the exact, closed conversation rollout.
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { link, lstat, mkdir, open, readdir, realpath, readFile, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { spawnSpec } from './exec-spec.mjs';
import { configHash, isTrustOnlyConfig, isCustomCodexConfig } from './codex-engine-config.mjs';
import { codexHandoffPath } from './codex-handoff.mjs';
import { killTree } from './exec-children.mjs';
import { readCodexSelection } from './codex-selection.mjs';
import { discoverCodexProfiles, readCodexProfileQuota } from './codex-profiles.mjs';
import { readCodexAuto } from './codex-auto.mjs';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const CONTINUE = 'Continue the previous task from where it stopped. Check the existing work before repeating any action.';
const MAX_LINE = 1024 * 1024;

// Only a conservative, understood argv shape may be reconstructed on resume.
// Unknown options still reach Codex unchanged, but cannot authorize a handoff.
const values = new Set(['-c', '--config', '--enable', '--disable', '-m', '--model', '-s', '--sandbox', '-a', '--ask-for-approval', '-C', '--cd', '--add-dir', '--output-schema', '-o', '--output-last-message', '--color']);
const switches = new Set(['--json', '--strict-config', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '--approve-for-me', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust', '--search']);
export function codexEngineInvocation(args) {
  const kept = [];
  let exec = false, resume = false, threadId = null, prompt = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (prompt) return null; // extra positional arguments/attachments need their own contract
    if (a === 'exec' && !exec) { exec = true; kept.push(a); continue; }
    if (a === 'resume' && exec && !resume) { resume = true; continue; }
    if (a === '--') {
      if (!exec || i !== args.length - 2) return null;
      prompt = true; i++; continue;
    }
    const key = a.split('=')[0];
    if (values.has(key)) {
      kept.push(a);
      if (a === key) { if (i + 1 >= args.length) return null; kept.push(args[++i]); }
      // Do not route a non-OpenAI provider or remote/configured proxy implicitly.
      if ((key === '-c' || key === '--config') && /^(?:model_provider|model_providers\.|chatgpt_base_url|openai_base_url)/.test(kept[kept.length - 1].replace(/^--config=/, ''))) return null;
      continue;
    }
    if (switches.has(a)) { kept.push(a); continue; }
    if (a.startsWith('-') && a !== '-') return null;
    if (!exec) return null;
    if (resume && !threadId) { if (!UUID.test(a)) return null; threadId = a; }
    else prompt = true;
  }
  if (!exec || !kept.includes('--json')) return null;
  return { threadId, resumeArgs: id => [...kept, 'resume', id, '--', CONTINUE] };
}

export function runCodexEngineAttempt(executable, args, home, { signal, stdout = process.stdout, stderr = process.stderr, spawnChild = spawn, resumed = false, env = process.env } = {}) {
  if (signal?.aborted) return Promise.resolve({ code: 130, reason: 'cancelled' });
  return new Promise((resolveRun, reject) => {
    const spec = spawnSpec(executable, args);
    const child = spawnChild(spec.file, spec.args, { ...spec.opts, stdio: [resumed ? 'ignore' : 'inherit', 'pipe', 'pipe'], env: { ...env, CODEX_HOME: home } });
    let pending = '', threadId = null, failed = null, completed = false, uncertain = false;
    const decoder = new StringDecoder('utf8');
    function line(text) {
      if (!text.trim()) return;
      let event;
      try { event = JSON.parse(text); } catch { uncertain = true; return; }
      if (event.type === 'thread.started') {
        if (!UUID.test(event.thread_id ?? '') || threadId && threadId !== event.thread_id) uncertain = true;
        else threadId = event.thread_id;
      }
      if (event.type === 'turn.completed') completed = true;
      if (event.type === 'turn.failed') failed = event.error;
    }
    const pump = (source, target, inspect = false) => {
      source.on('data', chunk => {
        if (!target.write(chunk)) { source.pause(); target.once('drain', () => source.resume()); }
        if (!inspect) return;
        pending += decoder.write(chunk);
        let end;
        while ((end = pending.indexOf('\n')) >= 0) { line(pending.slice(0, end)); pending = pending.slice(end + 1); }
        if (pending.length > MAX_LINE) { pending = ''; uncertain = true; }
      });
    };
    pump(child.stdout, stdout, true);
    pump(child.stderr, stderr);
    let escalation;
    const stop = () => {
      killTree(child, 'SIGTERM');
      escalation ??= setTimeout(() => killTree(child, 'SIGKILL'), 2000);
      escalation.unref?.();
    };
    signal?.addEventListener('abort', stop, { once: true });
    child.once('error', error => { clearTimeout(escalation); signal?.removeEventListener('abort', stop); reject(error); });
    child.once('close', (code, killedBy) => {
      clearTimeout(escalation);
      signal?.removeEventListener('abort', stop);
      pending += decoder.end();
      if (pending) line(pending);
      const message = typeof failed?.message === 'string' ? failed.message : '';
      const quota = /(?:usage limit|quota (?:exceeded|exhausted)|exceeded your current quota|insufficient_quota|usage_limit_reached)/i.test(message);
      resolveRun({ code: code ?? (killedBy === 'SIGINT' ? 130 : 143), threadId,
        reason: signal?.aborted || killedBy ? 'cancelled' : uncertain ? 'protocol_error' : completed ? 'completed' : failed && quota ? 'usage_limit' : 'failed' });
    });
  });
}

export async function transferCodexThread(sourceHome, targetHome, threadId, { moveSource = false } = {}) {
  if (!UUID.test(threadId)) throw new Error('Invalid Codex conversation id.');
  const root = join(sourceHome, 'sessions');
  let found = null, visited = 0;
  // Bounded and layout-specific; never walk arbitrary/symlinked directories.
  async function walk(dir, depth) {
    if (++visited > 4096) throw new Error('Codex conversation scan exceeded its limit.');
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (depth < 3 && entry.isDirectory() && /^\d{2,4}$/.test(entry.name)) await walk(path, depth + 1);
      else if (depth === 3 && entry.isFile() && entry.name.endsWith(`-${threadId}.jsonl`)) {
        if (found) throw new Error('Codex conversation has more than one rollout.');
        found = path;
      }
    }
  }
  if ((await lstat(root)).isSymbolicLink()) throw new Error('Codex conversation folder must not be a symbolic link.');
  await walk(root, 0);
  if (!found) throw new Error('Codex conversation could not be found; nothing was resumed.');
  const handle = await open(found, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let snapshot, content;
  try {
    snapshot = await handle.stat();
    if (snapshot.size > 64 * 1024 * 1024) throw new Error('Codex conversation is too large to transfer automatically.');
    const header = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const first = header.subarray(0, bytesRead).toString('utf8').split('\n')[0];
    const meta = JSON.parse(first);
    if (meta.type !== 'session_meta' || meta.payload?.id !== threadId) throw new Error('Codex conversation identity did not match.');
    content = Buffer.alloc(snapshot.size);
    for (let offset = 0; offset < content.length;) {
      const { bytesRead } = await handle.read(content, offset, content.length - offset, offset);
      if (!bytesRead) throw new Error('Codex conversation was truncated while being transferred.');
      offset += bytesRead;
    }
  } finally { await handle.close(); }
  const targetRoot = join(targetHome, 'sessions');
  await mkdir(targetRoot, { recursive: true, mode: 0o700 });
  if ((await lstat(targetRoot)).isSymbolicLink()) throw new Error('Target conversation folder must not be a symbolic link.');
  const destination = join(targetRoot, relative(root, found));
  let parent = targetRoot;
  for (const part of relative(targetRoot, dirname(destination)).split(/[\\/]/)) {
    parent = join(parent, part);
    await mkdir(parent, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
    if (!(await lstat(parent)).isDirectory()) throw new Error('Target conversation path is unavailable.');
  }
  if (content.length !== snapshot.size || content.at(-1) !== 10) throw new Error('Codex conversation has an incomplete final record.');
  // Publish the complete private file atomically and exclusively. The sidecar
  // exists before publication, so a live deck never replays the copied prefix.
  try { await lstat(destination); throw new Error('Target conversation already exists.'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const marker = codexHandoffPath(destination);
  const receipt = await open(marker, 'wx', 0o600);
  try { await receipt.writeFile(JSON.stringify({ version: 1, threadId, copiedBytes: content.length })); }
  catch (e) { await unlink(marker).catch(() => {}); throw e; }
  finally { await receipt.close(); }
  const staged = `${destination}.${randomUUID()}.tmp`;
  let published = false;
  try {
    const output = await open(staged, 'wx', 0o600);
    try { await output.writeFile(content); await output.sync(); }
    finally { await output.close(); }
    const after = await lstat(found);
    if (after.size !== snapshot.size || after.mtimeMs !== snapshot.mtimeMs || after.ino !== snapshot.ino) throw new Error('Codex conversation changed while being transferred.');
    await link(staged, destination);
    published = true;
  } finally {
    await unlink(staged).catch(() => {});
    if (!published) await unlink(marker).catch(() => {});
  }
  if (moveSource) {
    const backup = `${found}.ccdeck-moved-${randomUUID()}`;
    try {
      await rename(found, backup);
      // A returning rollout publishes a fresh prefix receipt. Keep the old
      // one beside its backup rather than blocking a later round trip.
      await rename(codexHandoffPath(found), codexHandoffPath(backup)).catch(e => { if (e.code !== 'ENOENT') throw e; });
    }
    catch (error) {
      await rename(backup, found).catch(() => {});
      await unlink(destination).catch(() => {}); await unlink(marker).catch(() => {}); throw error;
    }
  }
  return destination;
}

export function createCodexEngineAdapter(file, executable, args, home, options = {}) {
  const invocation = codexEngineInvocation(args);
  if (!invocation) return null;
  const settingsOptions = { store: dirname(file), ...options };
  let selection;
  const leases = new Map();
  return {
    async close() {
      for (const lease of leases.values()) {
        try {
          const owner = JSON.parse(await readFile(lease.path, 'utf8'));
          if (owner.pid === process.pid && owner.nonce === lease.nonce) await unlink(lease.path);
        } catch { /* never remove a replacement lease */ }
      }
      leases.clear();
    },
    invocation,
    async settings() {
      const s = await readCodexAuto(settingsOptions);
      const config = await readFile(join(home, 'config.toml'), 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
      // A custom provider/profile can use a different authentication lifecycle.
      // Its process remains untouched instead of rotating ChatGPT accounts.
      const custom = isCustomCodexConfig(config);
      return { enabled: s.enabled && !custom, custom, threshold: Number(s.settings['autoswitch.threshold'].value), next: s.choice.next, heldOut: s.heldOut };
    },
    async accounts() {
      selection = await readCodexSelection(settingsOptions);
      return discoverCodexProfiles({ ...settingsOptions, selection, enableNative: true });
    },
    quota(id) { return readCodexProfileQuota(id, { ...settingsOptions, selection, enableNative: true }); },
    run(current, context) { return runCodexEngineAttempt(executable, current.args, current.home, { ...options, ...context, resumed: current.resumed }); },
    async prepare({ from, id, threadId, sessionConfig }) {
      // Per-account configuration can select a different provider, MCP servers,
      // or permissions. Never transfer work into a different configuration.
      const config = async home => readFile(join(home, 'config.toml'), 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
      const latest = await readCodexSelection(settingsOptions);
      const target = latest.profiles.find(p => p.id === id && p.available);
      const source = latest.profiles.find(p => p.id === from.id && p.available);
      if (!target || !source || await realpath(source.home) !== await realpath(from.home)) throw new Error('Codex accounts changed before continuation.');
      // One owner for this conversation across every target account. A stale
      // lease after a crash is refused rather than guessing about a live run.
      if (!leases.has(threadId)) {
        const locks = join(dirname(file), 'codex-engine-locks');
        await mkdir(locks, { recursive: true, mode: 0o700 });
        if (!(await lstat(locks)).isDirectory()) throw new Error('Codex continuation lock folder is unavailable.');
        const lock = join(locks, `${threadId}.lock`);
        const handle = await open(lock, 'wx', 0o600);
        const nonce = randomUUID();
        try { await handle.writeFile(JSON.stringify({ pid: process.pid, nonce })); }
        catch (e) { await unlink(lock).catch(() => {}); throw e; }
        finally { await handle.close(); }
        leases.set(threadId, { path: lock, nonce });
      }
      const sourceConfig = await config(from.home), targetConfig = await config(target.home);
      if (sourceConfig !== targetConfig && (!sessionConfig || sessionConfig.sourceHash !== configHash(sourceConfig)
        || !isTrustOnlyConfig(targetConfig) && configHash(targetConfig) !== sessionConfig.originHash)) throw new Error('Codex account configurations differ; resume manually.');
      await transferCodexThread(from.home, target.home, threadId, { moveSource: options.moveConversation === true });
      return { id, home: target.home, args: invocation.resumeArgs(threadId), resumed: true, threadId };
    },
  };
}
