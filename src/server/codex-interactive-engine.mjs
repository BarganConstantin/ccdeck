// The native TUI stays attached to one local bridge. Only its owned app-server
// changes account, after a structured terminal quota failure and a clean exit.
import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runAccountEngine } from './account-engine.mjs';
import { createCodexEngineAdapter } from './codex-engine-adapter.mjs';
import { createCodexEngineBridge } from './codex-engine-bridge.mjs';
import { startEngineRpc } from './codex-engine-rpc.mjs';
import { spawnSpec } from './exec-spec.mjs';
import { killTree } from './exec-children.mjs';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const fields = ['approvalPolicy', 'approvalsReviewer', 'baseInstructions', 'config', 'cwd', 'developerInstructions', 'model', 'modelProvider', 'personality', 'sandbox', 'serviceTier'];
const turnFields = ['approvalPolicy', 'approvalsReviewer', 'cwd', 'disabledPluginIds', 'effort', 'model', 'outputSchema', 'personality', 'sandboxPolicy', 'serviceTier', 'summary'];
const pick = (source, keys) => Object.fromEntries(keys.filter(k => Object.hasOwn(source ?? {}, k)).map(k => [k, source[k]]));
const clone = value => JSON.parse(JSON.stringify(value));
const continuation = 'Continue the previous task from where it stopped. Check the existing work before repeating any action.';

export function codexInteractiveInvocation(args) {
  const backendArgs = ['app-server', '--listen', 'stdio://'];
  const values = new Set(['-c', '--config', '--enable', '--disable', '-m', '--model', '-s', '--sandbox', '-a', '--ask-for-approval', '-C', '--cd', '--add-dir']);
  const flags = new Set(['--strict-config', '--no-alt-screen', '--search', '--approve-for-me', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust']);
  let resume = false, threadId = null, prompt = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i], key = arg.split('=')[0];
    if (prompt) return null;
    if (values.has(key)) {
      let value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[++i];
      if (value === undefined) return null;
      if (['-c', '--config'].includes(key)) {
        if (/^\s*(?:model_provider|model_providers\.|chatgpt_base_url|openai_base_url|cli_auth_credentials_store)/.test(value)) return null;
        backendArgs.push('-c', value);
      } else if (key === '--enable' || key === '--disable') backendArgs.push(key, value);
      continue;
    }
    if (flags.has(arg)) { if (arg === '--strict-config') backendArgs.push(arg); continue; }
    if (arg === 'resume' && !resume) { resume = true; continue; }
    if (arg === '--' && i === args.length - 2) { prompt = true; i++; continue; }
    if (arg.startsWith('-')) return null;
    if (resume && !threadId) { if (!UUID.test(arg)) return null; threadId = arg; }
    else { if (!resume && ['exec', 'e', 'review', 'fork', 'login', 'logout', 'app', 'app-server', 'mcp', 'mcp-server', 'completion', 'sandbox', 'debug', 'apply', 'cloud', 'features', 'help', 'update'].includes(arg)) return null; prompt = true; }
  }
  // A picker can choose unrelated histories. Explicit ids have a clear owner.
  if (resume && !threadId) return null;
  return { backendArgs, threadId };
}

export async function supportsCodexInteractiveEngine(executable, env = process.env) {
  try {
    const spec = spawnSpec(executable, ['--help']);
    const { stdout } = await promisify(execFile)(spec.file, spec.args, { ...spec.opts, env, timeout: 5000, maxBuffer: 256 * 1024 });
    return stdout.includes('--remote ') && stdout.includes('--remote-auth-token-env');
  } catch { return false; }
}

