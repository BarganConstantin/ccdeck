// The app's window after the app reattaches to a deck on another port.
//
// openWindow fixed the window's origin from the deck's port once, and attach()
// swapped the deck, the tray stream and the board but never the window. A deck
// replaced on another port — `ccdeck --port 4500` from a terminal, or every
// restart on a machine where 4317 is taken and each deck draws a random port —
// left the page retrying a port nobody listened on, and the custom-sound calls
// refused, because their check compares the page with the NEW deck. Closing and
// opening the window was the only way back.
//
// What the window does is decided by nav.mjs's originToFollow, run here; the
// last block pins main.mjs's use of it, since main.mjs imports electron and
// cannot be loaded here.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// @ts-expect-error — plain .mjs, no types
import { deckOrigin, navigationFor, originToFollow } from "../../../desktop/nav.mjs";

describe("the window, when the app attaches to a deck", () => {
  it("moves to the new deck's origin when it is on another port", () => {
    expect(originToFollow("http://127.0.0.1:4317", { port: 4500 })).toBe("http://127.0.0.1:4500");
  });

  it("stays where it is for a deck on the same port — a restart the supervisor did", () => {
    // The page reconnects to that one by itself; a reload would only lose its
    // place.
    expect(originToFollow("http://127.0.0.1:4317", { port: 4317 })).toBe(null);
  });

  it("does nothing with no window open, or with no deck", () => {
    expect(originToFollow(null, { port: 4500 })).toBe(null);
    // The deck lost: the page says it is reconnecting, and waits.
    expect(originToFollow("http://127.0.0.1:4317", null)).toBe(null);
  });

  it("keeps the page on the new origin once it has moved", () => {
    const moved = originToFollow("http://127.0.0.1:4317", { port: 4371 });
    expect(moved).toBe(deckOrigin(4371));
    expect(navigationFor(`${moved}/`, deckOrigin(4371))).toBe("stay");
    expect(navigationFor("http://127.0.0.1:4317/", deckOrigin(4371))).toBe("external");
  });
});

describe("the app's wiring", () => {
  const main = readFileSync(fileURLToPath(new URL("../../../desktop/main.mjs", import.meta.url)), "utf8");
  const fn = (name: string) => {
    const at = main.search(new RegExp(`(?:async )?function ${name}\\(`));
    expect(at, `${name} is gone or renamed`).toBeGreaterThan(-1);
    return main.slice(at, main.indexOf("\n}\n", at));
  };

  it("reloads an open window at the new deck's origin when attach() changes port", () => {
    const body = fn("attach");
    expect(body).toMatch(/originToFollow\(windowOrigin, deck\)/);
    expect(body).toMatch(/windowOrigin = moveTo;\s*win\.loadURL\(`\$\{moveTo\}\/`\);/);
  });

  it("keeps the window's origin where both of its handlers read it now, not in a copy taken at open", () => {
    const body = fn("openWindow");
    expect(body).not.toMatch(/const origin = /);
    expect(body).toContain("windowOrigin = deckOrigin(deck.port);");
    expect(body).toContain("win.loadURL(`${windowOrigin}/`);");
    expect(main).toMatch(/let windowOrigin = null;/);
  });
});
