// The shared daemon retains its threads. Active responses use a controlled
// interrupt/login/continue handoff so auth cannot revoke an in-flight stream.
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
import { prepareCodexLiveHandoff, assertCodexLiveQuiet, continueCodexLiveHandoff, confirmCodexLiveChildren, readCodexLiveTurn, retainCodexLiveHandoff } from './codex-live-handoff.mjs';
import { requestCodexLiveCheckpoints, inspectCodexLiveCheckpoints } from './codex-live-checkpoint.mjs';

const idPattern = /^[a-f0-9]{20}$/;
const publicReason = e => /^[a-z_]{1,64}$/.test(e?.code ?? '') ? e.code : 'live_switch_failed';
// 0.166's Account has no workspace ID. Its experimental response may expose
// workspaceRouting.chatgptAccountId; honor account-level IDs too if supplied.
// Labels are display data and never attest workspace equality across a gap.
const accountIds = snapshot => [snapshot?.account?.accountId, snapshot?.account?.id,
  snapshot?.workspaceRouting?.chatgptAccountId].filter(id => id != null);
const sameAccount = (snapshot, credential, attest = false) => snapshot?.account?.type === 'chatgpt'
  && typeof snapshot.account.email === 'string' && snapshot.account.email.toLowerCase() === credential.email.toLowerCase()
  && (!attest || accountIds(snapshot).length > 0)
  && accountIds(snapshot).every(id => typeof id === 'string' && id === credential.accountId);
const sameNativeAccount = (a, b) => a?.account?.type === b?.account?.type
  && a?.account?.email === b?.account?.email && a?.account?.workspaceName === b?.account?.workspaceName
  && accountIds(a).length === accountIds(b).length
  && accountIds(a).every((id, i) => id === accountIds(b)[i]);
const endpointKey = endpoint => createHash('sha256').update(endpoint.generation).digest('hex');

