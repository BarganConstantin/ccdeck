// V4 Phase 2, PR 1: the status bar (its Figma Shell / Status bar 27:7169) and
// the keys that arrived with it, N, Shift+N and P.
//
// The acceptance in one sentence: the status bar names only keys that work.
// So this file holds the bar's table (status-hints.ts) against the handler
// (use-deck-shortcuts.ts, terminal-keys.ts) and the sheet (key-help.ts), the
// way key-help.test.ts holds the sheet against the handler, and pins how the
// bar looks the way v4-bars.test.ts pins the bars. Plain node, no DOM: the
// components are read as text, the helpers are called.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { sheetText } from "./sheet-source";
import { blockedSessions, nextWaiting, prevWaiting, type BlockedSession } from "../ambient-counts";
import { KEY_HELP, documentedKeys } from "../key-help";
import { BOARD_HINTS, DECK_HINTS, statusViewFor } from "../status-hints";
import { isReleaseChord, paneNameOf, releaseChordLabel, stageKeyIntent } from "../terminal-keys";
import { isCharacterKey } from "../single-key-shortcuts";
import type { AgentNodeData } from "../types";

const web = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFileSync(join(web, rel), "utf8");

const css = read("styles/status-bar.css").replace(/\/\*[\s\S]*?\*\//g, "");
/** The declarations of the rule whose selector is exactly `selector`, at the
 *  top level (media: "") or inside the given @media prelude. */
function rule(selector: string, media = ""): Record<string, string> {
  const firstMedia = css.indexOf("@media");
  const text = media ? css.slice(css.indexOf(`@media ${media}`)) : css.slice(0, firstMedia < 0 ? css.length : firstMedia);
  const out: Record<string, string> = {};
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|[}\\s])${escaped}\\s*\\{([^}]*)\\}`).exec(text);
  if (!m) return out;
  for (const d of m[1].matchAll(/([\w-]+)\s*:\s*([^;]+?)\s*(?:;|$)/g)) out[d[1]] = d[2].replace(/\s+/g, " ");
  return out;
}

describe("the bar's geometry, from Figma", () => {
  const bar = rule(".statusbar");

  it("is --statusbar-h tall, full width, a row of its own at the foot of the shell", () => {
    expect(bar["height"]).toBe("var(--statusbar-h)");
    expect(bar["grid-row"]).toBe("4");
    expect(bar["grid-column"]).toBe("1 / -1");
    // Out across the stripes' padding, as the topbar is.
    expect(bar["margin-inline"]).toBe("calc(-1 * var(--edge-w))");
    expect(bar["overflow"]).toBe("hidden");
    expect(bar["position"]).toBeUndefined();
  });

  it("is a flex row, centred, packed to the start, 12 apart, padded 0 8 0 12", () => {
    expect(bar["display"]).toBe("flex");
    expect(bar["flex-direction"]).toBe("row");
    expect(bar["align-items"]).toBe("center");
    expect(bar["justify-content"]).toBe("flex-start");
    expect(bar["gap"]).toBe("12px");
    expect(bar["padding"]).toBe("0 8px 0 12px");
  });

  it("is a panel with a hairline on top, no bottom border, no radius", () => {
    expect(bar["background"]).toBe("var(--panel)");
    expect(bar["border-top"]).toBe("1px solid var(--line)");
    expect(bar["border-bottom"]).toBe("0");
    expect(bar["border-radius"]).toBe("0");
  });

  it("sets its type at 12/16 and follows --ui-text-increase like the rest of the chrome", () => {
    expect(bar["font-size"]).toBe("calc(12px + var(--ui-text-increase, 0px))");
    expect(bar["line-height"]).toBe("calc(16px + var(--ui-text-increase, 0px))");
  });

  it("never wraps: items clip at the right edge", () => {
    expect(bar["white-space"]).toBe("nowrap");
    expect(bar["overflow"]).toBe("hidden");
    expect(rule(".statusbar-hint")["flex"]).toBe("none");
  });

  it("draws who has the keys as a 6 x 6 round dot and a 500-weight secondary label, 6 apart", () => {
    const who = rule(".statusbar-who");
    expect(who["gap"]).toBe("6px");
    expect(who["align-items"]).toBe("center");
    expect(who["font-weight"]).toBe("500");
    expect(who["color"]).toBe("var(--text-secondary)");
    const dot = rule(".statusbar-dot");
    expect(dot["width"]).toBe("6px");
    expect(dot["height"]).toBe("6px");
    expect(dot["border-radius"]).toBe("50%");
  });

  it("colours the dot by layer: muted on the board and the deck, accent in the terminal", () => {
    expect(rule(".statusbar-dot")["background"]).toBe("var(--muted)");
    expect(rule('.statusbar[data-layer="terminal"] .statusbar-dot')["background"]).toBe("var(--accent)");
    expect(css).not.toMatch(/data-layer="(board|deck)"/);
  });

  it("draws a hint as caps then a 400-weight muted word, 4 apart, and two caps 4 apart", () => {
    const hint = rule(".statusbar-hint");
    expect(hint["gap"]).toBe("4px");
    expect(hint["align-items"]).toBe("center");
    expect(hint["font-weight"]).toBe("400");
    expect(hint["color"]).toBe("var(--muted)");
    expect(rule(".statusbar-caps")["gap"]).toBe("4px");
  });

  it("draws V4's Kbd: bg-soft, a hairline, 1 5 padding, radius 4, mono 11/14 at 500", () => {
    const kbd = rule(".kbd");
    expect(kbd["background"]).toBe("var(--bg-soft)");
    expect(kbd["border"]).toBe("1px solid var(--line)");
    expect(kbd["padding"]).toBe("1px 5px");
    expect(kbd["border-radius"]).toBe("4px");
    expect(kbd["font-family"]).toBe("var(--font-mono)");
    expect(kbd["font-size"]).toBe("calc(11px + var(--ui-text-increase, 0px))");
    expect(kbd["line-height"]).toBe("calc(14px + var(--ui-text-increase, 0px))");
    expect(kbd["font-weight"]).toBe("500");
    expect(kbd["color"]).toBe("var(--muted)");
    expect(kbd["white-space"]).toBe("nowrap");
  });

  it("uses tokens only and moves nothing", () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    expect(css).not.toMatch(/\b(transition|animation|transform)\s*:/);
  });
});

describe("the shell gives it a row, and everything else makes room", () => {
  const tokens = read("styles/tokens.css");

  it("adds the foot as an implicit fourth row, past the three the panels span, and gives it back on a phone", () => {
    // The explicit template stays the three drift-pane-615 pins; the bar is
    // placed on row 4, which only grid-auto-rows sizes, so the panels' `2 / -1`
    // and `3 / -1` still end above it.
    expect(tokens).toMatch(/grid-template-rows: var\(--topbar-h\) auto 1fr;/);
    expect(rule(".app")["grid-auto-rows"]).toBe("var(--status-room)");
    expect(rule(".app")["--status-room"]).toBe("var(--statusbar-h)");
    expect(rule(".app", "(max-width: 640px)")["--status-room"]).toBe("0px");
  });

  it("is not drawn on a phone, at the sheet's one narrow breakpoint", () => {
    expect(rule(".statusbar", "(max-width: 640px)")["display"]).toBe("none");
    // The same breakpoint EdgeDock decides on.
    expect(read("phone-load.ts")).toContain('PHONE_QUERY = "(max-width: 640px)"');
    expect(read("App.tsx")).toMatch(/\{!phone && <StatusBar stageOpen=/);
  });

  it("ends the panels that span the rows above the bar, and the fixed ones with it", () => {
    // `-1` is the end of the EXPLICIT grid, three rows: the bar's row is past it.
    expect(tokens).toMatch(/\.detail \{ grid-column: 2; grid-row: 2 \/ -1; \}/);
    expect(read("styles/left-column.css")).toMatch(/grid-row: 2 \/ -1;/);
    expect(read("styles/rating.css")).toMatch(/\{ grid-row: 3 \/ -1; \}/);
    for (const f of ["edge-rails.css", "usage-panel.css", "machine-panel.css", "panel-place.css", "rating.css"]) {
      expect(read(`styles/${f}`), f).toContain("var(--status-room, 0px)");
    }
    // The dragged panels' room ends where the bar begins.
    expect(read("panel-place.ts")).toContain('document.querySelector(".statusbar")');
  });

  it("is a sheet part imported after the stripes it reads --status-room beside", () => {
    const sheet = read("styles.css");
    expect(sheet.indexOf("status-bar.css")).toBeGreaterThan(sheet.indexOf("edge-rails.css"));
    expect(sheetText()).toContain(".statusbar-who");
  });
});

describe("the three layers, word for word", () => {
  const plain = (v: ReturnType<typeof statusViewFor>) => v.hints.map(h => `${h.caps.map(c => c.text).join(" ")} ${h.word}`);

  it("board: the board has the keys and the stage is closed", () => {
    const v = statusViewFor({ stageOpen: false, pane: null, onCard: true, zoomedOut: true, singleKeys: true, platform: "Linux" });
    expect(v.layer).toBe("board");
    expect(v.label).toBe("Keys on the board");
    expect(plain(v)).toEqual(["j k cards", "↵ select", "p peek", "n next waiting"]);
  });

  it("deck: the stage is open and the board around it has the keys", () => {
    const v = statusViewFor({ stageOpen: true, pane: null, onCard: true, zoomedOut: true, singleKeys: true, platform: "Linux" });
    expect(v.layer).toBe("deck");
    expect(v.label).toBe("Keys on the deck");
    expect(plain(v)).toEqual(["j k sessions", "↵ open and type", "n next waiting"]);
  });

  it("terminal: focus is in the pane, named as the stage's header names it, and one item", () => {
    const v = statusViewFor({ stageOpen: true, pane: "api · c450", onCard: true, zoomedOut: true, singleKeys: true, platform: "Linux" });
    expect(v.layer).toBe("terminal");
    expect(v.label).toBe("Keys in api · c450");
    expect(plain(v)).toEqual(["Ctrl+Shift+X keys back to the deck"]);
  });

  it("terminal: the release chord is spelled as the keyboard in front of the reader labels it", () => {
    const mac = statusViewFor({ stageOpen: true, pane: "api", onCard: true, zoomedOut: true, singleKeys: true, platform: "MacIntel" });
    expect(mac.hints[0].caps[0].text).toBe(releaseChordLabel("MacIntel"));
    expect(mac.hints[0].caps[0].text).toBe("⌃⇧X");
    expect(mac.hints[0].caps[0].spoken).toBe("Control Shift X");
  });

  it("focus in a pane is the terminal layer in every phase: closing, the pane still takes every key", () => {
    // stageOpen is stageClaimsKeys(phase), false while the stage closes; the
    // handler hands a focused pane its keys whatever the phase (inTerminalPanel).
    expect(statusViewFor({ stageOpen: false, pane: "api", onCard: false, zoomedOut: true, singleKeys: true, platform: "Linux" }).layer).toBe("terminal");
    expect(read("use-deck-shortcuts.ts")).toMatch(/if \(inTerminalPanel\(el\)\) \{/);
  });

  it("names ↵ select only while the keyboard is on a card: no handler answers the board's Enter anywhere else", () => {
    const off = statusViewFor({ stageOpen: false, pane: null, onCard: false, zoomedOut: true, singleKeys: true, platform: "Linux" });
    expect(off.hints.map(h => h.word)).toEqual(["cards", "peek", "next waiting"]);
    expect(BOARD_HINTS.filter(h => h.onCard).map(h => h.word)).toEqual(["select"]);
    // The deck's Enter is the stage's own (focus-pane), wherever focus is.
    expect(DECK_HINTS.some(h => h.onCard)).toBe(false);
    const deck = statusViewFor({ stageOpen: true, pane: null, onCard: false, zoomedOut: true, singleKeys: true, platform: "Linux" });
    expect(deck.hints.map(h => h.word)).toContain("open and type");
    expect(stageKeyIntent({ key: "Enter", repeat: false, modalOpen: false, target: null } as never)).toEqual({ kind: "focus-pane" });
  });

  it("names p peek only past the detail distance, where P opens one: the peek's own rule, by key or hover", () => {
    const near = statusViewFor({ stageOpen: false, pane: null, onCard: true, zoomedOut: false, singleKeys: true, platform: "Linux" });
    expect(near.hints.map(h => h.word)).toEqual(["cards", "select", "next waiting"]);
    expect(BOARD_HINTS.filter(h => h.zoomedOut).map(h => h.word)).toEqual(["peek"]);
    // The bar reads the same tier P reads (use-zoom-lod.ts), as a prop.
    // (Workspace adds a third prop, viewChord, after the zoom tier.)
    expect(read("App.tsx")).toMatch(/<StatusBar stageOpen=\{[^}]+\} zoomedOut=\{zoom\.lod !== "detail"\}( viewChord=\{[^\n]+\})? \/>/);
  });

  it("the bar learns 'on a card' from focus, as the handler does (isCanvasNodeElement)", () => {
    const bar = read("components/StatusBar.tsx");
    expect(bar).toMatch(/onCard: isCanvasNodeElement\(el\)/);
    expect(read("canvas-keys.ts")).toMatch(/activate/);
  });

  it("draws Enter as the symbol and says Enter", () => {
    const enter = BOARD_HINTS.find(h => h.word === "select")!.caps[0];
    expect(enter).toEqual({ text: "↵", spoken: "Enter" });
  });

  it("never names the backtick or Ctrl+backtick: they work in Phase 3", () => {
    for (const hint of [...BOARD_HINTS, ...DECK_HINTS]) {
      for (const c of hint.caps) expect(c.text, hint.word).not.toContain("`");
      for (const b of hint.binds) expect(b, hint.word).not.toBe("`");
      expect(hint.word).not.toMatch(/workspace|chat|term\b/);
    }
  });

  it("does not draw p in the deck: the stage hides the canvas a peek would hang off", () => {
    expect(DECK_HINTS.some(h => h.binds.includes("p"))).toBe(false);
    // And the key agrees: P does nothing while the stage is open.
    expect(read("use-deck-shortcuts.ts")).toMatch(/if \(!stageRef\?\.current\?\.open\) peekSelected\(\);/);
  });
});

