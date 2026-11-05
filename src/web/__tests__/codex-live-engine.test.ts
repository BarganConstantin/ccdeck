import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
// @ts-expect-error server ES module
import { createCodexLiveAccountController } from '../../server/codex-live-engine.mjs';
const A = 'a'.repeat(20), B = 'b'.repeat(20);
const controllers: { close(): Promise<void> }[] = [];
afterEach(async () => { for (const c of controllers.splice(0)) await c.close(); vi.restoreAllMocks(); });
async function fixture({ saved = null as any, actual = A, readCredential = null as any, auto = false, persistError = false,
  initial = null as any, resolveEndpoint = null as any, active = false, savedHandoff = null as any,
  delegationTimeoutMs = undefined as number | undefined } = {}) {
  const selection = { originalHome: '/native-home', profileId: A, revision: 0, runningSelection: null as any,
    profiles: [{ id: A, available: true }, { id: B, available: true }] };
  const email = (id: string) => id === A ? 'first@example.test' : 'second@example.test';
  let account = { type: 'chatgpt', email: email(actual), planType: 'plus' };
  const calls: { method: string; params: any }[] = [], sent: any[] = [], persisted: any[] = [];
  const journals: any[] = [], autoSettings = { enabled: auto };
  const thread = { id: 'active-thread', historyMode: 'legacy', status: { type: 'active', activeFlags: [] as string[] } };
  const turn = { id: 'original-turn', rootTurnId: 'root-turn', status: 'inProgress', itemsView: 'full', items: [{ id: 'input', type: 'userMessage' }] as any[] };
  let callbacks: any;
  const rpc = {
    request: vi.fn(async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === 'thread/loaded/list') return { data: active ? [thread.id] : [] } as any;
      if (method === 'thread/read') return { thread } as any;
      if (method === 'thread/resume') return { thread } as any;
      if (method === 'thread/unsubscribe') return {} as any;
      if (method === 'thread/turns/list') return { data: [{ ...turn, items: [...turn.items] }] } as any;
      if (method === 'turn/interrupt') { thread.status.type = 'idle'; turn.status = 'interrupted'; return {} as any; }
      if (method === 'turn/start') { thread.status.type = 'active'; turn.id = 'continued-turn'; turn.status = 'inProgress'; return { turn: { id: turn.id } } as any; }
      if (method === 'account/read') return { account, workspaceRouting: { chatgptAccountId: account.email === email(A) ? 'first' : 'second' } };
      if (method === 'account/login/start') {
        account = { type: 'chatgpt', email: email(params.chatgptAccountId === 'first' ? A : B), planType: 'plus' };
        setTimeout(() => {
          callbacks.onNotification({ method: 'account/login/completed', params: { loginId: null, success: true } });
          callbacks.onNotification({ method: 'account/updated', params: { authMode: 'chatgptAuthTokens', planType: 'plus' } });
        }, 0);
        return { type: 'chatgptAuthTokens' };
      }
      throw Error('Unexpected native RPC');
    }),
    send: vi.fn((m: any) => sent.push(m)), close: vi.fn(),
  };
  const lease = { valid: vi.fn(async () => true), release: vi.fn(async () => {}) };
  const credential = (id: string) => ({ profileId: id, accessToken: `fictional-access-${id}`, accountId: id === A ? 'first' : 'second',
    email: email(id), planType: 'plus', expiresAt: Date.now() + 3600_000 });
  if (saved) { selection.profileId = saved.profileId; selection.revision = saved.revision; selection.runningSelection = { id: saved.profileId, revision: saved.revision }; }
  if (initial) Object.assign(selection, initial);
  const c = createCodexLiveAccountController({
    store: '/unused-fixture-store', pollMs: 1000_000, restoreRetryMs: 0,
    delegationTimeoutMs,
    readSelection: async () => ({ ...selection }), readAuto: async () => autoSettings,
    loadState: async () => saved, persistState: async (m: any) => { if (persistError) throw Error('private disk detail'); persisted.push(m); },
    loadHandoff: async () => savedHandoff,
    persistHandoff: async (data: any) => { journals.push(structuredClone(data)); },
    resolveEndpoint: resolveEndpoint ?? (async () => ({ home: '/native-home', generation: 'native-generation' })),
    acquireLease: async () => lease,
    connectRpc: async (_endpoint: any, hooks: any) => { callbacks = hooks; hooks.onNotification({ method: 'account/updated', params: { authMode: 'chatgptAuthTokens', planType: 'plus' } }); return rpc; },
    readCredential: vi.fn(readCredential ?? (async (id: string) => credential(id))),
  });
  controllers.push(c); await c.ready;
  return { c, selection, rpc, calls, sent, persisted, lease, credential, journals, thread, turn, autoSettings, notify: (m: any) => callbacks.onNotification(m),
    serverRequest: (m: any) => callbacks.onRequest(m), actual: () => account,
    disconnect: () => callbacks.onClose(),
    externalLogin: (id: string) => { account = { ...account, email: email(id) }; callbacks.onNotification({ method: 'account/updated' }); } };
}
describe('existing Codex session account engine', () => {
  it.each(['removed', 'unavailable'])('refuses a target profile made %s during credential reading before interrupting work', async state => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture({ active: true, readCredential: async (id: string) => { await gate; return f.credential(id); } });
    const pending = f.c.request({ id: B, revision: 1 });
    await vi.waitFor(() => expect(f.rpc.request.mock.calls.some(([method]) => method === 'account/read')).toBe(true));
    if (state === 'removed') f.selection.profiles = f.selection.profiles.filter(p => p.id !== B);
    else f.selection.profiles.find(p => p.id === B)!.available = false;
    release();
    expect(await pending).toMatchObject({ state: 'failed', reason: 'profile_unavailable' });
    expect(f.calls.some(c => ['account/login/start', 'turn/interrupt', 'turn/start'].includes(c.method))).toBe(false);
  });

  it('resumes the original account once if the target profile is removed after interruption', async () => {
    const f = await fixture({ active: true });
    const original = f.rpc.request.getMockImplementation()!;
    f.rpc.request.mockImplementation(async (method, params) => {
      const result = await original(method, params);
      if (method === 'turn/interrupt') f.selection.profiles = f.selection.profiles.filter(p => p.id !== B);
      return result;
    });
    expect(await f.c.request({ id: B, revision: 1 })).toMatchObject({ state: 'failed', reason: 'profile_unavailable' });
    expect(f.calls.filter(c => c.method === 'turn/start')).toHaveLength(1);
    expect(f.calls.some(c => c.method === 'account/login/start')).toBe(false);
    expect(f.actual().email).toBe('first@example.test');
    expect(f.journals.at(-1).phase).toBe('finished');
  });

  it('retains durable recovery if a removed-target cancellation cannot confirm resuming the original turn', async () => {
    const f = await fixture({ active: true });
    const original = f.rpc.request.getMockImplementation()!;
    f.rpc.request.mockImplementation(async (method, params) => {
      if (method === 'turn/start') throw Object.assign(Error('timeout'), { code: 'native_request_timeout' });
      const result = await original(method, params);
      if (method === 'turn/interrupt') f.selection.profiles = f.selection.profiles.filter(p => p.id !== B);
      return result;
    });
    expect(await f.c.request({ id: B, revision: 1 })).toMatchObject({ continuation: 'manual_required', reason: 'native_continue_unconfirmed' });
    await f.c.tick(); await f.c.request({ id: A, revision: 2 });
    expect(f.rpc.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1);
    expect(f.calls.some(c => c.method === 'account/login/start')).toBe(false);
  });

  it('allows a still-available profile after an unrelated label or registry revision change during the credential read', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture({ readCredential: async (id: string) => { await gate; return f.credential(id); } });
    const pending = f.c.request({ id: B, revision: 1 });
    await vi.waitFor(() => expect(f.rpc.request.mock.calls.some(([method]) => method === 'account/read')).toBe(true));
    f.selection.revision++;
    f.selection.profiles = f.selection.profiles.map(p => p.id === B ? { ...p, label: 'Renamed test account' } : p);
    release();
    expect(await pending).toMatchObject({ state: 'applied', profileId: B });
    expect(f.calls.filter(c => c.method === 'account/login/start')).toHaveLength(1);
  });

  it('does not start an automatic handoff when Auto-switch is disabled during the credential read', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture({ auto: true, active: true, readCredential: async (id: string) => {
      await gate; return f.credential(id);
    } });
    const pending = f.c.request({ id: B, revision: 1 }, true);
    await vi.waitFor(() => expect(f.rpc.request.mock.calls.some(([method]) => method === 'account/read')).toBe(true));
    f.autoSettings.enabled = false; release(); await pending;
    expect(f.calls.some(c => ['account/login/start', 'turn/interrupt', 'turn/start'].includes(c.method))).toBe(false);
    expect(f.c.status().reason).toBe('auto_switch_disabled');
  });

  it('resumes the original turn once if Auto-switch is disabled after interruption', async () => {
    const f = await fixture({ auto: true, active: true });
    const original = f.rpc.request.getMockImplementation()!;
    f.rpc.request.mockImplementation(async (method, params) => {
      const result = await original(method, params);
      if (method === 'turn/interrupt') f.autoSettings.enabled = false;
      return result;
    });
    expect(await f.c.request({ id: B, revision: 1 }, true)).toMatchObject({ state: 'idle', reason: 'auto_switch_disabled' });
    await f.c.tick();
    expect(f.calls.filter(c => c.method === 'turn/interrupt')).toHaveLength(1);
    expect(f.calls.filter(c => c.method === 'turn/start')).toHaveLength(1);
    expect(f.calls.some(c => c.method === 'account/login/start')).toBe(false);
    expect(f.actual().email).toBe('first@example.test');
    expect(f.journals.at(-1).phase).toBe('finished');
  });

  it('preserves recovery protection if a cancelled automatic switch cannot resume the original turn', async () => {
    const f = await fixture({ auto: true, active: true });
    const original = f.rpc.request.getMockImplementation()!;
    f.rpc.request.mockImplementation(async (method, params) => {
      if (method === 'turn/start') throw Object.assign(Error('timeout'), { code: 'native_request_timeout' });
      const result = await original(method, params);
      if (method === 'turn/interrupt') f.autoSettings.enabled = false;
      return result;
    });
    expect(await f.c.request({ id: B, revision: 1 }, true)).toMatchObject({ continuation: 'manual_required', reason: 'native_continue_unconfirmed' });
    await f.c.tick();
    expect(await f.c.request({ id: B, revision: 2 })).toMatchObject({ continuation: 'manual_required' });
    expect(f.rpc.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1);
    expect(f.calls.some(c => c.method === 'account/login/start')).toBe(false);
  });

  it('keeps a manual switch waiting when new activity appears before authentication, then applies it once quiet', async () => {
    const f = await fixture({ active: true });
    const original = f.rpc.request.getMockImplementation()!;
    let lists = 0, raced = true;
    f.rpc.request.mockImplementation(async (method, params) => {
      if (method === 'thread/loaded/list') {
        lists++;
        if (raced) return { data: lists === 1 ? [] : [f.thread.id] } as any;
        return { data: [] } as any;
      }
      return original(method, params);
    });
    expect(await f.c.request({ id: B, revision: 1 })).toMatchObject({ state: 'waiting', reason: 'native_tools_active', requestedProfileId: B });
    expect(f.calls.some(c => ['account/login/start', 'turn/interrupt', 'turn/start'].includes(c.method))).toBe(false);
    raced = false;
    await f.c.tick();
    expect(f.c.status()).toMatchObject({ state: 'applied', profileId: B });
    expect(f.calls.filter(c => c.method === 'account/login/start')).toHaveLength(1);
  });

  it('keeps rechecking a raced switch without logging in while tools remain active', async () => {
    const f = await fixture({ active: true }), original = f.rpc.request.getMockImplementation()!;
    let lists = 0;
    f.rpc.request.mockImplementation(async (method, params) => {
      if (method === 'thread/loaded/list' && ++lists === 1) return { data: [] } as any;
      return original(method, params);
    });
    await f.c.request({ id: B, revision: 1 });
    f.turn.items.push({ id: 'tool', type: 'commandExecution', status: 'inProgress' });
    await f.c.tick(); await f.c.tick();
    expect(f.c.status()).toMatchObject({ state: 'waiting', requestedProfileId: B });
    expect(f.calls.some(c => ['account/login/start', 'turn/interrupt', 'turn/start'].includes(c.method))).toBe(false);
    f.thread.status.type = 'idle'; f.turn.status = 'completed'; f.turn.items[1].status = 'completed';
    await f.c.tick();
    expect(f.c.status()).toMatchObject({ state: 'applied', profileId: B });
  });
  it('does not retry after an interrupt was sent and its result cannot be reconciled', async () => {
    const f = await fixture({ active: true }), original = f.rpc.request.getMockImplementation()!;
    let interrupted = false;
    f.rpc.request.mockImplementation(async (method, params) => {
      const result = await original(method, params);
      if (method === 'turn/interrupt') interrupted = true;
      if (method === 'thread/turns/list' && interrupted) result.data[0].items.push({ id: 'new-input', type: 'userMessage' });
      return result;
    });
    await f.c.request({ id: B, revision: 1 });
    expect(f.c.status()).toMatchObject({ state: 'failed', continuation: 'manual_required' });
    await f.c.tick();
    expect(f.calls.filter(c => c.method === 'turn/interrupt')).toHaveLength(1);
    expect(f.calls.some(c => ['account/login/start', 'turn/start'].includes(c.method))).toBe(false);
  });
  it('discards a raced selection after an outside login instead of retrying it', async () => {
    const f = await fixture({ active: true }), original = f.rpc.request.getMockImplementation()!;
    let lists = 0;
    f.rpc.request.mockImplementation(async (method, params) => {
      if (method === 'thread/loaded/list' && ++lists === 1) return { data: [] } as any;
      return original(method, params);
    });
    await f.c.request({ id: B, revision: 1 });
    f.externalLogin(A); await f.c.tick();
    expect(f.c.status().state).toBe('external_change');
    expect(f.calls.some(c => c.method === 'account/login/start')).toBe(false);
  });
  async function v2({ timeout = undefined as number | undefined, nearExpiry = false, auto = false } = {}) {
    const credential = nearExpiry ? async (id: string) => ({ profileId: id, accessToken: 'fictional-access', accountId: id === A ? 'first' : 'second',
      email: id === A ? 'first@example.test' : 'second@example.test', planType: 'plus', expiresAt: Date.now() + 300_000 }) : null;
    const f = await fixture({ active: true, delegationTimeoutMs: timeout, readCredential: credential, auto }), original = f.rpc.request.getMockImplementation()!;
    Object.assign(f.thread, { canAcceptDirectInput: true });
    const child = { id: 'v2-child', parentThreadId: f.thread.id, canAcceptDirectInput: false,
      source: { subAgent: { thread_spawn: { parent_thread_id: f.thread.id, agent_path: '/root/report' } } },
      status: { type: 'active', activeFlags: [] } };
    const turn = { id: 'v2-turn', rootTurnId: 'root-turn', status: 'inProgress', itemsView: 'full', items: [] as any[] };
    f.turn.items.push({ id: 'wait', type: 'collabAgentToolCall', tool: 'wait', status: 'inProgress', senderThreadId: f.thread.id, receiverThreadIds: [] });
    f.rpc.request.mockImplementation(async (method, params) => {
      if (method === 'thread/loaded/list') return { data: [f.thread.id, child.id] };
      if (params?.threadId === child.id) {
        f.calls.push({ method, params });
        if (method === 'thread/read') return { thread: structuredClone(child) };
        if (method === 'thread/resume') return { thread: structuredClone(child) };
        if (method === 'thread/unsubscribe') return {};
        if (method === 'thread/turns/list') return { data: [structuredClone(turn)] };
        if (method === 'turn/interrupt') { child.status.type = 'idle'; turn.status = 'interrupted'; return {}; }
        throw Error('Direct V2 input is forbidden');
      }
      if (method === 'turn/steer') {
        f.calls.push({ method, params });
        f.turn.items.push({ id: 'checkpoint-input', type: 'userMessage', clientId: params.clientUserMessageId }); return {};
      }
      if (method === 'turn/interrupt') f.turn.items[1].status = 'completed';
      return original(method, params);
    });
    const checkpoint = async () => {
      const id = f.journals.at(-1).entries[0].checkpointId;
      f.thread.status.type = 'idle'; f.turn.status = 'completed'; f.turn.items[1].status = 'completed';
      child.status.type = 'idle'; turn.status = 'completed';
      f.turn.items.push({ id: 'parent-checkpoint', type: 'agentMessage', text: 'CCDECK_CHECKPOINT_' + id });
      turn.items.push({ id: 'child-checkpoint', type: 'agentMessage', text: 'CCDECK_CHECKPOINT_' + id });
      await f.c.tick();
    };
    return { ...f, child, childTurn: turn, checkpoint };
  }
  it('reports waiting until the parent really resumes its V2 child and records confirmation without another prompt', async () => {
    const f = await v2();
    expect(await f.c.request({ id: B, revision: 1 })).toMatchObject({ state: 'waiting', continuation: 'waiting' });
    expect(f.calls.some(c => ['turn/interrupt', 'account/login/start'].includes(c.method))).toBe(false);
    await f.checkpoint(); expect(f.c.status()).toMatchObject({ state: 'applied', continuation: 'waiting' });
    expect(f.journals.at(-1)).toMatchObject({ phase: 'pending' });
    await f.c.tick(); expect(f.c.status().continuation).toBe('waiting');
    f.child.status.type = 'active'; f.childTurn.id = 'parent-followup'; f.childTurn.status = 'inProgress';
    await f.c.tick(); expect(f.c.status()).toMatchObject({ state: 'applied', continuation: 'automatic' });
    expect(f.journals.at(-1)).toMatchObject({ phase: 'finished' });
    expect(f.calls.filter(c => c.method === 'turn/start').map(c => c.params.threadId)).toEqual([f.thread.id]);
  });
  it('retains checkpoint subscriptions through child confirmation and releases them on completion or shutdown', async () => {
    const f = await v2(); await f.c.request({ id: B, revision: 1 });
    expect(f.calls.filter(c => c.method === 'thread/resume').map(c => c.params.threadId).sort()).toEqual(['active-thread', 'v2-child']);
    await f.checkpoint();
    expect(f.calls.filter(c => c.method === 'thread/unsubscribe')).toHaveLength(0);
    f.child.status.type = 'active'; f.childTurn.id = 'parent-followup'; f.childTurn.status = 'inProgress';
    await f.c.tick();
    expect(f.c.status().continuation).toBe('automatic');
    expect(f.calls.filter(c => c.method === 'thread/unsubscribe').map(c => c.params.threadId).sort()).toEqual(['active-thread', 'v2-child']);
    const pending = await v2(); await pending.c.request({ id: B, revision: 1 }); await pending.c.close();
    expect(pending.calls.filter(c => c.method === 'thread/unsubscribe')).toHaveLength(2);
  });
  it('leaves an unconfirmed V2 continuation manual after its deadline or a restart without replaying input', async () => {
    const f = await v2({ timeout: 0 }); await f.c.request({ id: B, revision: 1 }); await f.checkpoint(); await f.c.tick();
    expect(f.c.status()).toMatchObject({ continuation: 'manual_required', reason: 'native_continue_unconfirmed' });
    const restored = await fixture({ savedHandoff: f.journals.at(-1) });
    expect(restored.c.status().continuation).toBe('manual_required');
    expect(restored.calls.some(c => c.method === 'turn/start')).toBe(false);
    expect(f.calls.filter(c => c.method === 'turn/start')).toHaveLength(1);
    await f.c.request({ id: A, revision: 2 }); await f.c.tick();
    expect(f.journals.at(-1).phase).toBe('pending');
    expect(f.calls.filter(c => c.method === 'account/login/start')).toHaveLength(1);
    await restored.c.request({ id: B, revision: 1 });
    expect(restored.calls.some(c => c.method === 'account/login/start')).toBe(false);
  });
  it('observes a delayed checkpoint again without replaying the steer or logging in before it is ready', async () => {
    const f = await v2(); await f.c.request({ id: B, revision: 1 });
    f.rpc.request.mockRejectedValueOnce(Object.assign(Error('timeout'), { code: 'native_request_timeout' }));
    await f.c.tick();
    expect(f.c.status()).toMatchObject({ state: 'waiting', continuation: 'waiting' });
    expect(f.calls.filter(c => c.method === 'turn/steer')).toHaveLength(1);
    expect(f.calls.filter(c => c.method === 'account/login/start')).toHaveLength(0);
    await f.checkpoint();
    expect(f.c.status()).toMatchObject({ state: 'applied', continuation: 'waiting' });
    expect(f.calls.filter(c => c.method === 'turn/steer')).toHaveLength(1);
    expect(f.calls.filter(c => c.method === 'account/login/start')).toHaveLength(1);
  });
  it('observes delayed child continuation again only until its original deadline', async () => {
    const f = await v2(); await f.c.request({ id: B, revision: 1 }); await f.checkpoint();
    f.rpc.request.mockRejectedValueOnce(Object.assign(Error('timeout'), { code: 'native_request_timeout' }));
    await f.c.tick(); expect(f.c.status().continuation).toBe('waiting');
    f.child.status.type = 'active'; f.childTurn.id = 'parent-followup'; f.childTurn.status = 'inProgress';
    await f.c.tick(); expect(f.c.status().continuation).toBe('automatic');
    expect(f.calls.filter(c => c.method === 'turn/start')).toHaveLength(1);
    const expired = await v2({ timeout: 0 }); await expired.c.request({ id: B, revision: 1 }); await expired.checkpoint();
    expired.rpc.request.mockRejectedValueOnce(Object.assign(Error('timeout'), { code: 'native_request_timeout' }));
    await expired.c.tick(); expect(expired.c.status().continuation).toBe('manual_required');
    expect(expired.calls.filter(c => c.method === 'turn/start')).toHaveLength(1);
  });
  it('honors an outside login during V2 continuation instead of sending a retry', async () => {
    const f = await v2(); await f.c.request({ id: B, revision: 1 }); await f.checkpoint(); f.externalLogin(A); await f.c.tick();
    expect(f.c.status()).toMatchObject({ state: 'external_change', continuation: 'manual_required' });
    expect(f.calls.filter(c => c.method === 'turn/start')).toHaveLength(1);
  });
  it('keeps a pending manual selection ahead of renewal while V2 resumption is unresolved', async () => {
    const f = await v2({ nearExpiry: true }); await f.c.request({ id: B, revision: 1 }); await f.checkpoint();
    await f.c.request({ id: A, revision: 2 });
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    await f.c.tick();
    f.child.status.type = 'active'; f.childTurn.id = 'late-followup'; f.childTurn.status = 'inProgress';
    await f.c.tick();
    expect(f.c.status().requestedProfileId).toBe(A);
    expect(f.journals.at(-1).profileId).toBe(A);
    expect(f.journals.some(j => j.profileId === B && j.phase === 'finished')).toBe(true);
  });
  it('guards unfinished checkpoint delegation if the parent continuation response is lost', async () => {
    const f = await v2(), original = f.rpc.request.getMockImplementation()!;
    f.rpc.request.mockImplementation(async (method, params) => {
      if (method === 'turn/start') { f.calls.push({ method, params }); throw Error('timeout'); }
      return original(method, params);
    });
    await f.c.request({ id: B, revision: 1 }); await f.checkpoint();
    expect(f.c.status().continuation).toBe('manual_required');
    await f.c.request({ id: A, revision: 2 }); await f.c.tick();
    expect(f.calls.filter(c => c.method === 'account/login/start')).toHaveLength(1);
    expect(f.journals.at(-1).phase).toBe('pending');
  });
  it('retains checkpoint recovery if automatic switching is disabled before authentication', async () => {
    const f = await v2({ auto: true }); await f.c.request({ id: B, revision: 1 }, true);
    f.autoSettings.enabled = false; await f.checkpoint();
    expect(f.c.status().continuation).toBe('manual_required');
    await f.c.request({ id: A, revision: 2 }); await f.c.tick();
    expect(f.calls.some(c => c.method === 'account/login/start')).toBe(false);
    expect(f.journals.at(-1).phase).toBe('pending');
  });
  it('switches authentication only after pausing a waiting parent and its child, then continues the child first', async () => {
    const f = await fixture({ active: true }); const original = f.rpc.request.getMockImplementation()!;
    const child = { id: 'child-thread', parentThreadId: f.thread.id, canAcceptDirectInput: true,
      status: { type: 'active', activeFlags: [] } };
    const childTurn = { id: 'child-turn', rootTurnId: 'root-turn', status: 'inProgress', itemsView: 'full',
      items: [{ id: 'child-input', type: 'userMessage' }] };
    f.turn.items.push({ id: 'wait', type: 'collabAgentToolCall', tool: 'wait', status: 'inProgress',
      senderThreadId: f.thread.id, receiverThreadIds: [child.id] });
    f.rpc.request.mockImplementation(async (method, params) => {
      if (method === 'thread/loaded/list') return { data: [child.id, f.thread.id] };
      if (params?.threadId === child.id) {
        f.calls.push({ method, params });
        if (method === 'thread/read') return { thread: structuredClone(child) };
        if (method === 'thread/turns/list') return { data: [structuredClone(childTurn)] };
        if (method === 'turn/interrupt') { child.status.type = 'idle'; childTurn.status = 'interrupted'; return {}; }
        if (method === 'turn/start') { child.status.type = 'active'; return { turn: { id: 'child-continued' } }; }
      }
      if (method === 'turn/interrupt') f.turn.items[1].status = 'completed';
      return original(method, params);
    });
    expect(await f.c.request({ id: B, revision: 1 })).toMatchObject({ state: 'applied', profileId: B, continuation: 'automatic' });
    expect(f.calls.filter(c => ['turn/interrupt', 'account/login/start', 'turn/start'].includes(c.method))
      .map(c => [c.method, c.params.threadId ?? null])).toEqual([
      ['turn/interrupt', f.thread.id], ['turn/interrupt', child.id], ['account/login/start', null],
      ['turn/start', child.id], ['turn/start', f.thread.id],
    ]);
    expect(f.journals.at(-1)).toMatchObject({ phase: 'finished', entries: [
      { threadId: f.thread.id, phase: 'continued' }, { threadId: child.id, parentThreadId: f.thread.id, phase: 'continued' },
    ] });
    expect(JSON.stringify(f.journals)).not.toContain('fictional-access');
  });
  it('waits for an existing tool, switches after a clean interrupt and automatically continues once', async () => {
    const f = await fixture({ active: true }); f.turn.items.push({ id: 'command', type: 'commandExecution', status: 'inProgress' });
    expect(await f.c.request({ id: B, revision: 1 })).toMatchObject({ state: 'waiting', continuation: 'waiting' });
    expect(f.calls.some(c => ['turn/interrupt', 'account/login/start'].includes(c.method))).toBe(false);
    f.turn.items[1].status = 'completed'; await f.c.tick();
    expect(f.c.status()).toMatchObject({ state: 'applied', profileId: B, continuation: 'automatic' });
    expect(f.calls.filter(c => c.method === 'turn/start')).toHaveLength(1);
    expect(f.calls.findIndex(c => c.method === 'turn/interrupt')).toBeLessThan(f.calls.findIndex(c => c.method === 'account/login/start'));
    expect(f.journals.at(-1)).toMatchObject({ phase: 'finished', entries: [{ threadId: 'active-thread', phase: 'continued' }] });
    expect(JSON.stringify(f.journals)).not.toContain('fictional-access');
  });
  it.each(['lease', 'account'])('does not resume after losing %s control during a handoff', async loss => {
    const f = await fixture({ active: true });
    if (loss === 'lease') f.lease.valid.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false);
    else {
      const original = f.rpc.request.getMockImplementation()!;
      f.rpc.request.mockImplementation(async (method, params) => {
        if (method === 'account/read' && f.turn.status === 'interrupted') f.externalLogin(B);
        return original(method, params);
      });
    }
    const result = await f.c.request({ id: B, revision: 1 });
    expect(result).toMatchObject({ state: 'failed', continuation: 'manual_required' });
    expect(f.calls.some(c => ['turn/start', 'account/login/start'].includes(c.method))).toBe(false);
  });
  it('reports manual recovery for a rejected native login after interruption', async () => {
    const f = await fixture({ active: true }); const original = f.rpc.request.getMockImplementation()!;
    f.rpc.request.mockImplementation(async (method, params) => { if (method === 'account/login/start') throw Object.assign(Error('rejected'), { code: 'native_request_rejected' }); return original(method, params); });
    expect(await f.c.request({ id: B, revision: 1 })).toMatchObject({ state: 'failed', continuation: 'manual_required' });
    expect(f.turn.status).toBe('interrupted');
    expect(f.calls.some(c => c.method === 'turn/start')).toBe(false);
  });
  it('cancels a deferred automatic move when Auto-switch is disabled', async () => {
    const f = await fixture({ active: true, auto: true }); f.thread.status.type = 'idle'; f.turn.status = 'completed';
    await f.c.request({ id: A, revision: 1 });
    f.thread.status.type = 'active'; f.turn.status = 'inProgress'; f.turn.items.push({ id: 'tool', type: 'dynamicToolCall', status: 'inProgress' });
    f.selection.profileId = B; f.selection.revision = 2; await f.c.tick();
    expect(f.c.status().state).toBe('waiting');
    f.autoSettings.enabled = false; f.turn.items[1].status = 'completed'; await f.c.tick();
    expect(f.c.status()).toMatchObject({ profileId: A, reason: 'auto_switch_disabled' });
    expect(f.calls.filter(c => c.method === 'account/login/start').map(c => c.params.chatgptAccountId)).toEqual(['first']);
  });
  it('does not resend an uncertain Continue, including after restoring ownership', async () => {
    const f = await fixture({ active: true }); const original = f.rpc.request.getMockImplementation()!;
    let starts = 0;
    f.rpc.request.mockImplementation(async (method, params) => { if (method === 'turn/start') { starts++; throw Error('connection ended'); } return original(method, params); });
    expect(await f.c.request({ id: B, revision: 1 })).toMatchObject({ state: 'applied', continuation: 'manual_required' });
    await f.c.tick(); await f.c.request({ id: B, revision: 1 }); expect(starts).toBe(1);
    const restored = await fixture({ actual: B, saved: f.persisted.at(-1), savedHandoff: f.journals.at(-1) });
    expect(restored.c.status()).toMatchObject({ state: 'applied', continuation: 'manual_required', reason: 'native_continue_unconfirmed' });
    expect(restored.calls.some(c => c.method === 'turn/start')).toBe(false);
  });
  it.each([false, true])('reports an unfinished handoff journal even without successfully restored ownership: %s', async prior => {
    const endpoint = createHash('sha256').update('native-generation').digest('hex');
    const f = await fixture({ actual: A,
      saved: prior ? { version: 1, wasControlling: true, profileId: A, revision: 1, endpoint } : null,
      initial: { profileId: B, revision: 2, runningSelection: { id: B, revision: 2 } },
      savedHandoff: { version: 1, phase: 'paused', entries: [{ threadId: 'active-thread', turnId: 'interrupted-turn', phase: 'paused' }] } });
    expect(f.c.status()).toMatchObject({ continuation: 'manual_required', reason: 'native_continue_unconfirmed' });
    expect(f.calls.some(c => c.method === 'turn/start')).toBe(false);
  });
  it('changes native authentication without interrupting, resuming or stopping existing threads', async () => {
    const f = await fixture();
    expect(f.calls).toHaveLength(0);
    const result = await f.c.request({ id: B, revision: 1 });
    expect(result).toMatchObject({ state: 'applied', profileId: B, scope: 'shared_native_server' });
    expect(f.actual().email).toBe('second@example.test');
    expect(f.calls.filter(c => c.method === 'account/login/start')).toHaveLength(1);
    expect(f.rpc.close).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('fictional-access');
    expect(JSON.stringify(f.persisted)).not.toContain('fictional-access');
    await f.c.close();
    expect(f.rpc.close).toHaveBeenCalledOnce();
    expect(f.calls.some(c => /logout|interrupt|resume/.test(c.method))).toBe(false);
  });
  it('supersedes an unsent selection and submits only the most recent requested identity', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void; const waiting = new Promise<void>(resolve => { entered = resolve; });
    let f: Awaited<ReturnType<typeof fixture>>;
    f = await fixture({ readCredential: async (id: string) => { if (id === A) { entered(); await blocked; } return f.credential(id); } });
    const first = f.c.request({ id: A, revision: 1 }); await waiting;
    const second = f.c.request({ id: B, revision: 2 }); release();
    await Promise.all([first, second]);
    expect(f.calls.filter(c => c.method === 'account/login/start').map(c => c.params.chatgptAccountId)).toEqual(['second']);
    expect(f.c.status().profileId).toBe(B);
  });
  it('does not replay a timed-out native login or expose its raw error', async () => {
    const f = await fixture();
    f.rpc.request.mockImplementation(async (method: string) => {
      if (method === 'account/read') return { account: f.actual() } as any;
      if (method === 'thread/loaded/list') return { data: [] } as any;
      throw Object.assign(new Error('private native detail'), { code: 'native_request_timeout' });
    });
    const result = await f.c.request({ id: B, revision: 1 });
    await f.c.request({ id: B, revision: 1 }); await f.c.tick();
    expect(result).toMatchObject({ state: 'failed', profileId: null, reason: 'native_request_timeout' });
    expect(JSON.stringify(result)).not.toContain('private native detail');
    expect(f.rpc.request.mock.calls.filter(c => c[0] === 'account/login/start')).toHaveLength(1);
  });
  it('serializes a credential refresh before a new identity and ignores unrelated server requests', async () => {
    const f = await fixture(); await f.c.request({ id: A, revision: 1 });
    await f.serverRequest({ id: 'approval', method: 'item/commandExecution/requestApproval', params: {} });
    await f.serverRequest({ id: 'foreign', method: 'account/chatgptAuthTokens/refresh', params: { previousAccountId: 'unowned' } });
    expect(f.sent).toHaveLength(0);
    const refreshing = f.serverRequest({ id: 'refresh', method: 'account/chatgptAuthTokens/refresh', params: { previousAccountId: 'first' } });
    const changing = f.c.request({ id: B, revision: 2 });
    await Promise.all([refreshing, changing]);
    expect(f.sent).toEqual([{ id: 'refresh', result: { accessToken: `fictional-access-${A}`, chatgptAccountId: 'first', chatgptPlanType: 'plus' } }]);
    expect(f.actual().email).toBe('second@example.test');
  });
  it('honors a native login performed outside ccdeck instead of changing it back', async () => {
    const f = await fixture(); await f.c.request({ id: B, revision: 1 });
    f.externalLogin(A);
    await new Promise(resolve => setTimeout(resolve, 0)); await f.c.tick();
    expect(f.c.status()).toMatchObject({ state: 'external_change', profileId: null });
    expect(f.persisted.at(-1).wasControlling).toBe(false);
    expect(f.calls.filter(c => c.method === 'account/login/start')).toHaveLength(1);
  });
  it('pauses ownership for an unsolicited account update even with the same email', async () => {
    const f = await fixture(); await f.c.request({ id: B, revision: 1 });
    f.notify({ method: 'account/updated', params: { authMode: 'chatgptAuthTokens' } });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.c.status().state).toBe('external_change');
    expect(f.lease.release).toHaveBeenCalledOnce();
  });
  it('keeps live renewal ownership if metadata persistence fails after a successful native login', async () => {
    const f = await fixture({ persistError: true });
    expect(await f.c.request({ id: B, revision: 1 })).toMatchObject({ state: 'applied', profileId: B, reason: 'ownership_not_saved' });
    await f.serverRequest({ id: 'refresh', method: 'account/chatgptAuthTokens/refresh', params: { previousAccountId: 'second' } });
    expect(f.sent[0].result.chatgptAccountId).toBe('second');
    expect(f.rpc.close).not.toHaveBeenCalled();
  });
  it('rejects a stale renewal queued behind a committed account change', async () => {
    let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    let f: Awaited<ReturnType<typeof fixture>>;
    const reads: string[] = [];
    f = await fixture({ readCredential: async (id: string) => { reads.push(id); if (id === B) { entered(); await blocked; } return f.credential(id); } });
    await f.c.request({ id: A, revision: 1 });
    const changing = f.c.request({ id: B, revision: 2 }); await waiting;
    const refresh = f.serverRequest({ id: 'late-refresh', method: 'account/chatgptAuthTokens/refresh', params: { previousAccountId: 'first' } });
    release(); await Promise.all([changing, refresh]);
    expect(reads).toEqual([A, B]);
    expect(f.sent).toEqual([{ id: 'late-refresh', error: { code: -32000, message: 'Codex account changed during renewal.' } }]);
    expect(f.actual().email).toBe('second@example.test');
  });
  it.each([true, false])('renews an expiring credential before login and rejects one still expiring: %s', async renewed => {
    let f: Awaited<ReturnType<typeof fixture>>;
    const reads: boolean[] = [];
    f = await fixture({ readCredential: async (id: string, options: any) => {
      reads.push(options.refresh);
      return { ...f.credential(id), expiresAt: Date.now() + (options.refresh && renewed ? 3600_000 : 10_000) };
    } });
    const result = await f.c.request({ id: B, revision: 1 });
    expect(reads).toEqual([false, true]);
    expect(result.state).toBe(renewed ? 'applied' : 'failed');
    expect(f.calls.filter(c => c.method === 'account/login/start')).toHaveLength(renewed ? 1 : 0);
  });
  it('restores its saved refresh ownership without a logout when the daemon still uses that account', async () => {
    const endpoint = createHash('sha256').update('native-generation').digest('hex');
    const f = await fixture({ actual: B, saved: { version: 1, wasControlling: true, profileId: B, revision: 3, endpoint } });
    expect(f.c.status()).toMatchObject({ state: 'applied', profileId: B });
    expect(f.calls.filter(c => c.method === 'account/login/start')).toHaveLength(0);
    await f.serverRequest({ id: 'restore-refresh', method: 'account/chatgptAuthTokens/refresh', params: { previousAccountId: 'second' } });
    expect(f.sent[0].result.chatgptAccountId).toBe('second');
    expect(f.calls.some(c => c.method === 'account/logout')).toBe(false);
  });
  it('does not restore an old selection over a native login changed while ccdeck was closed', async () => {
    const endpoint = createHash('sha256').update('native-generation').digest('hex');
    const f = await fixture({ actual: A, saved: { version: 1, wasControlling: true, profileId: B, revision: 3, endpoint } });
    expect(f.c.status().state).toBe('external_change');
    expect(f.calls.some(c => c.method === 'account/login/start')).toBe(false);
    expect(f.rpc.close).toHaveBeenCalledOnce();
    expect(f.lease.release).toHaveBeenCalledOnce();
  });
  it('restores automatic selection ownership when the last manual selection is older', async () => {
    const endpoint = createHash('sha256').update('native-generation').digest('hex');
    const f = await fixture({ actual: B, auto: true,
      saved: { version: 1, wasControlling: true, profileId: B, revision: 3, endpoint },
      initial: { profileId: B, revision: 3, runningSelection: { id: A, revision: 1 } } });
    expect(f.c.status()).toMatchObject({ state: 'applied', profileId: B });
    expect(f.calls.some(c => c.method === 'account/login/start')).toBe(false);
    await f.serverRequest({ id: 'auto-refresh', method: 'account/chatgptAuthTokens/refresh', params: { previousAccountId: 'second' } });
    expect(f.sent[0].result.chatgptAccountId).toBe('second');
  });
  it.each([A, B])('reconciles an unacknowledged newer selection after restart without replaying login, actual=%s', async actual => {
    const endpoint = createHash('sha256').update('native-generation').digest('hex');
    const f = await fixture({ actual,
      saved: { version: 1, wasControlling: true, profileId: A, revision: 1, endpoint },
      initial: { profileId: B, revision: 2, runningSelection: { id: B, revision: 2 } } });
    expect(f.c.status()).toMatchObject({ state: actual === B ? 'applied' : 'failed', profileId: actual, requestedProfileId: B });
    expect(f.calls.some(c => c.method === 'account/login/start')).toBe(false);
    await f.c.tick();
    expect(f.calls.some(c => c.method === 'account/login/start')).toBe(false);
    await f.serverRequest({ id: 'reconciled-refresh', method: 'account/chatgptAuthTokens/refresh', params: { previousAccountId: actual === A ? 'first' : 'second' } });
    expect(f.sent[0].result.chatgptAccountId).toBe(actual === A ? 'first' : 'second');
  });
  it('keeps the surviving saved login renewed when an unconfirmed target credential is unavailable', async () => {
    const endpoint = createHash('sha256').update('native-generation').digest('hex');
    const f = await fixture({ actual: A,
      saved: { version: 1, wasControlling: true, profileId: A, revision: 1, endpoint },
      initial: { profileId: B, revision: 2, runningSelection: { id: B, revision: 2 } },
      readCredential: async (id: string) => {
        if (id === B) throw Error('target unavailable');
        return { profileId: A, accessToken: 'fictional-access', accountId: 'first', email: 'first@example.test', planType: 'plus', expiresAt: Date.now() + 3600_000 };
      } });
    expect(f.c.status()).toMatchObject({ state: 'failed', profileId: A, requestedProfileId: B });
    await f.serverRequest({ id: 'surviving-refresh', method: 'account/chatgptAuthTokens/refresh', params: { previousAccountId: 'first' } });
    expect(f.sent[0].result.chatgptAccountId).toBe('first');
    expect(f.calls.some(c => c.method === 'account/login/start')).toBe(false);
  });
  it('retries saved ownership discovery when the native daemon starts after ccdeck', async () => {
    const endpoint = createHash('sha256').update('native-generation').digest('hex');
    const resolveEndpoint = vi.fn().mockRejectedValueOnce(Object.assign(Error('offline'), { code: 'native_not_running' }))
      .mockResolvedValue({ home: '/native-home', generation: 'native-generation' });
    const f = await fixture({ actual: B, saved: { version: 1, wasControlling: true, profileId: B, revision: 3, endpoint }, resolveEndpoint });
    expect(f.c.status().state).toBe('unavailable');
    await f.c.tick();
    expect(f.c.status()).toMatchObject({ state: 'applied', profileId: B });
    expect(resolveEndpoint).toHaveBeenCalledTimes(2);
    expect(f.calls.some(c => c.method === 'account/login/start')).toBe(false);
  });
  it('asks native Codex to renew an expired source token once before changing live authentication', async () => {
    let f: Awaited<ReturnType<typeof fixture>>;
    const reads: boolean[] = [];
    f = await fixture({ readCredential: async (id: string, options: any) => {
      reads.push(options.refresh); if (!options.refresh) throw Object.assign(Error('expired'), { code: 'credential_expired' });
      return f.credential(id);
    } });
    expect((await f.c.request({ id: B, revision: 1 })).state).toBe('applied');
    expect(reads).toEqual([false, true]);
    expect(f.calls.filter(c => c.method === 'account/login/start')).toHaveLength(1);
  });
  it('reconnects to a surviving daemon without logging in again or retrying a failed selection', async () => {
    let f: Awaited<ReturnType<typeof fixture>>;
    const reads: string[] = [];
    f = await fixture({ readCredential: async (id: string) => {
      reads.push(id); if (id === B) throw Error('credential unavailable'); return f.credential(id);
    } });
    await f.c.request({ id: A, revision: 1 });
    expect((await f.c.request({ id: B, revision: 2 })).state).toBe('failed');
    f.disconnect(); await f.c.tick();
    expect(f.c.status()).toMatchObject({ state: 'applied', profileId: A, requestedProfileId: B });
    expect(f.calls.filter(c => c.method === 'account/login/start')).toHaveLength(1);
    expect(reads).toEqual([A, B]);
    await f.serverRequest({ id: 'old-account-refresh', method: 'account/chatgptAuthTokens/refresh', params: { previousAccountId: 'first' } });
    expect(f.sent[0].result.chatgptAccountId).toBe('first');
  });
  it.each([false, true])('follows an automatic default change only with Auto-switch enabled=%s', async auto => {
    const f = await fixture({ auto }); await f.c.request({ id: A, revision: 1 });
    f.selection.profileId = B; f.selection.revision = 2;
    await f.c.tick();
    expect(f.c.status().profileId).toBe(auto ? B : A);
  });
});
