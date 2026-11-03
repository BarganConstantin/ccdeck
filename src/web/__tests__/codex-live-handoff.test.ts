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
describe('native account handoff without network-permit revocation', () => {
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
