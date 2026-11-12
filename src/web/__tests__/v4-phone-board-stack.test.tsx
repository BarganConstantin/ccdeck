// V4 critique, round 3, point 7: on a phone the Board was a free canvas at 26 %,
// a spinner in a pill per card and no text. It is now a stack of full-width
// cards, one per session, in the Sessions list's order: the mark and the state
// word the card wears (faceStatus), the name with a look-alike's start time,
// the question it waits on or its task, and "model · time" in mono. A tap is
// the Sessions row's press. No free canvas and none of its controls on a phone;
// wider, the board is React Flow as before.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import type { RailItem } from "../components/EdgeRails";
import PhoneBoard, { PhoneBoardCard } from "../components/PhoneBoard";
import { buildRows } from "../components/SessionList";
import { en } from "../i18n/en";
import { quickOpenItems } from "../quick-open-items";
import { commandPanelMore, type RailItems } from "../rail-items";
import { modelChipText } from "../model-label";
import { faceStatus } from "../node-face";
import { phoneBoardCards } from "../phone-board";
import { twinStart } from "../rail-row-copy";
import { applyEvent, initialState, type GraphState } from "../reducer";
import { resetSessionsSeen } from "../session-seen";
import type { HookEnvelope, HookPayload } from "../types";

const T0 = 1_700_000_000_000;
const NOW = T0 + 600_000;
let seq = 0;
const send = (s: GraphState, sid: string, payload: Record<string, unknown>, at: number) =>
  applyEvent(s, { seq: ++seq, receivedAt: T0 + at, source: "hook", payload: { session_id: sid, ...payload } as HookPayload } as HookEnvelope);
const begin = (s: GraphState, sid: string, cwd: string, prompt: string, at: number) => {
  s = send(s, sid, { hook_event_name: "SessionStart", cwd }, at);
  return send(s, sid, { hook_event_name: "UserPromptSubmit", prompt }, at + 1);
};

const NOTES = "Write the release notes for 3.83";

/** The picture's phone: "api" waits on a question, two "ccdeck" sessions read
 *  the same and work, "site" finished with a failed call, "retention" is done. */
function board(): GraphState {
  let s = initialState();
  s = begin(s, "api", "/code/api", "Run the tests", 0);
  s = begin(s, "n1", "/code/ccdeck", NOTES, 100_000);
  s = begin(s, "n2", "/code/ccdeck", NOTES, 160_000);
  s = begin(s, "site", "/code/site", "Run the test suite and fix the failures", 0);
  s = send(s, "site", { hook_event_name: "Stop" }, 30_000);
  s = begin(s, "ret", "/code/retention", "Add a retention job to the API", 0);
  s = send(s, "ret", { hook_event_name: "Stop" }, 20_000);
  s.agents.get("site")!.toolErrorCount = 1;
  s.agents.get("api")!.waiting = { kind: "asked", message: "Allow npm test?", since: T0 + 200_000 };
  for (const a of s.agents.values()) a.model = "claude-opus-4-5";
  return s;
}

beforeEach(() => { seq = 0; resetSessionsSeen(); });

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The [start, end) of every top-level block opened by `header`, braces matched. */
function blocksOf(css: string, header: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let at = css.indexOf(header); at >= 0; at = css.indexOf(header, at + 1)) {
    let depth = 0;
    for (let i = at + header.length - 1; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) { out.push([at, i + 1]); break; }
    }
  }
  return out;
}
/** One card's markup, by its session. */
const cardOf = (html: string, id: string) => {
  const at = html.indexOf(`data-session="${id}"`);
  return html.slice(at, html.indexOf("</button>", at));
};
/** The inside of a span by class: its own nested spans counted, so a part
 *  inside it does not end it. */
function spanOf(html: string, cls: string): string {
  const open = `<span class="${cls}">`;
  const from = html.indexOf(open) + open.length;
  let depth = 1;
  for (let i = from; i < html.length; i++) {
    if (html.startsWith("<span", i)) depth++;
    else if (html.startsWith("</span>", i) && --depth === 0) return html.slice(from, i);
  }
  return "";
}
const headOf = (card: string) => spanOf(card, "pb-head");
const metaOf = (card: string) => spanOf(card, "pb-meta");
/** The mono line as it reads on screen: the words for a screen reader and the tags left out. */
const metaText = (card: string) => metaOf(card).replace(/<span class="vis-hidden">[^<]*<\/span>/g, "").replace(/<[^>]+>/g, "");

