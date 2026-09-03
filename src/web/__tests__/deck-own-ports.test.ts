// A deck must not report itself.
//
// The exclusion guessed a range — 4317 and the 4318-4400 the listen fallback
// picks from — and that covers a deck started the ordinary way. It does not
// cover `--port 4793`, which is what a deck running out of a git worktree was
// using. It opened its own tab, that tab carried FROM_API because `open` is an
// API call, and the panel reported it to its owner as a program driving the
// browser. It was — and the program was ccdeck.
//
// The registry already holds a port per live deck, for the election. So the
// answer was a fact the machine had, not a range somebody has to keep current.
import { describe, it, expect } from "vitest";
import { deckOwnOrigins } from "../../server/browser-watch.mjs";

describe("which loopback addresses are the deck's own", () => {
  it("still covers the documented range with no registry at all", () => {
    // The first run on a machine, and every deck started the ordinary way.
    const o = deckOwnOrigins();
    expect(o).toContain("http://127.0.0.1:4317");
    expect(o).toContain("http://127.0.0.1:4400");
    expect(o).toHaveLength(84);
  });

  it("adds a registered port outside the range", () => {
    // THE CASE THAT WAS REPORTED. A worktree deck on 4793.
    const o = deckOwnOrigins(undefined, [4793]);
    expect(o).toContain("http://127.0.0.1:4793");
  });

  it("does not duplicate a registered port already inside the range", () => {
    // Every ordinary deck registers a port the range already covers, so this is
    // the common case and it must not grow the list on every poll.
    expect(deckOwnOrigins(undefined, [4317, 4394])).toHaveLength(84);
  });

  it("still reports a user's own dev server", () => {
    // The cost of a wider exclusion, and the line it must not cross. A program
    // driving the browser to localhost:44440 is exactly the case this feature
    // is for, and swallowing every loopback port to save bookkeeping would have
    // hidden it.
    const o = deckOwnOrigins(undefined, [4793]);
    expect(o).not.toContain("http://127.0.0.1:44440");
    expect(o).not.toContain("http://127.0.0.1:3000");
  });

  it("refuses a registry entry that is not a port", () => {
    // The files are written by other processes and read by this one. A junk
    // value must cost nothing rather than excuse something at random.
    const o = deckOwnOrigins(undefined, [0, 70000, -1, 1.5, NaN, "4793" as never, null as never]);
    expect(o).toHaveLength(84);
  });

  it("takes an empty registry as an empty registry", () => {
    expect(deckOwnOrigins(undefined, [])).toHaveLength(84);
    expect(deckOwnOrigins()).toHaveLength(84);
  });
});
