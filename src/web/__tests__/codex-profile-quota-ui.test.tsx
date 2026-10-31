import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, one, textOf, flush } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);
const { default: CodexProfilesSection } = await import("../components/CodexProfilesSection");

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function quotaButton(tree: unknown) {
  return one(tree, el => el.type === 'button' && textOf(el) === 'Check quota')!;
}

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
    const button = quotaButton(tree);
    if (button?.props.disabled) focused = false;
  } });
  cleanup = view.unmount;
  await flush();
  const click = quotaButton(view.tree).props.onClick as () => void;
  click(); click();
  expect(quotaReads).toBe(1);
  expect(quotaButton(view.tree).props['aria-busy']).toBe(true);
  expect(focused).toBe(true);
  answer({ ok: true, json: async () => ({ ok: true, identityVersion: revision, windows: [{ usedPercent: 130, seconds: 18000 }] }) });
  await flush();
  return { view, focused, quotaReads: () => quotaReads };
}

describe('Codex quota request behavior', () => {
  it('keeps focus and a successful quota when an independent roster refresh fails', async () => {
    const { view, focused } = await setup('a');
    expect(textOf(view.tree)).toContain('130% used');
    expect(textOf(view.tree)).toContain('Could not refresh Codex profiles');
    expect(quotaButton(view.tree).props['aria-busy']).toBe(false);
    expect(focused).toBe(true);
  });
  it('releases quota activation when a separate roster refresh is still pending', async () => {
    const { view, quotaReads } = await setup('a', true);
    expect(quotaButton(view.tree).props['aria-busy']).toBe(false);
    (quotaButton(view.tree).props.onClick as () => void)();
    expect(quotaReads()).toBe(2);
    await flush();
  });
  it('suppresses a newer identity quota when roster refresh fails', async () => {
    const { view } = await setup('b');
    expect(textOf(view.tree)).not.toContain('130% used');
    expect(textOf(view.tree)).toContain('profile changed');
    expect(textOf(view.tree)).toContain('Account A');
  });
});
