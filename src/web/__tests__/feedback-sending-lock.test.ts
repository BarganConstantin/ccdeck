// While a report was sending, the dialog stayed as editable as before it. The
// request is built once, from the message and the images as they were when
// Send was pressed, but a paste or a drop still attached an image, the strip's
// remove and replace still worked and the message still took typing. So a
// screenshot removed mid-send — say, one that turned out to show an address —
// was said to be removed and went anyway, one pasted was said to be added and
// did not go, and words typed meanwhile were lost when the dialog thanked and
// closed. Everything above Cancel and Send is out of reach now until the
// answer, and a paste or a drop is not taken.
//
// Run on fake-react.ts's React, with the images held by the test so the send
// stays out for as long as it needs, and a document of stand-in nodes whose
// focus and inert flags are what the test reads.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { flush, mount, one, type Drawn } from "./fake-react";
import type { FeedbackImages } from "../use-feedback-images";

vi.mock("react", async () => (await import("./fake-react")).react);
vi.mock("../components/use-modal-dismiss", async orig => ({
  ...(await orig<typeof import("../components/use-modal-dismiss")>()),
  useModalDismiss: () => ({ current: null }),
}));
vi.mock("../components/SuccessMark", () => ({ default: () => null }));

/** The dialog's images: nothing attached, ready when the test says, and every
 *  change asked of them counted. */
let finishFits: (blobs: Blob[]) => void;
const images = {
  shots: [], problem: "", announcement: "",
  add: vi.fn(), replace: vi.fn(), remove: vi.fn(), sayFull: vi.fn(),
  ready: () => new Promise<Blob[]>(resolve => { finishFits = resolve; }),
  kept: () => ({ ready: [], waiting: [] }), clear: vi.fn(),
};
vi.mock("../use-feedback-images", () => ({ useFeedbackImages: (): FeedbackImages => images as unknown as FeedbackImages }));

const { default: FeedbackDialog } = await import("../components/FeedbackDialog");
const { draftKey, feedbackDrafts, feedbackSeed } = await import("../feedback-draft");

/** A node the document holds: where it sits, whether it is inert, focus. */
interface Node { tagName: string; inside: Node[]; inert?: boolean; focus(): void; contains(n: unknown): boolean }
let page: { activeElement: Node | null };
const node = (tagName: string, inside: Node[] = []): Node => {
  const n: Node = {
    tagName, inside,
    focus: () => { page.activeElement = n; },
    contains: other => other === n || n.inside.some(c => c.contains(other)),
  };
  return n;
};
const field = node("TEXTAREA");
const send = node("BUTTON");
const fields = node("SECTION", [field]);
const form = node("FORM", [fields, send]);
const BODY = node("BODY");

/** Each element the dialog draws with a ref, and the node the document gave it. */
const NODES: Array<[(el: Drawn) => boolean, Node]> = [
  [el => el.type === "form", form],
  [el => el.type === "section", fields],
  [el => el.type === "textarea", field],
  [el => el.type === "button" && el.props.type === "submit", send],
];

/** What the document does with a render: refs get their nodes. */
function commit(tree: unknown) {
  for (const [match, n] of NODES) {
    const el = one(tree, match);
    if (el?.ref && typeof el.ref === "object") (el.ref as { current: unknown }).current = n;
  }
}

let posts: Array<(ok: boolean) => void>;

beforeEach(() => {
  // A draft the last test left is not this one's to open on.
  feedbackDrafts.forget(draftKey(feedbackSeed({})));
  page = { activeElement: BODY };
  for (const n of [form, fields, field, send]) n.inert = false;
  posts = [];
  images.add.mockClear();
  vi.stubGlobal("document", page);
  vi.stubGlobal("HTMLTextAreaElement", class {});
  vi.stubGlobal("HTMLInputElement", class {});
  vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => new Promise(resolve => {
    // The facts the dialog asks for when it opens are never answered.
    if (init?.method !== "POST") return;
    posts.push(ok => resolve({ ok, status: ok ? 200 : 502, json: async () => ({ ok }) }));
  })));
});
afterEach(() => { vi.unstubAllGlobals(); });

const el = (tree: unknown, match: (e: Drawn) => boolean) => one(tree, match) as Drawn;
const handler = (e: Drawn, name: string) => e.props[name] as (ev: unknown) => void;

/** The dialog with a message written and Send pressed from the message with
 *  the shortcut; the report is out until the test finishes the fits. */
function sending() {
  const view = mount(FeedbackDialog, { onClose: vi.fn() }, { commit });
  handler(el(view.tree, e => e.type === "textarea"), "onChange")({ target: { value: "The usage chart is empty" } });
  field.focus();
  handler(el(view.tree, e => e.type === "form"), "onSubmit")({ preventDefault() {} });
  return view;
}

const surface = (tree: unknown) => el(tree, e => typeof e.props.className === "string" && e.props.className.startsWith("modal feedback-dialog"));
const SHOT = { name: "shot.png" };

describe("the feedback dialog while a report is sending", () => {
  it("takes no image pasted into it", () => {
    const view = sending();
    const preventDefault = vi.fn();
    handler(surface(view.tree), "onPaste")({
      clipboardData: { files: [SHOT], types: ["Files"] }, target: {}, preventDefault,
    });
    expect(images.add).not.toHaveBeenCalled();
  });

  it("takes no image dropped on it", () => {
    const view = sending();
    const dataTransfer = { types: ["Files"], files: [SHOT], dropEffect: "copy" };
    handler(surface(view.tree), "onDragEnter")({ dataTransfer, preventDefault() {} });
    handler(surface(view.tree), "onDrop")({ dataTransfer, preventDefault() {} });
    expect(images.add).not.toHaveBeenCalled();
  });

  it("puts the message, the kinds and the images out of reach, and keeps Cancel and Send", () => {
    sending();
    expect(fields.inert).toBe(true);
    expect(form.inert).toBe(false);
  });

  it("moves focus from the message to Send, which says it is working", () => {
    sending();
    expect(page.activeElement).toBe(send);
  });

  it("gives everything back, focus included, when the send fails", async () => {
    const view = sending();
    finishFits([]);
    await flush();
    posts[0](false);
    await flush();
    expect(fields.inert).toBe(false);
    expect(page.activeElement).toBe(field);
    handler(surface(view.tree), "onPaste")({ clipboardData: { files: [SHOT], types: ["Files"] }, target: {}, preventDefault() {} });
    expect(images.add).toHaveBeenCalledTimes(1);
  });

  it("gives focus back too when a press on the inert part dropped it meanwhile", async () => {
    // A click on anything inert lands on nothing that takes focus.
    sending();
    BODY.focus();
    finishFits([]);
    await flush();
    posts[0](false);
    await flush();
    expect(page.activeElement).toBe(field);
  });

  it("leaves focus where the reader put it meanwhile", async () => {
    sending();
    const cancel = node("BUTTON");
    cancel.focus();
    finishFits([]);
    await flush();
    posts[0](false);
    await flush();
    expect(page.activeElement).toBe(cancel);
  });

  it("took an image before Send was pressed", () => {
    const view = mount(FeedbackDialog, { onClose: vi.fn() }, { commit });
    handler(surface(view.tree), "onPaste")({ clipboardData: { files: [SHOT], types: ["Files"] }, target: {}, preventDefault() {} });
    expect(images.add).toHaveBeenCalledTimes(1);
  });
});
