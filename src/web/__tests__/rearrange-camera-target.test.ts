import { afterEach, expect, it, vi } from 'vitest';
vi.mock('react', async orig => ({ ...(await orig<typeof import('react')>()), useCallback: (fn: unknown) => fn, useRef: (current: unknown) => ({ current }), useEffect: () => {} }));
const rf = vi.hoisted(() => ({ setViewport: vi.fn(), getViewport: vi.fn(), getNodes: vi.fn() }));
vi.mock('reactflow', () => ({ useReactFlow: () => rf, useStoreApi: () => ({ getState: () => ({}) }) }));
const { useCamera } = await import('../use-camera');
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.clearAllMocks(); });
it('fits the final R positions while the drawn nodes are still sliding from the old layout', () => {
  vi.useFakeTimers();
  const canvas = { getBoundingClientRect: () => ({ left: 328, top: 44, right: 1040, width: 712, height: 1876 }) };
  const drawn = [0, 1].map(i => ({ dataset: { id: `s${i}` }, offsetWidth: 260, offsetHeight: 130,
    // Still on the 320ms CSS transition from the user's old arrangement.
    getBoundingClientRect: () => ({ left: 600 + i * 150, right: 730 + i * 150, top: 500, bottom: 565 }),
  }));
  vi.stubGlobal('document', { hidden: true, querySelector: () => canvas,
    querySelectorAll: (selector: string) => selector === '.react-flow__node' ? drawn : [],
  });
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  rf.getViewport.mockReturnValue({ x: -646, y: 831, zoom: 0.5 });
  rf.getNodes.mockReturnValue([0, 1].map(i => ({ id: `s${i}`, position: { x: 0, y: i * 229 }, width: 260, height: 130 })));
  const camera = useCamera();
  camera.fitLeft(0);
  expect(rf.setViewport).toHaveBeenCalled();
  const target = rf.setViewport.mock.calls[0][0];
  expect(target.x, 'R must leave the final nodes inside the canvas, beyond its 80px margin').toBe(80);
  expect(target.zoom).toBeGreaterThan(0);
});
