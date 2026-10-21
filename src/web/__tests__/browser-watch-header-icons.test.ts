import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import BrowserWatchModal from "../components/BrowserWatchModal";
import { readPalette } from "../palette";

const state = vi.hoisted(() => ({ busy: false }));
vi.mock("../use-browser-watch", () => ({
  useBrowserWatch: () => ({
    snap: null, error: null, writeError: null, busy: state.busy,
    quiet: null, saving: false, load: () => {}, dismiss: () => {},
    save: () => {}, setQuiet: () => {}, setWriteError: () => {},
  }),
}));

function refreshMarkup() {
  const html = renderToStaticMarkup(createElement(BrowserWatchModal, {
    onClose: () => {}, onSeen: () => {}, onWatching: () => {},
    palette: readPalette(() => "#ffffff"),
  }));
  return html.match(/<button\b[^>]*aria-label="Re-read every profile now"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? "";
}

describe("Browser Watch refresh stays independent of system fonts", () => {
  it("draws a square vector icon instead of the font-dependent Unicode arrow", () => {
    state.busy = false;
    const button = refreshMarkup();
    expect(button).toContain("<svg");
    expect(button).toMatch(/width="13" height="13"/);
    expect(button).toContain('aria-hidden="true"');
    expect(button).not.toContain("↻");
  });

  it("keeps the existing busy feedback and accessible refresh name", () => {
    state.busy = true;
    const button = refreshMarkup();
    expect(button).toContain('aria-busy="true"');
    expect(button).toContain("…");
    expect(button).not.toMatch(/\sdisabled(?:=|\s|>)/);
    state.busy = false;
  });
});
