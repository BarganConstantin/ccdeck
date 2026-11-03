import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error server module
import { requestCodexLiveCheckpoints, inspectCodexLiveCheckpoints } from '../../server/codex-live-checkpoint.mjs';
function fixture() {
  const entries: any[] = [
    { threadId: 'parent', turnId: 'parent-turn', rootTurnId: 'root', inputIds: ['original'], checkpointId: 'marker' },
    { threadId: 'child', turnId: 'child-turn', rootTurnId: 'root', inputIds: [], checkpointId: 'marker', parentThreadId: 'parent', resumeViaThreadId: 'parent' },
  ];
  const threads: any = { parent: { id: 'parent', status: { type: 'active' } }, child: { id: 'child', parentThreadId: 'parent', status: { type: 'active' } } };
  const turns: any = { parent: { id: 'parent-turn', rootTurnId: 'root', status: 'inProgress', itemsView: 'full', items: [{ id: 'original', type: 'userMessage' }] },
    child: { id: 'child-turn', rootTurnId: 'root', status: 'inProgress', itemsView: 'full', items: [] } };
  const record = vi.fn(async (entry: any, phase: string) => { entry.phase = phase; });
  const rpc = { request: vi.fn(async (method: string, params: any) => {
    if (method === 'turn/steer') { turns.parent.items.push({ id: 'checkpoint-input', type: 'userMessage', clientId: params.clientUserMessageId }); return {}; }
    if (method === 'thread/read') return { thread: threads[params.threadId] };
    if (method === 'thread/turns/list') return { data: [structuredClone(turns[params.threadId])] };
    throw Error('Unexpected mutation: ' + method);
  }) };
  const finish = (id: string, marker = true) => {
    turns[id].status = 'completed'; threads[id].status.type = 'idle';
    turns[id].items.push({ id: 'result', type: 'agentMessage', text: marker ? 'CCDECK_CHECKPOINT_marker' : 'Original task completed' });
  };
  return { entries, threads, turns, rpc, record, finish };
}
describe('cooperative V2 checkpoints', () => {
  it('queues only an expected-turn parent steer after persisting intent and never interrupts a child', async () => {
    const f = fixture(); await requestCodexLiveCheckpoints(f.rpc, f.entries, { record: f.record });
    expect(f.rpc.request.mock.calls.map(c => c[0])).toEqual(['turn/steer']);
    expect(f.rpc.request.mock.calls[0][1]).toMatchObject({ threadId: 'parent', expectedTurnId: 'parent-turn', clientUserMessageId: 'marker' });
    expect(f.rpc.request.mock.calls[0][1].input[0].text).toContain('finish its current tool call');
    expect(f.record.mock.invocationCallOrder.at(-1)).toBeLessThan(f.rpc.request.mock.invocationCallOrder[0]);
  });
  it('waits for terminal checkpoint acknowledgements before returning resumable entries', async () => {
    const f = fixture(); await requestCodexLiveCheckpoints(f.rpc, f.entries, { record: f.record });
    f.finish('child'); expect(await inspectCodexLiveCheckpoints(f.rpc, f.entries, { record: f.record })).toBeNull();
    f.finish('parent'); const h = await inspectCodexLiveCheckpoints(f.rpc, f.entries, { record: f.record });
    expect(h.paused).toHaveLength(2); expect(h.paused.every((e: any) => e.checkpointReady)).toBe(true);
    expect(h.paused[0].inputIds).toEqual(['original', 'checkpoint-input']);
  });
  it.each(['new-input', 'new-turn', 'cancelled', 'unloaded'])('does not authorize a change after %s during preparation', async condition => {
    const f = fixture(); await requestCodexLiveCheckpoints(f.rpc, f.entries, { record: f.record }); f.finish('child'); f.finish('parent');
    if (condition === 'new-input') f.turns.parent.items.push({ id: 'owner-input', type: 'userMessage' });
    if (condition === 'new-turn') f.turns.parent.id = 'owner-new-turn';
    if (condition === 'cancelled') f.turns.parent.status = 'interrupted';
    if (condition === 'unloaded') {
      f.threads.child.status.type = 'notLoaded';
      expect(await inspectCodexLiveCheckpoints(f.rpc, f.entries, { record: f.record })).toBeNull(); return;
    }
    await expect(inspectCodexLiveCheckpoints(f.rpc, f.entries, { record: f.record })).rejects.toMatchObject({ code: expect.stringMatching(/^native_/) });
  });
  it('leaves naturally finished child work complete', async () => {
    const f = fixture(); await requestCodexLiveCheckpoints(f.rpc, f.entries, { record: f.record }); f.finish('child', false); f.finish('parent');
    const h = await inspectCodexLiveCheckpoints(f.rpc, f.entries, { record: f.record });
    expect(h.paused.map((e: any) => e.threadId)).toEqual(['parent']); expect(f.entries[1].phase).toBe('skipped');
  });
  it('preserves uncertainty when the checkpoint request is not acknowledged', async () => {
    const f = fixture(); f.rpc.request.mockRejectedValueOnce(Error('timeout'));
    await expect(requestCodexLiveCheckpoints(f.rpc, f.entries, { record: f.record })).rejects.toThrow('timeout');
    expect(f.entries[0].phase).toBe('checkpoint_sent'); expect(f.entries[1].phase).toBe('checkpoint_waiting');
    expect(f.rpc.request).toHaveBeenCalledOnce();
  });
  it('revalidates cached checkpoints after other work delayed authentication', async () => {
    const f = fixture(); await requestCodexLiveCheckpoints(f.rpc, f.entries, { record: f.record }); f.finish('child'); f.finish('parent');
    expect(await inspectCodexLiveCheckpoints(f.rpc, f.entries, { record: f.record })).not.toBeNull();
    f.turns.parent.items.push({ id: 'new-cancellation', type: 'userMessage' });
    await expect(inspectCodexLiveCheckpoints(f.rpc, f.entries, { record: f.record })).rejects.toMatchObject({ code: 'native_activity_changed' });
  });
});
