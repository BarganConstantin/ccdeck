import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error server module
import { prepareCodexLiveHandoff, continueCodexLiveHandoff } from '../../server/codex-live-handoff.mjs';
function fixture() {
  const turn = { id: 'turn-one', rootTurnId: 'root-turn', status: 'inProgress', itemsView: 'full', items: [{ id: 'input', type: 'userMessage' }, { id: 'reason', type: 'reasoning' }] as any[] };
  const thread = { id: 'thread-one', parentThreadId: null as string | null, historyMode: 'legacy', status: { type: 'active', activeFlags: [] as string[] } };
  const rpc = { request: vi.fn(async (method: string, params: any) => {
    if (method === 'thread/loaded/list') return { data: [thread.id] };
    if (method === 'thread/read') return { thread: { ...thread } };
    if (method === 'thread/turns/list') return { data: [{ ...turn, items: [...turn.items] }] };
    if (method === 'thread/resume') return { thread, initialTurnsPage: { data: [{ ...turn, items: [...turn.items] }] } };
    if (method === 'thread/unsubscribe') return {};
    if (method === 'turn/interrupt') { expect(params.turnId).toBe(turn.id); turn.status = 'interrupted'; thread.status.type = 'idle'; return {}; }
    if (method === 'turn/start') { thread.status.type = 'active'; return { turn: { id: 'continued-turn' } }; }
    throw Error('Unexpected method');
  }) };
  return { turn, thread, rpc };
}
function familyFixture(nested = false) {
  const ids = nested ? ['parent', 'child', 'grandchild'] : ['parent', 'child'];
  const threads = ids.map((id, i) => ({ id, parentThreadId: i ? ids[i - 1] : null,
    canAcceptDirectInput: true, historyMode: 'legacy', status: { type: 'active', activeFlags: [] as string[] } }));
  const turns = ids.map(id => ({ id: id + '-turn', rootTurnId: 'family-root', status: 'inProgress', itemsView: 'full',
    items: [{ id: id + '-input', type: 'userMessage' }] as any[] }));
  const rpc = { request: vi.fn(async (method: string, params: any) => {
    if (method === 'thread/loaded/list') return { data: [...ids].reverse() };
    const i = ids.indexOf(params.threadId), thread = threads[i], turn = turns[i];
    if (method === 'thread/read') return { thread: structuredClone(thread) };
    if (method === 'thread/turns/list') return { data: [structuredClone(turn)] };
    if (method === 'turn/interrupt') {
      expect(params.turnId).toBe(turn.id); thread.status.type = 'idle'; turn.status = 'interrupted';
      for (const item of turn.items) if (item.type === 'collabAgentToolCall' && item.tool === 'wait') item.status = 'completed';
      return {};
    }
    if (method === 'turn/start') { thread.status.type = 'active'; return { turn: { id: params.threadId + '-continued' } }; }
    throw Error('Unexpected method');
  }) };
  const wait = (sender: number, receiver: number) => turns[sender].items.push({ id: 'wait-' + sender, type: 'collabAgentToolCall',
    status: 'inProgress', tool: 'wait', senderThreadId: ids[sender], receiverThreadIds: [ids[receiver]] });
  return { threads, turns, rpc, wait };
}
describe('native account handoff without network-permit revocation', () => {
  it('pauses parents before children and resumes children before their parents in the same threads', async () => {
    const f = familyFixture(true); f.wait(0, 1); f.wait(1, 2);
    const h = await prepareCodexLiveHandoff(f.rpc);
    expect(h.waiting).toBe(false);
    expect(f.rpc.request.mock.calls.filter(c => c[0] === 'turn/interrupt').map(c => c[1].threadId)).toEqual(['parent', 'child', 'grandchild']);
    expect(h.paused).toMatchObject([{ threadId: 'parent' }, { threadId: 'child', parentThreadId: 'parent' }, { threadId: 'grandchild', parentThreadId: 'child' }]);
    expect(await continueCodexLiveHandoff(f.rpc, h)).toEqual({ resumed: 3 });
    const starts = f.rpc.request.mock.calls.filter(c => c[0] === 'turn/start');
    expect(starts.map(c => c[1].threadId)).toEqual(['grandchild', 'child', 'parent']);
    expect(starts.every(c => c[1].rootTurnId === 'family-root')).toBe(true);
    await continueCodexLiveHandoff(f.rpc, h);
    expect(f.rpc.request.mock.calls.filter(c => c[0] === 'turn/start')).toHaveLength(3);
  });
  it('still waits for an actual child command while the parent waits for that child', async () => {
    const f = familyFixture(); f.wait(0, 1);
    f.turns[1].items.push({ id: 'shell', type: 'commandExecution', status: 'inProgress' });
    expect(await prepareCodexLiveHandoff(f.rpc)).toEqual({ waiting: true, paused: [] });
    expect(f.rpc.request.mock.calls.some(c => c[0] === 'turn/interrupt')).toBe(false);
  });
  it.each([false, undefined])('leaves a child without confirmed direct-input support untouched: %s', async supported => {
    const f = familyFixture(); f.threads[1].canAcceptDirectInput = supported as any;
    expect((await prepareCodexLiveHandoff(f.rpc)).waiting).toBe(true);
    expect(f.rpc.request.mock.calls.some(c => c[0] === 'turn/interrupt')).toBe(false);
  });
  it.each(['missing', 'parent'])('does not treat a wait on %s as a safe child wait', async target => {
    const f = familyFixture(); f.wait(0, 1); f.turns[0].items[1].receiverThreadIds = [target];
    expect((await prepareCodexLiveHandoff(f.rpc)).waiting).toBe(true);
    expect(f.rpc.request.mock.calls.some(c => c[0] === 'turn/interrupt')).toBe(false);
  });
  it.each(['spawnAgent', 'sendInput', 'closeAgent'])('does not interrupt an active %s operation in a family', async tool => {
    const f = familyFixture(); f.wait(0, 1); f.turns[0].items[1].tool = tool;
    expect((await prepareCodexLiveHandoff(f.rpc)).waiting).toBe(true);
  });
  it('does not resume a paused child that loses direct-input support', async () => {
    const f = familyFixture(); const h = await prepareCodexLiveHandoff(f.rpc);
    expect(h.paused).toHaveLength(2); f.threads[1].canAcceptDirectInput = false;
    await expect(continueCodexLiveHandoff(f.rpc, h)).rejects.toMatchObject({ code: 'native_activity_changed' });
    expect(f.rpc.request.mock.calls.some(c => c[0] === 'turn/start')).toBe(false);
  });
  it('leaves a closed child unloaded while still continuing its parent', async () => {
    const f = familyFixture(); const h = await prepareCodexLiveHandoff(f.rpc);
    f.threads[1].status.type = 'notLoaded'; f.threads[1].canAcceptDirectInput = null as any;
    f.rpc.request.mockClear(); const skipped = vi.fn();
    expect(await continueCodexLiveHandoff(f.rpc, h, { onSkip: skipped })).toEqual({ resumed: 1 });
    expect(skipped).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'child' }));
    expect(f.rpc.request.mock.calls.filter(c => c[1]?.threadId === 'child').map(c => c[0])).toEqual(['thread/read']);
    expect(f.rpc.request.mock.calls.filter(c => c[0] === 'turn/start').map(c => c[1].threadId)).toEqual(['parent']);
  });
  it.each(['missing', 'child'])('refuses missing or cyclic family ancestry before interrupting: %s', async parent => {
    const f = familyFixture(); f.threads[0].parentThreadId = parent;
    await expect(prepareCodexLiveHandoff(f.rpc)).rejects.toMatchObject({ code: 'native_activity_unknown' });
    expect(f.rpc.request.mock.calls.some(c => c[0] === 'turn/interrupt')).toBe(false);
  });
  it('does not request unsupported stored history from an idle ephemeral conversation', async () => {
    const f = fixture(); const original = f.rpc.request.getMockImplementation()!;
    f.rpc.request.mockImplementation(async (method, params) => {
      if (method === 'thread/loaded/list') return { data: ['ephemeral-idle', f.thread.id] };
      if (params.threadId === 'ephemeral-idle') {
        if (method === 'thread/read') return { thread: { id: 'ephemeral-idle', ephemeral: true, historyMode: 'paginated', status: { type: 'idle' } } };
        throw Object.assign(Error('ephemeral threads do not support thread/turns/list'), { code: 'native_request_rejected' });
      }
      return original(method, params);
    });
    const h = await prepareCodexLiveHandoff(f.rpc);
    expect(h.waiting).toBe(false); expect(h.paused).toHaveLength(1);
    expect(f.rpc.request.mock.calls.filter(c => c[1]?.threadId === 'ephemeral-idle').map(c => c[0])).toEqual(['thread/read', 'thread/read', 'thread/read', 'thread/read']);
  });
  it.each(['active', 'systemError', 'notLoaded'])('waits for an ephemeral conversation with state %s without attempting history or interrupt', async type => {
    const f = fixture(); const original = f.rpc.request.getMockImplementation()!;
    f.rpc.request.mockImplementation(async (method, params) => {
      if (method === 'thread/read') return { thread: { ...f.thread, ephemeral: true, status: { type, activeFlags: [] } } };
      return original(method, params);
    });
    expect((await prepareCodexLiveHandoff(f.rpc)).waiting).toBe(true);
    expect(f.rpc.request.mock.calls.map(c => c[0])).toEqual(['thread/loaded/list', 'thread/read']);
  });
  it('does not ignore an ephemeral conversation that becomes active on the confirmation read', async () => {
    const f = fixture(); let reads = 0; const original = f.rpc.request.getMockImplementation()!;
    f.rpc.request.mockImplementation(async (method, params) => {
      if (method === 'thread/read') return { thread: { ...f.thread, ephemeral: true, status: { type: ++reads === 1 ? 'idle' : 'active', activeFlags: [] } } };
      return original(method, params);
    });
    expect((await prepareCodexLiveHandoff(f.rpc)).waiting).toBe(true);
    expect(f.rpc.request.mock.calls.some(c => ['thread/turns/list', 'turn/interrupt'].includes(c[0]))).toBe(false);
  });
  it('recognizes a finished native web search through its completion timestamp', async () => {
    const f = fixture(); f.turn.items.push({ id: 'search', type: 'webSearch', startedAtMs: 100, completedAtMs: 200 });
    const h = await prepareCodexLiveHandoff(f.rpc);
    expect(h.waiting).toBe(false); expect(h.paused).toHaveLength(1);
  });
  it.each([null, undefined, 0, NaN])('waits for native web search without a valid completion timestamp: %s', async end => {
    const f = fixture(); f.turn.items.push({ id: 'search', type: 'webSearch', startedAtMs: 100, completedAtMs: end });
    expect((await prepareCodexLiveHandoff(f.rpc)).waiting).toBe(true);
  });
  it('does not treat an explicitly running tool as finished because of a stale timestamp', async () => {
    const f = fixture(); f.turn.items.push({ id: 'search', type: 'webSearch', status: 'inProgress', completedAtMs: 200 });
    expect((await prepareCodexLiveHandoff(f.rpc)).waiting).toBe(true);
  });
  it('ignores a confirmed idle thread whose history is not materialized before its first message', async () => {
    const f = fixture(); const original = f.rpc.request.getMockImplementation()!;
    f.rpc.request.mockImplementation(async (method, params) => {
      if (method === 'thread/loaded/list') return { data: ['empty-thread', f.thread.id] };
      if (params.threadId === 'empty-thread') {
        if (method === 'thread/read') return { thread: { id: 'empty-thread', status: { type: 'idle' }, historyMode: 'paginated' } };
        throw Object.assign(Error('not materialized'), { code: 'native_thread_not_materialized' });
      }
      return original(method, params);
    });
    const handoff = await prepareCodexLiveHandoff(f.rpc);
    expect(handoff.waiting).toBe(false);
    expect(handoff.paused).toMatchObject([{ threadId: f.thread.id }]);
    expect(f.rpc.request.mock.calls.some(c => ['turn/interrupt', 'thread/resume'].includes(c[0]) && c[1].threadId === 'empty-thread')).toBe(false);
  });
  it('waits when an unmaterialized idle thread receives work between observations', async () => {
    const f = fixture(); f.thread.status.type = 'idle'; let reads = 0; const original = f.rpc.request.getMockImplementation()!;
    f.rpc.request.mockImplementation(async (method, params) => {
      if (method === 'thread/read' && ++reads === 2) f.thread.status.type = 'active';
      if (method === 'thread/turns/list') throw Object.assign(Error('not materialized'), { code: 'native_thread_not_materialized' });
      return original(method, params);
    });
    expect((await prepareCodexLiveHandoff(f.rpc)).waiting).toBe(true);
    expect(f.rpc.request.mock.calls.some(c => c[0] === 'turn/interrupt')).toBe(false);
  });
  it('does not hide other rejected history reads on an idle thread', async () => {
    const f = fixture(); f.thread.status.type = 'idle'; const original = f.rpc.request.getMockImplementation()!;
    f.rpc.request.mockImplementation(async (method, params) => {
      if (method === 'thread/turns/list') throw Object.assign(Error('rejected'), { code: 'native_request_rejected' });
      return original(method, params);
    });
    await expect(prepareCodexLiveHandoff(f.rpc)).rejects.toMatchObject({ code: 'native_request_rejected' });
  });
  it('interrupts only an observed response, then continues the exact thread once without permission overrides', async () => {
    const { rpc } = fixture(); const journal = vi.fn(async () => {});
    const handoff = await prepareCodexLiveHandoff(rpc);
    expect(handoff.paused).toMatchObject([{ threadId: 'thread-one', turnId: 'turn-one' }]);
    expect(await continueCodexLiveHandoff(rpc, handoff, { beforeSend: journal })).toEqual({ resumed: 1 });
    await continueCodexLiveHandoff(rpc, handoff, { beforeSend: journal });
    const starts = rpc.request.mock.calls.filter(c => c[0] === 'turn/start'); expect(starts).toHaveLength(1);
    expect(starts[0][1]).toMatchObject({ threadId: 'thread-one', rootTurnId: 'root-turn' });
    expect(Object.keys(starts[0][1]).sort()).toEqual(['clientUserMessageId', 'input', 'rootTurnId', 'threadId']);
    expect(journal).toHaveBeenCalledOnce();
  });
  it('preserves follow-up messages already recorded in a working turn instead of waiting forever', async () => {
    const f = fixture(); f.turn.items.push({ id: 'followup', type: 'userMessage' });
    const h = await prepareCodexLiveHandoff(f.rpc);
    expect(h.waiting).toBe(false); expect(h.paused[0].inputIds).toEqual(['input', 'followup']);
    expect(await continueCodexLiveHandoff(f.rpc, h)).toEqual({ resumed: 1 });
  });
  it('does not interrupt if new input arrives after the initial snapshot in the same turn', async () => {
    const f = fixture(); let reads = 0; const original = f.rpc.request.getMockImplementation()!;
    f.rpc.request.mockImplementation(async (method, params) => {
      if (method === 'thread/turns/list' && ++reads === 2) f.turn.items.push({ id: 'new-input', type: 'userMessage' });
      return original(method, params);
    });
    await expect(prepareCodexLiveHandoff(f.rpc)).rejects.toMatchObject({ code: 'native_activity_changed' });
    expect(f.rpc.request.mock.calls.some(c => c[0] === 'turn/interrupt')).toBe(false);
  });
  it('does not append Continue over input added to an interrupted turn', async () => {
    const f = fixture(); const h = await prepareCodexLiveHandoff(f.rpc);
    f.turn.items.push({ id: 'new-input', type: 'userMessage' });
    expect(await continueCodexLiveHandoff(f.rpc, h)).toEqual({ resumed: 0 });
    expect(f.rpc.request.mock.calls.some(c => c[0] === 'turn/start')).toBe(false);
  });
  it.each(['commandExecution', 'mcpToolCall', 'dynamicToolCall', 'fileChange', 'collabAgentToolCall'])('waits for an active %s without interrupting or sending input', async type => {
    const { rpc, turn } = fixture(); turn.items.push({ id: 'tool', type, status: 'inProgress' });
    expect(await prepareCodexLiveHandoff(rpc)).toEqual({ waiting: true, paused: [] });
    expect(rpc.request.mock.calls.some(c => c[0].startsWith('turn/'))).toBe(false);
  });
  it.each(['waitingOnApproval', 'waitingOnUserInput'])('preserves %s instead of answering or cancelling it', async flag => {
    const { rpc, thread } = fixture(); thread.status.activeFlags.push(flag);
    expect((await prepareCodexLiveHandoff(rpc)).waiting).toBe(true);
    expect(rpc.request.mock.calls.some(c => c[0] === 'turn/interrupt')).toBe(false);
  });
  it('waits for a child agent and an unfinished PTY even when its original turn is terminal', async () => {
    const f = fixture(); f.thread.parentThreadId = 'parent';
    expect((await prepareCodexLiveHandoff(f.rpc)).waiting).toBe(true);
    f.thread.parentThreadId = null; f.thread.status.type = 'idle'; f.turn.status = 'completed';
    f.turn.items.push({ id: 'pty', type: 'commandExecution', status: 'inProgress', processId: '123' });
    expect((await prepareCodexLiveHandoff(f.rpc)).waiting).toBe(true);
  });
  it('refuses a contradictory idle-thread/in-progress-turn snapshot', async () => {
    const f = fixture(); f.thread.status.type = 'idle';
    expect((await prepareCodexLiveHandoff(f.rpc)).waiting).toBe(true);
    expect(f.rpc.request.mock.calls.some(c => c[0] === 'turn/interrupt')).toBe(false);
  });
  it.each(['notLoaded', 'summary'])('fails closed on a %s item snapshot', async view => {
    const f = fixture(); f.turn.itemsView = view;
    expect((await prepareCodexLiveHandoff(f.rpc)).waiting).toBe(true);
  });
  it('waits for an empty live snapshot instead of assuming model-only work', async () => {
    const f = fixture(); f.turn.items = [];
    expect((await prepareCodexLiveHandoff(f.rpc)).waiting).toBe(true);
    expect(f.rpc.request.mock.calls.some(c => c[0] === 'turn/interrupt')).toBe(false);
  });
  it('does not automatically interrupt unknown tool lifecycles', async () => {
    const f = fixture(); f.turn.items.push({ id: 'future', type: 'futureTool' });
    expect((await prepareCodexLiveHandoff(f.rpc)).waiting).toBe(true);
  });
  it('uses a native live snapshot for paginated threads and detaches without changing thread settings', async () => {
    const f = fixture(); f.thread.historyMode = 'paginated';
    const handoff = await prepareCodexLiveHandoff(f.rpc); expect(handoff.paused).toHaveLength(1);
    const resumes = f.rpc.request.mock.calls.filter(c => c[0] === 'thread/resume');
    expect(resumes[0][1]).toEqual({ threadId: 'thread-one', excludeTurns: true, initialTurnsPage: { limit: 1, sortDirection: 'desc', itemsView: 'full' } });
    expect(f.rpc.request.mock.calls.filter(c => c[0] === 'thread/unsubscribe')).toHaveLength(resumes.length);
  });
  it('does not mistake a missing stored tool-start event for a safe paginated response', async () => {
    const f = fixture(); f.thread.historyMode = 'paginated'; const original = f.rpc.request.getMockImplementation()!;
    f.rpc.request.mockImplementation(async (method, params) => {
      if (method === 'thread/turns/list') return { data: [{ ...f.turn, items: [] }] };
      if (method === 'thread/resume') return { thread: f.thread, initialTurnsPage: { data: [{ ...f.turn, items: [{ id: 'active-command', type: 'commandExecution', status: 'inProgress' }] }] } };
      return original(method, params);
    });
    expect((await prepareCodexLiveHandoff(f.rpc)).waiting).toBe(true);
    expect(f.rpc.request.mock.calls.some(c => c[0] === 'turn/interrupt')).toBe(false);
  });
  it('leaves a naturally completed response idle even if its completion acknowledges the interrupt', async () => {
    const f = fixture(); const original = f.rpc.request.getMockImplementation()!;
    f.rpc.request.mockImplementation(async (method, params) => { if (method === 'turn/interrupt') { f.turn.status = 'completed'; f.thread.status.type = 'idle'; return {}; } return original(method, params); });
    const handoff = await prepareCodexLiveHandoff(f.rpc); expect(handoff.paused).toEqual([]);
    expect(await continueCodexLiveHandoff(f.rpc, handoff)).toEqual({ resumed: 0 });
  });
  it('does not inject Continue over a new user turn', async () => {
    const f = fixture(); const handoff = await prepareCodexLiveHandoff(f.rpc);
    f.turn.id = 'user-next-turn'; f.thread.status.type = 'active';
    expect(await continueCodexLiveHandoff(f.rpc, handoff)).toEqual({ resumed: 0 });
    expect(f.rpc.request.mock.calls.some(c => c[0] === 'turn/start')).toBe(false);
  });
  it('marks an uncertain Continue as sent and never retries it', async () => {
    const f = fixture(); const handoff = await prepareCodexLiveHandoff(f.rpc); const original = f.rpc.request.getMockImplementation()!;
    f.rpc.request.mockImplementation(async (method, params) => { if (method === 'turn/start') throw Error('timeout'); return original(method, params); });
    await expect(continueCodexLiveHandoff(f.rpc, handoff)).rejects.toThrow('timeout');
    await continueCodexLiveHandoff(f.rpc, handoff);
    expect(f.rpc.request.mock.calls.filter(c => c[0] === 'turn/start')).toHaveLength(1);
  });
  it('does not send Continue if its durable intent cannot be saved', async () => {
    const f = fixture(); const handoff = await prepareCodexLiveHandoff(f.rpc);
    await expect(continueCodexLiveHandoff(f.rpc, handoff, { beforeSend: async () => { throw Error('disk'); } })).rejects.toThrow('disk');
    expect(f.rpc.request.mock.calls.some(c => c[0] === 'turn/start')).toBe(false);
  });
  it('does not interrupt if its durable intent cannot be saved', async () => {
    const f = fixture();
    await expect(prepareCodexLiveHandoff(f.rpc, { beforeInterrupt: async () => { throw Error('disk'); } })).rejects.toThrow('disk');
    expect(f.rpc.request.mock.calls.some(c => c[0] === 'turn/interrupt')).toBe(false);
  });
  it('refuses a changed exact turn instead of interrupting the replacement', async () => {
    const f = fixture(); let reads = 0; const original = f.rpc.request.getMockImplementation()!;
    f.rpc.request.mockImplementation(async (method, params) => { if (method === 'thread/turns/list' && ++reads === 2) f.turn.id = 'replacement'; return original(method, params); });
    await expect(prepareCodexLiveHandoff(f.rpc)).rejects.toMatchObject({ code: 'native_activity_changed' });
    expect(f.rpc.request.mock.calls.some(c => c[0] === 'turn/interrupt')).toBe(false);
  });
});
