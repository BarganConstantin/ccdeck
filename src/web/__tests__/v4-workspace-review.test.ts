// V4 Workspace, the review's findings that live outside the stage hook (the
// hook's own are at the end of use-stage.test.ts): the empty pane's button, a
// phone's key sheet, the skip link, the keys landing from a row, Usage and
// Machine over the Inspector, and the left column's Sessions list.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sourceOf } from "./client-source";
import { withoutComments } from "./tsx-scan";
import { landFocus, openWaiting } from "../components/terminal/TerminalStage";
import { offersWorkspace, type TerminalSwitch } from "../components/TerminalSection";
import { keyHelpFor, WORKSPACE_KEY_ROW } from "../key-help";
import { SKIP_TO_PANE, WORKSPACE_PANE_ID, skipToPane } from "../workspace-pane";

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");
const waiting = { id: "oldest", name: "web-api", waited: "6m 42s", ask: "Allow this command?", command: null };

describe("the empty pane's Open <name> (review 2)", () => {
  it("opens exactly the session the card names, not the next ask", () => {
    const open = vi.fn();
    openWaiting(waiting, open)!();
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith("oldest");
  });

  it("is no button when nobody waits, or when nothing can open it", () => {
    expect(openWaiting(null, vi.fn())).toBeUndefined();
    expect(openWaiting(waiting, undefined)).toBeUndefined();
  });

  it("is wired by session, with the keys in its pane, and no longer through the next-ask door", () => {
    const ts = withoutComments(sourceOf("components/terminal/TerminalStage.tsx"));
    expect(ts).toContain("onOpenWaiting={openWaiting(p.waiting, p.onOpenWaiting)}");
    expect(ts).not.toContain("onOpenWaiting={p.onNextAsk}");
    const shell = withoutComments(sourceOf("components/terminal/StageShell.tsx"));
    expect(shell).toContain("onOpenWaiting={id => stage.switchTo(id, { focusPane: true })}");
  });
});

describe("a row opens its session in the pane, whatever the stage is doing (review 3a)", () => {
  it("is answered in Workspace before the Board's rule, which wants a stage that is up", () => {
    const app = withoutComments(sourceOf("App.tsx"));
    const at = app.indexOf("const openSession = useCallback");
    const body = app.slice(at, app.indexOf("}, [removedAgentIds, bringBack, focusSession, followSession, markLanded", at));
    expect(body.indexOf("workspaceRef.current && stage.enabled")).toBeGreaterThan(-1);
    expect(body.indexOf("openInPane(sessionId)")).toBeLessThan(body.indexOf("followSession(sessionId)"));
    // The Board's lines after it are the lines they were.
    expect(body).toContain("focusSession(sessionId);");
  });
});

