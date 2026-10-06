// A path cut to its row: the file name whole, the folder cut in its middle,
// the whole path cut only when the name alone does not fit — and one file
// listed twice cut the same way in both rows.
import { describe, expect, it } from "vitest";
import { cachedMeasure, fitPath, fitShared, middleCut, nameFits, splitPath, units, type Measure } from "../git-path-fit";

/** A monospace font at 7px a character, the ellipsis included. */
const mono: (text: string) => number = text => [...text].length * 7;
const room = (chars: number) => chars * 7;
const shown = (c: { dir: string; base: string }) => c.dir + c.base;

describe("splitting a path", () => {
  it("keeps the folder's trailing slash with the folder", () => {
    expect(splitPath("src/auth/session.ts")).toEqual({ dir: "src/auth/", base: "session.ts" });
    expect(splitPath("README.md")).toEqual({ dir: "", base: "README.md" });
  });
});

describe("a path that fits", () => {
  it("is shown whole and says nothing was cut", () => {
    expect(fitPath("src/auth/session.ts", room(19), mono)).toEqual({ dir: "src/auth/", base: "session.ts", cut: false });
  });
});

describe("a path too long for its row", () => {
  it("keeps the whole file name and cuts the folder in its middle", () => {
    const c = fitPath("src/features/billing/invoices/builder.ts", room(30), mono);
    expect(c.base).toBe("builder.ts");
    expect(c.dir.endsWith("/")).toBe(true);
    expect(c.dir).toContain("…");
    expect(c.dir.startsWith("src/")).toBe(true);
    expect(mono(shown(c))).toBeLessThanOrEqual(room(30));
    expect(c.cut).toBe(true);
  });

  it("keeps as much of the folder as the room allows", () => {
    const path = "src/features/billing/invoices/builder.ts";
    for (let chars = 14; chars < path.length; chars++) {
      const c = fitPath(path, room(chars), mono);
      // The longest spelling that fits: one more character would not.
      // (a folder cut to under three letters goes to …/, so up to two less)
      expect(mono(shown(c)), `${chars}: ${shown(c)}`).toBeGreaterThan(room(chars) - 3 * 7 - 1);
      expect(mono(shown(c))).toBeLessThanOrEqual(room(chars));
    }
  });

  it("drops a folder cut to a sliver to …/ rather than leave two letters of it", () => {
    expect(shown(fitPath("src/auth/session.ts", room(14), mono))).toBe("…/session.ts");
    expect(shown(fitPath("src/auth/session.ts", room(15), mono))).toBe("sr…h/session.ts");
  });

  it("goes down to …/ in front of the name before it touches the name", () => {
    expect(shown(fitPath("src/auth/oauth-callback.ts", room(19), mono))).toBe("…/oauth-callback.ts");
  });

  it("cuts the whole path in its middle only when …/name does not fit", () => {
    const c = fitPath("src/auth/oauth-callback.ts", room(14), mono);
    expect(shown(c)).toContain("…");
    expect(mono(shown(c))).toBeLessThanOrEqual(room(14));
    // More of the end is kept than of the start: the end is the name.
    expect(shown(c)).toBe("src/au…back.ts");
  });

  it("cuts a long name at the top level in its middle", () => {
    const c = fitPath("CHANGELOG-for-the-very-long-release.md", room(16), mono);
    expect(c.dir).toBe("");
    expect(c.base).toContain("…");
    expect(c.base.endsWith(".md")).toBe(true);
  });

  it("keeps the folder's tone on what is left of the folder", () => {
    const c = fitPath("src/auth/oauth-callback.ts", room(18), mono);
    expect(c.dir === "" || c.dir.endsWith("/")).toBe(true);
  });

  it("says at least an ellipsis when there is no room at all", () => {
    expect(shown(fitPath("src/auth/session.ts", 0, mono))).toBe("…");
  });
});

