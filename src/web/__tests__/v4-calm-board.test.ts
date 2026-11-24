// V4 top-10 #1, #2 and part of #9: the board's session cards get one frame,
// and colour on the board means state only.
//
// Before: a card was framed three times — a box tinted with a hashed
// per-session hue, an uppercase mono folder pill in that hue, and the card's
// own edge with a 3px hue stripe down its left side — and every finished face
// was edged green, so the eye had nothing to find. The head named the model
// in mono and cut the task to one line; a look-alike's start clock was mono;
// and a run that finished with failures drew done's green tick beside "1
// failed". This file holds the after, one behaviour per case, read from the
// sheet the app ships and from the markup the card renders.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider } from "reactflow";
import AgentNode from "../components/AgentNode";
import type { AgentNodeData } from "../types";
import { declared, sheetRules } from "./sheet-cascade";
import { sheetText } from "./sheet-source";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const bare = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const sheet = bare(sheetText());

/** Every rule (any media) whose selector list names `sel` exactly. */
const rulesFor = (sel: string) => sheetRules().filter(r => r.selectors.includes(sel));
/** The winning value of `prop` among the rules for `sel`, in sheet order. */
const decl = (sel: string, prop: string) =>
  rulesFor(sel).map(r => declared(r.body, prop)).filter((v): v is string => v !== undefined).at(-1);

const NO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };
const card = (over: Partial<AgentNodeData>) => renderToStaticMarkup(createElement(ReactFlowProvider, null,
  createElement(AgentNode as never, {
    id: "s",
    data: {
      sessionId: "6f0c2a9e-session", label: "billing-api", kind: "root", state: "done", childCount: 0, tools: [],
      toolCount: 3, usage: NO_USAGE, prompts: [], startedAt: Date.now(), model: "claude-opus-5-5", effort: "high", ...over,
    },
    selected: false,
  } as never)));