describe("with the single keys off the bar names no single character key", () => {
  it("keeps only the named keys: Enter on the board and on the deck", () => {
    const board = statusViewFor({ stageOpen: false, pane: null, onCard: true, zoomedOut: true, singleKeys: false, platform: "Linux" });
    expect(board.hints.map(h => h.word)).toEqual(["select"]);
    const deck = statusViewFor({ stageOpen: true, pane: null, onCard: true, zoomedOut: true, singleKeys: false, platform: "Linux" });
    expect(deck.hints.map(h => h.word)).toEqual(["open and type"]);
  });

  it("leaves the terminal layer as it is: a chord is not a single key", () => {
    const on = statusViewFor({ stageOpen: true, pane: "api", onCard: true, zoomedOut: true, singleKeys: true, platform: "Linux" });
    const off = statusViewFor({ stageOpen: true, pane: "api", onCard: true, zoomedOut: true, singleKeys: false, platform: "Linux" });
    expect(off).toEqual(on);
  });

  it("draws no character cap in any layer", () => {
    for (const stageOpen of [false, true]) {
      const v = statusViewFor({ stageOpen, pane: null, onCard: true, zoomedOut: true, singleKeys: false, platform: "Linux" });
      for (const h of v.hints) for (const b of h.binds) expect(isCharacterKey(b), `${h.word}: ${b}`).toBe(false);
    }
  });
});

