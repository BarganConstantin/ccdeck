import { afterEach, expect, it, vi } from 'vitest';
vi.mock('react', async orig => ({ ...(await orig<typeof import('react')>()), useCallback: (fn: unknown) => fn, useRef: (current: unknown) => ({ current }), useEffect: () => {} }));
const rf = vi.hoisted(() => ({ setViewport: vi.fn(), getViewport: vi.fn(), getNodes: vi.fn() }));
vi.mock('reactflow', () => ({ useReactFlow: () => rf, useStoreApi: () => ({ getState: () => ({}) }) }));
const { useCamera } = await import('../use-camera');
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.clearAllMocks(); });
it.each([
  { width: 712, height: 1876, portrait: true },
  { width: 1876, height: 712, portrait: false },
  { width: 1000, height: 1000, portrait: false },
])('fits final R positions in a $width × $height canvas while nodes are still sliding', ({ width, height, portrait }) => {
  vi.useFakeTimers();
  const canvas = { getBoundingClientRect: () => ({ left: 328, top: 44, right: 328 + width, width, height }) };
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
  expect(target.y).toBe(portrait ? 80 : Math.max(80, (height - 359 * target.zoom) / 2));
  expect(target.zoom).toBeGreaterThan(0);
  // An interrupted animation can reach the right zoom/x but leave the old y.
  // The trailing correction must still land the requested frame.
  rf.getViewport.mockReturnValue({ ...target, y: target.y + 100 });
  vi.advanceTimersByTime(60);
  expect(rf.setViewport).toHaveBeenLastCalledWith(target, { duration: 0 });
});
