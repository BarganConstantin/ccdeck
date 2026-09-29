// #1628: a browser that blocks site data opened the deck blank.
//
// On such a profile `window.localStorage` is a getter that THROWS — Safari's
// "Block All Cookies", Chrome with site data blocked, Firefox in strict mode —
// and #208 already fixed this failure once, for the usage panel and the theme.
// It came back with "Remove node" (#1210): the set of cards taken off the board
// was restored by
//
//     readRemovedNodes(typeof window === "undefined" ? null : window.localStorage)
//
// inside a useState initialiser. readRemovedNodes guards its own getItem, but
// the accessor is read HERE, as the argument, before that try has begun. The
// throw escaped the first render, src/web has no error boundary, and #root
// stayed empty. Measured through a headless Chromium whose `localStorage`
// getter throws, against an isolated deck: 0 children under #root before, the
// whole deck after. A remove or a bring-back evaluated the same argument inside
// a state updater, which is a render too.
//
// Plain node: the rules run against a fake window, and the wiring is read as
// text through the client's comment-stripped source.
import { describe, it, expect, afterEach } from "vitest";
import { readRemovedNodes, saveRemovedNodes } from "../remove-node";
import { localStore } from "../storage";
import { clientPairs, sourceOf } from "./client-source";

const glob = globalThis as unknown as Record<string, unknown>;

/** What a blocked profile actually raises on the property read. */
function refuse(): never {
  throw new DOMException("The operation is insecure.", "SecurityError");
}

function blockedBrowser(): void {
  glob.window = Object.defineProperty({}, "localStorage", { configurable: true, get: refuse });
}

afterEach(() => { delete glob.window; });

describe("the removed-card set on a profile that blocks site data", () => {
  it("was lost to the accessor, not to readRemovedNodes", () => {
    // The shape the hook had, run: the throw comes from reading the argument.
    blockedBrowser();
    const w = glob.window as { localStorage: Storage };
    expect(() => readRemovedNodes(typeof window === "undefined" ? null : w.localStorage))
      .toThrow("The operation is insecure.");
  });

  it("reads as nothing removed through localStore(), without a throw", () => {
    blockedBrowser();
    expect(() => readRemovedNodes(localStore())).not.toThrow();
    expect(readRemovedNodes(localStore()).size).toBe(0);
  });

  it("saves as a no-op through localStore(), so a remove and a bring-back still work", () => {
    blockedBrowser();
    expect(() => saveRemovedNodes(localStore(), new Set(["agent-1"]))).not.toThrow();
  });

  it("is what use-removals hands the rules, at all three places it reads the store", () => {
    const hook = sourceOf("use-removals.ts");
    expect(hook).toContain("useState<Set<string>>(() => readRemovedNodes(localStore()));");
    expect(hook.match(/saveRemovedNodes\(localStore\(\), next\)/g) ?? []).toHaveLength(2);
    expect(hook).not.toMatch(/(?:read|save)RemovedNodes\([^)]*window\.localStorage/);
  });
});

describe("the client never hands the bare accessor on outside a try", () => {
  // The general form of #1628, so the next function that takes a store is not
  // the next blank deck. `window.localStorage` followed by anything but a
  // member access is the accessor passed or returned as a value; each one has
  // to sit on a line that opens its own try. storage.ts's localStore() is the
  // one every other caller should use, and it passes this by construction.
  const handedOn = clientPairs().flatMap(([file, text]) =>
    text.split("\n")
      .filter(line => /window\.localStorage(?!\s*[.?\w])/.test(line))
      .map(line => [file, line.trim()] as const));

  it("finds the ones there are, so the sweep below is not vacuous", () => {
    expect(handedOn.map(([file]) => file)).toContain("storage.ts");
  });

  it("finds each of them inside a try on its own line", () => {
    expect(handedOn.filter(([, line]) => !/\btry \{/.test(line))).toEqual([]);
  });
});
