import { afterEach, expect, it, vi } from 'vitest';
import { isUserViewportGesture } from '../viewport-intent';
vi.mock('react', async orig => ({ ...(await orig<typeof import('react')>()), useCallback: (fn: unknown) => fn, useRef: (current: unknown) => ({ current }), useEffect: () => {} }));
const rf = vi.hoisted(() => ({ setViewport: vi.fn() }));
vi.mock('reactflow', () => ({ useReactFlow: () => rf, useStoreApi: () => ({ getState: () => ({}) }) }));
const { useCamera } = await import('../use-camera');
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('marks an immediate Recenter as a deck move before synchronous onMove arrives', () => {
  vi.stubGlobal('document', { hidden: true });
  const camera = useCamera();
  let readAsGesture = true;
  rf.setViewport.mockImplementation(() => {
    readAsGesture = isUserViewportGesture({ hasSourceEvent: false, at: Date.now(), lastDeckFitAt: camera.lastFitTimeRef.current, lastCanvasInputAt: Date.now() });
  });
  camera.moveCamera({ x: 80, y: 80, zoom: 0.4 }, 0);
  expect(readAsGesture).toBe(false);
});
