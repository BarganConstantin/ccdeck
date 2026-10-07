// One thing answers a hover over a zoomed-out note, never two.
//
// At the compact and overview distances a pointer resting on a session's note
// opens the deck's hover card beside it (SessionPeek's RecapPeek): the note
// whole, its age, who wrote it and whose session it is. The face under the
// pointer also carried a native `title` with the same words — its text since
// the face's lines were made whole, its age since the age stopped being cut —
// and a status note's own box carried who wrote it. So the browser's tooltip
// opened on top of the hover card a moment later, the same sentence twice.
//
// The rule is one hover affordance per element. Where the hover card opens,
// nothing under the pointer or around it carries a title. At the full card's
// size the hover card never opens, and there the cut text keeps its title,
// because it is the only way to read the rest. The face is hidden from
// assistive technology, so its titles were never anybody's way in; who wrote a
// status note, which the note's box gave a screen reader as its description,
// is still its description.
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider } from "reactflow";
import AgentNode from "../components/AgentNode";
import RecapNoteNode, { type RecapNoteData } from "../components/RecapNoteNode";
import { faceTitle } from "../node-face";
import { noteSource, type SessionNote } from "../session-note";
import { applyEvent, initialState, type GraphState } from "../reducer";
import type { AgentNodeData, HookEnvelope, HookPayload } from "../types";

const T0 = 1_700_000_000_000;

interface El { tag: string; attrs: string; parent: El | null; children: El[] }

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

/** The element tree of React's static markup, which escapes `>` in attribute
 *  values and closes every element that is not void. */
function parse(html: string): El {
  const root: El = { tag: "#root", attrs: "", parent: null, children: [] };
  let at = root;
  for (const [, close, tag, attrs] of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g)) {
    if (close) { at = at.parent ?? root; continue; }
    const el: El = { tag, attrs, parent: at, children: [] };
    at.children.push(el);
    if (!VOID.has(tag) && !attrs.endsWith("/")) at = el;
  }
  return root;
}

const unescape = (s: string) => s
  .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const attr = (el: El, name: string) => {
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(el.attrs);
  return m ? unescape(m[1]) : undefined;
};
const hasClass = (el: El, cls: string) => (attr(el, "class") ?? "").split(/\s+/).includes(cls);

function find(el: El, cls: string): El | undefined {
  if (hasClass(el, cls)) return el;
  for (const c of el.children) {
    const hit = find(c, cls);
    if (hit) return hit;
  }
  return undefined;
}

function descendants(el: El): El[] {
  return el.children.flatMap(c => [c, ...descendants(c)]);
}

function ancestors(el: El): El[] {
  const out: El[] = [];
  for (let p = el.parent; p && p.tag !== "#root"; p = p.parent) out.push(p);
  return out;
}

const describeEl = (el: El) => `<${el.tag} class="${attr(el, "class") ?? ""}" title="${attr(el, "title")}">`;

/** Every element a pointer on the face would take a native tooltip from: the
 *  face, what is inside it, and what it sits in, up to the node's own root. */
function titledAroundFace(html: string): string[] {
  const face = find(parse(html), "lod-face");
  expect(face, "the node draws a zoomed-out face").toBeDefined();
  return [face!, ...descendants(face!), ...ancestors(face!)]
    .filter(el => attr(el, "title") != null)
    .map(describeEl);
}

function noteHtml(note: Partial<SessionNote>): string {
  const data: RecapNoteData = {
    sessionId: "s1",
    parentId: "s1",
    hue: 210,
    noteKey: "k",
    note: { kind: "recap", source: "recap", text: "", at: Date.now() - 3_600_000, key: "k", ...note } as SessionNote,
  };
  return renderToStaticMarkup(createElement(ReactFlowProvider, null,
    // NodeProps carries more than the note reads; only data matters here.
    createElement(RecapNoteNode as any, { id: "note:s1", data, selected: false })));
}

const LONG = "I've moved the invoice preview onto the customer's locale, and the currency, the dates and the totals now follow it across all four templates, with the PDF export still to check.";

const NOTES: Array<[string, Partial<SessionNote>]> = [
  ["a recap", { kind: "recap", source: "recap", text: LONG }],
  ["a status note read off the newest reply", { kind: "now", source: "activity", text: LONG }],
  ["a question with a suggested reply", { kind: "needs", source: "job", text: "Should I push the branch now?", reply: "yes, push it and open the PR against development" }],
];

describe("a zoomed-out note, where the deck's hover card opens", () => {
  it.each(NOTES)("%s carries no native title on its face or around it", (_, note) => {
    expect(titledAroundFace(noteHtml(note))).toEqual([]);
  });
});

describe("the note at the full card's size, where the hover card never opens", () => {
  const status: Partial<SessionNote> = { kind: "now", source: "activity", text: LONG };

  it("keeps its cut text whole on hover, with who wrote a status note under it", () => {
    const root = parse(noteHtml(status));
    expect(attr(find(root, "recap-note-text")!, "title")).toBe(faceTitle(LONG, noteSource(status as SessionNote)));
    const recap = parse(noteHtml({ kind: "recap", source: "recap", text: LONG }));
    expect(attr(find(recap, "recap-note-text")!, "title")).toBe(LONG);
  });

  it("says who wrote a status note on its head, which the full size alone draws", () => {
    const head = find(parse(noteHtml(status)), "recap-note-head")!;
    expect(attr(head, "title")).toBe(noteSource(status as SessionNote));
    expect(attr(find(parse(noteHtml({ kind: "recap", source: "recap", text: LONG })), "recap-note-head")!, "title")).toBeUndefined();
  });

  it("still gives a screen reader who wrote a status note, as the note's description", () => {
    const note = find(parse(noteHtml(status)), "recap-note")!;
    expect(attr(note, "role")).toBe("note");
    expect(attr(note, "aria-description")).toBe(noteSource(status as SessionNote));
  });
});

describe("a zoomed-out card, where the deck's hover card opens", () => {
  function card(): AgentNodeData {
    let seq = 0;
    const send = (state: GraphState, payload: HookPayload, at: number) =>
      applyEvent(state, { seq: ++seq, receivedAt: at, source: "hook", payload: { session_id: "s1", ...payload } } as HookEnvelope);
    let state = send(initialState(), { hook_event_name: "SessionStart", cwd: "/w/shop-api-auth" }, T0);
    state = send(state, { hook_event_name: "UserPromptSubmit", prompt: "add the login route and its tests" }, T0 + 1_000);
    state = send(state, { hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "t1" }, T0 + 2_000);
    return { ...state.agents.get("s1")!, sessionTitle: "Add the login route to shop-api-auth and cover it" } as AgentNodeData;
  }

  it("carries no native title on its face or around it", () => {
    const data = card();
    const html = renderToStaticMarkup(createElement(ReactFlowProvider, null,
      createElement(AgentNode as any, { id: data.id, data, selected: false })));
    expect(html).toContain('class="lod-title"');
    expect(titledAroundFace(html)).toEqual([]);
  });
});