describe("no session hue on the board", () => {
  it("renders a card that carries no hue of its own", () => {
    for (const state of ["active", "done", "err"] as const) {
      const out = card({ state });
      expect(out, state).not.toContain("--session-hue");
      expect(out, state).not.toMatch(/hsl\(/);
    }
  });

  it("reads no session hue anywhere in the sheet, the Term stage's sheet or the LAN view's", () => {
    expect(sheet).not.toMatch(/--session-hue|--ns-hue/);
    expect(bare(read("../styles/terminal-stage.css"))).not.toMatch(/--ns-hue|--session-hue/);
    expect(bare(read("../styles/lan-sync.css"))).not.toMatch(/--session-hue/);
    expect(bare(read("../styles/gruvbox.css"))).not.toMatch(/--session-hue|cluster-card|cluster-label|recap-tie/);
  });

  it("leaves the theme catalog no session lightness tiers to light it with", () => {
    const dir = fileURLToPath(new URL("../themes/", import.meta.url));
    const files = readdirSync(dir).filter(f => f.endsWith(".json"));
    expect(files.length, "the catalog moved").toBeGreaterThan(5);
    for (const f of files) expect(read(`../themes/${f}`), f).not.toMatch(/"session-[a-z-]+-l"/);
  });

  it("draws the project picker's folder glyph and the LAN view's recap mark in neutral ink", () => {
    expect(bare(read("../styles/terminal-stage.css"))).toMatch(/\.ns-folder \{[^}]*color: var\(--muted\);/);
    expect(read("../components/terminal/NewSessionPopover.tsx")).not.toMatch(/--ns-hue/);
    expect(bare(read("../styles/lan-sync.css"))).toMatch(/\.recap-peek-mark \{[^}]*color: var\(--text\);/);
  });
});

describe("one frame, and its colour is a state", () => {
  it("draws no stripe down a face or a navigator tile", () => {
    expect(sheet).not.toMatch(/\.lod-face::before/);
    expect(sheet).not.toMatch(/\.nav-face::before/);
  });

  it("leaves a finished face on the neutral edge in every theme, and edges only work and failure", () => {
    // A rule anywhere that gives a done face an edge colour would put the green
    // (or any colour) back on most of the board.
    const doneEdges = sheetRules().filter(r =>
      r.selectors.some(s => /state-done[^,]*\.lod-face|\.nav-face\[data-state="done"\]/.test(s)) &&
      (declared(r.body, "--lod-edge") !== undefined || declared(r.body, "--nav-edge") !== undefined));
    expect(doneEdges.map(r => r.selectors.join(", ")), "a done face is edged").toEqual([]);
    expect(decl(".agent-node.state-active > .lod-face", "--lod-edge")).toBe("var(--inflight)");
    expect(decl(".agent-node.state-err > .lod-face", "--lod-edge")).toBeDefined();
    // The face's border falls through to --line when no state sets an edge,
    // and the waiting alarm still outranks every edge.
    expect(decl('.canvas-wrap[data-lod="compact"] .lod-face', "border")).toMatch(/var\(--lod-alarm, var\(--lod-ready, var\(--lod-edge, var\(--line\)\)\)\)/);
  });

  it("strokes an edge by its state: --inflight while the session works, --muted once it settles", () => {
    expect(decl(".react-flow__edge.sess-edge.sess-live .react-flow__edge-path", "stroke")).toBe("var(--inflight)");
    expect(decl(".react-flow__edge.sess-edge.sess-idle .react-flow__edge-path", "stroke")).toBe("var(--muted)");
  });

  it("draws a session's box as a quiet neutral group with no border", () => {
    expect(decl(".cluster-card", "background")).toBe("color-mix(in srgb, var(--text) 3%, transparent)");
    expect(decl(".cluster-card", "border")).toBeUndefined();
    expect(decl(".cluster-card", "border-color")).toBeUndefined();
  });

  it("writes the folder label as plain text: as written, sans, 12px, --muted, no pill", () => {
    const sel = ".cluster-label";
    expect(decl(sel, "font-family")).toBe("inherit");
    expect(decl(sel, "font-size")).toBe("calc(12px + var(--ui-text-increase, 0px))");
    expect(decl(sel, "color")).toBe("var(--muted)");
    expect(decl(sel, "border")).toBe("0");
    expect(decl(sel, "background")).toBe("transparent");
    expect(decl(sel, "text-transform")).toBeUndefined();
    expect(decl(sel, "letter-spacing")).toBeUndefined();
    // No rule anywhere puts the capitals or a mono face back on it.
    const label = sheetRules().filter(r => r.selectors.some(s => /\.cluster-label(?![-\w])/.test(s)));
    for (const r of label) {
      expect(declared(r.body, "text-transform"), r.selectors.join(", ")).toBeUndefined();
      expect(declared(r.body, "font-family") ?? "inherit", r.selectors.join(", ")).not.toMatch(/mono/);
    }
  });

  it("keeps the label a button with its waiting mark, words and the warning's ink", () => {
    const tsx = read("../components/SessionClusters.tsx");
    expect(tsx).toMatch(/<button[\s\S]{0,200}className="cluster-label"/);
    expect(tsx).toContain('<span className="cluster-label-said">{t("board.cluster.waitingOnYou")}</span>');
    expect(decl(".cluster-label[data-alarm]", "color")).toBe("var(--warn)");
    // After the hover in the sheet, so a waiting label keeps --warn under the pointer.
    const order = (sel: string) => sheetRules().findIndex(r => r.selectors.includes(sel) && declared(r.body, "color") !== undefined);
    expect(order(".cluster-label[data-alarm]")).toBeGreaterThan(order(".cluster-label:hover"));
  });
});

describe("the card says its task, not the machinery", () => {
  // CHANGED ON PURPOSE (the owner's call, 2026-11-24): this held no model and
  // no effort anywhere on the card. They are shown again in the foot, and
  // still not in the head or on the face drawn from a distance.
  it("names the model and its effort in the foot only, not in the head or on its face", () => {
    const out = card({});
    expect(out).not.toContain("model-text");
    expect(/<div class="title">([\s\S]*?)<\/div>/.exec(out)![1]).not.toContain("opus 5.5");
    expect(/<div class="foot">([\s\S]*?)<\/div>/.exec(out)![1]).toContain(">opus 5.5 · high</span>");
    const face = out.slice(out.indexOf('class="lod-face"'));
    expect(face).not.toContain("opus 5.5");
    expect(face).not.toMatch(/· high\b/);
  });

  it("still tells a Codex card from a Claude one: a muted \"Codex\" where the model sat, nothing for Claude", () => {
    const head = (out: string) => /<div class="title">([\s\S]*?)<\/div>/.exec(out)![1];
    // With a model and without one: the word is the provider's, not a stand-in.
    for (const model of ["gpt-5.5", undefined]) {
      const codex = head(card({ provider: "codex", model }));
      expect(codex, `codex, model ${model}`).toMatch(/^<span class="label"[^>]*>[^<]*<\/span><span class="provider-word">Codex<\/span>/);
      expect(codex).not.toContain("gpt");
    }
    // Claude, stated or by default, draws no word at all.
    expect(head(card({ provider: "claude" }))).not.toContain("provider-word");
    expect(head(card({ provider: undefined }))).not.toContain("provider-word");
    // A word in the UI face at 12 in --muted, no pill; the faces never had one.
    const sel = ".agent-node .title .provider-word";
    expect(decl(sel, "font-size")).toBe("calc(12px + var(--ui-text-increase, 0px))");
    expect(decl(sel, "color")).toBe("var(--muted)");
    expect(decl(sel, "font-family")).toBeUndefined();
    for (const prop of ["border", "background", "padding", "border-radius"]) expect(decl(sel, prop), prop).toBeUndefined();
    const whole = card({ provider: "codex" });
    const at = whole.indexOf('class="lod-face"');
    expect(at, "the card drew no face").toBeGreaterThan(-1);
    expect(whole.slice(at)).not.toContain("provider-word");
  });

  it("lets the task wrap to two lines, and nothing fixes the card's height", () => {
    expect(decl(".agent-node .task-line", "-webkit-line-clamp")).toBe("2");
    expect(decl(".agent-node .task-line", "line-clamp")).toBe("2");
    expect(decl(".agent-node .task-line", "overflow")).toBe("hidden");
    expect(decl(".agent-node", "height")).toBeUndefined();
    expect(decl(".agent-node", "max-height")).toBeUndefined();
    // The layout reads the card's measured height, so a second line moves the
    // card under it rather than overlapping it.
    expect(read("../layout-geometry.ts")).toMatch(/h: m\?\.height \?\? NODE_H/);
  });

  it("draws the start clock only on look-alikes, in tabular figures and not in mono", () => {
    const at = Date.parse("2026-11-16T09:30:00Z");
    const alone = card({ state: "active", startedAt: at });
    expect(alone).not.toContain("twin-start");
    expect(alone).not.toContain("lod-start");
    const twin = card({ state: "active", startedAt: at, twin: "minute" } as Partial<AgentNodeData>);
    expect(twin).toContain("lod-start");
    for (const sel of [".lod-start", ".agent-node .task-line .twin-start"]) {
      expect(decl(sel, "font-variant-numeric"), sel).toBe("tabular-nums");
      expect(decl(sel, "font-family"), sel).toBeUndefined();
    }
  });
});

describe("done with failures is one warn mark", () => {
  it("paints the partial mark in --warn on every surface that draws it", () => {
    for (const [sel, prop] of [
      ['.state-mark[data-kind="partial"]', "color"],
      ['.agent-node .state-line[data-tone="partial"] .state-mark', "color"],
      ['.qo-state[data-kind="partial"]', "color"],
      ['.detail-hero .hero-state[data-state="partial"]', "color"],
      [".kit-warn", "fill"],
    ] as const) {
      expect(decl(sel, prop), sel).toBe("var(--warn)");
    }
  });

  it("lets no rule, in any theme, paint a partial mark done's green", () => {
    const green = sheetRules().filter(r =>
      r.selectors.some(s => /partial/.test(s)) &&
      [declared(r.body, "color"), declared(r.body, "fill")].some(v => v !== undefined && /--ok\b/.test(v)));
    expect(green.map(r => r.selectors.join(", "))).toEqual([]);
  });

  it("keeps the glyph: the tick with its dot", () => {
    const out = card({ state: "done", toolErrorCount: 1 });
    expect(out).toMatch(/class="state-mark" data-kind="partial"/);
    expect(out).toContain('<circle class="kit-warn"');
  });
});