export async function createInteractiveCodexSession(file, executable, args, home, options = {}) {
  const invocation = codexInteractiveInvocation(args);
  if (!invocation) return null;
  const adapter = options.adapter ?? createCodexEngineAdapter(file, executable, ['exec', '--json'], home, options);
  const controller = new AbortController();
  const clients = new Map(), serverRequests = new Set(), threads = new Map(), active = new Set(), processes = new Set(), tools = new Set();
  let rpc, bridge, initialize, settleAttempt, current, failedThread, frozen = false, automatic = true, closed = false;
  let authChanged = false, restoring = false, quotaFailure = null, deferredTurn = null, interrupted = false, engineFinished = false;
  const sendClient = message => bridge.send(message);
  const rejectClient = (message, text) => {
    if (message.id !== undefined && message.method) sendClient({ id: message.id, error: { code: -32000, message: text } });
  };
  function fromClient(message) {
    if (closed) return;
    if (frozen) {
      if (message.method === 'turn/interrupt') {
        interrupted = true; automatic = false;
        if (deferredTurn) rejectClient(deferredTurn, 'Your queued message was cancelled.');
        deferredTurn = null;
      }
      // The native TUI may submit a queued follow-up as a failed turn ends.
      // Hold that unsent request once; do not add an engine Continue as well.
      if (message.method === 'turn/start' && message.params?.threadId === failedThread && !deferredTurn && !interrupted) {
        automatic = false; deferredTurn = clone(message);
        options.onState?.({ state: 'follow-up-held' });
        return;
      }
      if (['turn/interrupt', 'account/login/start', 'account/logout', 'thread/start', 'thread/fork'].includes(message.method)
        || message.method === 'thread/resume' && message.params?.threadId !== failedThread) automatic = false;
      options.onState?.({ state: 'request-during-handoff', method: message.method, sameThread: message.params?.threadId === failedThread });
      rejectClient(message, 'Account continuation is in progress. Please wait, then try again.');
      return;
    }
    if (['turn/start', 'turn/interrupt', 'thread/start', 'thread/resume', 'thread/fork'].includes(message.method)) quotaFailure = null;
    if (message.method === 'process/spawn') processes.add(message.params?.processHandle);
    if (message.method === 'initialize') initialize = clone(message.params);
    if (['account/login/start', 'account/logout'].includes(message.method)) authChanged = true;
    if (message.id !== undefined && message.method) {
      if (clients.size >= 128) { rejectClient(message, 'Too many pending requests.'); return; }
      clients.set(message.id, { method: message.method, params: clone(message.params ?? {}) });
    } else if (!message.method) serverRequests.delete(message.id);
    try { rpc.send(message); } catch { rejectClient(message, 'Codex connection is unavailable. No request was retried.'); }
  }
  function fromServer(message) {
    if (closed) return;
    const request = clients.get(message.id);
    if (!message.method && request) {
      clients.delete(message.id);
      const thread = message.result?.thread;
      if (thread && UUID.test(thread.id ?? '') && ['thread/start', 'thread/resume', 'thread/fork'].includes(request.method)) {
        threads.set(thread.id, { ephemeral: request.params.ephemeral === true, resume: { ...pick(request.params, fields), ...(thread.cwd ? { cwd: thread.cwd } : {}) }, turn: {} });
      }
    }
    if (message.method && message.id !== undefined) serverRequests.add(message.id);
    const p = message.params;
    if (message.method === 'process/exited') processes.delete(p?.processHandle);
    if (message.method === 'item/started' && ['commandExecution', 'mcpToolCall', 'fileChange'].includes(p?.item?.type)) tools.add(p.item.id);
    if (message.method === 'item/completed' && p?.item?.status !== 'inProgress') tools.delete(p?.item?.id);
    if (message.method === 'turn/started') active.add(p?.threadId);
    if (message.method === 'turn/completed') active.delete(p?.threadId);
    if (request?.method === 'process/spawn' && message.error) processes.delete(request.params.processHandle);
    if (request?.method === 'turn/start' && !message.error) {
      const owned = threads.get(request.params.threadId);
      if (owned) owned.turn = pick(request.params, turnFields);
    }
    // Closing the old owned backend is a transport handoff, not a closed user
    // thread. Letting the TUI see it would trigger its own competing resume.
    if (!(frozen && ['thread/closed', 'thread/started', 'thread/status/changed'].includes(message.method))) sendClient(message);
    if (message.method === 'turn/completed' && p?.turn?.status === 'failed'
      && p.turn.error?.codexErrorInfo === 'usageLimitExceeded' && threads.has(p.threadId)
      && !threads.get(p.threadId).ephemeral) quotaFailure = p;
    maybeFailover();
  }
  function maybeFailover() {
    if (engineFinished || !quotaFailure || restoring || frozen || authChanged || active.size || tools.size || processes.size || clients.size || serverRequests.size || !initialize) return;
    failedThread = quotaFailure.threadId;
    quotaFailure = null;
    frozen = true; automatic = true; interrupted = false;
    options.onState?.({ state: 'switching' });
    const owner = rpc;
    // Drain and flush the old server before the generic engine may transfer it.
    owner.stop().then(clean => {
      if (!closed) settleAttempt?.({ code: 1, reason: clean ? 'usage_limit' : 'failed', threadId: failedThread });
    }).catch(() => { if (!closed) settleAttempt?.({ code: 1, reason: 'failed' }); });
  }
  function start(home) {
    return (options.startRpc ?? startEngineRpc)(executable, options.backendArgs ?? invocation.backendArgs, home, {
      ...options, onMessage: fromServer,
      onClose: () => { if (!frozen && !closed) settleAttempt?.({ code: 1, reason: 'failed' }); },
    });
  }
  async function reconnect(next, continueTask) {
    rpc = start(next.home);
    await rpc.request('initialize', initialize);
    rpc.send({ method: 'initialized', params: {} });
    const saved = threads.get(failedThread);
    if (!saved) throw new Error('Codex conversation ownership is unknown.');
    const resumed = await rpc.request('thread/resume', { ...saved.resume, threadId: failedThread });
    if (resumed?.thread?.id !== failedThread) throw new Error('Codex resumed a different conversation.');
    frozen = false;
    options.onState?.({ state: 'resumed', automatic: continueTask && automatic });
    if (deferredTurn) {
      const queued = deferredTurn; deferredTurn = null;
      if (continueTask && !interrupted && !controller.signal.aborted) fromClient(queued);
      else rejectClient(queued, 'Automatic continuation stopped. Please submit your message again.');
    } else if (continueTask && automatic && !interrupted && !controller.signal.aborted) {
      // One submission only. A timeout is ambiguous and is never resubmitted.
      await rpc.request('turn/start', { ...saved.turn, threadId: failedThread, clientUserMessageId: randomUUID(), input: [{ type: 'text', text: continuation }] });
    }
  }
  bridge = await createCodexEngineBridge({ onMessage: fromClient, onDisconnect: () => { void close(); } });
  const initial = { id: createHash('sha256').update(await realpath(home)).digest('hex').slice(0, 20), home, threadId: invocation.threadId };
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const provider = {
    ...adapter,
    run(next) {
      current = next;
      return new Promise((resolveAttempt, reject) => {
        settleAttempt = resolveAttempt;
        if (controller.signal.aborted) { resolveAttempt({ code: 130, reason: 'cancelled' }); return; }
        if (!rpc) { rpc = start(next.home); readyResolve(); }
        else reconnect(next, true).catch(reject);
      });
    },
  };
  const done = runAccountEngine(provider, initial, { signal: controller.signal }).then(async result => {
    engineFinished = true;
    if (!closed && frozen && failedThread) {
      // No candidate, cancellation or a refused transfer leaves a usable TUI on
      // its current account. Resume idle; never automatically repeat the turn.
      restoring = true;
      try { await reconnect(current, false); } catch { await close(); }
      restoring = false;
    }
    if (!closed && !frozen && result.reason === 'failed') await close();
    return result;
  }).catch(async () => { engineFinished = true; readyReject(new Error('Codex app-server could not start.')); await close(); return { code: 1, reason: 'failed' }; });
  let closing;
  async function close() {
    if (closing) return closing;
    closed = true; controller.abort();
    settleAttempt?.({ code: 130, reason: 'cancelled' });
    closing = (async () => { await rpc?.stop(); await adapter.close(); await bridge.close(); })();
    return closing;
  }
  await ready;
  return { url: bridge.url, token: bridge.token, done, close };
}

