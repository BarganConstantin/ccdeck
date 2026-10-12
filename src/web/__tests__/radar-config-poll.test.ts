import { afterEach, expect, it, vi } from 'vitest';
import { mount } from './fake-react';
vi.mock('react', async () => (await import('./fake-react')).react);
const { useTrafficRadar } = await import('../use-traffic-radar');
afterEach(() => vi.unstubAllGlobals());
it('does not let a delayed settings poll overwrite a confirmed save', async () => {
  let visibility!: () => void;
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: (_: string, fn: () => void) => { visibility = fn; }, removeEventListener: vi.fn() });
  const enabled = { sources: [], variables: [{ key: 'OTEL_LOG_USER_PROMPTS', value: 'Enabled', source: 'User settings' }] };
  const disabled = { sources: [], variables: [{ ...enabled.variables[0], value: 'Disabled' }] };
  let resolvePoll!: (value: unknown) => void;
  const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, config: enabled }) }).mockImplementationOnce(() => new Promise(resolve => { resolvePoll = resolve; }));
  vi.stubGlobal('fetch', fetch);
  let radar!: ReturnType<typeof useTrafficRadar>;
  const view = mount(() => { radar = useTrafficRadar(); return null; }, {});
  try {
    await vi.waitFor(() => expect(radar.snapshot?.config).toEqual(enabled));
    visibility();
    radar.updateConfig(disabled);
    resolvePoll({ ok: true, json: async () => ({ ok: true, config: enabled }) });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(radar.snapshot?.config).toEqual(disabled);
  } finally { view.unmount(); }
});
