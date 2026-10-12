import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Node } from 'reactflow';
import { initialState } from '../reducer';
import { columnsWouldChange } from '../layout';

vi.mock('react', async orig => ({ ...(await orig<typeof import('react')>()), useEffect: (run: () => void) => run() }));
const { useReframe } = await import('../use-reframe');

const ref = <T>(current: T) => ({ current });
function resize({ manual = false, focused = false } = {}) {
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  const nodes: Node[] = [0, 1].map(i => ({ id: `s${i}`, type: 'agent', position: { x: i * 1200, y: 0 }, data: { sessionId: `s${i}` }, width: 260, height: 130 }));
  const measured = new Map(nodes.map(n => [n.id, { width: 260, height: 130 }]));
  const pins = new Map(nodes.map(n => [n.id, n.position]));
  const previous = { width: 1197, height: 650 };
  const next = { width: 475, height: 1475 };
  expect(columnsWouldChange(nodes, [], { direction: 'LR', pinned: pins, measured, lanes: new Map() }, previous, next)).toBe(false);
  const fitLeft = vi.fn();
  const focusAgent = vi.fn();
  const positions = new Map(pins);
  const setLayoutEpoch = vi.fn();
  const epoch = ref(0);
  const disabled = ref(manual);
  // Only members read by the hook are needed; the real packing decision above
  // and the real effect below run, rather than a copy of their conditions.
  useReframe({ nodes, edges: [], settled: true, dragging: false,
    availableWidth: next.width, availableHeight: next.height,
    layout: { lastLayoutFrameRef: ref(previous), pinnedRef: ref(pins), positionsRef: ref(positions), provisionalRef: ref(new Map()), lastLayoutSigRef: ref('stable'), setLayoutEpoch } as Parameters<typeof useReframe>[0]['layout'],
    camera: { fitLeft, applyViewport: vi.fn(), cameraEpochRef: epoch, lastFitTimeRef: ref(0) } as Parameters<typeof useReframe>[0]['camera'],
    rf: { getViewport: () => ({ x: 80, y: 0, zoom: 0.8 }) } as Parameters<typeof useReframe>[0]['rf'],
    measuredRef: ref(measured), stateRef: ref(initialState()),
    lastFocusRef: ref(focused ? { id: 's0', at: Date.now() } : null),
    primarySelectedIdRef: ref(focused ? 's0' : null), focusAgentRef: ref(focusAgent), autoFitDisabledRef: disabled,
  });
  return { fitLeft, focusAgent, positions, pins, setLayoutEpoch, epoch, disabled };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('camera when the frame shrinks without changing columns', () => {
  it('refits a pinned board for a portrait frame without rearranging it', () => {
    vi.useFakeTimers(); const s = resize(); vi.runAllTimers();
    expect(s.fitLeft).toHaveBeenCalledOnce();
    expect(s.positions).toEqual(s.pins);
    expect(s.setLayoutEpoch).not.toHaveBeenCalled();
  });
  it('keeps a recently focused card in the new frame', () => {
    vi.useFakeTimers(); const s = resize({ manual: true, focused: true }); vi.runAllTimers();
    expect(s.focusAgent).toHaveBeenCalledWith('s0');
    expect(s.fitLeft).not.toHaveBeenCalled();
  });
  it('does not overwrite a newer camera move while waiting for the pane', () => {
    vi.useFakeTimers(); const s = resize(); s.epoch.current++; vi.runAllTimers();
    expect(s.fitLeft).not.toHaveBeenCalled();
  });
  it('stands down when the user pans during the settling delay', () => {
    vi.useFakeTimers(); const s = resize(); s.disabled.current = true; vi.runAllTimers();
    expect(s.fitLeft).not.toHaveBeenCalled();
  });
  it('leaves a manually panned view alone', () => {
    vi.useFakeTimers(); const s = resize({ manual: true }); vi.runAllTimers();
    expect(s.fitLeft).not.toHaveBeenCalled(); expect(s.focusAgent).not.toHaveBeenCalled();
  });
});
