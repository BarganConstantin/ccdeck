// Characters that make code or a file name read differently from what it is:
// bidirectional controls ("Trojan Source") and invisible ones are drawn as
// their code points, in the diff and in paths, and the diff says it holds
// some. Built from code points so this file holds none of them itself.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import GitDiff from "../components/GitDiff";
import GitFiles from "../components/GitFiles";
import { codePoint, hasHidden, hiddenIn, hiddenName, shownPath, splitHidden } from "../git-hidden-chars";
import { sheetText } from "./sheet-source";

let quiet: ReturnType<typeof vi.spyOn>;
beforeAll(() => { quiet = vi.spyOn(console, "error").mockImplementation(() => {}); });
afterAll(() => { quiet.mockRestore(); });

const c = (...cps: number[]) => String.fromCodePoint(...cps);
const RLO = c(0x202e), ZWSP = c(0x200b), ZWJ = c(0x200d), PDI = c(0x2069);
const FAMILY = c(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
const SCOTLAND = c(0x1f3f4, 0xe0067, 0xe0062, 0xe0073, 0xe0063, 0xe0074, 0xe007f);

describe("which characters are hidden", () => {
  it("counts bidirectional controls, zero-width spaces and stray tag characters", () => {
    expect(hasHidden(`let s = "${RLO}evil";`)).toBe(true);
    expect(hasHidden(`const a = "x${ZWSP}";`)).toBe(true);
    expect(hasHidden(`ok${PDI}`)).toBe(true);
    expect(hasHidden(`hi${c(0xe0041, 0xe0042)}`)).toBe(true);
    expect(hiddenName(RLO)).toBe("U+202E right-to-left override");
    expect(codePoint(c(0xe0041))).toBe("U+E0041");
  });

  it("leaves what scripts and emoji need: joiners, and the tags inside a flag", () => {
    expect(hasHidden(`emoji ${FAMILY} family`)).toBe(false);
    expect(hasHidden(`flag ${SCOTLAND}`)).toBe(false);
    expect(hasHidden(`mi${c(0x200c)}xed`)).toBe(false);
    expect(hasHidden("plain ascii")).toBe(false);
  });

  it("splits text into plain runs and hidden characters, and names the distinct ones", () => {
    expect(splitHidden(`a${RLO}b${ZWSP}`)).toEqual([
      { text: "a", hidden: false }, { text: RLO, hidden: true }, { text: "b", hidden: false }, { text: ZWSP, hidden: true },
    ]);
    expect(hiddenIn(["x", `${RLO}y${RLO}`, `z${ZWSP}`])).toEqual(["U+202E", "U+200B"]);
  });
});

describe("a path that holds one", () => {
  const name = `edge/${c(0x5e9, 0x5dc, 0x5d5, 0x5dd)}-${RLO}txt.exe`;

  it("is drawn with the character as its code point, so an .exe cannot pass for a .txt", () => {
    expect(shownPath(name)).toBe(`edge/${c(0x5e9, 0x5dc, 0x5d5, 0x5dd)}-⟨U+202E⟩txt.exe`);
    expect(shownPath("src/a.ts")).toBe("src/a.ts");
  });

  it("is drawn that way in the files list, and read and titled as it is", () => {
    const html = renderToStaticMarkup(createElement(GitFiles, {
      entries: [{ path: name, area: "untracked", change: "untracked" }], mode: "uncommitted", edits: [],
      focus: { sessionId: "s", agentIds: null }, selected: null, onSelect: () => {}, onOpen: () => {}, collisions: [],
    }));
    const drawn = /<span class="gvf-path"[^>]*>([\s\S]*?)<\/span><\/span>/.exec(html)![1];
    expect(drawn).toContain("⟨U+202E⟩txt.exe");
    expect(drawn).not.toContain(RLO);
    expect(html).toContain(`<span class="vis-hidden">${name}</span>`);
  });
});

describe("a diff that holds one", () => {
  const patch = `@@ -1,2 +1,2 @@\n-let s = "evil";\n-const a = "x";\n+let s = "${RLO}evil";\n+const a = "x${ZWSP}";\n`;
  const html = renderToStaticMarkup(createElement(GitDiff, {
    file: { path: "edge/unicode.md", area: "unstaged" }, diff: { ok: true, binary: false, patch, added: 2, removed: 2 },
    loading: false, stale: false, onShowLatest: () => {}, wrap: true, onToggleWrap: () => {}, collision: null,
  }));

  it("draws each as its code point beside the character itself, kept for a copy", () => {
    expect(html).toContain(`<span class="gvd-ctl" title="U+202E right-to-left override"><span class="gvd-ctl-raw">${RLO}</span><span class="gvd-ctl-mark">U+202E</span></span>`);
    expect(html).toContain('<span class="gvd-ctl-mark">U+200B</span>');
  });

  it("says above the diff that it holds hidden or bidirectional characters, and which", () => {
    expect(html).toContain("Hidden or bidirectional characters.");
    expect(html).toContain("U+202E, U+200B");
  });

  it("isolates the character so it reorders nothing, and never copies the code point", () => {
    const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toMatch(/\.gvd-ctl-raw \{ unicode-bidi: isolate; \}/);
    expect(css).toMatch(/\.gvd-ctl-mark \{ -webkit-user-select: none; user-select: none; \}/);
  });
});
