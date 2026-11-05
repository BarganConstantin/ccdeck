import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
// @ts-expect-error server ES module
import { createCodexLiveAccountController } from '../../server/codex-live-engine.mjs';

// Every native/file boundary is injected; these cases cannot touch real logins.
vi.mock('../../server/codex-live-credentials.mjs', () => ({ readLiveCodexCredential: () => { throw Error('Native credentials disabled'); } }));
const A = 'a'.repeat(20), B = 'b'.repeat(20);
const controllers: any[] = [];
afterEach(async () => { for (const c of controllers.splice(0)) await c.close(); vi.restoreAllMocks(); });
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
async function fixture({ ids = false, saved = false, notifyLogin = true, actual = A, active = false, initialUpdate = false as false | 'connect' | 'read' | 'delayed' | 'missing', workspaceName = null as string | null, initialAccountTimeoutMs = undefined as number | undefined } = {}) {
  let hooks: any, initialRead = false;
  let snapshot: any = { account: { type: 'chatgpt', email: 'same@example.invalid', planType: 'plus', workspaceName } };
  const nativeId = (id: string) => id === A ? 'workspace-a' : 'workspace-b';
  const setAccount = (id: string) => {
    snapshot = { account: { ...snapshot.account }, ...(ids ? { workspaceRouting: { chatgptAccountId: nativeId(id) } } : {}) };
  };
  setAccount(actual);
  const selection = { originalHome: '/fictional-native', profileId: A, revision: 1,
    runningSelection: { id: A, revision: 1 }, profiles: [{ id: A, available: true }, { id: B, available: true }] };
  const sends: any[] = [], persisted: any[] = [], connections: any[] = [];
  const thread = { id: 'fictional-thread', canAcceptDirectInput: true, historyMode: 'legacy', status: { type: active ? 'active' : 'idle', activeFlags: [] } };
  const turn = { id: 'fictional-turn', rootTurnId: 'fictional-root', status: 'inProgress', itemsView: 'full', items: [{ id: 'input', type: 'userMessage' }] };
  const persistHandoff = vi.fn(async (_journal: any) => {});
  const credential = (id: string) => ({ profileId: id, accountId: nativeId(id), email: 'same@example.invalid',
    accessToken: 'fictional-access', planType: 'plus', expiresAt: Date.now() + 3600_000 });
  const notify = (method = 'account/updated', params: any = { authMode: 'chatgptAuthTokens', planType: 'plus' }) => hooks.onNotification({ method, params });
  const rpc = {
    request: vi.fn(async (method: string, params: any) => {
      if (method === 'account/read') {
        if (initialRead && initialUpdate === 'read') notify();
        initialRead = false;
        return structuredClone(snapshot);
      }
      if (method === 'thread/loaded/list') return { data: active ? [thread.id] : [] };
      if (method === 'thread/read') return { thread: structuredClone(thread) };
      if (method === 'thread/turns/list') return { data: [structuredClone(turn)] };
      if (method === 'turn/interrupt') { thread.status.type = 'idle'; turn.status = 'interrupted'; return {}; }
      if (method === 'turn/start') { thread.status.type = 'active'; turn.id = 'continued-turn'; turn.status = 'inProgress'; return { turn: { id: turn.id } }; }
      if (method === 'account/login/start') {
        setAccount(params.chatgptAccountId === nativeId(A) ? A : B);
        if (notifyLogin) setTimeout(() => {
          notify('account/login/completed', { loginId: null, success: true, error: null }); notify();
        }, 0);
        return { type: 'chatgptAuthTokens' };
      }
      throw Error(method);
    }),
    send: vi.fn((message: any) => sends.push(message)), close: vi.fn(),
  };
  const readCredential = vi.fn(async (id: string) => credential(id));
  const c = createCodexLiveAccountController({ store: '/fictional-unused-store', pollMs: 1000_000, loginNotificationTimeoutMs: 200, initialAccountTimeoutMs,
    readSelection: async () => selection, readAuto: async () => ({ enabled: true }),
    readCredential, loadState: async () => saved ? { version: 1, wasControlling: true, profileId: A, revision: 1,
      endpoint: createHash('sha256').update('generation').digest('hex') } : null,
    loadHandoff: async () => null, persistHandoff, persistState: async (s: any) => persisted.push(s),
    resolveEndpoint: async () => ({ home: selection.originalHome, generation: 'generation' }),
    acquireLease: async () => ({ valid: async () => true, release: async () => {} }),
    connectRpc: async (_: any, callbacks: any) => {
      hooks = callbacks; connections.push(callbacks);
      initialRead = true;
      if (initialUpdate === 'connect' || ids && !initialUpdate) notify();
      if (initialUpdate === 'delayed') setTimeout(() => notify(), 5);
      return rpc;
    },
  });
  controllers.push(c); await c.ready;
  return { c, rpc, sends, persisted, persistHandoff, connections, readCredential, selection, notify, credential, setAccount,
    get snapshot() { return snapshot; }, disconnect: () => hooks.onClose(),
    refresh: () => hooks.onRequest({ id: 'renewal', method: 'account/chatgptAuthTokens/refresh', params: { previousAccountId: nativeId(A) } }) };
}