function outsideMedia(css: string): string {
  let out = css;
  for (const [a, b] of blocksOf(css, "@media").reverse()) out = out.slice(0, a) + out.slice(b);
  return out;
}

describe("the stack is the Sessions list's order and groups, one card per session", () => {
  it("roots only, in buildRows' order: Needs you, Working, then Done · new", () => {
    const s = board();
    const cards = phoneBoardCards(s, NOW);
    expect(cards.map(c => c.row.sessionId)).toEqual(buildRows(s, NOW).map(r => r.sessionId));
    expect(cards.map(c => c.row.sessionId)).toEqual(["api", "n2", "n1", "site", "ret"]);
    expect(cards.map(c => c.group)).toEqual([0, 1, 1, 2, 2]);
  });

  it("a finished turn looked at moves down to Done with the list's row", () => {
    const s = board();
    const watching = new Set(["site", "ret"]);
    expect(phoneBoardCards(s, NOW, { watching }).map(c => c.group)).toEqual([0, 1, 1, 3, 3]);
    expect(phoneBoardCards(s, NOW, { watching }).map(c => c.row.sessionId)).toEqual(buildRows(s, NOW, watching).map(r => r.sessionId));
  });

  it("a subagent is never a card of its own", () => {
    let s = board();
    s = send(s, "n1", { hook_event_name: "SubagentStart", agent_id: "sub1", agent_type: "explorer" }, 200_100);
    expect([...s.agents.values()].some(a => a.kind === "subagent")).toBe(true);
    expect(phoneBoardCards(s, NOW).every(c => s.agents.get(c.row.sessionId)?.kind === "root")).toBe(true);
    expect(phoneBoardCards(s, NOW)).toHaveLength(5);
  });

  it("what the canvas would not draw is left to the list: a removed session draws no card", () => {
    const s = board();
    expect(phoneBoardCards(s, NOW, { removed: new Set(["site"]) }).map(c => c.row.sessionId)).toEqual(["api", "n2", "n1", "ret"]);
  });
});

describe("each card wears the one mark and word its session has everywhere", () => {
  it("the mark and the word are faceStatus's", () => {
    const s = board();
    for (const c of phoneBoardCards(s, NOW)) expect(c.status).toEqual(faceStatus(s.agents.get(c.row.sessionId)!));
  });

  it("waiting is the alert mark and Waiting; working the live ring; site the partial mark and \"1 failed\"; done the tick", () => {
    const html = renderToStaticMarkup(createElement(PhoneBoard, { state: board(), now: NOW, onOpen: () => {} }));
    const card = (id: string) => html.slice(html.indexOf(`data-session="${id}"`), html.indexOf("</button>", html.indexOf(`data-session="${id}"`)));
    expect(card("api")).toContain("alert-mark");
    expect(card("api")).toContain(">Waiting<");
    expect(card("n1")).toMatch(/class="state-mark" data-kind="live"/);
    expect(card("n1")).toContain(">Working<");
    expect(card("site")).toContain('data-tone="partial"');
    expect(card("site")).toContain('data-kind="partial"');
    expect(card("site")).toContain('class="kit-warn"');
    expect(card("site")).not.toContain('data-kind="err"');
    expect(card("site")).toContain(">1 failed<");
    expect(card("ret")).toContain('data-kind="done"');
    expect(card("ret")).toContain(">Done<");
  });

  it("a waiting card keeps its question line; the others say their task", () => {
    const html = renderToStaticMarkup(createElement(PhoneBoard, { state: board(), now: NOW, onOpen: () => {} }));
    expect(html).toContain("Allow npm test?");
    expect(html).toContain("Run the test suite and fix the failures");
    expect(html).toContain("Add a retention job to the API");
  });

  it("the mono line is the model as the list names it and the list's clock", () => {
    const html = renderToStaticMarkup(createElement(PhoneBoard, { state: board(), now: NOW, onOpen: () => {} }));
    const meta = ["api", "n2", "n1", "site", "ret"].map(id => metaText(cardOf(html, id)));
    for (const m of meta) expect(m.startsWith(`${modelChipText("claude-opus-4-5")} · `)).toBe(true);
    // Waiting since 200 s in, at 600 s: the wait, counted as the list counts it.
    expect(meta[0]).toBe(`${modelChipText("claude-opus-4-5")} · 6m 40s`);
  });

  it("only the two look-alikes draw when they started, last on the mono line, and the name keeps its line", () => {
    const s = board();
    const cards = phoneBoardCards(s, NOW);
    expect(cards.filter(c => c.row.twin).map(c => c.row.sessionId).sort()).toEqual(["n1", "n2"]);
    const html = renderToStaticMarkup(createElement(PhoneBoard, { state: s, now: NOW, onOpen: () => {} }));
    expect(html.match(/class="pb-start"/g)).toHaveLength(2);
    const n1 = cardOf(html, "n1");
    // "opus · 8m 19s · 22:15": model · elapsed · start, separators only between parts.
    const start = twinStart(T0 + 100_000, "minute");
    expect(metaOf(n1)).toMatch(new RegExp(`<span class="pb-start">${start}</span>$`));
    expect(metaText(n1)).toMatch(new RegExp(`^${modelChipText("claude-opus-4-5")} · \\S+( \\S+)? · ${start}$`));
    expect(headOf(n1)).not.toContain("pb-start");
    expect(headOf(n1)).not.toContain(start);
    // A card that reads like no other has no third part and no trailing dot.
    expect(metaText(cardOf(html, "site"))).not.toMatch(/ · $|·\s*·/);
    expect(cardOf(html, "site")).not.toContain("pb-start");
  });

  it("with one of them off the board the other reads like no card and draws no time", () => {
    const cards = phoneBoardCards(board(), NOW, { removed: new Set(["n1"]) });
    expect(cards.some(c => c.row.twin)).toBe(false);
  });
});

