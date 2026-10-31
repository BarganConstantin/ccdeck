// A press on a link in the pane (terminal-links.ts): the web only, Ctrl+click
// (Cmd+click on a Mac) only, never while the program has the mouse, and never
// through a browser dialog.
import { afterEach, describe, expect, it, vi } from "vitest";
import { linkToOpen, openLink } from "../terminal-links";

const linux = { apple: false, programHasMouse: false };
const mac = { apple: true, programHasMouse: false };
const plain = { ctrlKey: false, metaKey: false };
const ctrl = { ctrlKey: true, metaKey: false };
const cmd = { ctrlKey: false, metaKey: true };

afterEach(() => { delete (globalThis as Record<string, unknown>).window; });

describe("which press on a link opens it", () => {
  it("opens http and https on Ctrl+click, and Cmd+click on a Mac", () => {
    expect(linkToOpen(ctrl, "https://github.com/o/r/pull/1", linux)).toBe("https://github.com/o/r/pull/1");
    expect(linkToOpen(ctrl, "http://localhost:3000/", linux)).toBe("http://localhost:3000/");
    expect(linkToOpen(cmd, "https://example.com", mac)).toBe("https://example.com/");
  });

  it("opens nothing on a plain click, or with the other platform's modifier", () => {
    expect(linkToOpen(plain, "https://example.com", linux)).toBeNull();
    expect(linkToOpen(cmd, "https://example.com", linux)).toBeNull();
    expect(linkToOpen(ctrl, "https://example.com", mac)).toBeNull();
  });

  it("leaves the click to a program that has the mouse, which opens links itself", () => {
    expect(linkToOpen(ctrl, "https://example.com", { apple: false, programHasMouse: true })).toBeNull();
  });

  it("opens nothing that is not the web", () => {
    for (const uri of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "vscode://file/x", "not a url", ""]) {
      expect(linkToOpen(ctrl, uri, linux), uri).toBeNull();
    }
  });

  it("opens in a new tab with no opener, and never asks with confirm()", () => {
    const open = vi.fn();
    const confirm = vi.fn();
    (globalThis as Record<string, unknown>).window = { open, confirm };
    openLink(ctrl, "https://example.com/a?b=1", linux);
    openLink(plain, "https://example.com/a?b=1", linux);
    expect(open.mock.calls).toEqual([["https://example.com/a?b=1", "_blank", "noopener,noreferrer"]]);
    expect(confirm).not.toHaveBeenCalled();
  });
});