describe("the middle cut", () => {
  it("finds the longest spelling that fits", () => {
    expect(middleCut("abcdefghij", room(10), mono)).toBe("abcdefghij");
    expect(middleCut("abcdefghij", room(7), mono)).toBe("abc…hij");
    expect(middleCut("abcdefghij", room(1), mono)).toBe("…");
  });

  it("takes a share of the kept characters from the front", () => {
    expect(middleCut("abcdefghij", room(6), mono, 0.4)).toBe("ab…hij");
  });
});

describe("whether the name fits behind …/", () => {
  it("is the test a row runs before folding a subagent's name", () => {
    expect(nameFits("src/auth/session.ts", room(12), mono)).toBe(true);
    expect(nameFits("src/auth/session.ts", room(11), mono)).toBe(false);
    expect(nameFits("README.md", room(9), mono)).toBe(true);
  });
});

describe("one file listed twice", () => {
  it("is cut to the narrower of its two rows in both", () => {
    const cuts = fitShared([
      { key: "staged\0src/features/billing/invoices/builder.ts", path: "src/features/billing/invoices/builder.ts", room: room(34) },
      { key: "unstaged\0src/features/billing/invoices/builder.ts", path: "src/features/billing/invoices/builder.ts", room: room(26) },
      { key: "unstaged\0README.md", path: "README.md", room: room(40) },
    ], mono);
    const staged = cuts.get("staged\0src/features/billing/invoices/builder.ts")!;
    const unstaged = cuts.get("unstaged\0src/features/billing/invoices/builder.ts")!;
    expect(staged).toEqual(unstaged);
    expect(mono(shown(staged))).toBeLessThanOrEqual(room(26));
    expect(cuts.get("unstaged\0README.md")).toEqual({ dir: "", base: "README.md", cut: false });
  });
});

describe("the width cache", () => {
  it("measures each distinct string once", () => {
    let calls = 0;
    const m = cachedMeasure(text => { calls++; return mono(text); });
    for (let i = 0; i < 5; i++) fitPath("src/features/billing/invoices/builder.ts", room(24), m);
    const first = calls;
    fitPath("src/features/billing/invoices/builder.ts", room(24), m);
    expect(calls).toBe(first);
  });

  it("starts again past its cap rather than growing for the life of the page", () => {
    let calls = 0;
    const m = cachedMeasure(text => { calls++; return text.length; }, 2);
    m("a"); m("b"); m("c"); m("a");
    expect(calls).toBe(4);
  });
});

describe("cutting by what a reader sees as one character", () => {
  const c = (...cps: number[]) => String.fromCodePoint(...cps);
  const PARTY = c(0x1f389);
  const lone = (s: string) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
  // Every character one unit wide: the cut is decided by count alone.
  const mono: Measure = t => units(t).length;

  it("never cuts a surrogate pair in half", () => {
    const folder = `edge/${PARTY.repeat(16)}-folder`;
    for (let room = 4; room < 30; room++) {
      const cut = middleCut(folder, room, mono);
      expect(lone(cut), `room ${room}: ${cut}`).toBe(false);
      expect(units(cut).length).toBeLessThanOrEqual(room);
    }
    const fit = fitPath(`${folder}/inner-file.ts`, 20, mono);
    expect(lone(fit.dir + fit.base)).toBe(false);
  });

  it("keeps an emoji with its joiners and a letter with its marks whole", () => {
    const family = c(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
    expect(units(`a${family}b`)).toEqual(["a", family, "b"]);
    const cut = middleCut(`${family.repeat(6)}`, 3, mono);
    expect(cut.replace("…", "").split(family).every(p => p === "")).toBe(true);
  });

  it("keeps a hidden character's drawn code point as one unit", () => {
    expect(units("a⟨U+202E⟩b")).toEqual(["a", "⟨U+202E⟩", "b"]);
    const cut = middleCut("x⟨U+202E⟩".repeat(8), 5, mono);
    expect(cut).not.toMatch(/⟨U\+[0-9A-F]*$|^[0-9A-F]*⟩/);
  });
});