describe("a tap is the Sessions row's press", () => {
  it("the card is one button carrying its session, and a press hands that id on", () => {
    const opened: string[] = [];
    const [card] = phoneBoardCards(board(), NOW);
    const el = PhoneBoardCard({ card, now: NOW, selected: false, onOpen: id => opened.push(id) }) as ReactElement<{ type: string; onClick(): void; "data-session": string }>;
    expect(el.type).toBe("button");
    expect(el.props["data-session"]).toBe("api");
    el.props.onClick();
    expect(opened).toEqual(["api"]);
  });

  it("App hands the stack the same pickSession the Sessions list's rows call, and the pane gives the Board back", () => {
    const app = read("App.tsx");
    expect(app).toMatch(/<SessionList[\s\S]*?onSelect=\{pickSession\}/);
    expect(app).toContain("onOpen={pickFromBoard}");
    const pick = app.slice(app.indexOf("const pickFromBoard"), app.indexOf("}, [pickSession]);"));
    expect(pick).toContain("pickSession(sessionId);");
    expect(pick).toContain("paneFromListRef.current = false;");
  });

  it("the whole card is the target, at least 44 high", () => {
    const css = outsideMedia(strip(read("styles/phone-board.css")));
    const card = css.slice(css.indexOf(".phone-board .pb-card {"));
    const min = Number(/min-height:\s*(\d+)px/.exec(card.slice(0, card.indexOf("}")))?.[1]);
    expect(min).toBeGreaterThanOrEqual(44);
    expect(card.slice(0, card.indexOf("}"))).toContain("width: 100%;");
  });

  it("every rule of the sheet is about the stack, which only a phone draws", () => {
    const css = strip(read("styles/phone-board.css"));
    const selectors = [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)].map(m => m[1].trim()).filter(s => !s.startsWith("@"));
    expect(selectors.length).toBeGreaterThan(10);
    for (const list of selectors) for (const sel of list.split(",")) expect(sel, sel).toContain(".phone-board");
  });

  it("the Inspector a card opened gives focus back to that card", () => {
    expect(read("App.tsx")).toContain('.phone-board .pb-card[data-session="${CSS.escape(primarySelectedId)}"]');
  });
});

