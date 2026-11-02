import { describe, it, expect, vi } from 'vitest';
// @ts-expect-error server ES module
import { chooseEngineAccount, runAccountEngine } from '../../server/account-engine.mjs';
const A = 'a'.repeat(20), B = 'b'.repeat(20), C = 'c'.repeat(20);
const row = (id: string, extra = {}) => ({ id, signedIn: true, available: true, ...extra });
const quota = (usedPercent: number, extra = {}) => ({ ok: true, windows: [{ usedPercent, resetAt: Date.now() / 1000 + 3600, seconds: 18000 }], ...extra });
const threadId = '12345678-1234-1234-1234-123456789abc';
function fixture(extra = {}) {
  const runs: string[] = [];
  const adapter = {
    settings: vi.fn(async () => ({ enabled: true, threshold: 90, next: 'room', heldOut: [] })),
    accounts: async () => [row(A), row(B), row(C)],
    quota: async (id: string) => quota(id === B ? 10 : 30),
    prepare: vi.fn(async ({ id, threadId }: { id: string; threadId: string }) => ({ id, threadId })),
    run: vi.fn(async ({ id }: { id: string }) => { runs.push(id); return id === A ? { code: 1, reason: 'usage_limit', threadId } : { code: 0, reason: 'completed', threadId }; }),
    ...extra,
  };
  return { adapter, runs };
}
describe('account engine', () => {
  it('continues the exact conversation on the eligible account with most room', async () => {
    const { adapter, runs } = fixture(); const switched = vi.fn();
    expect(await runAccountEngine(adapter, { id: A }, { onSwitch: switched })).toMatchObject({ code: 0 });
    expect(runs).toEqual([A, B]);
    expect(adapter.prepare).toHaveBeenCalledWith({ from: { id: A }, id: B, threadId });
    expect(switched).toHaveBeenCalledOnce();
  });
  it.each(['completed', 'failed', 'protocol_error', 'cancelled'])('never switches for %s', async reason => {
    const { adapter } = fixture({ run: async () => ({ code: 1, reason, threadId }) });
    await runAccountEngine(adapter, { id: A });
    expect(adapter.prepare).not.toHaveBeenCalled();
  });
  it('refuses missing or changed conversation IDs', async () => {
    const { adapter } = fixture({ run: async () => ({ code: 1, reason: 'usage_limit', threadId: null }) });
    await runAccountEngine(adapter, { id: A });
    expect(adapter.prepare).not.toHaveBeenCalled();
    const changed = fixture();
    expect(await runAccountEngine(changed.adapter, { id: A, threadId: 'different' })).toMatchObject({ reason: 'thread_changed' });
    expect(changed.adapter.prepare).not.toHaveBeenCalled();
  });
  it('stops rather than looping when every account hits a limit', async () => {
    const { adapter } = fixture({ run: async () => ({ code: 1, reason: 'usage_limit', threadId }) });
    expect(await runAccountEngine(adapter, { id: A })).toMatchObject({ reason: 'no_account_with_room' });
    expect(adapter.prepare.mock.calls.map(c => c[0].id)).toEqual([B, C]);
  });
  it('skips duplicate identities and held-out accounts', async () => {
    const { adapter, runs } = fixture({ accounts: async () => [row(A), row(B, { sameAccountAs: A }), row(C)] });
    await runAccountEngine(adapter, { id: A }); expect(runs).toEqual([A, C]);
    const held = fixture({ settings: async () => ({ enabled: true, heldOut: [B, C] }) });
    expect(await runAccountEngine(held.adapter, { id: A })).toMatchObject({ reason: 'no_account_with_room' });
  });
  it('honors disabling and cancellation while quota is being checked', async () => {
    let enabled = true;
    const { adapter } = fixture({ settings: async () => ({ enabled }), quota: async () => { enabled = false; return quota(10); } });
    await runAccountEngine(adapter, { id: A }); expect(adapter.prepare).not.toHaveBeenCalled();
    const controller = new AbortController();
    const aborted = fixture({ quota: async () => { controller.abort(); return quota(10); } });
    await runAccountEngine(aborted.adapter, { id: A }, { signal: controller.signal });
    expect(aborted.adapter.prepare).not.toHaveBeenCalled();
  });
  it('does not launch if the transfer fails', async () => {
    const { adapter, runs } = fixture({ prepare: async () => { throw new Error('conflict'); } });
    expect(await runAccountEngine(adapter, { id: A })).toMatchObject({ code: 1, reason: 'handoff_failed' });
    expect(runs).toEqual([A]);
  });
  it('requires known, fresh remaining capacity', () => {
    const bad = [quota(1, { stale: true }), { ok: true, windows: [] }, quota(1, { ok: false }), { ok: true, windows: [{ usedPercent: 1, resetAt: 1 }] }];
    for (const q of bad) expect(chooseEngineAccount([row(B)], new Map([[B, q]]))).toBeNull();
    expect(chooseEngineAccount([row(B), row(C)], new Map([[B, quota(95)], [C, quota(20)]]))?.id).toBe(C);
  });
  it('uses the soonest weekly reset when requested', () => {
    const now = Date.now() / 1000;
    const weekly = (days: number) => ({ ok: true, windows: [{ usedPercent: 50, seconds: 604800, resetAt: now + days * 86400 }] });
    expect(chooseEngineAccount([row(B), row(C)], new Map([[B, weekly(3)], [C, weekly(1)]]), { next: 'weekly' })?.id).toBe(C);
  });
});
