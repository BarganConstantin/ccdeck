// A tab that outlives an upgrade still holds the old bundle, and the old bundle
// names the old hashes of the two dialogs that load when they open (#883). Once
// `npm i -g` has rewritten dist/web, those files are gone: the server answered
// the missing chunk with index.html as 200 text/html, the dynamic import failed,
// React.lazy rethrew it during render, and the only boundary — the one round
// the whole deck — swapped the canvas, the panels and the topbar for the crash
// pane, and forwarded a crash report for no real fault.
//
// Two halves, each pinned here: a missing file under assets/ is a 404 rather
// than a page that cannot run as a module, and a dialog whose chunk does not
// arrive fails as that dialog — it says so and offers the reload — while the
// rest of the deck stays up.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ComponentType, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { serveStatic } from "../../server/static-serve.mjs";

// What the browser's import() does when the server no longer has the file.
vi.mock("../components/UsageHistoryModal", () => {
  throw new TypeError("Failed to fetch dynamically imported module: /assets/UsageHistoryModal-OLDHASH.js");
});
vi.mock("../components/BrowserWatchModal", () => {
  throw new TypeError("Failed to fetch dynamically imported module: /assets/BrowserWatchModal-OLDHASH.js");
});

import DeckDialogs from "../components/DeckDialogs";

function fakeRes() {
  const r: { status?: number; headers?: Record<string, unknown>; body?: string } = {};
  return {
    r,
    res: {
      writeHead(status: number, headers?: Record<string, unknown>) { r.status = status; r.headers = headers; },
      end(b?: unknown) { r.body = b == null ? "" : String(b); },
      setHeader() {}, getHeader() { return undefined; },
    },
  };
}

async function get(path: string) {
  const { r, res } = fakeRes();
  await serveStatic({ method: "GET", url: path, headers: {} }, res, new URL(`http://127.0.0.1${path}`));
  return r;
}

describe("a file the build no longer has", () => {
  it("is a 404 under assets/, not index.html", async () => {
    for (const path of ["/assets/UsageHistoryModal-OLDHASH.js", "/assets/index-OLDHASH.css"]) {
      const r = await get(path);
      expect(r.status, path).toBe(404);
      expect(String(r.headers?.["Content-Type"] ?? ""), path).not.toContain("text/html");
      expect(r.body?.toLowerCase() ?? "", path).not.toContain("<!doctype html>");
    }
  });

  it("still answers a client-side route with the page", async () => {
    const r = await get("/some/client/route");
    expect(r.status).toBe(200);
    expect(String(r.headers?.["Content-Type"])).toContain("text/html");
  });
});

const LAZY = Symbol.for("react.lazy");
type Lazy = { $$typeof: symbol; _payload: unknown; _init: (p: unknown) => ComponentType<Record<string, unknown>> };

/** Every lazy component DeckDialogs puts on screen for these flags. DeckDialogs
 *  calls no hooks, so its markup is read straight off its return value. */
function lazyDialogs(flags: { usageHistoryOpen?: boolean; browserWatchOpen?: boolean }): Lazy[] {
  const noop = () => {};
  const props = {
    dialogs: {
      openedTool: null, setOpenedToolKey: noop, usageHistoryOpen: false, setUsageHistoryOpen: noop,
      browserWatchOpen: false, setBrowserWatchOpen: noop, contextAgent: null, setContextFor: noop,
      summaryFor: null, setSummaryFor: noop, keyHelpOpen: false, setKeyHelpOpen: noop,
      feedbackOpen: false, setFeedbackOpen: noop, feedbackPrefill: null, setFeedbackPrefill: noop,
      ...flags,
    },
    welcome: { tourOpen: false, openTour: noop, closeTour: noop, releaseNotes: null, closeReleaseNotes: noop, chipVersion: "1.0.0" },
    desktopUpdate: { desktopUpdateRestarting: false, desktopUpdateFailure: null, readyAppUpdate: null, askDesktopUpdateRestart: noop },
    versionCheck: { version: null },
    restart: { askRestart: noop },
    lanPairs: {},
    attention: {},
    clearFlow: { clearConfirmOpen: false, setClearConfirmOpen: noop, requestClear: noop },
    watchBadge: { setWatchOn: noop, markWatchSeen: noop },
    announcements: { setWatchSaid: noop },
    appearance: { palette: "default" },
    providers: { claude: true, codex: false },
    stateRef: { current: {} },
    agentCount: 0,
  };
  const found: Lazy[] = [];
  const walk = (node: ReactNode) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object" || !("type" in node)) return;
    const el = node as ReactElement<{ children?: ReactNode }>;
    if ((el.type as unknown as Lazy)?.$$typeof === LAZY) found.push(el.type as unknown as Lazy);
    walk(el.props?.children);
  };
  walk((DeckDialogs as unknown as (p: typeof props) => ReactNode)(props));
  return found;
}

/** What React.lazy hands the renderer once the import has settled: the
 *  component, or the error it rethrows into the nearest boundary. */
async function settle(type: Lazy): Promise<ComponentType<Record<string, unknown>>> {
  try {
    return type._init(type._payload);
  } catch (pending) {
    if (pending && typeof (pending as Promise<unknown>).then === "function") {
      await (pending as Promise<unknown>).then(() => {}, () => {});
      return type._init(type._payload);
    }
    throw pending;
  }
}

describe("a dialog whose chunk does not arrive", () => {
  // lazyDialog says what failed on the console; the test only needs the result.
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  for (const [flag, name] of [["usageHistoryOpen", "Usage history"], ["browserWatchOpen", "Browser Watch"]] as const) {
    it(`fails as ${name} alone, and offers the reload`, async () => {
      const [type] = lazyDialogs({ [flag]: true });
      expect(type, `no lazy dialog for ${flag}`).toBeTruthy();
      // Before: this rethrew "Failed to fetch dynamically imported module",
      // which React passes to the boundary round the whole deck.
      const Shown = await settle(type);
      const html = renderToStaticMarkup(createElement(Shown, { onClose: () => {} }));
      expect(html).toContain('role="dialog"');
      expect(html).toContain(name);
      expect(html).toMatch(/>Reload</);
      expect(html).toMatch(/>Close</);
    });
  }
});
