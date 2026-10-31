import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, one, textOf, flush } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);
const { default: CodexProfilesSection } = await import("../components/CodexProfilesSection");

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const laneBar = (view: { tree: unknown }) =>
  one(view.tree, el => typeof el.type === 'function' && 'lane' in el.props);

const isMore = (el: { type: unknown; props: Record<string, unknown> }) =>
  el.type === 'button' && String(el.props['aria-label'] ?? '').startsWith('More actions for');

/** Press Check quota, which lives in the row's ⋯ menu: open the menu when it
 *  is not open, then press the item. The menu closes itself on the press. */
function pressQuota(view: { tree: unknown }) {
  const item = () => one(view.tree, el => el.type === 'button' && textOf(el) === 'Check quota');
  if (!item()) (one(view.tree, isMore)!.props.onClick as () => void)();
  (item()!.props.onClick as () => void)();
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
    quotaReads++;
    return pending;
  }));
  let focused = true;
  const view = mount(() => CodexProfilesSection(), {}, { commit(tree) {
    // Focus rests on the row's ⋯, which stays drawn and enabled throughout.
    const more = one(tree, isMore);
    if (more?.props.disabled) focused = false;
  } });
  cleanup = view.unmount;
  await flush();
  expect(quotaReads).toBe(1);
  expect(textOf(view.tree)).toContain('Checking quota…');
  // Asking again while that read is out starts no second one.
  pressQuota(view); pressQuota(view);
  expect(quotaReads).toBe(1);
  answer({ ok: true, json: async () => ({ ok: true, identityVersion: revision, fetchedAt: Date.now(), windows: [{ usedPercent: 130, seconds: 18000, resetAt: null }] }) });
  await flush();
  // The roster's own poll is what finds a roster that cannot be read.
  await vi.advanceTimersByTimeAsync(15_000);
  return { view, focused, quotaReads: () => quotaReads };
}

describe('Codex quota request behavior', () => {
  it('keeps focus and a successful quota when an independent roster refresh fails', async () => {
    const { view, focused } = await setup('a');
    // The window's bar carries the reading as it came, over its limit and all.
    expect((laneBar(view)!.props.lane as { pct: number; label: string }).pct).toBe(130);
    expect((laneBar(view)!.props.lane as { label: string }).label).toBe('5h');
    expect(textOf(view.tree)).toContain('Could not refresh Codex profiles');
    expect(textOf(view.tree)).not.toContain('Checking quota…');
    expect(focused).toBe(true);
  });
  it('releases quota activation when a separate roster refresh is still pending', async () => {
    const { view, quotaReads } = await setup('a', true);
    expect(textOf(view.tree)).not.toContain('Checking quota…');
    pressQuota(view);
    expect(quotaReads()).toBe(2);
    await flush();
  });
  it('suppresses a newer identity quota when roster refresh fails', async () => {
    const { view } = await setup('b');
    expect(laneBar(view)).toBeFalsy();
    expect(textOf(view.tree)).toContain('profile changed');
    expect(textOf(view.tree)).toContain('Account A');
  });
});
