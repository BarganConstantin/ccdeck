import { afterEach, expect, it, vi } from 'vitest';
import { mount } from './fake-react';
vi.mock('react', async () => (await import('./fake-react')).react);
const { useTelemetryCapture } = await import('../use-telemetry-capture');
afterEach(() => { vi.unstubAllGlobals(); });
it('does not let a delayed status poll undo the confirmed Stop result', async () => {
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn() });
  let resolvePoll!: (value: unknown) => void;
  const poll = new Promise(r => { resolvePoll = r; });
  const stopped = { ok: true, enabled: false, state: 'stopped', events: [] };
  const fetch = vi.fn().mockReturnValueOnce(poll).mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) }).mockResolvedValue({ ok: true, json: async () => stopped });
  vi.stubGlobal('fetch', fetch);
  let monitor!: ReturnType<typeof useTelemetryCapture>;
  const view = mount(() => { monitor = useTelemetryCapture(); return null; }, {});
  try {
    await monitor.action('stop'); expect(monitor.capture?.state).toBe('stopped');
    resolvePoll({ ok: true, json: async () => ({ ...stopped, enabled: true, state: 'capturing' }) });
    await new Promise(r => setTimeout(r, 10));
    expect(monitor.capture?.state).toBe('stopped'); expect(monitor.capture?.enabled).toBe(false);
  } finally { view.unmount(); }
});
