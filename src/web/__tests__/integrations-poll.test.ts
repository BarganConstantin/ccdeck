// How often the page reads GET /api/integrations. It reads it again only where
// the deck reports something that a read could change: a provider (available
// or not), or a connection (a stranded one too, so its row stays right). A
// deck that reports neither, as the free deck ships with no provider
// registered, is read once on load, and then neither every minute nor each
// time the tab comes back into view. The condition is what the deck answers,
// never which product it is, so a deck that registers a provider is read every
// minute exactly as before, with nothing to change here.
//
// A first read that fails is tried again sooner, three times at most, before
// the minute's read takes over: a deck restarting under the page does not
// leave its integrations hidden (they stay hidden while the list is unknown).
//
// The hook runs under fake-react (no DOM), on vitest's fake timers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The fake React, with its mount: a test takes mount from the very module the
// client's hooks come from, which a reset of the modules does not part.
vi.mock("react", async () => {
  const fake = await import("./fake-react");
  return { ...fake.react, fakeMount: fake.mount, fakeFlush: fake.flush };
});
type FakeReact = { fakeMount: typeof import("./fake-react").mount; fakeFlush: typeof import("./fake-react").flush };

const CONN = {
  id: "c1", kind: "jira", name: "Work Jira", baseUrl: "https://jira.example.com",
  account: { id: "1", login: "jdoe", name: "Jane Doe", avatarUrl: "" },
  meta: {}, allowedOrigins: ["https://jira.example.com"], createdAt: "", updatedAt: "", tokenSaved: true,
};

/** What the deck answers one read with: the fields the client reads. */
type Answer = { ok: boolean; status: number; json: () => Promise<unknown> };
const answer = (body: unknown, status = 200) => (): Answer => ({ ok: status < 400, status, json: async () => body });
const NOTHING = answer({ ok: true, providers: [], connections: [] });
const PROVIDER = answer({ ok: true, providers: [{ kind: "jira", label: "Jira", available: true }], connections: [] });
const PROVIDER_DOWN = answer({ ok: true, providers: [{ kind: "jira", label: "Jira", available: false }], connections: [] });
const STRANDED = answer({ ok: true, providers: [], connections: [CONN] });
const FAILS = answer({ error: "internal error" }, 500);

/** What the page shows of the integrations for the list it holds now, by the
 *  same calls its surfaces draw from: the kinds offered, the Settings tab,
 *  Settings search, the I row in Keyboard help, the rail's controls. */
interface Shown { offered: string[]; settingsTab: boolean; searchHits: boolean; iRow: boolean; railControls: number }
const NOTHING_SHOWN: Shown = { offered: [], settingsTab: false, searchHits: false, iRow: false, railControls: 0 };

interface Page {
  /** How many times the page has read the list. */
  reads(): number;
  shows(): Shown;
  /** The tab comes back into view. */
  show(): void;
  unmount(): void;
}

/** A fresh page holding the list, as App does, on a deck that answers its
 *  reads with `answers` in turn, the last one from then on. */
async function pageOn(...answers: Array<() => Answer>): Promise<Page> {
  // A fresh list each time: the client keeps it, and its poll, at module level.
  vi.resetModules();
  let onVisible: (() => void) | null = null;
  let asked = 0;
  const fetch = vi.fn(async (_path: string): Promise<Answer> => answers[Math.min(asked++, answers.length - 1)]());
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("window", {
    setTimeout: (run: () => void, ms: number) => setTimeout(run, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    setInterval: (run: () => void, ms: number) => setInterval(run, ms),
    clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
  });
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: (type: string, run: () => void) => { if (type === "visibilitychange") onVisible = run; },
    removeEventListener: (type: string) => { if (type === "visibilitychange") onVisible = null; },
  });
  const { useIntegrations, offeredKinds, integrationsReach, kindOffered, kindOpenable } = await import("../integrations/client");
  const { sectionsDrawn } = await import("../settings");
  const { indexFor, searchSettings } = await import("../settings-search");
  const { keyHelpFor } = await import("../key-help");
  const { fakeMount, fakeFlush } = (await import("react")) as unknown as FakeReact;
  const page = fakeMount(() => useIntegrations(), {});
  await fakeFlush();
  return {
    reads: () => fetch.mock.calls.filter(([path]) => path === "/api/integrations").length,
    shows: () => {
      const state = page.tree as ReturnType<typeof useIntegrations>;
      const reach = integrationsReach(state);
      return {
        offered: [...offeredKinds(state)].sort(),
        settingsTab: sectionsDrawn(reach, "general").some(s => s.id === "integrations"),
        searchHits: searchSettings("integrations", indexFor(true, reach)).length > 0,
        iRow: keyHelpFor(true, kind => kindOffered(state, kind)).some(g => g.rows.some(r => r.cap === "I")),
        railControls: (["jira", "github", "gitlab"] as const).filter(kind => kindOpenable(state, kind)).length,
      };
    },
    show: () => onVisible?.(),
    unmount: () => page.unmount(),
  };
}

