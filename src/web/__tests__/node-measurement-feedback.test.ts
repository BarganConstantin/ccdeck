import { afterEach, expect, it, vi } from 'vitest';
import { mount } from './fake-react';
vi.mock('react', async () => (await import('./fake-react')).react);
const store = vi.hoisted(() => ({ selector: null as null | ((state: any) => number) }));
vi.mock('reactflow', () => ({ useStore: selector => { store.selector = selector; return 0; } }));
const { useNodeMeasurements } = await import('../use-node-measurements');
afterEach(() => vi.unstubAllGlobals());
it('does not treat a DOM measurement as another change in the unchanged Flow store', () => {
  vi.stubGlobal('document', { visibilityState: 'visible' });
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('window', { clearTimeout: vi.fn() });
  let measured!: ReturnType<typeof useNodeMeasurements>;
  const view = mount(() => { measured = useNodeMeasurements({ current: false }); return null; }, {});
  try {
    const state = { nodeInternals: new Map([['card', { id: 'card', width: 200, height: 80 }]]) };
    const first = store.selector!(state);
    measured.measuredRef.current.set('card', { width: 200, height: 100 });
    expect(store.selector!(state)).toBe(first);
    expect(measured.measuredRef.current.get('card')?.height).toBe(100);
    state.nodeInternals.get('card')!.height = 120;
    expect(store.selector!(state)).toBe(first + 1);
    expect(measured.measuredRef.current.get('card')?.height).toBe(120);
  } finally { view.unmount(); }
});
