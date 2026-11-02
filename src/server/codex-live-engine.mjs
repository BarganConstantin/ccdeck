// The shared daemon retains its threads, tools and current stream. Native Codex
// applies its new authentication to the next model request in those threads.
import { readFile, mkdir, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { deckDataDir } from './deck-home.mjs';
import { writeFileAtomic } from './atomic-write.mjs';
import { readCodexSelection } from './codex-selection.mjs';
import { readCodexAuto } from './codex-auto.mjs';
import { resolveCodexLiveEndpoint, connectCodexLiveRpc, liveError } from './codex-live-rpc.mjs';
import { acquireCodexLiveLease } from './codex-live-lease.mjs';
import { readLiveCodexCredential } from './codex-live-credentials.mjs';

const idPattern = /^[a-f0-9]{20}$/;
const publicReason = e => /^[a-z_]{1,64}$/.test(e?.code ?? '') ? e.code : 'live_switch_failed';
const sameAccount = (account, credential) => account?.type === 'chatgpt'
  && typeof account.email === 'string' && account.email.toLowerCase() === credential.email.toLowerCase();
const endpointKey = endpoint => createHash('sha256').update(endpoint.generation).digest('hex');

export function createCodexLiveAccountController(input = {}) {
  const options = { ...input, env: { ...(input.env ?? process.env) } };
  const store = resolve(options.store ?? deckDataDir(undefined, options.env));
  const metadata = join(store, 'codex-live-account.json');
  const selection = options.readSelection ?? (() => readCodexSelection({ ...options, store }));
  const credentialFor = options.readCredential ?? ((id, extra) => readLiveCodexCredential(id, { ...options, ...extra, store }));
  const resolveEndpoint = options.resolveEndpoint ?? (home => resolveCodexLiveEndpoint(home, options));
  const connect = options.connectRpc ?? ((ep, callbacks) => connectCodexLiveRpc(ep, callbacks));
  let state = { state: 'idle', profileId: null, requestedProfileId: null, reason: null };
  let rpc = null, endpoint = null, lease = null, credential = null, desired = null, appliedIntent = null;
  let owned = false, applying = false, refreshing = false, closed = false, ticking = false;
  let lastManual = 0, lastSelected = null, lastCheck = 0, lastRefresh = 0;
  let chain = Promise.resolve(), pendingKey = '', pendingSwitch = null;
  let restorePending = null, restoreRetryAt = 0;
  const status = () => ({ ...state, scope: 'shared_native_server' });
  const update = patch => { state = { ...state, ...patch }; options.onState?.(status()); };
  const enqueue = fn => { const next = chain.then(fn, fn); chain = next.catch(() => {}); return next; };
  const save = async () => {
    if (!endpoint || !desired) return;
    const data = { version: 1, wasControlling: owned, profileId: credential?.profileId ?? null,
      revision: appliedIntent?.revision ?? desired.revision, endpoint: endpointKey(endpoint) };
    if (options.persistState) return options.persistState(data);
    await mkdir(store, { recursive: true, mode: 0o700 });
    await writeFileAtomic(metadata, JSON.stringify(data) + '\n'); await chmod(metadata, 0o600);
  };
  async function disconnect() {
    rpc?.close(); rpc = null; await lease?.release(); lease = null;
  }
  async function verifyAccount() {
    if (!owned || !rpc || !credential || closed) return;
    const actual = await rpc.request('account/read', { refreshToken: false });
    if (!sameAccount(actual.account, credential)) await externalChange();
  }
  async function externalChange() {
    if (!owned || closed) return;
    owned = false; credential = null;
    update({ state: 'external_change', profileId: null, reason: 'account_changed_outside_deck' });
    await save().catch(() => {});
    await disconnect();
  }
  async function serverRequest(message) {
    if (message.method !== 'account/chatgptAuthTokens/refresh' || !owned || !credential || closed) return;
    const owner = rpc, previous = credential.accountId;
    if (message.params?.previousAccountId && message.params.previousAccountId !== previous) return;
    // Refreshes and logins share one queue. No asynchronous refresh of A may
    // supply A's credentials after a queued selection has committed B.
    return enqueue(async () => {
      if (owner !== rpc || !owned || closed) return;
      if (credential.accountId !== previous) {
        owner.send({ id: message.id, error: { code: -32000, message: 'Codex account changed during renewal.' } });
        return;
      }
      refreshing = true;
      try {
        const next = await credentialFor(credential.profileId, { refresh: true });
        if (closed || owner !== rpc) return;
        if (next.accountId !== previous) throw liveError('profile_changed');
        credential = next; lastRefresh = Date.now();
        owner.send({ id: message.id, result: { accessToken: next.accessToken, chatgptAccountId: next.accountId, chatgptPlanType: next.planType } });
      } catch {
        // Never return paths, token values or provider error text on the wire.
        try { owner.send({ id: message.id, error: { code: -32000, message: 'Selected Codex login could not be renewed.' } }); } catch { /* connection ended */ }
        update({ state: 'failed', reason: 'credential_refresh_failed' });
      } finally { refreshing = false; }
    });
  }
  async function ensureRpc(originalHome) {
    if (rpc) return;
    const next = await resolveEndpoint(originalHome);
    if (!lease) lease = await (options.acquireLease ?? acquireCodexLiveLease)(next.home, options);
    if (!await lease.valid()) throw liveError('native_control_lost');
    endpoint = next;
    rpc = await connect(next, {
      onRequest: serverRequest,
      onNotification: m => {
        if (m.method === 'account/updated' && !applying) void enqueue(verifyAccount).catch(() => {});
      },
      onClose: () => { rpc = null; if (!closed && owned) update({ state: 'disconnected', reason: 'native_disconnected' }); },
    });
    const account = await rpc.request('account/read', { refreshToken: false });
    if (account.account && account.account.type !== 'chatgpt') { rpc.close(); rpc = null; owned = false; throw liveError('unsupported_auth_mode'); }
  }
  async function loginCredential(id, refresh = false) {
    let next;
    try { next = await credentialFor(id, { refresh }); }
    catch (error) {
      if (refresh || error?.code !== 'credential_expired') throw error;
      next = await credentialFor(id, { refresh: true }); refresh = true;
    }
    // Renew before submitting; a callback cannot wait on its own login queue.
    if (next.expiresAt - Date.now() < 60_000 && !refresh) next = await credentialFor(id, { refresh: true });
    if (next.expiresAt - Date.now() < 60_000) throw liveError('credential_expiring');
    if (next.profileId !== id) throw liveError('profile_changed');
    return next;
  }
  async function apply(intent, refresh = false) {
    const currentIntent = () => refresh ? appliedIntent : desired;
    if (closed || currentIntent()?.revision !== intent.revision || currentIntent().id !== intent.id) return status();
    update({ state: 'switching', requestedProfileId: intent.id, reason: null });
    let maybeApplied = false;
    try {
      const s = await selection();
      if (!s.profiles?.some(p => p.id === intent.id && p.available !== false)) throw liveError('profile_unavailable');
      await ensureRpc(s.originalHome);
      const next = await loginCredential(intent.id, refresh);
      if (closed || currentIntent()?.revision !== intent.revision || currentIntent().id !== intent.id) return status();
      if (!await lease.valid()) throw liveError('native_control_lost');
      applying = true;
      // Authentication crosses only this owner-validated local socket. Codex
      // stores external tokens in memory, not either profile's credential file.
      maybeApplied = true;
      const result = await rpc.request('account/login/start', { type: 'chatgptAuthTokens', accessToken: next.accessToken,
        chatgptAccountId: next.accountId, chatgptPlanType: next.planType });
      if (result?.type !== 'chatgptAuthTokens') throw liveError('unsupported_protocol');
      const account = await rpc.request('account/read', { refreshToken: false });
      if (!sameAccount(account.account, next)) throw liveError('native_identity_mismatch');
      credential = next; appliedIntent = { ...intent }; owned = true; lastRefresh = Date.now(); lastCheck = Date.now();
      update({ state: 'applied', profileId: intent.id, requestedProfileId: intent.id, reason: null });
      // The daemon has acknowledged this login. Keep renewal ownership even
      // if local metadata cannot be saved; losing it would strand live auth.
      await save().catch(() => update({ reason: 'ownership_not_saved' }));
    } catch (error) {
      if (maybeApplied) { credential = null; owned = false; }
      const reason = publicReason(error);
      update({ state: ['native_not_running', 'cli_unavailable'].includes(reason) ? 'unavailable' : 'failed',
        ...(maybeApplied ? { profileId: null } : {}), reason });
      if (!owned) await disconnect();
    } finally { applying = false; }
    return status();
  }
  async function request(intent) {
    await ready;
    if (closed) return status();
    if (!idPattern.test(intent?.id ?? '') || !Number.isSafeInteger(intent.revision) || intent.revision < 1) throw liveError('invalid_selection');
    const key = `${intent.revision}:${intent.id}`;
    if (pendingKey === key && pendingSwitch) return pendingSwitch;
    if (desired && intent.revision < desired.revision) return status();
    restorePending = null;
    desired = { id: intent.id, revision: intent.revision };
    pendingKey = key;
    pendingSwitch = enqueue(() => apply(intent));
    return pendingSwitch;
  }
  async function restorePrevious(saved, intent, actual) {
    restorePending = null;
    const previous = await loginCredential(saved.profileId);
    if (endpointKey(endpoint) === saved.endpoint && sameAccount(actual.account, previous)) {
      credential = previous; appliedIntent = { id: saved.profileId, revision: saved.revision }; owned = true;
      lastCheck = Date.now(); lastRefresh = Date.now();
      update({ state: 'failed', profileId: saved.profileId, requestedProfileId: intent.id, reason: 'native_login_unconfirmed' });
    } else {
      update({ state: 'external_change', reason: 'account_changed_outside_deck' }); await disconnect();
    }
  }
  async function restore(saved) {
    if (closed || restorePending !== saved) return;
    try {
      const s = await selection();
      if (saved?.version !== 1 || saved.wasControlling !== true || !idPattern.test(saved.profileId ?? '')
        || !Number.isSafeInteger(saved.revision) || saved.revision < 1 || saved.revision > s.revision
        || !s.profiles?.some(p => p.id === saved.profileId && p.available !== false)) {
        restorePending = null; return;
      }
      let intent = { id: saved.profileId, revision: saved.revision };
      if (s.runningSelection?.revision > intent.revision) intent = { ...s.runningSelection };
      if (s.profileId !== intent.id && s.revision > intent.revision) {
        const auto = await (options.readAuto ?? (() => readCodexAuto({ ...options, store })))();
        if (auto.enabled) intent = { id: s.profileId, revision: s.revision };
      }
      if (closed || restorePending !== saved) return;
      desired = intent;
      await ensureRpc(s.originalHome);
      const actual = await rpc.request('account/read', { refreshToken: false });
      let next;
      try { next = await loginCredential(intent.id); }
      catch (error) {
        if (intent.revision <= saved.revision) throw error;
        await restorePrevious(saved, intent, actual); return;
      }
      if (closed || restorePending !== saved) return;
      if (intent.revision > saved.revision && !sameAccount(actual.account, next)) {
        // The newer request has no persisted acknowledgement. It may have
        // timed out after sending: reconcile it, never replay it on restart.
        await restorePrevious(saved, intent, actual); return;
      }
      if (intent.revision === saved.revision && endpointKey(endpoint) === saved.endpoint && !sameAccount(actual.account, next)) {
        update({ state: 'external_change', reason: 'account_changed_outside_deck' });
        restorePending = null;
        await save().catch(() => {}); await disconnect(); return;
      }
      if (sameAccount(actual.account, next) && (endpointKey(endpoint) === saved.endpoint || intent.revision > saved.revision)) {
        // Adopt the surviving login without another account-change notification.
        credential = next; appliedIntent = { ...intent }; owned = true;
        lastCheck = Date.now(); lastRefresh = Date.now();
        update({ state: 'applied', profileId: intent.id, requestedProfileId: intent.id, reason: null });
        await save().catch(() => update({ reason: 'ownership_not_saved' }));
        restorePending = null; return;
      }
      // Only discovery is retried. An ambiguous native login must not replay.
      restorePending = null; await apply(intent);
    } catch (error) {
      if (!owned) await disconnect();
      const reason = publicReason(error);
      const retry = ['native_not_running', 'cli_unavailable', 'native_unavailable', 'native_connection_failed', 'native_disconnected', 'native_control_busy'].includes(reason);
      update({ state: retry ? 'unavailable' : 'failed', reason });
      if (!retry) restorePending = null;
      restoreRetryAt = Date.now() + (options.restoreRetryMs ?? 5000);
    }
  }
  const ready = (async () => {
    try {
      const s = await selection(); lastManual = s.runningSelection?.revision ?? 0; lastSelected = s.profileId;
      restorePending = options.loadState ? await options.loadState() : JSON.parse(await readFile(metadata, 'utf8'));
      if (restorePending) await enqueue(() => restore(restorePending));
    } catch { /* No prior ownership means no native authentication mutation. */ }
  })();
  async function reconnect() {
    const generation = endpoint?.generation;
    const s = await selection(); await ensureRpc(s.originalHome);
    const actual = await rpc.request('account/read', { refreshToken: false });
    if (sameAccount(actual.account, credential)) {
      lastCheck = Date.now(); update({ state: 'applied', profileId: credential.profileId, reason: null });
    } else if (endpoint.generation === generation) await externalChange();
    else await apply(appliedIntent, true);
  }
  async function tick() {
    if (closed || ticking) return;
    ticking = true;
    try {
      await ready;
      const s = await selection();
      if (s.runningSelection && s.runningSelection.revision > lastManual) {
        lastManual = s.runningSelection.revision; await request(s.runningSelection);
      } else if (s.profileId !== lastSelected) {
        const auto = await (options.readAuto ?? (() => readCodexAuto({ ...options, store })))();
        if (auto.enabled) await request({ id: s.profileId, revision: s.revision });
      }
      lastSelected = s.profileId;
      if (restorePending && Date.now() >= restoreRetryAt) await enqueue(() => restore(restorePending));
      if (owned && !rpc && appliedIntent) await enqueue(reconnect);
      if (owned && credential && appliedIntent && Date.now() - lastRefresh > 60_000 && credential.expiresAt - Date.now() < 10 * 60_000) {
        lastRefresh = Date.now(); await enqueue(() => apply(appliedIntent, true));
      }
      if (owned && rpc && credential && Date.now() - lastCheck > 30_000) {
        lastCheck = Date.now();
        await enqueue(verifyAccount);
      }
    } catch { /* Temporary discovery failure never authorizes an account change. */ }
    finally { ticking = false; }
  }
  const timer = setInterval(() => { void tick(); }, options.pollMs ?? 1000); timer.unref();
  return { ready, status, request, tick,
    async close() { closed = true; clearInterval(timer); await ready; await chain.catch(() => {}); credential = null; await disconnect(); },
  };
}

const controllers = new Map();
const keyFor = options => resolve(options.store ?? deckDataDir(undefined, options.env));
export function startCodexLiveAccounts(options = {}) {
  const key = keyFor(options);
  if (!controllers.has(key)) {
    const disabled = (options.env ?? process.env).AGENTS_DECK_NO_CODEX_LIVE === '1';
    const idle = () => ({ state: 'disabled', profileId: null });
    controllers.set(key, disabled ? { ready: Promise.resolve(), status: idle, request: async () => idle(), close: async () => {} }
      : createCodexLiveAccountController({ ...options, store: key }));
  }
  return controllers.get(key);
}
export function codexLiveAccountStatus(options = {}) { return controllers.get(keyFor(options))?.status() ?? { state: 'idle', profileId: null }; }
export async function requestCodexLiveAccount(intent, options = {}) { return startCodexLiveAccounts(options).request(intent); }
export async function stopCodexLiveAccounts(options = {}) { const key = keyFor(options), c = controllers.get(key); controllers.delete(key); await c?.close(); }