export async function runInteractiveCodex(file, executable, args, home, options = {}) {
  const session = await createInteractiveCodexSession(file, executable, args, home, options);
  if (!session) throw new Error('Unsupported interactive Codex invocation.');
  const spec = spawnSpec(executable, ['--remote', session.url, '--remote-auth-token-env', 'CCDECK_CODEX_ENGINE_TOKEN', ...args]);
  const child = spawn(spec.file, spec.args, { ...spec.opts, stdio: 'inherit', env: { ...(options.env ?? process.env), CODEX_HOME: home, CCDECK_CODEX_ENGINE_TOKEN: session.token } });
  let force;
  const stop = () => {
    killTree(child, 'SIGTERM');
    force ??= setTimeout(() => killTree(child, 'SIGKILL'), 2000);
    force.unref?.();
  };
  const hold = () => {}; // Ctrl+C belongs to the native TUI; it is not an engine retry.
  process.on('SIGINT', hold); process.on('SIGTERM', stop); process.on('SIGHUP', stop);
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code: code ?? (signal === 'SIGINT' ? 130 : 143), signal }));
    });
  } finally {
    clearTimeout(force);
    process.removeListener('SIGINT', hold); process.removeListener('SIGTERM', stop); process.removeListener('SIGHUP', stop);
    await session.close();
  }
}