/** Lets `ms` pass, every timer due in it firing and its read answered. */
const pass = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("a deck that reports no provider and holds no connection", () => {
  it("is read once, on load, and not again: not each minute, nor when the tab comes back", async () => {
    const page = await pageOn(NOTHING);
    expect(page.reads()).toBe(1);
    await pass(130_000);
    expect(page.reads()).toBe(1);
    page.show();
    await pass(0);
    expect(page.reads()).toBe(1);
    page.unmount();
  });

  it("stops being read once its last stranded connection is gone", async () => {
    const page = await pageOn(STRANDED, NOTHING);
    expect(page.reads()).toBe(1);
    await pass(60_000);
    expect(page.reads()).toBe(2);
    await pass(70_000);
    expect(page.reads()).toBe(2);
    page.unmount();
  });
});

describe("a deck that reports a provider, or holds a connection", () => {
  it("is read every minute and when the tab comes back, as before, where the provider is available", async () => {
    const page = await pageOn(PROVIDER);
    expect(page.reads()).toBe(1);
    await pass(59_999);
    expect(page.reads()).toBe(1);
    await pass(1);
    expect(page.reads()).toBe(2);
    await pass(60_000);
    expect(page.reads()).toBe(3);
    await pass(10_000);
    expect(page.reads()).toBe(3);
    page.show();
    await pass(0);
    expect(page.reads()).toBe(4);
    page.unmount();
  });

  it("is read every minute too where the provider is not available now, or a connection is stranded", async () => {
    for (const deck of [PROVIDER_DOWN, STRANDED]) {
      const page = await pageOn(deck);
      await pass(130_000);
      expect(page.reads()).toBe(3);
      page.unmount();
    }
  });
});

describe("a deck that lists its provider as not available now, with no connection", () => {
  // As a deck lists a provider that cannot serve yet: the host lists every
  // registered provider, with `available` false meanwhile.

  it("is read every minute, and shows no Integrations entry while the provider stays unavailable", async () => {
    const page = await pageOn(PROVIDER_DOWN);
    expect(page.reads()).toBe(1);
    expect(page.shows()).toEqual(NOTHING_SHOWN);
    for (const reads of [2, 3]) {
      await pass(60_000);
      expect(page.reads()).toBe(reads);
      expect(page.shows()).toEqual(NOTHING_SHOWN);
    }
    page.unmount();
  });

  it("shows the kind's entries from the later read that lists it available, and keeps reading every minute", async () => {
    const page = await pageOn(PROVIDER_DOWN, PROVIDER);
    expect(page.shows()).toEqual(NOTHING_SHOWN);
    await pass(59_999);
    expect(page.reads()).toBe(1);
    expect(page.shows()).toEqual(NOTHING_SHOWN);
    await pass(1);
    expect(page.reads()).toBe(2);
    expect(page.shows()).toEqual({ offered: ["jira"], settingsTab: true, searchHits: true, iRow: true, railControls: 0 });
    await pass(60_000);
    expect(page.reads()).toBe(3);
    page.unmount();
  });
});

describe("a first read that fails", () => {
  it("is tried again after 5 s, so a deck with a provider shows it then, and every minute after", async () => {
    const page = await pageOn(FAILS, PROVIDER);
    expect(page.reads()).toBe(1);
    await pass(5_000);
    expect(page.reads()).toBe(2);
    await pass(55_000);
    expect(page.reads()).toBe(3);
    await pass(60_000);
    expect(page.reads()).toBe(4);
    page.unmount();
  });

  it("costs a deck that reports nothing one more read, then none", async () => {
    const page = await pageOn(FAILS, NOTHING);
    await pass(130_000);
    expect(page.reads()).toBe(2);
    page.unmount();
  });

  it("is tried again three times at most, sooner each than the minute, then each minute while the list stays unknown", async () => {
    const page = await pageOn(FAILS);
    await pass(5_000);
    expect(page.reads()).toBe(2);
    await pass(10_000);
    expect(page.reads()).toBe(3);
    await pass(20_000);
    expect(page.reads()).toBe(4);
    await pass(24_999);
    expect(page.reads()).toBe(4);
    // The minute's reads, at 60 s and 120 s; no fourth retry.
    await pass(70_001);
    expect(page.reads()).toBe(6);
    page.unmount();
  });

  it("is not tried again once nothing holds the list", async () => {
    const page = await pageOn(FAILS);
    page.unmount();
    await pass(130_000);
    expect(page.reads()).toBe(1);
  });
});