describe("a phone's key sheet and Settings name no chord (review 6)", () => {
  const sw = (over: Partial<TerminalSwitch>): TerminalSwitch => ({ on: true, supported: true, toggle: () => {}, ...over });

  it("offers the chord where Workspace is on offer, and nowhere else", () => {
    expect(offersWorkspace(sw({}))).toBe(true);
    expect(offersWorkspace(sw({ phone: true }))).toBe(false);
    expect(offersWorkspace(sw({ on: false }))).toBe(false);
    expect(offersWorkspace(sw({ supported: false }))).toBe(false);
    expect(offersWorkspace(sw({ failed: true }))).toBe(false);
    expect(offersWorkspace(undefined)).toBe(false);
  });

  it("draws no chord row in the key sheet at phone width, and the row where it is offered", () => {
    const rows = (workspace: boolean) => keyHelpFor(true, () => true, workspace).flatMap(g => g.rows);
    expect(rows(offersWorkspace(sw({ phone: true })))).not.toContainEqual(WORKSPACE_KEY_ROW);
    expect(rows(offersWorkspace(sw({})))).toContainEqual(WORKSPACE_KEY_ROW);
  });

  it("is told the real phone value by App, and both screens ask the one function", () => {
    expect(withoutComments(sourceOf("App.tsx"))).toMatch(/terminal=\{\{ on: stage\.enabled, supported: stage\.supported, windows: stage\.windows, phone,/);
    for (const file of ["components/DeckDialogs.tsx", "components/SettingsModal.tsx"]) {
      const src = withoutComments(sourceOf(file));
      expect(src, file).toContain("workspace={offersWorkspace(terminal)}");
      expect(src, file).not.toMatch(/workspaceOffered\(\{[^}]*\}, false\)/);
    }
  });
});

describe("the skip link in Workspace (review 8)", () => {
  it("moves the focus to the pane, and never to the canvas", () => {
    const focus = vi.fn();
    const pane = { focus } as unknown as HTMLElement;
    expect(skipToPane(id => (id === WORKSPACE_PANE_ID ? pane : null))).toBe(true);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("leaves the link to its own jump when no pane is drawn", () => {
    expect(skipToPane(() => null)).toBe(false);
  });

  it("reads Skip to the pane there, and the Board's link is the link it was, byte for byte", () => {
    expect(SKIP_TO_PANE).toBe("Skip to the pane");
    const app = withoutComments(sourceOf("App.tsx"));
    expect(app).toContain('<a className="skip-link" href="#canvas">Skip to the canvas</a>');
    expect(app).toContain("href={`#${WORKSPACE_PANE_ID}`}");
    expect(app.indexOf("{inWorkspace\n")).toBeGreaterThan(-1);
  });

  it("gives the pane's element the id and a negative tabIndex, only as the Workspace pane", () => {
    const ts = withoutComments(sourceOf("components/terminal/TerminalStage.tsx"));
    expect(ts).toContain("id={workspace ? WORKSPACE_PANE_ID : undefined}");
    expect(ts).toContain("tabIndex={workspace ? -1 : undefined}");
  });
});

describe("Enter on a row lands the keys in the pane, not back on the row (review 9)", () => {
  const body = { id: "body" };
  const el = (opts: { inRow?: boolean; inBoard?: boolean } = {}) => {
    const e = {
      tagName: "BUTTON",
      focus: vi.fn(() => { (globalThis as { document: { activeElement: unknown } }).document.activeElement = e; }),
      closest: (sel: string) => (sel === ".session-list" && opts.inRow) || (sel.includes(".react-flow") && opts.inBoard) ? {} : null,
      setAttribute: () => {}, removeAttribute: () => {}, addEventListener: () => {}, removeEventListener: () => {},
    };
    return e;
  };
  const stage = (found: Record<string, unknown>, fill: boolean) => ({
    ...(fill ? { dataset: { fill: "" } } : {}),
    contains: () => false,
    querySelector: (sel: string) => found[sel] ?? null,
  }) as unknown as HTMLElement;
  const at = (active: unknown) => { (globalThis as Record<string, unknown>).document = { body, activeElement: active }; };
  afterEach(() => { delete (globalThis as Record<string, unknown>).document; });

  it("moves it onto the card's first action from the row the press left it on", () => {
    const row = el({ inRow: true });
    const action = el();
    at(row);
    expect(landFocus(stage({ "[data-stage-land]": action }, true))).toBe(true);
    expect(action.focus, "the state card's action, where the terminal could not attach").toHaveBeenCalledTimes(1);
  });

  it("and onto the header's own control when the card has no action", () => {
    const row = el({ inRow: true });
    const close = el();
    at(row);
    expect(landFocus(stage({ ".ts-head button[data-stage-close]": close }, true))).toBe(true);
    expect(close.focus).toHaveBeenCalledTimes(1);
  });

  it("leaves focus the reader has put on the list alone on the Board's stage, which has no rows", () => {
    const row = el({ inRow: true });
    const action = el();
    at(row);
    expect(landFocus(stage({ "[data-stage-land]": action }, false))).toBe(true);
    expect(action.focus).not.toHaveBeenCalled();
  });
});

describe("Usage and Machine over the Inspector (review 11)", () => {
  const css = strip(read("styles/workspace.css"));
  const machine = strip(read("styles/machine-panel.css"));

  /** The text of an at-rule block opened by `head`. */
  function block(text: string, head: string): string {
    const at = text.indexOf(head);
    expect(at, head).toBeGreaterThan(-1);
    const open = text.indexOf("{", at);
    let depth = 0;
    for (let i = open; i < text.length; i++) {
      if (text[i] === "{") depth++;
      if (text[i] === "}" && --depth === 0) return text.slice(open + 1, i);
    }
    throw new Error(`unclosed ${head}`);
  }

  it("puts their right edge where the Board has no Inspector under them, from 1320 up, in Workspace only", () => {
    const wide = block(css, "@media (min-width: 1320px)");
    expect(wide.replace(/\s+/g, " ")).toContain('body .app[data-view="workspace"] { --rail-r: calc(8px + var(--edge-w)); }');
  });

  it("states it nowhere else: under 1320 the Board's place stands", () => {
    const wide = block(css, "@media (min-width: 1320px)");
    const rest = css.replace(wide, "");
    expect(rest).not.toContain("--rail-r");
  });

  it("is a column of the Inspector's width: 280px plus the density's increase, inside 320", () => {
    // The panels are 280 wide (+ --ui-panel-increase), the Inspector 320 at
    // Compact and 360 at Default, and the right edge is 8px inside the stripe:
    // the left edge is at least 32px inside the Inspector's, so never left of
    // the pane's right edge.
    const panel = /width:\s*calc\(280px \+ var\(--ui-panel-increase, 0px\)\)/;
    expect(machine).toMatch(panel);
    expect(strip(read("styles/tokens.css"))).toMatch(/--inspector-w:\s*360px/);
  });

  it("leaves the Board's own rules where they were", () => {
    expect(machine).toContain(".app { --rail-r: calc(var(--inspector-w) + 8px + var(--edge-w)); }");
    expect(machine).toContain(".app:not(:has(.detail)) { --rail-r: calc(8px + var(--edge-w)); }");
  });
});
