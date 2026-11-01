import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, one, textOf, flush } from "./fake-react";
import { rowOf, rowText } from "./codex-panel-helpers";

vi.mock("react", async () => (await import("./fake-react")).react);
const { default: CodexProfilesSection } = await import("../components/CodexProfilesSection");

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const lanes = (view: { tree: unknown }) => (rowOf(view, 'Account A')!.props.a as { lanes: { pct: number; label: string }[] }).lanes;
const rowSays = (view: { tree: unknown }) => rowText(rowOf(view, 'Account A')!);

/** The header's ↻, which reads the roster and every account again. */
function pressReload(view: { tree: unknown }) {
  (one(view.tree, el => el.type === 'button' && el.props['aria-label'] === 'Reload Codex accounts')!.props.onClick as () => void)();
}

/** The profile's numbers are read as it appears, so the first read is already
 *  in flight when the panel has drawn; answering it is what these cases hold. */
async function setup(revision: string, slowRoster = false) {
  vi.useFakeTimers();
  let rosterReads = 0;
  let quotaReads = 0;
  let answer!: (value: unknown) => void;
  const pending = new Promise(resolve => { answer = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/codex-profiles') {
      if (++rosterReads > 1) {
        if (slowRoster) return new Promise(() => {});
        throw Error('roster temporarily unavailable');
      }
      return { ok: true, json: async () => ({ profiles: [{ id: 'profile-a', label: 'Account A', identityVersion: 'a', active: true, signedInFilePresent: true }] }) };
    }
    if (url === '/api/codex-auto') return { ok: false, json: async () => ({}) };
    quotaReads++;
    return pending;
  }));
  const view = mount(() => CodexProfilesSection());
  cleanup = view.unmount;
  await flush();
  expect(quotaReads).toBe(1);
  expect(rowSays(view)).toContain('Reading usage…');
  expect(rowSays(view)).not.toContain('never collected');
  // Asking again while that read is out starts no second one.
  pressReload(view); pressReload(view);
  await flush();
  expect(quotaReads).toBe(1);
  answer({ ok: true, json: async () => ({ ok: true, identityVersion: revision, fetchedAt: Date.now(), windows: [{ usedPercent: 130, seconds: 18000, resetAt: null }] }) });
  await flush();
  // The roster's own poll is what finds a roster that cannot be read.
  await vi.advanceTimersByTimeAsync(15_000);
  return { view, quotaReads: () => quotaReads };
}

describe('Codex quota request behavior', () => {
  it('keeps focus and a successful quota when an independent roster refresh fails', async () => {
    const { view } = await setup('a');
    // The window's bar carries the reading as it came, over its limit and all.
    expect(lanes(view)[0]).toMatchObject({ pct: 130, label: '5h' });
    expect(textOf(view.tree)).toContain('Could not refresh the accounts');
    expect(rowSays(view)).not.toContain('Reading usage…');
  });
  it('releases quota activation when a separate roster refresh is still pending', async () => {
    const { view, quotaReads } = await setup('a', true);
    expect(rowSays(view)).not.toContain('Reading usage…');
    pressReload(view);
    await flush();
    expect(quotaReads()).toBe(2);
    await flush();
  });
  it('suppresses a newer identity quota when roster refresh fails', async () => {
    const { view } = await setup('b');
    expect(lanes(view)).toEqual([]);
    // Not an error to read about: the moment after a sign-in, said as a read.
    expect(rowSays(view)).toContain('Reading usage…');
    expect(rowSays(view)).not.toContain('changed');
  });
});
