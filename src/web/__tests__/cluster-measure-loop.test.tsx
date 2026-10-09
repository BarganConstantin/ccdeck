import { afterEach, expect, it, vi } from 'vitest';
import { mount, one } from './fake-react';
vi.mock('react', async () => (await import('./fake-react')).react);
vi.mock('reactflow', () => ({
  useViewport: () => ({ x: 0, y: 0, zoom: 1 }),
  useStore: selector => selector({ width: 100, height: 100, domNode: null, nodeInternals: new Map(['a','b'].map((id, i) => [id, { type: 'agent', position: { x: i * 300, y: 50 }, width: 240, height: 130, data: { sessionId: id, kind: 'root', label: id, state: 'active' } }])) }),
}));
const { default: SessionClusters } = await import('../components/SessionClusters');
afterEach(() => vi.unstubAllGlobals());
it('measures moving canvas chrome without recursively rendering until React crashes', () => {
  let id = 0, measures = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
  vi.stubGlobal('cancelAnimationFrame', (value: number) => frames.delete(value));
  const host = { getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 100 }), ownerDocument: { querySelectorAll: () => [{ getBoundingClientRect: () => ({ left: 0, top: ++measures % 2, right: 30, bottom: 20 }) }] } };
  const view = mount(SessionClusters, {}, { commit: tree => {
    const element = one(tree, e => e.props.className === 'session-clusters');
    if (element) { const ref = element.ref ?? element.props.ref; if (ref && typeof ref === 'object' && 'current' in ref) ref.current = { parentElement: host }; }
  } });
  try {
    for (let i = 0; i < 5; i++) { const queued = [...frames.values()]; frames.clear(); for (const frame of queued) frame(i * 16); }
    expect(measures).toBeGreaterThan(1); expect(measures).toBeLessThan(20);
  } finally { view.unmount(); }
  expect(frames.size).toBe(0);
});