describe("every key the bar names works", () => {
  const handlerSource = read("use-deck-shortcuts.ts");
  const start = handlerSource.indexOf("const onKey = (e: KeyboardEvent) => {");
  const end = handlerSource.indexOf('window.addEventListener("keydown", onKey);', start);
  const HANDLER = handlerSource.slice(start, end);
  const BOUND = new Set([...HANDLER.matchAll(/e\.key === "((?:[^"\\]|\\.)*)"/g)].map(m => m[1]));
  const documented = documentedKeys();
  const target = { tagName: "BODY" };

  it("found the handler, so the sweep is not vacuous", () => {
    expect(BOUND.size).toBeGreaterThan(20);
  });

  it("the board layer: each letter is a literal the handler answers in both cases, and is on the sheet", () => {
    for (const hint of BOARD_HINTS) {
      for (const bind of hint.binds) {
        expect(documented, `${bind} is not on the sheet`).toContain(bind.toLowerCase());
        if (isCharacterKey(bind)) {
          expect(BOUND, bind).toContain(bind);
          expect(BOUND, bind.toUpperCase()).toContain(bind.toUpperCase());
        }
      }
    }
    // Enter is a named key: a focused card's, answered by canvasKeyIntent.
    expect(read("canvas-keys.ts")).toMatch(/Enter/);
  });

  it("the deck layer: j, k, Enter and n are what stageKeyIntent answers with the stage open", () => {
    expect(stageKeyIntent({ key: "j", repeat: false, target, modalOpen: false })).toEqual({ kind: "step", direction: 1 });
    expect(stageKeyIntent({ key: "k", repeat: false, target, modalOpen: false })).toEqual({ kind: "step", direction: -1 });
    expect(stageKeyIntent({ key: "Enter", repeat: false, target, modalOpen: false })).toEqual({ kind: "focus-pane" });
    expect(stageKeyIntent({ key: "n", repeat: false, target, modalOpen: false })).toEqual({ kind: "next-ask" });
    // Shift+N is "N" to the handler: still the next ask inside the stage, not
    // the board's previous-waiting.
    expect(stageKeyIntent({ key: "N", repeat: false, target, modalOpen: false })).toEqual({ kind: "next-ask" });
    for (const hint of DECK_HINTS) for (const b of hint.binds) expect(documented).toContain(b.toLowerCase());
  });

  it("the deck layer does not name p: the stage leaves p to the board's handler, which declines it", () => {
    expect(stageKeyIntent({ key: "p", repeat: false, target, modalOpen: false })).toBeNull();
  });

  it("the terminal layer: the chord it names is the one the handler releases on", () => {
    expect(isReleaseChord({ key: "X", code: "KeyX", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false })).toBe(true);
    expect(HANDLER).toMatch(/if \(isReleaseChord\(e\)\) \{[\s\S]{0,120}stageRef\?\.current\?\.release\(\)/);
  });

  it("every letter hint is a row of the sheet whose binds include it", () => {
    const rows = KEY_HELP.flatMap(g => g.rows);
    for (const hint of [...BOARD_HINTS, ...DECK_HINTS]) {
      for (const bind of hint.binds.filter(isCharacterKey)) {
        expect(rows.some(r => r.binds.includes(bind) && r.binds.includes(bind.toUpperCase())), bind).toBe(true);
      }
    }
  });
});

describe("the pane says whose it is", () => {
  const el = (attrs: Record<string, string> | null) => ({
    closest: (sel: string) => (attrs && sel === "[data-terminal-panel]" ? { getAttribute: (n: string) => attrs[n] ?? null } : null),
  });

  it("reads the name off the pane, and null outside every pane", () => {
    expect(paneNameOf(el({ "data-terminal-name": "api" }))).toBe("api");
    expect(paneNameOf(el(null))).toBeNull();
    expect(paneNameOf(null)).toBeNull();
    expect(paneNameOf({})).toBeNull();
  });

  it("a pane without a name still answers, so the bar is still the terminal layer", () => {
    expect(paneNameOf(el({}))).toBe("");
    expect(statusViewFor({ stageOpen: true, pane: "", onCard: true, zoomedOut: true, singleKeys: true, platform: "Linux" }).label).toBe("Keys in the session");
  });

  it("the stage's pane carries the header's name", () => {
    expect(read("components/terminal/StageBody.tsx")).toMatch(/data-terminal-panel=""\s+data-terminal-name=\{p\.paneName\}/);
    expect(read("components/terminal/TerminalStage.tsx")).toMatch(/hostRef=\{session\.hostRef\}\s+paneName=\{name\}/);
  });
});

describe("the landmark, the focus listeners and the first-load graph", () => {
  const bar = read("components/StatusBar.tsx");

  it("is one footer named Keys, with no live region", () => {
    expect(bar).toMatch(/<footer className="statusbar" aria-label="Keys"/);
    expect(bar).not.toMatch(/aria-live|role="status"|role="alert"/);
  });

  it("speaks a symbol cap's words from a hidden span, never an aria-label on a bare <kbd>", () => {
    const kbd = read("components/Kbd.tsx");
    expect(kbd).toMatch(/<kbd className="kbd" aria-hidden>\{children\}<\/kbd>\s*<span className="kbd-spoken">\{label\}<\/span>/);
    expect(kbd).not.toMatch(/<kbd[^>]*aria-label/);
    expect(css).toMatch(/\.kbd-spoken \{ position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset\(50%\); white-space: nowrap; \}/);
  });

  it("watches the focused pane's name, which the stage changes in place with no focus event", () => {
    expect(bar).toMatch(/names\.observe\(pane, \{ attributes: true, attributeFilter: \[PANE_NAME_ATTR\] \}\)/);
    expect(bar).toMatch(/names\.disconnect\(\);\s*document\.removeEventListener\("focusin"/);
  });

  it("renders only when its inputs change: memoised against App's clock", () => {
    expect(bar).toMatch(/export default memo\(function StatusBar\(/);
  });

  it("follows focus from the document's events, not a timer", () => {
    expect(bar).toContain('document.addEventListener("focusin"');
    expect(bar).toContain('document.addEventListener("focusout"');
    expect(bar).not.toMatch(/setInterval|setTimeout|requestAnimationFrame/);
  });

  it("is imported statically by App.tsx and imports nothing of the stage", () => {
    expect(read("App.tsx")).toMatch(/^import StatusBar from "\.\/components\/StatusBar";/m);
    for (const f of ["components/StatusBar.tsx", "components/Kbd.tsx", "status-hints.ts"]) {
      const imports = [...read(f).matchAll(/from "([^"]+)"/g)].map(m => m[1]);
      for (const i of imports) {
        expect(i, `${f} imports ${i}`).not.toMatch(/terminal\/|use-stage|StageSlots|stage-shell|use-terminal/);
      }
    }
  });
});

describe("N, Shift+N and P", () => {
  const agent = (id: string, since: number): AgentNodeData => ({
    id, kind: "root", label: id, sessionId: id, waiting: { kind: "permission", since, text: "" },
  } as unknown as AgentNodeData);
  const queue: BlockedSession[] = blockedSessions([agent("a", 1), agent("b", 2), agent("c", 3)]);

  it("prevWaiting is nextWaiting the other way, wrapping", () => {
    expect(prevWaiting(queue, "c")!.id).toBe("b");
    expect(prevWaiting(queue, "b")!.id).toBe("a");
    expect(prevWaiting(queue, "a")!.id).toBe("c");
  });

  it("with nothing visited yet, or the visited one answered, it starts from the end", () => {
    expect(prevWaiting(queue, null)!.id).toBe("c");
    expect(prevWaiting(queue, "gone")!.id).toBe("c");
  });

  it("nothing waiting, nothing to go to", () => {
    expect(prevWaiting([], null)).toBeNull();
    expect(prevWaiting([], "a")).toBeNull();
  });

  it("next and previous undo each other on one queue", () => {
    const n = nextWaiting(queue, "a")!;
    expect(prevWaiting(queue, n.id)!.id).toBe("a");
    expect(prevWaiting(queue, prevWaiting(queue, "b")!.id)!.id).toBe("c");
  });

  it("a single waiting session is its own next and previous", () => {
    const one = queue.slice(0, 1);
    expect(nextWaiting(one, "a")!.id).toBe("a");
    expect(prevWaiting(one, "a")!.id).toBe("a");
  });

  const source = read("use-deck-shortcuts.ts");
  const nBranch = source.slice(source.indexOf('if (e.key === "n" || e.key === "N") {'));

  it("N shares W's cursor and queue, and Shift decides the direction, not the letter's case", () => {
    expect(source).toMatch(/if \(e\.key === "n" \|\| e\.key === "N"\) \{/);
    expect(nBranch.slice(0, 520)).toMatch(/e\.shiftKey \? prevWaiting\(queue, waitingCursorRef\.current\) : nextWaiting\(queue, waitingCursorRef\.current\)/);
    expect(nBranch.slice(0, 520)).toMatch(/waitingCursorRef\.current = to\.id;\s*focusSession\(to\.id\);/);
    expect(nBranch.slice(0, 520)).not.toMatch(/e\.key === "N"\s*\?|e\.key === "n"\s*\?/);
    // W is untouched.
    expect(source).toMatch(/const next = nextWaiting\(blockedSessions\(stateRef\.current\.agents\.values\(\)\), waitingCursorRef\.current\);/);
  });

  it("N and P sit among the letters behind the shared gates, after the single-key filter", () => {
    const gate = source.indexOf("characterKeyMuted(e.key, singleKeyShortcutsOn())");
    expect(gate).toBeGreaterThan(0);
    expect(source.indexOf('if (e.key === "n" || e.key === "N")')).toBeGreaterThan(source.indexOf("shortcutBlocked({"));
    expect(source.indexOf('if (e.key === "p" || e.key === "P")')).toBeGreaterThan(source.indexOf("shortcutBlocked({"));
  });

  it("with the stage open, Shift+N stays the stage's next ask: the stage answers before this branch", () => {
    expect(source.indexOf("stageKeyIntent({")).toBeLessThan(source.indexOf('if (e.key === "n" || e.key === "N")'));
    expect(source).toMatch(/Shift is read off the event[\s\S]{0,400}Shift\+N[\s\S]{0,80}"next ask"/);
  });

  it("P peeks the selected card, else the longest waiting, else nothing; P again or Escape closes it", () => {
    expect(source).toMatch(/const candidates = \[selected && state\.agents\.has\(selected\) \? selected : null, blockedSessions\(state\.agents\.values\(\)\)\[0\]\?\.id \?\? null\];/);
    // The first candidate whose card is drawn AND on screen gets it: a card
    // panned away would carry a peek nobody sees.
    expect(source).toMatch(/if \(id && card && cardOnScreen\(card\)\) \{ showPeek\(id, card, "focus"\); return; \}/);
    expect(source).toMatch(/if \(peekedId\(\) != null\) \{ hidePeek\(\); return; \}/);
    // Never at the detail distance: the hover's own rule (use-canvas-clicks.ts).
    expect(source).toMatch(/if \(lodRef && \(lodRef\.current == null \|\| lodRef\.current === "detail"\)\) return;/);
    expect(read("use-canvas-clicks.ts")).toMatch(/if \(lodRef\.current == null \|\| lodRef\.current === "detail"\) return;/);
    expect(read("App.tsx")).toMatch(/stageRef: stage\.keysRef, lodRef,/);
    // Escape closes a peek that has no focus to lose.
    expect(source).toMatch(/clearSelection\(\);\s*\/\/ A peek P opened[^\n]*\n\s*hidePeek\(\);/);
  });

  it("opens at once: a key-opened peek has no entrance under data-motion=instant", () => {
    expect(read("styles/lan-sync.css")).toMatch(/:root\[data-motion="instant"\] \.ap-peek \{ animation: none; \}/);
  });

  it("is on the sheet, in Canvas after W", () => {
    const canvas = KEY_HELP.find(g => g.title === "Canvas")!.rows;
    const caps = canvas.map(r => r.cap);
    expect(caps.slice(caps.indexOf("W") + 1, caps.indexOf("W") + 4)).toEqual(["N", "Shift + N", "P"]);
    const row = (cap: string) => canvas.find(r => r.cap === cap)!;
    expect(row("N")).toMatchObject({ action: "the next one waiting on you — W does the same", binds: ["n", "N"] });
    // "on the board": with the Command Panel open, Shift+N is its next ask.
    expect(row("Shift + N")).toMatchObject({ action: "the previous one waiting, on the board", binds: ["N"] });
    expect(row("P")).toMatchObject({ action: "peek at the selected card without opening it", binds: ["p", "P"] });
  });

  it("does not add Q, the backtick or Ctrl+backtick", () => {
    const bound = [...source.matchAll(/e\.key === "((?:[^"\\]|\\.)*)"/g)].map(m => m[1].toLowerCase());
    expect(bound).not.toContain("q");
    expect(bound).not.toContain("`");
  });
});