describe('native Codex authentication ownership', () => {
  it.each([1, 2])('recovers an attested connection after account read %s times out during reconnection without replaying login', async failedRead => {
    const f = await fixture({ ids: true }); await f.c.request({ id: A, revision: 2 });
    f.disconnect();
    const original = f.rpc.request.getMockImplementation()!; let reads = 0;
    f.rpc.request.mockImplementation(async (method, params) => {
      if (method === 'account/read' && ++reads === failedRead) throw Object.assign(Error('timeout'), { code: 'native_request_timeout' });
      return original(method, params);
    });
    await f.c.tick();
    expect(f.c.status().state).toBe('disconnected');
    await f.c.tick();
    expect(f.c.status()).toMatchObject({ state: 'applied', profileId: A });
    expect(f.connections).toHaveLength(3);
    // A discarded socket's late update cannot revoke the new attested owner.
    f.connections[1].onNotification({ method: 'account/updated' });
    await f.c.tick();
    expect(f.c.status().state).toBe('applied');
    await f.refresh(); expect(f.sends).toHaveLength(1);
    expect(f.rpc.request.mock.calls.filter(([method]) => method === 'account/login/start')).toHaveLength(1);
  });
  it('still rejects an outside workspace change when retrying a failed reconnection', async () => {
    const f = await fixture({ ids: true }); await f.c.request({ id: A, revision: 2 }); f.disconnect();
    f.rpc.request.mockRejectedValueOnce(Object.assign(Error('timeout'), { code: 'native_request_timeout' }));
    await f.c.tick(); f.setAccount(B); await f.c.tick();
    expect(f.c.status().state).toBe('external_change');
    expect(f.rpc.request.mock.calls.filter(([method]) => method === 'account/login/start')).toHaveLength(1);
    await f.refresh(); expect(f.sends).toEqual([]);
  });

  it.each(['connect', 'read'] as const)('accepts the initial routing snapshot during %s and still detects later outside updates', async initialUpdate => {
    const f = await fixture({ initialUpdate });
    expect(await f.c.request({ id: A, revision: 2 })).toMatchObject({ state: 'applied', profileId: A });
    f.notify(); await flush();
    expect(f.c.status()).toMatchObject({ state: 'external_change', profileId: null });
    expect(await f.c.request({ id: B, revision: 3 })).toMatchObject({ state: 'applied', profileId: B });
    expect(f.connections).toHaveLength(2);
  });
  it.each(['restart', 'reconnect'])('checks native identity after an initial routing snapshot during %s', async mode => {
    const f = await fixture({ initialUpdate: 'read', ids: true, saved: mode === 'restart' });
    if (mode === 'reconnect') {
      await f.c.request({ id: A, revision: 2 }); f.disconnect(); await f.c.tick();
    }
    expect(f.c.status()).toMatchObject({ state: 'applied', profileId: A });
    f.notify(); await flush();
    expect(f.c.status().state).toBe('external_change');
  });

  it.each(['account/updated', 'account/login/completed'])('still pauses on a second auth event during initialization: %s', async method => {
    const f = await fixture({ initialUpdate: 'connect', ids: true });
    const original = f.rpc.request.getMockImplementation()!;
    f.rpc.request.mockImplementationOnce(async (name, params) => {
      f.notify(method, method === 'account/login/completed' ? { loginId: null, success: true } : { authMode: 'chatgptAuthTokens', planType: 'plus' });
      return original(name, params);
    });
    await f.c.request({ id: A, revision: 2 }); await flush();
    expect(f.c.status().state).toBe('external_change');
    expect(f.rpc.request.mock.calls.some(([name]) => name === 'account/login/start')).toBe(false);
  });
  it('waits for routing discovery that notifies after the first account read', async () => {
    const f = await fixture({ ids: true, initialUpdate: 'delayed' });
    expect(await f.c.request({ id: A, revision: 2 })).toMatchObject({ state: 'applied', profileId: A });
    expect(f.rpc.request.mock.calls.filter(([method]) => method === 'account/login/start')).toHaveLength(1);
    f.notify(); await flush(); expect(f.c.status().state).toBe('external_change');
  });
  it('does not log in or continue work when the promised initial routing snapshot never arrives', async () => {
    const f = await fixture({ ids: true, initialUpdate: 'missing', initialAccountTimeoutMs: 5 });
    expect(await f.c.request({ id: A, revision: 2 })).toMatchObject({ state: 'failed', reason: 'native_initial_account_unconfirmed' });
    expect(f.rpc.request.mock.calls.some(([method]) => ['account/login/start', 'turn/start', 'turn/interrupt'].includes(method))).toBe(false);
  });
  it.each([false, true])('does not use the initial snapshot to bypass restart identity checks (IDs: %s)', async ids => {
    const f = await fixture({ initialUpdate: 'read', ids, saved: true, actual: B });
    expect(f.c.status().state).toBe('external_change');
    expect(f.rpc.request.mock.calls.some(([method]) => method === 'account/login/start')).toBe(false);
    await f.refresh(); expect(f.sends).toEqual([]);
  });
  it('pauses on an unsolicited same-email update and sends no later renewal', async () => {
    const f = await fixture(); await f.c.request({ id: A, revision: 2 }); await flush();
    f.setAccount(B); f.notify(); await flush(); await f.refresh();
    expect(f.c.status()).toMatchObject({ state: 'external_change', profileId: null });
    expect(f.sends).toEqual([]);
    expect(f.persisted.at(-1).wasControlling).toBe(false);
  });
  it('does not reclaim ownership from email alone after restart', async () => {
    const f = await fixture({ saved: true });
    expect(f.c.status()).toMatchObject({ state: 'external_change', reason: 'native_identity_unattested' });
    expect(f.rpc.request.mock.calls.some(([method]) => method === 'account/login/start')).toBe(false);
    await f.refresh(); expect(f.sends).toEqual([]);
  });
  it('does not reclaim ownership from email alone after disconnect', async () => {
    const f = await fixture(); await f.c.request({ id: A, revision: 2 }); await flush();
    f.disconnect(); f.setAccount(B); await f.c.tick();
    expect(f.c.status()).toMatchObject({ state: 'external_change', reason: 'native_identity_unattested' });
    expect(f.rpc.request.mock.calls.filter(([method]) => method === 'account/login/start')).toHaveLength(1);
  });
  it('waits for the acknowledged login notification pair and preserves native renewal', async () => {
    const f = await fixture({ notifyLogin: false });
    let finished = false;
    const switching = f.c.request({ id: A, revision: 2 }).then((result: any) => { finished = true; return result; });
    await vi.waitFor(() => expect(f.rpc.request.mock.calls.some(([m]) => m === 'account/login/start')).toBe(true));
    expect(finished).toBe(false);
    f.notify('account/login/completed', { loginId: null, success: true }); f.notify();
    expect(await switching).toMatchObject({ state: 'applied', profileId: A });
    await f.refresh();
    expect(f.sends).toEqual([{ id: 'renewal', result: { accessToken: 'fictional-access', chatgptAccountId: 'workspace-a', chatgptPlanType: 'plus' } }]);
    expect(f.c.status().state).toBe('applied');
    // No lingering exemption may consume the next outside update.
    f.notify(); await flush(); expect(f.c.status().state).toBe('external_change');
  });
  it('does not classify an update without login completion as our login', async () => {
    const f = await fixture({ notifyLogin: false });
    const switching = f.c.request({ id: A, revision: 2 });
    await vi.waitFor(() => expect(f.rpc.request.mock.calls.some(([m]) => m === 'account/login/start')).toBe(true));
    f.notify(); await switching; await flush();
    expect(f.c.status().state).toBe('external_change');
    expect(f.persisted.some(s => s.wasControlling)).toBe(false);
  });
  it('bounds a missing native login notification without replaying login', async () => {
    const f = await fixture({ notifyLogin: false });
    expect(await f.c.request({ id: A, revision: 2 })).toMatchObject({ state: 'failed', reason: 'native_login_unconfirmed', profileId: null });
    await f.c.tick();
    expect(f.rpc.request.mock.calls.filter(([m]) => m === 'account/login/start')).toHaveLength(1);
  });
  it.each(['accountId', 'id', 'routing'])('rejects a supplied conflicting native %s after login', async field => {
    const f = await fixture();
    const original = f.rpc.request.getMockImplementation()!;
    let loggedIn = false;
    f.rpc.request.mockImplementation(async (method, params) => {
      const result = await original(method, params);
      if (method === 'account/login/start') loggedIn = true;
      if (method === 'account/read' && loggedIn) {
        if (field === 'routing') result.workspaceRouting = { chatgptAccountId: 'workspace-b' };
        else result.account[field] = 'workspace-b';
      }
      return result;
    });
    expect(await f.c.request({ id: A, revision: 2 })).toMatchObject({ state: 'failed', reason: 'native_identity_mismatch', profileId: null });
    await f.refresh(); expect(f.sends).toEqual([]);
  });
  it.each(['restart', 'reconnect'])('preserves attested ownership across %s', async mode => {
    const f = await fixture({ ids: true, saved: mode === 'restart' });
    if (mode === 'reconnect') { await f.c.request({ id: A, revision: 2 }); f.disconnect(); await f.c.tick(); }
    expect(f.c.status()).toMatchObject({ state: 'applied', profileId: A });
    await f.refresh(); expect(f.sends[0].result.chatgptAccountId).toBe('workspace-a');
    expect(f.rpc.request.mock.calls.filter(([m]) => m === 'account/login/start')).toHaveLength(mode === 'restart' ? 0 : 1);
  });
  it('rejects a same-email workspace change across a reconnect even without a notification', async () => {
    const f = await fixture({ ids: true }); await f.c.request({ id: A, revision: 2 });
    f.disconnect(); f.setAccount(B); await f.c.tick();
    expect(f.c.status().state).toBe('external_change'); await f.refresh(); expect(f.sends).toEqual([]);
  });
  it('invalidates a native renewal whose credential read overlaps an outside update', async () => {
    const f = await fixture(); await f.c.request({ id: A, revision: 2 });
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    f.readCredential.mockImplementationOnce(async (id: string) => { await blocked; return f.credential(id); });
    const renewal = f.refresh(); await flush();
    f.setAccount(B); f.notify(); release(); await renewal; await flush();
    expect(f.sends).toEqual([]); expect(f.c.status().state).toBe('external_change');
  });
  it('honors a native ID mismatch during renewal even without an update', async () => {
    const f = await fixture({ ids: true }); await f.c.request({ id: A, revision: 2 });
    f.setAccount(B); await f.refresh();
    expect(f.sends).toEqual([]); expect(f.c.status().state).toBe('external_change');
  });
  it('requires fresh manual selection to rearm after an outside change', async () => {
    const f = await fixture(); await f.c.request({ id: A, revision: 2 });
    f.notify(); await flush();
    await f.c.request({ id: B, revision: 3 }, true);
    expect(f.rpc.request.mock.calls.filter(([m]) => m === 'account/login/start')).toHaveLength(1);
    expect(await f.c.request({ id: B, revision: 4 })).toMatchObject({ state: 'applied', profileId: B });
  });
  it('preserves proactive renewal with its own acknowledged login notifications', async () => {
    const f = await fixture();
    let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
    f.readCredential.mockImplementation(async (id: string) => ({ ...f.credential(id), expiresAt: now + 300_000 }));
    await f.c.request({ id: A, revision: 2 }); now += 61_000; await f.c.tick();
    expect(f.c.status()).toMatchObject({ state: 'applied', profileId: A });
    expect(f.rpc.request.mock.calls.filter(([m]) => m === 'account/login/start')).toHaveLength(2);
    expect(f.readCredential.mock.calls).toHaveLength(2);
  });

  it('does not use a workspace display name as restart attestation', async () => {
    const f = await fixture({ saved: true, workspaceName: 'Same display name' });
    expect(f.c.status()).toMatchObject({ state: 'external_change', reason: 'native_identity_unattested' });
    expect(f.rpc.request.mock.calls.some(([m]) => m === 'account/login/start')).toBe(false);
  });
  it('ignores notifications and closure from the old connection after manual rearming', async () => {
    const f = await fixture(); await f.c.request({ id: A, revision: 2 });
    const old = f.connections[0]; f.notify(); await flush();
    await f.c.request({ id: B, revision: 3 });
    old.onNotification({ method: 'account/updated', params: { authMode: 'chatgptAuthTokens', planType: 'plus' } });
    old.onClose(); await flush();
    expect(f.c.status()).toMatchObject({ state: 'applied', profileId: B });
  });
  it('does not renew or log in when an outside update arrives during credential preparation', async () => {
    const f = await fixture(); await f.c.request({ id: A, revision: 2 });
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    f.readCredential.mockImplementationOnce(async (id: string) => { await blocked; return f.credential(id); });
    const switching = f.c.request({ id: B, revision: 3 }); await flush();
    f.notify(); release(); await switching; await flush();
    expect(f.c.status().state).toBe('external_change');
    expect(f.rpc.request.mock.calls.filter(([m]) => m === 'account/login/start')).toHaveLength(1);
  });

  it('rejects same-email but differently attested restart ownership', async () => {
    const f = await fixture({ saved: true, ids: true, actual: B });
    expect(f.c.status().state).toBe('external_change');
    await f.refresh(); expect(f.sends).toEqual([]);
    expect(f.rpc.request.mock.calls.some(([m]) => m === 'account/login/start')).toBe(false);
  });
  it('does not consume a foreign login notification pair before our RPC acknowledgement', async () => {
    const f = await fixture({ notifyLogin: false });
    const original = f.rpc.request.getMockImplementation()!;
    f.rpc.request.mockImplementation(async (method, params) => {
      if (method === 'account/login/start') {
        f.notify('account/login/completed', { loginId: null, success: true }); f.notify();
        await flush(); // Our RPC result has not arrived yet.
      }
      return original(method, params);
    });
    await f.c.request({ id: A, revision: 2 }); await flush();
    expect(f.c.status().state).toBe('external_change');
    expect(f.persisted.some(s => s.wasControlling)).toBe(false);
  });

  it('accepts our result and ordered notification pair delivered in one read', async () => {
    const f = await fixture({ notifyLogin: false });
    const original = f.rpc.request.getMockImplementation()!;
    f.rpc.request.mockImplementation((method, params) => {
      if (method !== 'account/login/start') return original(method, params);
      f.setAccount(A);
      return new Promise(resolve => setTimeout(() => {
        resolve({ type: 'chatgptAuthTokens' });
        // Match the native transport: resolve the RPC, then dispatch the
        // notifications synchronously before the caller's await can resume.
        f.notify('account/login/completed', { loginId: null, success: true }); f.notify();
      }, 0));
    });
    expect(await f.c.request({ id: A, revision: 2 })).toMatchObject({ state: 'applied', profileId: A });
  });
  it.each(['interrupt_sent', 'sent'])('stops handoff when an outside update arrives during %s journal persistence', async phase => {
    const f = await fixture({ active: true });
    f.persistHandoff.mockImplementation(async journal => {
      if (journal.entries.some((entry: any) => entry.phase === phase)) f.notify();
    });
    await f.c.request({ id: A, revision: 2 }); await flush();
    expect(f.c.status().state).toBe('external_change');
    expect(f.rpc.request.mock.calls.some(([m]) => m === 'turn/start')).toBe(false);
    if (phase === 'interrupt_sent') expect(f.rpc.request.mock.calls.some(([m]) => m === 'turn/interrupt')).toBe(false);
  });

});
