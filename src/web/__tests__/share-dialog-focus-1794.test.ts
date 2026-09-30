// #1794: the Share accounts dialog dropped keyboard focus on every step it
// took, and said nothing about the step it took it to.
//
// A keyboard user opens the dialog on "Share 3 accounts" and presses Enter.
// When the bundle arrives the picker's action row goes, and the focused button
// with it: focus falls to <body>, the dialog's trap sends the next Tab to the ×
// rather than to "copy all 3", and nothing speaks "3 accounts, ready to paste"
// or that this is 3 passwords. "Pick again" and, after the expiry, "make a new
// share" took their own buttons away the same way. And a share that failed put
// its reason in a paragraph no screen reader is told about.
//
// The rule is panel-press.ts's (#518): a control the update takes away hands
// focus to what replaced it — here each step's primary control, through
// useFocusRescue (#1762), which focus-rescue-1762.test.ts drives on its own.
// The dialog is a component the suite has no DOM to mount, so its wiring to it
// is read from the markup, the way #1411, #1540 and #1762 are. What the dialog
// draws as it opens is rendered: the region that says a bundle has landed has
// to be on the page before the bundle is, or a screen reader has nothing to
// watch change.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { sourceOf } from "./client-source";

vi.mock("react-dom", async (orig) => ({ ...(await orig<typeof import("react-dom")>()), createPortal: (node: unknown) => node }));

const { default: ShareAccountsDialog } = await import("../components/ShareAccountsDialog");

beforeAll(() => { vi.stubGlobal("document", { body: null }); });
afterAll(() => { vi.unstubAllGlobals(); });

const src = sourceOf("components/ShareAccountsDialog.tsx");

describe("focus follows the step (#1794)", () => {
  it("hands focus to the bundle's copy once the share it asked for replaces the picker", () => {
    expect(src).toMatch(/const rescueShare = useFocusRescue\(bundle != null, primaryRef\);/);
    expect(src).toMatch(/<button type="button" className="btn primary" ref=\{primaryRef\}\s*\{\.\.\.selfPressProps\(busy, !picked\.length\)\} onClick=\{\(\) => \{ rescueShare\(\); void make\(\); \}\}>/);
    // The copy is the bundle view's primary control, and so its first stop.
    expect(src).toMatch(/<button type="button" className="ap-manage-btn" ref=\{primaryRef\}/);
  });

  it("hands focus to Share once Pick again takes the bundle away", () => {
    expect(src).toMatch(/const rescuePick = useFocusRescue\(bundle == null, primaryRef\);/);
    expect(src).toMatch(/onClick=\{\(\) => \{ rescuePick\(\); setBundle\(null\); setCopied\(false\); \}\}>\s*Pick again/);
  });

  it("carries focus through a new share made after the expiry: to Share while it is out, then to the copy", () => {
    expect(src).toMatch(/if \(dead\) \{ rescuePick\(\); rescueShare\(\); setBundle\(null\); void make\(\); return; \}/);
  });
});

describe("what the dialog says (#1794)", () => {
  it("announces a share that failed", () => {
    expect(src).toMatch(/\{error && <p className="aa-err" role="alert">\{error\}<\/p>\}/);
  });

  it("says the bundle's heading and its warning as it lands, from a region outside the steps", () => {
    expect(src).toMatch(/<div className="vis-hidden" role="status" aria-atomic="true">\{said\}<\/div>\s*\{bundle \? \(/);
    expect(src).toMatch(/const said = !bundle \? "" : dead \? heading : `\$\{heading\} — \$\{warning\}`;/);
    // The view draws the same two, so what is said is what is on screen.
    expect(src).toMatch(/<h4>\{heading\}<\/h4>/);
    expect(src).toMatch(/<span className="ap-share-warn">\{warning\}<\/span>/);
  });

  it("is on the page, empty, before any bundle is", () => {
    const html = renderToStaticMarkup(createElement(ShareAccountsDialog, {
      accounts: [{ num: 1, email: "a@b", alias: null, org: null }],
      onClose: () => {},
      copyText: async () => true,
    }));
    expect(html).toContain('<section class="modal-body sa-body"><div class="vis-hidden" role="status" aria-atomic="true"></div><div class="sa-step">');
    expect(html).toContain(">Share 1 account</button>");
  });
});
