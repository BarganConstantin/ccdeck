// The native TUI stays attached to one local bridge. Only its owned app-server
// changes account after an explicit selection or terminal quota failure, once
// active tools have finished and the old backend has exited cleanly.
import { dirname } from 'node:path';
import { readCodexSelection } from './codex-selection.mjs';
import { captureSessionConfig, configHash, configText, isTrustOnlyConfig, isCustomCodexConfig } from './codex-engine-config.mjs';
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
const toolTypes = new Set(['commandExecution', 'mcpToolCall', 'dynamicToolCall', 'fileChange', 'collabAgentToolCall', 'subAgentActivity', 'webSearch', 'imageView', 'imageGeneration', 'sleep']);
const deferredMethods = new Set(['account/read', 'account/rateLimits/read', 'app/installed', 'app/read', 'plugin/list', 'skills/list', 'config/read', 'configRequirements/read', 'model/list', 'collaborationMode/list', 'command/exec']);

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
  const adapter = options.adapter ?? createCodexEngineAdapter(file, executable, ['exec', '--json'], home, { ...options, moveConversation: true });
  const controller = new AbortController();
  const clients = new Map(), serverRequests = new Set(), threads = new Map(), active = new Set(), processes = new Set(), tools = new Set();
  const deferredRequests = [];
  let rpc, bridge, initialize, settleAttempt, current, failedThread, frozen = false, automatic = true, closed = false;
  let authChanged = false, restoring = false, quotaFailure = null, deferredTurn = null, interrupted = false, engineFinished = false;
  let selectedThread = invocation.threadId, pendingManual = null, lastManualRevision = 0, manualTurn = false, manualInterrupt = false, switchingManual = false;
  const turnIds = new Map();
  const selectionOptions = { store: dirname(file), ...options };
  const readSelection = options.readSelection ?? (() => readCodexSelection(selectionOptions));
  let initialSelection;
  try { initialSelection = await readSelection(); lastManualRevision = initialSelection.runningSelection?.revision ?? 0; } catch { /* registry is checked on each poll */ }
  let inheritedConfig = null;
  // Isolated login homes start empty. Keep the original CLI's settings for
  // those sessions, regardless of which account was selected at launch.
  const original = initialSelection?.originalHome;
  const originalPath = original ? await realpath(original).catch(() => null) : null;
  if (originalPath && originalPath !== await realpath(home) && isTrustOnlyConfig(await configText(home))) {
    const text = await configText(original);
    if (text.trim() && !isCustomCodexConfig(text)) {
      const reader = startEngineRpc(executable, options.backendArgs ?? invocation.backendArgs, original, { env: options.env });
      try {
        await reader.request('initialize', { clientInfo: { name: 'ccdeck-config', version: '1' }, capabilities: { experimentalApi: true } });
        const captured = await captureSessionConfig(reader, original);
        if (captured) inheritedConfig = { ...captured, sourceHash: configHash(await configText(home)) };
      } finally { await reader.stop(); }
    }
  }
  const sendClient = message => bridge.send(message);
  const rejectClient = (message, text) => {
    if (message.id !== undefined && message.method) sendClient({ id: message.id, error: { code: -32000, message: text } });
  };
  function fromClient(message) {
    if (closed) return;
    if (frozen) {
      // These requests have not reached any backend. Hold startup/metadata
      // work once, so the native TUI does not show spurious handoff warnings.
      if (message.id !== undefined && deferredMethods.has(message.method) && deferredRequests.length < 32) {
        deferredRequests.push(clone(message)); return;
      }
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
    if (inheritedConfig && ['thread/start', 'thread/resume', 'thread/fork'].includes(message.method)) {
      message = { ...message, params: { ...message.params, config: { ...inheritedConfig.overrides, ...message.params?.config } } };
    }
    if (['turn/start', 'turn/interrupt', 'thread/start', 'thread/resume', 'thread/fork'].includes(message.method)) quotaFailure = null;
    if (message.method === 'turn/interrupt') { pendingManual = null; manualTurn = false; manualInterrupt = false; }
    if (message.method === 'turn/start' && threads.has(message.params?.threadId)
      && !threads.get(message.params.threadId).ephemeral) selectedThread = message.params.threadId;
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
        if (request.params.ephemeral !== true) selectedThread = thread.id;
        threads.set(thread.id, { ephemeral: request.params.ephemeral === true, resume: { ...pick(request.params, fields), ...(thread.cwd ? { cwd: thread.cwd } : {}) }, turn: {}, ...(inheritedConfig ? { sessionConfig: inheritedConfig } : {}) });
      }
    }
    if (message.method && message.id !== undefined) serverRequests.add(message.id);
    const p = message.params;
    if (message.method === 'process/exited') processes.delete(p?.processHandle);
    if (message.method === 'item/started' && toolTypes.has(p?.item?.type)) tools.add(p.item.id);
    if (message.method === 'item/completed' && p?.item?.status !== 'inProgress') tools.delete(p?.item?.id);
    if (message.method === 'turn/started') { active.add(p?.threadId); turnIds.set(p?.threadId, p?.turn?.id); }
    if (message.method === 'turn/completed') {
      active.delete(p?.threadId); turnIds.delete(p?.threadId);
      if (manualInterrupt && p?.threadId === selectedThread) manualTurn = p.turn.status === 'interrupted'
        || p.turn.error?.codexErrorInfo === 'usageLimitExceeded';
    }
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
    maybeManual();
    maybeFailover();
  }
  function maybeManual() {
    if (!pendingManual || closed || frozen || restoring || authChanged || !initialize || !selectedThread
      || !threads.has(selectedThread) || threads.get(selectedThread).ephemeral || clients.size || serverRequests.size || tools.size || processes.size) return;
    if ([...active].some(id => id !== selectedThread)) return;
    if (pendingManual.id === current.id) { pendingManual = null; return; }
    if (engineFinished) { engineFinished = false; drive(current); }
    if (active.has(selectedThread)) {
      if (!manualInterrupt) {
        manualInterrupt = true; manualTurn = false;
        rpc.request('turn/interrupt', { threadId: selectedThread, turnId: turnIds.get(selectedThread) }).catch(() => { pendingManual = null; manualInterrupt = false; });
      }
      return;
    }
    const intent = pendingManual; pendingManual = null; manualInterrupt = false;
    beginHandoff(selectedThread, { reason: 'manual_switch', targetId: intent.id }, manualTurn);
    manualTurn = false;
  }
  function maybeFailover() {
    if (engineFinished || !quotaFailure || restoring || frozen || authChanged || active.size || tools.size || processes.size || clients.size || serverRequests.size || !initialize) return;
    const threadId = quotaFailure.threadId; quotaFailure = null;
    beginHandoff(threadId, { reason: 'usage_limit' }, true);
  }
  function beginHandoff(threadId, outcome, continueTask) {
    failedThread = threadId;
    frozen = true; automatic = continueTask; interrupted = false;
    switchingManual = outcome.reason === 'manual_switch';
    options.onState?.({ state: 'switching', trigger: switchingManual ? 'manual' : 'quota', targetId: outcome.targetId });
    const owner = rpc;
    (async () => {
      const saved = threads.get(threadId);
      const captured = await captureSessionConfig(owner, current.home, saved.resume.cwd);
      // config/read is backend-wide. A later backend's defaults must not
      // replace the original thread settings we already carried over.
      saved.sessionConfig = saved.sessionConfig && captured
        ? { ...saved.sessionConfig, sourceHash: captured.sourceHash } : captured;
      const clean = await owner.stop();
      if (!closed) settleAttempt?.({ code: 1, threadId, ...outcome, ...(!clean ? { reason: 'failed' } : {}) });
    })().catch(async () => {
      // Even a failed configuration read must drain the old backend before
      // restoring it. Two writers must never own the same rollout.
      const clean = await owner.stop();
      if (!closed) settleAttempt?.({ code: 1, reason: clean ? 'handoff_failed' : 'failed' });
    });
  }
  function start(home) {
    return (options.startRpc ?? startEngineRpc)(executable, options.backendArgs ?? invocation.backendArgs, home, {
      ...options, onMessage: fromServer,
      onClose: () => { options.onState?.({ state: 'backend-closed' }); if (!frozen && !closed) settleAttempt?.({ code: 1, reason: 'failed' }); },
    });
  }
  async function reconnect(next, continueTask) {
    rpc = start(next.home);
    await rpc.request('initialize', initialize);
    rpc.send({ method: 'initialized', params: {} });
    const saved = threads.get(failedThread);
    if (!saved) throw new Error('Codex conversation ownership is unknown.');
    const resumed = await rpc.request('thread/resume', { ...saved.resume, ...(saved.sessionConfig ? { config: { ...saved.sessionConfig.overrides, ...saved.resume.config } } : {}), threadId: failedThread, excludeTurns: true });
    if (resumed?.thread?.id !== failedThread) throw new Error('Codex resumed a different conversation.');
    frozen = false;
    selectedThread = failedThread;
    options.onState?.({ state: 'resumed', automatic: continueTask && automatic, accountId: next.id });
    for (const request of deferredRequests.splice(0)) fromClient(request);
    if (deferredTurn) {
      const queued = deferredTurn; deferredTurn = null;
      if (continueTask && !interrupted && !controller.signal.aborted) fromClient(queued);
      else rejectClient(queued, 'Automatic continuation stopped. Please submit your message again.');
    } else if (continueTask && automatic && !interrupted && !controller.signal.aborted) {
      // One submission only. A timeout is ambiguous and is never resubmitted.
      await rpc.request('turn/start', { ...saved.turn, threadId: failedThread, clientUserMessageId: randomUUID(), input: [{ type: 'text', text: continuation }] });
    }
  }
  bridge = await createCodexEngineBridge({ onMessage: fromClient, onDisconnect: () => { options.onState?.({ state: 'client-disconnected' }); void close(); } });
  const initial = { id: createHash('sha256').update(await realpath(home)).digest('hex').slice(0, 20), home, threadId: invocation.threadId };
  // A selection committed between launcher resolution and engine startup
  // still belongs to this launch, rather than being mistaken for an old event.
  if (initialSelection?.profileId === initialSelection?.runningSelection?.id
    && initialSelection?.runningSelection && initialSelection.profileId !== initial.id) pendingManual = initialSelection.runningSelection;
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const provider = {
    ...adapter,
    prepare(params) { return adapter.prepare({ ...params, sessionConfig: threads.get(params.threadId)?.sessionConfig }); },
    run(next) {
      current = next;
      return new Promise((resolveAttempt, reject) => {
        settleAttempt = resolveAttempt;
        if (controller.signal.aborted) { resolveAttempt({ code: 130, reason: 'cancelled' }); return; }
        if (!rpc) { rpc = start(next.home); readyResolve(); }
        else if (frozen) reconnect(next, true).catch(reject);
      });
    },
  };
  let done;
  function drive(startAt) {
    done = runAccountEngine(provider, startAt, { signal: controller.signal }).then(async result => {
      engineFinished = true;
      if (!closed && frozen && failedThread) {
        restoring = true;
        try { await reconnect(current, false); } catch { await close(); }
        restoring = false;
      }
      if (!closed && !frozen && result.reason === 'failed') await close();
      return result;
    }).catch(async () => { engineFinished = true; readyReject(new Error('Codex app-server could not start.')); await close(); return { code: 1, reason: 'failed' }; });
    return done;
  }
  drive(initial);
  let checking = false;
  const poll = setInterval(async () => {
    if (checking || closed) return;
    checking = true;
    try {
      const s = await readSelection(), intent = s.runningSelection;
      if (intent && intent.revision > lastManualRevision) {
        lastManualRevision = intent.revision;
        pendingManual = intent;
        options.onState?.({ state: 'manual-requested', targetId: intent.id });
      }
      maybeManual();
    } catch { /* unavailable metadata never authorizes a switch */ }
    finally { checking = false; }
  }, options.manualPollMs ?? 500);
  poll.unref();
  let closing;
  async function close() {
    if (closing) return closing;
    closed = true; clearInterval(poll); controller.abort();
    settleAttempt?.({ code: 130, reason: 'cancelled' });
    closing = (async () => { await rpc?.stop(); await adapter.close(); await bridge.close(); })();
    return closing;
  }
  await ready;
  return { url: bridge.url, token: bridge.token, tuiHome: inheritedConfig ? original : home, get done() { return done; }, close };
}

export async function runInteractiveCodex(file, executable, args, home, options = {}) {
  const session = await createInteractiveCodexSession(file, executable, args, home, options);
  if (!session) throw new Error('Unsupported interactive Codex invocation.');
  const spec = spawnSpec(executable, ['--remote', session.url, '--remote-auth-token-env', 'CCDECK_CODEX_ENGINE_TOKEN', ...args]);
  const child = spawn(spec.file, spec.args, { ...spec.opts, stdio: 'inherit', env: { ...(options.env ?? process.env), CODEX_HOME: session.tuiHome, CCDECK_CODEX_ENGINE_TOKEN: session.token } });
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