export function createCodexLiveAccountController(input = {}) {
  const options = { ...input, env: { ...(input.env ?? process.env) } };
  const store = resolve(options.store ?? deckDataDir(undefined, options.env));
  const metadata = join(store, 'codex-live-account.json');
  const selection = options.readSelection ?? (() => readCodexSelection({ ...options, store }));
  const credentialFor = options.readCredential ?? ((id, extra) => readLiveCodexCredential(id, { ...options, ...extra, store }));
  const resolveEndpoint = options.resolveEndpoint ?? (home => resolveCodexLiveEndpoint(home, options));
  const connect = options.connectRpc ?? ((ep, callbacks) => connectCodexLiveRpc(ep, callbacks));
  let state = { state: 'idle', profileId: null, requestedProfileId: null, reason: null, continuation: 'none' };
  let rpc = null, endpoint = null, lease = null, credential = null, desired = null, appliedIntent = null;
  let owned = false, closed = false, ticking = false;
  let ownershipEpoch = 0, connectionSerial = 0, ownershipPaused = false, pendingLogin = null;
  let lastManual = 0, lastSelected = null, lastCheck = 0, lastRefresh = 0;
  let chain = Promise.resolve(), pendingKey = '', pendingSwitch = null;
  let restorePending = null, restoreRetryAt = 0;
  let deferred = null;
  let childContinuation = null;
  let checkpointWork = null;
  let releaseSubscriptions = null;
  let recoveryNeeded = false;
  let recoveryJournal = null;
  const defer = (intent, refresh, automatic) => {
    if (!refresh || !deferred || deferred.refresh) deferred = { intent: { ...intent }, refresh, automatic };
  };
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
  const saveHandoff = async data => {
    if (options.persistHandoff) return options.persistHandoff(data);
    await mkdir(store, { recursive: true, mode: 0o700 });
    const file = join(store, 'codex-live-handoff.json');
    await writeFileAtomic(file, JSON.stringify(data) + '\n'); await chmod(file, 0o600);
  };
  async function releaseHandoff() {
    const release = releaseSubscriptions; releaseSubscriptions = null; await release?.();
  }
  async function disconnect() {
    await releaseHandoff();
    connectionSerial++; rpc?.close(); rpc = null; await lease?.release(); lease = null;
  }
  async function verifyAccount() {
    if (!owned || !rpc || !credential || closed) return;
    const actual = await rpc.request('account/read', { refreshToken: false });
    if (!sameAccount(actual, credential)) await externalChange();
  }
  async function externalChange(reason = 'account_changed_outside_deck') {
    if (closed) return;
    ownershipPaused = true;
    owned = false; credential = null; deferred = null;
    update({ state: 'external_change', profileId: null, reason,
      ...(childContinuation || checkpointWork ? { continuation: 'manual_required' } : {}) });
    if (childContinuation || checkpointWork) {
      recoveryNeeded = true; recoveryJournal = childContinuation?.journal ?? checkpointWork?.journal;
    }
    childContinuation = null;
    checkpointWork = null;
    await save().catch(() => {});
    await disconnect();
  }
  function invalidateOwnership(reason = 'account_changed_outside_deck') {
    // Invalidate synchronously: queued cleanup cannot authorize an in-flight
    // credential read, checkpoint, login or continuation to finish first.
    ownershipEpoch++; ownershipPaused = true; deferred = null;
    pendingLogin?.reject(liveError(reason));
    void enqueue(() => externalChange(reason)).catch(() => {});
  }
  function accountNotification(message) {
    const login = pendingLogin;
    if (login && !login.acknowledged && ['account/login/completed', 'account/updated'].includes(message.method)) {
      invalidateOwnership(); return;
    }
    if (message.method === 'account/login/completed') {
      if (login && !login.completed && message.params?.loginId === null && message.params?.success === true) login.completed = true;
      else invalidateOwnership();
    } else if (message.method === 'account/updated') {
      // Native external-token login sends its RPC result, then login/completed,
      // then updated (account_processor.rs, rust-v0.166.0). Consume only that
      // one ordered pair. An in-flight operation alone cannot identify its update.
      if (login && login.completed && !login.updated && message.params?.authMode === 'chatgptAuthTokens'
        && (login.planType == null || message.params?.planType === login.planType)) {
        login.updated = true; login.resolve();
      } else invalidateOwnership();
    }
  }
  function expectLoginNotifications(next) {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    promise.catch(() => {}); // A rejected login RPC may end before this waiter.
    const timer = setTimeout(() => reject(liveError('native_login_unconfirmed')),
      options.loginNotificationTimeoutMs ?? 30_000);
    const login = { planType: next.planType, acknowledged: false, completed: false, updated: false, promise, resolve, reject,
      close() { clearTimeout(timer); if (pendingLogin === login) pendingLogin = null; } };
    pendingLogin = login;
    return login;
  }
  async function serverRequest(message) {
    if (message.method !== 'account/chatgptAuthTokens/refresh' || !owned || !credential || closed || ownershipPaused) return;
    const owner = rpc, previous = credential.accountId, epoch = ownershipEpoch;
    if (message.params?.previousAccountId && message.params.previousAccountId !== previous) return;
    // Refreshes and logins share one queue. No asynchronous refresh of A may
    // supply A's credentials after a queued selection has committed B.
    return enqueue(async () => {
      if (owner !== rpc || !owned || closed || ownershipPaused || epoch !== ownershipEpoch) return;
      if (credential.accountId !== previous) {
        owner.send({ id: message.id, error: { code: -32000, message: 'Codex account changed during renewal.' } });
        return;
      }
      try {
        if (!await lease?.valid()) throw liveError('native_control_lost');
        if (owner !== rpc || !owned || closed || ownershipPaused || epoch !== ownershipEpoch) return;
        const next = await credentialFor(credential.profileId, { refresh: true });
        if (closed || owner !== rpc || !owned || ownershipPaused || epoch !== ownershipEpoch) return;
        if (next.accountId !== previous) throw liveError('profile_changed');
        const actual = await owner.request('account/read', { refreshToken: false });
        if (closed || owner !== rpc || ownershipPaused || epoch !== ownershipEpoch) return;
        if (!sameAccount(actual, next)) { await externalChange(); return; }
        // A profile can be removed after its credential read has finished.
        // Do not keep renewing a login whose row/home is no longer available.
        const latest = await selection();
        if (!latest.profiles?.some(p => p.id === credential.profileId && p.available !== false)) throw liveError('profile_unavailable');
        if (!await lease?.valid()) throw liveError('native_control_lost');
        if (closed || owner !== rpc || !owned || ownershipPaused || epoch !== ownershipEpoch) return;
        // ExternalAuthBridge::refresh returns the auth directly; it does not
        // emit account/updated. Do not leave a notification-suppression window.
        credential = next; lastRefresh = Date.now();
        owner.send({ id: message.id, result: { accessToken: next.accessToken, chatgptAccountId: next.accountId, chatgptPlanType: next.planType } });
      } catch (error) {
        if (closed || owner !== rpc || !owned || ownershipPaused || epoch !== ownershipEpoch) return;
        // Never return paths, token values or provider error text on the wire.
        try { owner.send({ id: message.id, error: { code: -32000, message: 'Selected Codex login could not be renewed.' } }); } catch { /* connection ended */ }
        if (['native_control_lost', 'profile_unavailable'].includes(error?.code)) await externalChange(error.code);
        else update({ state: 'failed', reason: 'credential_refresh_failed' });
      }
    });
  }
  async function ensureRpc(originalHome) {
    if (rpc) return;
    const next = await resolveEndpoint(originalHome);
    if (!lease) lease = await (options.acquireLease ?? acquireCodexLiveLease)(next.home, options);
    if (!await lease.valid()) throw liveError('native_control_lost');
    endpoint = next;
    const serial = ++connectionSerial;
    let readingInitialAccount = true;
    let initialUpdate = false, resolveInitialUpdate;
    const initialAccountReady = new Promise(resolve => { resolveInitialUpdate = resolve; });
    rpc = await connect(next, {
      onRequest: m => serial === connectionSerial ? serverRequest(m) : undefined,
      onNotification: m => {
        // New connections receive an account/updated routing snapshot even
        // when no login changed. Establish the account baseline first; restore
        // and reconnect still attest its native IDs before reclaiming control.
        if (!closed && serial === connectionSerial && readingInitialAccount && !initialUpdate && m.method === 'account/updated') {
          initialUpdate = true; resolveInitialUpdate(); return;
        }
        const observe = () => { if (!closed && serial === connectionSerial) accountNotification(m); };
        // A WebSocket read can contain the result and both notifications. Let
        // its already-resolved RPC continuation mark the acknowledgement first,
        // preserving wire order without accepting notifications before a result.
        if (pendingLogin) queueMicrotask(observe); else observe();
      },
      onClose: () => {
        if (serial !== connectionSerial) return;
        ownershipEpoch++; pendingLogin?.reject(liveError('native_disconnected'));
        rpc = null; if (!closed && owned) update({ state: 'disconnected', reason: 'native_disconnected' });
      },
    });
    let account;
    try {
      account = await rpc.request('account/read', { refreshToken: false });
      // Routing discovery notifies each initialized connection asynchronously,
      // including after account/read has answered. Do not mistake that delayed
      // snapshot for an outside login, or claim ownership before it arrives.
      if (account.workspaceRouting && !initialUpdate) {
        let timeout;
        try {
          await Promise.race([initialAccountReady, new Promise((_, reject) => {
            timeout = setTimeout(() => reject(liveError('native_initial_account_unconfirmed')),
              options.initialAccountTimeoutMs ?? 30_000);
          })]);
        } finally { clearTimeout(timeout); }
        account = await rpc.request('account/read', { refreshToken: false });
      }
    } catch (error) {
      // Manual switches and renewals can also create this connection while
      // retaining a previous login. Never retain an unattested bootstrap.
      await disconnect();
      throw error;
    } finally { readingInitialAccount = false; }
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
  async function applyCore(intent, refresh = false, automatic = false, checkpoint = null) {
    const epoch = ownershipEpoch;
    const currentIntent = () => refresh ? appliedIntent : desired;
    if (closed || ownershipPaused || currentIntent()?.revision !== intent.revision || currentIntent().id !== intent.id) return status();
    if (recoveryNeeded) {
      update({ state: 'failed', requestedProfileId: intent.id, continuation: 'manual_required', reason: 'native_continue_unconfirmed' }); return status();
    }
    if (childContinuation || checkpointWork) {
      defer(intent, refresh, automatic);
      update({ state: 'waiting', requestedProfileId: intent.id,
        reason: childContinuation?.expired ? 'native_continue_unconfirmed' : 'native_tools_active',
        continuation: childContinuation?.expired ? 'manual_required' : 'waiting' }); return status();
    }
    if (automatic && !(await (options.readAuto ?? (() => readCodexAuto({ ...options, store })))()).enabled) {
      update({ state: owned ? 'applied' : 'idle', reason: 'auto_switch_disabled', continuation: 'none' }); return status();
    }
    update({ state: 'switching', requestedProfileId: intent.id, reason: null, continuation: 'none' });
    let maybeApplied = false, handoff = null, resumeIdentity = null;
    const journal = checkpoint?.journal ?? { version: 1, phase: 'paused', profileId: intent.id, revision: intent.revision, entries: [] };
    const record = async (entry, phase, turnId) => {
      if (!journal.entries.some(e => e.messageId === entry.messageId)) journal.entries.push(entry);
      Object.assign(entry, { phase, ...(turnId ? { continuedTurnId: turnId } : {}) });
      journal.phase = journal.entries.every(e => ['continued', 'skipped'].includes(e.phase)) ? 'finished' : 'pending';
      await saveHandoff(journal);
    };
    const assertAutoEnabled = async () => {
      if (automatic && !(await (options.readAuto ?? (() => readCodexAuto({ ...options, store })))()).enabled) {
        throw liveError('auto_switch_disabled');
      }
    };
    const assertProfileAvailable = async () => {
      const latest = await selection();
      if (!latest.profiles?.some(p => p.id === intent.id && p.available !== false)) throw liveError('profile_unavailable');
    };
    const authCurrent = () => !closed && !ownershipPaused && epoch === ownershipEpoch;
    const owner = () => authCurrent() && currentIntent()?.revision === intent.revision && currentIntent()?.id === intent.id;
    const verifyOwnership = async () => {
      if (!await lease?.valid()) throw liveError('native_control_lost');
      const actual = await rpc.request('account/read', { refreshToken: false });
      if (!authCurrent() || !sameNativeAccount(actual, resumeIdentity)) throw liveError('account_changed_outside_deck');
    };
    const resume = async () => continueCodexLiveHandoff(rpc, handoff, {
      isCurrent: () => authCurrent() && !!rpc,
      beforeSend: async entry => {
        if (!await lease?.valid()) throw liveError('native_control_lost');
        const actual = await rpc.request('account/read', { refreshToken: false });
        if (!authCurrent() || !sameNativeAccount(actual, resumeIdentity)) throw liveError('account_changed_outside_deck');
        await record(entry, 'sent');
        if (!authCurrent()) throw liveError('account_changed_outside_deck');
      },
      afterSend: (entry, turnId) => record(entry, 'continued', turnId),
      onSkip: entry => record(entry, 'skipped'),
      onDelegate: entry => record(entry, 'delegated'),
    });
    try {
      const s = await selection();
      if (!s.profiles?.some(p => p.id === intent.id && p.available !== false)) throw liveError('profile_unavailable');
      await ensureRpc(s.originalHome);
      const next = await loginCredential(intent.id, refresh);
      await assertProfileAvailable();
      await assertAutoEnabled();
      if (!owner()) throw liveError('account_changed_outside_deck');
      if (!await lease.valid()) throw liveError('native_control_lost');
      const before = await rpc.request('account/read', { refreshToken: false });
      resumeIdentity = before;
      handoff = await prepareCodexLiveHandoff(rpc, { isCurrent: owner,
        beforeInterrupt: async entry => {
          await assertProfileAvailable();
          await assertAutoEnabled();
          if (!owner()) throw liveError('account_changed_outside_deck');
          await record(entry, 'interrupt_sent');
          if (!owner()) throw liveError('account_changed_outside_deck');
        }, afterInterrupt: (entry, phase) => record(entry, phase) });
      if (handoff.checkpoint) {
        if (checkpoint) handoff.checkpoint.unshift(...checkpoint.handoff.paused);
        const previousRelease = releaseSubscriptions;
        const release = await retainCodexLiveHandoff(rpc, handoff.checkpoint);
        releaseSubscriptions = async () => { await release(); await previousRelease?.(); };
        checkpointWork = { rpc, entries: handoff.checkpoint, intent: { ...intent }, refresh, automatic, journal, record,
          identity: resumeIdentity, deadline: Date.now() + (options.checkpointTimeoutMs ?? 120_000), current: owner };
        try { await requestCodexLiveCheckpoints(rpc, handoff.checkpoint, { record, beforeSend: verifyOwnership }); }
        catch (error) { checkpointWork = null; recoveryNeeded = true; recoveryJournal = journal; throw error; }
        update({ state: 'waiting', reason: 'native_tools_active', continuation: 'waiting' }); return status();
      }
      if (handoff.waiting) {
        if (checkpoint) {
          checkpointWork = checkpoint.work;
          update({ state: 'waiting', reason: 'native_tools_active', continuation: 'waiting' }); return status();
        }
        defer(intent, refresh, automatic);
        update({ state: 'waiting', reason: 'native_tools_active', continuation: 'waiting' }); return status();
      }
      if (checkpoint) handoff.paused.push(...checkpoint.handoff.paused);
      deferred = null;
      if (!owner()) throw liveError('native_switch_superseded');
      await assertCodexLiveQuiet(rpc);
      const current = await rpc.request('account/read', { refreshToken: false });
      if (!owner() || !sameNativeAccount(current, before)) throw liveError('account_changed_outside_deck');
      if (!await lease.valid()) throw liveError('native_control_lost');
      await assertProfileAvailable();
      await assertAutoEnabled();
      if (!owner()) throw liveError('account_changed_outside_deck');
      // Authentication crosses only this owner-validated local socket. Codex
      // stores external tokens in memory, not either profile's credential file.
      maybeApplied = true;
      const login = expectLoginNotifications(next);
      let account;
      try {
        const result = await rpc.request('account/login/start', { type: 'chatgptAuthTokens', accessToken: next.accessToken,
          chatgptAccountId: next.accountId, chatgptPlanType: next.planType });
        if (result?.type !== 'chatgptAuthTokens') throw liveError('unsupported_protocol');
        login.acknowledged = true;
        await login.promise;
        account = await rpc.request('account/read', { refreshToken: false });
        if (!authCurrent()) throw liveError('account_changed_outside_deck');
        if (!sameAccount(account, next)) throw liveError('native_identity_mismatch');
      } finally { login.close(); }
      credential = next; appliedIntent = { ...intent }; owned = true; lastRefresh = Date.now(); lastCheck = Date.now();
      resumeIdentity = account;
      update({ state: 'applied', profileId: intent.id, requestedProfileId: intent.id, reason: null });
      // The daemon has acknowledged this login. Keep renewal ownership even
      // if local metadata cannot be saved; losing it would strand live auth.
      await save().catch(() => update({ reason: 'ownership_not_saved' }));
      if (handoff.paused.length) {
        try {
          const result = await resume();
          if (result.delegated?.length) {
            childContinuation = { rpc, entries: result.delegated, deadline: Date.now() + (options.delegationTimeoutMs ?? 60_000),
              record, journal, identity: resumeIdentity };
          }
          update({ continuation: result.delegated?.length ? 'waiting' : result.resumed ? 'automatic' : 'none' });
        }
        catch { update({ reason: 'native_continue_unconfirmed', continuation: 'manual_required' }); }
      }
    } catch (error) {
      handoff ??= error.handoff;
      // Activity may start between the handoff snapshot and the final quiet
      // check. If nothing was sent, retain the current selection and observe
      // again instead of turning a harmless race into a permanent failure.
      // Any durable interrupt/checkpoint or possible login stays on the
      // existing recovery path: uncertain work must never be replayed.
      if (error.code === 'native_activity_changed' && !maybeApplied && !checkpoint
        && !journal.entries.length && !handoff?.paused?.length && owner() && await lease?.valid()) {
        defer(intent, refresh, automatic);
        update({ state: 'waiting', requestedProfileId: intent.id, reason: 'native_tools_active', continuation: 'waiting' });
        return status();
      }
      const lostControl = ['native_control_lost', 'account_changed_outside_deck', 'native_disconnected'].includes(error.code);
      if (!maybeApplied && !lostControl && handoff?.paused?.length && rpc && !closed) {
        try { await resume(); } catch { update({ continuation: 'manual_required' }); }
      }
      if (handoff?.paused?.length && (maybeApplied || lostControl)) update({ continuation: 'manual_required' });
      if (journal.entries.length && journal.phase !== 'finished') update({ continuation: 'manual_required' });
      if (maybeApplied) { credential = null; owned = false; }
      const reason = publicReason(error);
      update({ state: reason === 'auto_switch_disabled' && !maybeApplied ? (owned ? 'applied' : 'idle')
        : ['native_not_running', 'cli_unavailable'].includes(reason) ? 'unavailable' : 'failed',
        ...(maybeApplied ? { profileId: null } : {}), reason });
      if (!owned) await disconnect();
    } finally {
      if (journal.entries.length && journal.phase !== 'finished' && !childContinuation && !checkpointWork) {
        recoveryNeeded = true; recoveryJournal = journal;
        update({ continuation: 'manual_required', reason: 'native_continue_unconfirmed' });
      }
    }
    return status();
  }
  async function apply(intent, refresh = false, automatic = false, checkpoint = null) {
    try { await applyCore(intent, refresh, automatic, checkpoint); }
    finally {
      // A checkpoint is already real work, even if admission exits early (for
      // example Auto-switch was disabled). Never drop its recovery protection.
      if (checkpoint?.journal.entries.length && checkpoint.journal.phase !== 'finished' && !checkpointWork && !childContinuation) {
        recoveryNeeded = true; recoveryJournal = checkpoint.journal;
        update({ continuation: 'manual_required', reason: 'native_continue_unconfirmed' });
      }
      if (!checkpointWork && !childContinuation) await releaseHandoff();
    }
    return status();
  }
  async function request(intent, automatic = false) {
    await ready;
    if (closed || automatic && ownershipPaused) return status();
    if (!idPattern.test(intent?.id ?? '') || !Number.isSafeInteger(intent.revision) || intent.revision < 1) throw liveError('invalid_selection');
    const key = `${intent.revision}:${intent.id}`;
    if (pendingKey === key && pendingSwitch) return pendingSwitch;
    if (desired && intent.revision < desired.revision) return status();
    restorePending = null;
    deferred = null;
    desired = { id: intent.id, revision: intent.revision };
    pendingKey = key;
    const epoch = ownershipEpoch;
    pendingSwitch = enqueue(() => {
      if (!automatic && epoch === ownershipEpoch) ownershipPaused = false;
      return apply(intent, false, automatic);
    });
    return pendingSwitch;
  }
  async function restorePrevious(saved, intent) {
    restorePending = null;
    const epoch = ownershipEpoch;
    const previous = await loginCredential(saved.profileId);
    const actual = await rpc.request('account/read', { refreshToken: false });
    if (!await lease?.valid()) throw liveError('native_control_lost');
    if (ownershipPaused || epoch !== ownershipEpoch) { await externalChange(); return; }
    if (endpointKey(endpoint) === saved.endpoint && sameAccount(actual, previous, true)) {
      credential = previous; appliedIntent = { id: saved.profileId, revision: saved.revision }; owned = true;
      lastCheck = Date.now(); lastRefresh = Date.now();
      update({ state: 'failed', profileId: saved.profileId, requestedProfileId: intent.id, reason: 'native_login_unconfirmed' });
    } else {
      await externalChange();
    }
  }
  async function restore(saved) {
    const epoch = ownershipEpoch;
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
      let actual = await rpc.request('account/read', { refreshToken: false });
      if (!accountIds(actual).length) {
        restorePending = null; await externalChange('native_identity_unattested'); return;
      }
      let next;
      try { next = await loginCredential(intent.id); }
      catch (error) {
        if (intent.revision <= saved.revision) throw error;
        await restorePrevious(saved, intent); return;
      }
      // Credential preparation can outlive both the native account and our
      // control lease. Reattest after it, rather than adopting the old read.
      actual = await rpc.request('account/read', { refreshToken: false });
      if (!await lease?.valid()) throw liveError('native_control_lost');
      if (closed || restorePending !== saved) return;
      if (ownershipPaused || epoch !== ownershipEpoch) { restorePending = null; await externalChange(); return; }
      if (!accountIds(actual).length) { restorePending = null; await externalChange('native_identity_unattested'); return; }
      if (intent.revision > saved.revision && !sameAccount(actual, next, true)) {
        // The newer request has no persisted acknowledgement. It may have
        // timed out after sending: reconcile it, never replay it on restart.
        await restorePrevious(saved, intent); return;
      }
      if (intent.revision === saved.revision && endpointKey(endpoint) === saved.endpoint && !sameAccount(actual, next, true)) {
        restorePending = null; await externalChange(); return;
      }
      if (sameAccount(actual, next, true) && (endpointKey(endpoint) === saved.endpoint || intent.revision > saved.revision)) {
        // Adopt the surviving login without another account-change notification.
        credential = next; appliedIntent = { ...intent }; owned = true;
        lastCheck = Date.now(); lastRefresh = Date.now();
        update({ state: 'applied', profileId: intent.id, requestedProfileId: intent.id, reason: null });
        if (recoveryNeeded) update({ reason: 'native_continue_unconfirmed', continuation: 'manual_required' });
        await save().catch(() => update({ reason: 'ownership_not_saved' }));
        restorePending = null; return;
      }
      // Only discovery is retried. An ambiguous native login must not replay.
      restorePending = null; await externalChange();
    } catch (error) {
      if (!owned) await disconnect();
      const reason = publicReason(error);
      const retry = ['native_not_running', 'cli_unavailable', 'native_unavailable', 'native_connection_failed', 'native_disconnected', 'native_control_busy',
        'native_request_timeout', 'native_initial_account_unconfirmed'].includes(reason);
      update({ state: retry ? 'unavailable' : 'failed', reason });
      if (!retry) restorePending = null;
      restoreRetryAt = Date.now() + (options.restoreRetryMs ?? 5000);
    }
  }
  const ready = (async () => {
    try {
      const savedHandoff = options.loadHandoff ? await options.loadHandoff() : await readFile(join(store, 'codex-live-handoff.json'), 'utf8').then(JSON.parse).catch(() => null);
      recoveryNeeded = savedHandoff?.version === 1 && savedHandoff.phase !== 'finished' && savedHandoff.entries?.some(e => !['continued', 'skipped'].includes(e.phase)) === true;
      if (recoveryNeeded) recoveryJournal = savedHandoff;
      const s = await selection(); lastManual = s.runningSelection?.revision ?? 0; lastSelected = s.profileId;
      restorePending = options.loadState ? await options.loadState() : JSON.parse(await readFile(metadata, 'utf8'));
      if (restorePending) await enqueue(() => restore(restorePending));
    } catch { /* No prior ownership means no native authentication mutation. */ }
    finally { if (recoveryNeeded) update({ continuation: 'manual_required', reason: 'native_continue_unconfirmed' }); }
  })();
  async function confirmChildren() {
    const work = childContinuation;
    if (!work) return;
    try {
      if (work.rpc !== rpc || !owned || !await lease?.valid()) throw liveError('native_control_lost');
      const actual = await rpc.request('account/read', { refreshToken: false });
      if (ownershipPaused || !sameNativeAccount(actual, work.identity)) throw liveError('account_changed_outside_deck');
      const result = await confirmCodexLiveChildren(rpc, work.entries, {
        onConfirmed: (entry, id) => work.record(entry, 'continued', id), onSkip: entry => work.record(entry, 'skipped'),
      });
      work.entries = result.pending;
      if (!work.entries.length) {
        childContinuation = null; await releaseHandoff(); update({ continuation: work.expired ? 'none' : 'automatic', reason: null });
      } else if (Date.now() >= work.deadline) throw liveError('native_continue_unconfirmed');
    } catch (error) {
      // These are observations only. A slow daemon does not authorize replaying
      // input, but may be observed again within the existing bounded window.
      if (error.code === 'native_request_timeout' && Date.now() < work.deadline) return;
      work.expired = true; update({ continuation: 'manual_required', reason: 'native_continue_unconfirmed' });
      await releaseHandoff();
    }
  }
  async function prepareCheckpoint() {
    const work = checkpointWork;
    if (!work) return;
    try {
      if (!work.current() || work.rpc !== rpc || !await lease?.valid()) throw liveError('native_control_lost');
      const account = await rpc.request('account/read', { refreshToken: false });
      if (ownershipPaused || !sameNativeAccount(account, work.identity)) throw liveError('account_changed_outside_deck');
      const handoff = await inspectCodexLiveCheckpoints(rpc, work.entries, { record: work.record });
      if (!handoff) {
        if (Date.now() >= work.deadline) throw liveError('native_continue_unconfirmed');
        return;
      }
      checkpointWork = null;
      await apply(work.intent, work.refresh, work.automatic, { handoff, journal: work.journal, work });
    } catch (error) {
      if (error.code === 'native_request_timeout' && Date.now() < work.deadline) return;
      checkpointWork = null; recoveryNeeded = true; recoveryJournal = work.journal;
      await releaseHandoff();
      update({ state: 'failed', continuation: 'manual_required', reason: 'native_continue_unconfirmed' });
    }
  }
  async function reconcileRecovery() {
    if (!recoveryNeeded || !recoveryJournal) return;
    try {
      const s = await selection(); await ensureRpc(s.originalHome);
      for (const entry of recoveryJournal.entries) {
        if (['continued', 'skipped'].includes(entry.phase)) continue;
        const t = (await rpc.request('thread/read', { threadId: entry.threadId, includeTurns: false }))?.thread;
        if (!t || t.status?.type === 'notLoaded') return;
        const turn = await readCodexLiveTurn(rpc, t);
        if (!turn || !['inProgress', 'completed'].includes(turn.status)) return;
        if (turn.id === entry.turnId && (entry.phase !== 'interrupt_sent' || turn.status !== 'completed' || entry.checkpointReady)) return;
        // New work is an observed owner action, never permission to replay us.
        entry.phase = 'skipped';
      }
      recoveryJournal.phase = 'finished'; await saveHandoff(recoveryJournal);
      recoveryNeeded = false; recoveryJournal = null;
      update({ continuation: 'none', reason: null });
    } catch { /* Keep the durable recovery intent until its outcome is known. */ }
  }
  async function reconnect() {
    try {
      const s = await selection(); await ensureRpc(s.originalHome);
      const actual = await rpc.request('account/read', { refreshToken: false });
      // Notifications were unobservable during the gap. Email/workspace labels
      // cannot restore authority; require a native ID or a fresh manual selection.
      if (!accountIds(actual).length) await externalChange('native_identity_unattested');
      else if (!ownershipPaused && sameAccount(actual, credential, true)) {
        lastCheck = Date.now(); update({ state: 'applied', profileId: credential.profileId, reason: null });
      } else await externalChange();
    } catch (error) {
      // A partially initialized connection cannot attest ownership. Drop only
      // our control connection so the next poll can reconnect and read IDs.
      await disconnect();
      throw error;
    }
  }
  async function tick() {
    if (closed || ticking) return;
    ticking = true;
    try {
      await ready;
      if (recoveryNeeded) await enqueue(reconcileRecovery);
      if (childContinuation) await enqueue(confirmChildren);
      if (checkpointWork) await enqueue(prepareCheckpoint);
      const s = await selection();
      if (s.runningSelection && s.runningSelection.revision > lastManual) {
        lastManual = s.runningSelection.revision; await request(s.runningSelection);
      } else if (s.profileId !== lastSelected) {
        const auto = await (options.readAuto ?? (() => readCodexAuto({ ...options, store })))();
        if (auto.enabled) await request({ id: s.profileId, revision: s.revision }, true);
      }
      lastSelected = s.profileId;
      if (restorePending && Date.now() >= restoreRetryAt) await enqueue(() => restore(restorePending));
      if (deferred && !childContinuation && !checkpointWork && !recoveryNeeded) { const retry = deferred; deferred = null; await enqueue(() => apply(retry.intent, retry.refresh, retry.automatic)); }
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
    async close() { closed = true; clearInterval(timer); pendingLogin?.reject(liveError('native_disconnected')); await ready; await chain.catch(() => {}); credential = null; await disconnect(); },
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