describe("no canvas and none of its controls on a phone; the desktop keeps the canvas", () => {
  const app = read("App.tsx");
  const surface = app.slice(app.indexOf("{phone ? (", app.indexOf("components/PhoneBoard.tsx")), app.indexOf("<StageNavigatorSlot"));

  it("a phone draws the stack in the canvas's cell, and React Flow only on the other branch", () => {
    expect(surface).toMatch(/\{phone \? \(\s*<>\s*<PhoneBoard\b/);
    expect(surface).toMatch(/\) : \(\s*<BoardFlow\b/);
    expect(surface.indexOf("<PhoneBoard")).toBeLessThan(surface.indexOf(") : ("));
    expect(surface.indexOf("<BoardFlow")).toBeGreaterThan(surface.indexOf(") : ("));
  });

  it("the desktop board is still the canvas: BoardFlow mounts React Flow, its controls and its minimap", () => {
    const flow = read("components/BoardFlow.tsx");
    expect(flow).toMatch(/<ReactFlow\b/);
    expect(flow).toMatch(/<CanvasControls\b/);
    expect(flow).toMatch(/<BoardMinimap\b/);
    expect(flow).toMatch(/<AutoFitChip\b/);
  });

  it("the canvas's Tools filter is not drawn on a phone either", () => {
    expect(app).toContain("{!phone && (presentCats.length > 1 || hiddenCats.size > 0) && (");
  });

  it("the stack itself has no zoom, minimap, Fit all or trash", () => {
    const html = renderToStaticMarkup(createElement(PhoneBoard, { state: board(), now: NOW, onOpen: () => {} }));
    expect(html).not.toMatch(/react-flow|minimap|controls/i);
    expect(html).not.toMatch(/Zoom|Fit all|Clear the deck/);
    expect(html.match(/<button/g)).toHaveLength(5);
    expect(html).toContain('aria-label="Sessions on the board"');
  });

  it("the radio plays on without the companion, which would stand on the cards", () => {
    expect(surface).toMatch(/<RadioExperience\b[^>]*characterEnabled=\{false\}/);
  });

  it("an empty deck draws no stack, so the welcome speaks alone", () => {
    expect(renderToStaticMarkup(createElement(PhoneBoard, { state: initialState(), now: NOW, onOpen: () => {} }))).toBe("");
  });
});

describe("what the canvas bar held that a phone still needs, and what it does not", () => {
  const door = (id: string): RailItem => ({ id, label: id, short: id, ariaLabel: id, glyph: null, kind: "panel", onPress: () => {} });

  it("the Command Panel is a row of the dock's More with the stage on, named as the bar's button", () => {
    const opened: Array<Element | null> = [];
    const rows = commandPanelMore(opener => opened.push(opener));
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe(en["board.controls.openPanel"]);
    expect(rows[0].ariaLabel).toBe(en["board.controls.openPanel"]);
    rows[0].onPress();
    // The bar's press, handed the More button as its opener (none outside a page).
    expect(opened).toEqual([null]);
  });

  it("and no row at all with the stage off", () => {
    expect(commandPanelMore(undefined)).toEqual([]);
  });

  it("App puts it right after Search, on the stage's own condition and press", () => {
    const app = read("App.tsx");
    expect(app).toContain("more={[rails.search, ...commandPanelMore(stage.enabled ? stage.openFromButton : undefined), ...rails.capacity,");
    expect(app).toContain("onTerminal={stage.enabled ? stage.openFromButton : undefined}");
  });

  const quick = (phone: boolean | undefined) => quickOpenItems({
    rails: {
      left: [door("session-list")], codexDoor: [], capacity: [], right: [[door("usage")]], integrations: [], explore: [],
      utilities: [door("settings")], search: door("quick-open"),
    } as unknown as RailItems,
    sessions: [], openSession: () => {}, settings: [], openSettings: () => {}, singleKeys: true,
    fit: () => {}, rearrange: () => {}, phone, paused: false, togglePause: () => {},
    keyHelp: () => {}, tour: () => {}, theme: "rider-black", setTheme: () => {},
  }).map(i => i.id);

  it("Quick Open offers no Fit all and no Re-arrange on a phone, where nothing moves a camera", () => {
    const ids = quick(true);
    expect(ids).not.toContain("action:fit");
    expect(ids).not.toContain("action:rearrange");
    expect(ids).toContain("action:pause");
  });

  it("and offers both wider, as before", () => {
    for (const phone of [false, undefined]) {
      const ids = quick(phone);
      expect(ids).toContain("action:fit");
      expect(ids).toContain("action:rearrange");
    }
    expect(read("App.tsx")).toContain("singleKeys, fit: handleFit, rearrange: handleRelayout, phone,");
  });
});
