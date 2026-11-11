import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react', async orig => ({ ...(await orig<typeof import('react')>()), useEffect: (run: () => void) => run() }));
const { useReframe } = await import('../use-reframe');

// CHANGED ON PURPOSE (V4 critique, round 2): a frame change never re-columns
// the board, so the reframe is handed no positions at all — only the frame it
// compares against and the camera. The board flows on a fresh board's first
// layout and on R (v4-board-columns.test.ts).
const ref = <T>(current: T) => ({ current });
function resize({ manual = false, focused = false, previous = { width: 1197, height: 650 }, next = { width: 475, height: 1475 } } = {}) {
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  const fitLeft = vi.fn();
  const focusAgent = vi.fn();
  const epoch = ref(0);
  const disabled = ref(manual);
  const frameRef = ref<{ width: number; height: number } | null>(previous);
  useReframe({ settled: true, dragging: false,
    availableWidth: next.width, availableHeight: next.height,
    layout: { lastLayoutFrameRef: frameRef } as unknown as Parameters<typeof useReframe>[0]['layout'],
    camera: { fitLeft, cameraEpochRef: epoch } as unknown as Parameters<typeof useReframe>[0]['camera'],
    lastFocusRef: ref(focused ? { id: 's0', at: Date.now() } : null),
    focusAgentRef: ref(focusAgent), autoFitDisabledRef: disabled,
  });
  return { fitLeft, focusAgent, epoch, disabled, frameRef };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('camera when the frame changes', () => {
  it('refits the board for the new frame', () => {
    vi.useFakeTimers(); const s = resize(); vi.runAllTimers();
    expect(s.fitLeft).toHaveBeenCalledOnce();
    expect(s.frameRef.current).toEqual({ width: 475, height: 1475 });
  });
  it('only refits when the panels close, where it used to re-column the board', () => {
    // 457.5 -> 963.2: the accounts and usage panels closing on a 1280 window.
    vi.useFakeTimers(); const s = resize({ previous: { width: 457.5, height: 503.1 }, next: { width: 963.2, height: 503.1 } }); vi.runAllTimers();
    expect(s.fitLeft).toHaveBeenCalledOnce();
  });
  it('does nothing for a frame that has not moved', () => {
    vi.useFakeTimers(); const s = resize({ next: { width: 1197, height: 650 } }); vi.runAllTimers();
    expect(s.fitLeft).not.toHaveBeenCalled();
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
