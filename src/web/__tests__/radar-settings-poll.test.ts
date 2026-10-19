import { afterEach, expect, it, vi } from 'vitest';
import { mount } from './fake-react';
vi.mock('react', async () => (await import('./fake-react')).react);
const { useRadarSettings, setRadarEnabled, refreshRadarSettings } = await import('../use-radar-settings');
afterEach(() => { vi.unstubAllGlobals(); });
it('shares confirmed settings, rejects stale polls and keeps the previous value after a failed save', async () => {
  let release!: (value: unknown) => void, delayed = false, fail = false;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit = {}) => {
    if (options.method === 'POST') {
      if (fail) return { ok: false, json: async () => ({ error: 'Save failed' }) };
      return { ok: true, json: async () => ({ ok: true, enabled: JSON.parse(String(options.body)).enabled }) };
    }
    if (delayed) return new Promise(resolve => { release = resolve; });
    return { ok: true, json: async () => ({ ok: true, enabled: true }) };
  }));
  let first!: ReturnType<typeof useRadarSettings>, second!: ReturnType<typeof useRadarSettings>;
  const one = mount(() => { first = useRadarSettings(); return null; }, {});
  const two = mount(() => { second = useRadarSettings(); return null; }, {});
  try {
    await new Promise(resolve => setTimeout(resolve, 5)); expect(first.enabled).toBe(true);
    delayed = true; const oldPoll = refreshRadarSettings();
    await setRadarEnabled(false);
    expect(first.enabled).toBe(false); expect(second.enabled).toBe(false);
    release({ ok: true, json: async () => ({ ok: true, enabled: true }) }); await oldPoll;
    expect(first.enabled).toBe(false); expect(second.enabled).toBe(false);
    fail = true; await setRadarEnabled(true);
    expect(first.enabled).toBe(false); expect(second.enabled).toBe(false);
    expect(first.error).toContain('Could not save'); expect(first.busy).toBe(false);
  } finally { one.unmount(); two.unmount(); }
});
