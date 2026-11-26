// A press on a link in the pane (terminal-links.ts): the web only, Ctrl+click
// (Cmd+click on a Mac) only, one tab per press, the press kept from a program
// that has the mouse, and never through a browser dialog.
import { afterEach, describe, expect, it, vi } from "vitest";
import { isLinkGesture, keepsPressFromProgram, linkHint, linkToOpen, openLink } from "../terminal-links";
import { resetLanguageForTest, setLanguage } from "../i18n";

const linux = { apple: false };
const mac = { apple: true };
const plain = () => ({ button: 0, ctrlKey: false, metaKey: false });
const ctrl = () => ({ button: 0, ctrlKey: true, metaKey: false });
const cmd = () => ({ button: 0, ctrlKey: false, metaKey: true });

afterEach(() => { delete (globalThis as Record<string, unknown>).window; });

function stubWindow() {
  const open = vi.fn();
  const confirm = vi.fn();
  (globalThis as Record<string, unknown>).window = { open, confirm };
  return { open, confirm };
}

describe("which press on a link opens it", () => {
  it("opens http and https on Ctrl+click, and Cmd+click on a Mac", () => {
    expect(linkToOpen(ctrl(), "https://github.com/o/r/pull/1", linux)).toBe("https://github.com/o/r/pull/1");
    expect(linkToOpen(ctrl(), "http://localhost:3000/", linux)).toBe("http://localhost:3000/");
    expect(linkToOpen(cmd(), "https://example.com", mac)).toBe("https://example.com/");
  });

  it("opens nothing on a plain click, or with the other platform's modifier", () => {
    expect(linkToOpen(plain(), "https://example.com", linux)).toBeNull();
    expect(linkToOpen(cmd(), "https://example.com", linux)).toBeNull();
    expect(linkToOpen(ctrl(), "https://example.com", mac)).toBeNull();
    expect(linkToOpen(plain(), "https://example.com", mac)).toBeNull();
  });

  it("opens nothing on another button with the modifier held", () => {
    for (const button of [1, 2]) {
      expect(linkToOpen({ ...ctrl(), button }, "https://example.com", linux), `button ${button}`).toBeNull();
      expect(linkToOpen({ ...cmd(), button }, "https://example.com", mac), `button ${button}`).toBeNull();
    }
  });

  it("keeps a merge request's path, query and fragment exactly", () => {
    const mr = "https://gitlab.example.com/group/sub/project/-/merge_requests/1234?tab=diffs&commit_id=a1b2#note_987";
    expect(linkToOpen(ctrl(), mr, linux)).toBe(mr);
    expect(linkToOpen(cmd(), mr, mac)).toBe(mr);
  });

  it("opens nothing that is not the web", () => {
    for (const uri of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "vscode://file/x", "ssh://host", "not a url", ""]) {
      expect(linkToOpen(ctrl(), uri, linux), uri).toBeNull();
    }
  });

  it("is the same gesture whatever the program does with the mouse", () => {
    expect(isLinkGesture(ctrl(), false)).toBe(true);
    expect(isLinkGesture(cmd(), true)).toBe(true);
    expect(isLinkGesture(plain(), false)).toBe(false);
    expect(isLinkGesture({ button: 0, ctrlKey: true, metaKey: true }, true)).toBe(true);
  });
});

describe("a press kept from a program that has the mouse", () => {
  const on = { overLink: true, programHasMouse: true };

  it("keeps the gesture on a link from the program, so it opens here and only here", () => {
    expect(keepsPressFromProgram(ctrl(), { apple: false, ...on })).toBe(true);
    expect(keepsPressFromProgram(cmd(), { apple: true, ...on })).toBe(true);
  });

  it("leaves every other press to the program: plain, off a link, another button, the other modifier", () => {
    expect(keepsPressFromProgram(plain(), { apple: false, ...on })).toBe(false);
    expect(keepsPressFromProgram(plain(), { apple: true, ...on })).toBe(false);
    expect(keepsPressFromProgram(ctrl(), { apple: false, overLink: false, programHasMouse: true })).toBe(false);
    expect(keepsPressFromProgram({ ...ctrl(), button: 2 }, { apple: false, ...on })).toBe(false);
    // Ctrl+click on a Mac is the context menu, not the link's.
    expect(keepsPressFromProgram(ctrl(), { apple: true, ...on })).toBe(false);
  });

  it("keeps nothing while the program does not have the mouse: it never sees a press then", () => {
    expect(keepsPressFromProgram(ctrl(), { apple: false, overLink: true, programHasMouse: false })).toBe(false);
  });
});

describe("opening", () => {
  it("opens in a new tab with no opener, and never asks with confirm()", () => {
    const { open, confirm } = stubWindow();
    expect(openLink(ctrl(), "https://example.com/a?b=1#c", linux)).toBe(true);
    expect(openLink(plain(), "https://example.com/a?b=1#c", linux)).toBe(false);
    expect(open.mock.calls).toEqual([["https://example.com/a?b=1#c", "_blank", "noopener,noreferrer"]]);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("opens one tab per press, even if two handlers are handed the same press", () => {
    const { open } = stubWindow();
    const press = ctrl();
    // An OSC 8 link whose text is its own address is both kinds of link.
    openLink(press, "https://example.com/pr/1", linux);
    openLink(press, "https://example.com/pr/1", linux);
    expect(open).toHaveBeenCalledTimes(1);
    // The next press is a new one.
    openLink(ctrl(), "https://example.com/pr/1", linux);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("a press that opened nothing does not use up the press", () => {
    const { open } = stubWindow();
    const press = ctrl();
    openLink(press, "file:///etc/passwd", linux);
    openLink(press, "https://example.com/", linux);
    expect(open.mock.calls).toEqual([["https://example.com/", "_blank", "noopener,noreferrer"]]);
  });

  it("opens nothing on a plain press, nor with the other platform's modifier", () => {
    const { open } = stubWindow();
    openLink(plain(), "https://example.com/", linux);
    openLink(cmd(), "https://example.com/", linux);
    openLink(ctrl(), "https://example.com/", mac);
    expect(open).not.toHaveBeenCalled();
  });
});

describe("the hover hint", () => {
  it("names the address and the gesture for the keyboard in front of the reader", () => {
    expect(linkHint("https://gitlab.example.com/g/p/-/merge_requests/7", linux)).toBe("https://gitlab.example.com/g/p/-/merge_requests/7\nCtrl+click to open the link");
    expect(linkHint("https://example.com/", mac)).toBe("https://example.com/\n⌘+click to open the link");
  });
  it("calls the Control key by its name in the reader's language", () => {
    try {
      setLanguage("de");
      expect(linkHint("https://example.com/", linux)).toBe("https://example.com/\nStrg+Klick öffnet den Link");
      expect(linkHint("https://example.com/", mac)).toBe("https://example.com/\n⌘+Klick öffnet den Link");
    } finally { setLanguage("en"); resetLanguageForTest(); }
  });
});
