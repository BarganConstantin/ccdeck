import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useCodexStartupDiscovery } from "../use-codex-startup-discovery";

type Hook = ReturnType<typeof useCodexStartupDiscovery>;
let root: Root;
let hook: Hook;

function mount() {
  function Probe() {
    hook = useCodexStartupDiscovery();
    return null;
  }
  const container = {
    nodeType: 1, nodeName: "DIV", tagName: "DIV", namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: null, textContent: "", addEventListener() {}, removeEventListener() {},
  };
  root = createRoot(container as unknown as Element);
  return act(async () => root.render(createElement(Probe)));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function settle() {
  await new Promise(resolve => setTimeout(resolve, 0));
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { HTMLIFrameElement: class {} });
  await mount();
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("Codex startup preference writes", () => {
  it.each(["network", "http"] as const)("rolls back to the last confirmed value after a %s failure", async failure => {
    const pending = deferred<Response>();
    const fetchMock = vi.fn(() => pending.promise);
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => hook.toggleCodexStartupDiscovery());
    expect(hook.codexStartupDiscoveryEnabled).toBe(false);
    if (failure === "network") pending.reject(new Error("offline"));
    else pending.resolve({ ok: false, json: async () => ({ ok: false }) } as Response);
    await act(settle);

    expect(hook.codexStartupDiscoveryEnabled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("serializes rapid toggles and persists the latest intent despite an older response", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const requests = [first, second];
    const bodies: boolean[] = [];
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)).codexStartupDiscoveryEnabled);
      return requests[bodies.length - 1].promise;
    });
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      hook.toggleCodexStartupDiscovery(); // false
      hook.toggleCodexStartupDiscovery(); // true, while the first request is pending
    });
    expect(hook.codexStartupDiscoveryEnabled).toBe(true);
    expect(bodies).toEqual([false]);

    first.resolve({ ok: true, json: async () => ({ ok: true, prefs: { codexStartupDiscoveryEnabled: false } }) } as Response);
    await act(settle);
    expect(bodies).toEqual([false, true]);
    expect(hook.codexStartupDiscoveryEnabled).toBe(true);

    second.resolve({ ok: true, json: async () => ({ ok: true, prefs: { codexStartupDiscoveryEnabled: true } }) } as Response);
    await act(settle);
    expect(hook.codexStartupDiscoveryEnabled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not let a late initial prefs read override a user's click", async () => {
    const pending = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(() => pending.promise));
    await act(async () => hook.toggleCodexStartupDiscovery());
    act(() => hook.loadCodexStartupPrefs({ prefs: { codexStartupDiscoveryEnabled: true } }));
    expect(hook.codexStartupDiscoveryEnabled).toBe(false);
  });
});
