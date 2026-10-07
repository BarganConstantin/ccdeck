// Sending feedback from the keyboard, run rather than read: Ctrl+Enter (⌘+Enter
// on a Mac) sends from the dialog's fields, a plain Enter in the message is a
// new line, and the shortcut asks exactly what the Send button asks — nothing
// empty goes, nothing goes twice. What it leaves of the draft is the same as a
// press of Send: gone once sent, kept when the send failed.
//
// Run on fake-react.ts's React. A keydown in a field reaches the form's
// handler as the browser bubbles it, and the form's requestSubmit is what a
// browser does with it: the form's submit handler, once.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { flush, mount, one, textOf, type Drawn } from "./fake-react";
import type { EnterKey } from "../feedback";

vi.mock("react", async () => (await import("./fake-react")).react);
vi.mock("../components/use-modal-dismiss", async orig => ({
  ...(await orig<typeof import("../components/use-modal-dismiss")>()),
  useModalDismiss: () => ({ current: null }),
}));
vi.mock("../components/SuccessMark", () => ({ default: () => null }));

const { default: FeedbackDialog } = await import("../components/FeedbackDialog");
const { draftKey, feedbackDrafts, feedbackSeed } = await import("../feedback-draft");

let posts: Array<{ body: unknown; answer: (ok: boolean) => void }>;

beforeEach(() => {
  feedbackDrafts.forget(draftKey(feedbackSeed({})));
  posts = [];
  vi.stubGlobal("document", { activeElement: null });
  vi.stubGlobal("window", { setTimeout: () => 0, clearTimeout: () => {} });
  vi.stubGlobal("navigator", { platform: "Win32" });
  vi.stubGlobal("HTMLTextAreaElement", class {});
  vi.stubGlobal("HTMLInputElement", class {});
  vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => new Promise(resolve => {
    if (init?.method !== "POST") return;
    posts.push({ body: init.body, answer: ok => resolve({ ok, status: ok ? 200 : 502, json: async () => ({ ok }) }) });
  })));
});
afterEach(() => { vi.unstubAllGlobals(); });

const el = (tree: unknown, match: (e: Drawn) => boolean) => one(tree, match) as Drawn;
const form = (tree: unknown) => el(tree, e => e.type === "form");
const message = (tree: unknown) => el(tree, e => e.type === "textarea");
const enter = (over: Partial<EnterKey> = {}): EnterKey =>
  ({ key: "Enter", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, ...over });

/** A key pressed in the message: the field's own handler first, if it has
 *  one, then the form's. Answers whether anything stopped the browser's own
 *  answer to it — for a plain Enter in a textarea, the new line. */
function press(tree: unknown, key: EnterKey): { stopped: boolean; submitted: number } {
  let stopped = false;
  let submitted = 0;
  const event = {
    ...key, nativeEvent: key,
    preventDefault: () => { stopped = true; },
    currentTarget: {
      requestSubmit: () => {
        submitted++;
        (form(tree).props.onSubmit as (e: unknown) => void)({ preventDefault() {} });
      },
    },
  };
  (message(tree).props.onKeyDown as ((e: unknown) => void) | undefined)?.(event);
  (form(tree).props.onKeyDown as (e: unknown) => void)(event);
  return { stopped, submitted };
}

function open() {
  return mount(FeedbackDialog, { onClose: vi.fn() });
}

function write(tree: unknown, words: string) {
  (message(tree).props.onChange as (e: unknown) => void)({ target: { value: words } });
}

const sentBody = (n = 0) => JSON.parse(posts[n].body as string) as { body: string };

describe("sending feedback from the keyboard", () => {
  it("sends on Ctrl+Enter from the message", async () => {
    const view = open();
    write(view.tree, "The usage chart is empty after a restart");
    expect(press(view.tree, enter({ ctrlKey: true }))).toEqual({ stopped: true, submitted: 1 });
    await flush();
    expect(posts).toHaveLength(1);
    expect(sentBody().body).toBe("The usage chart is empty after a restart");
  });

  it("sends on ⌘+Enter, the Mac's way of saying it", async () => {
    const view = open();
    write(view.tree, "The usage chart is empty after a restart");
    expect(press(view.tree, enter({ metaKey: true })).submitted).toBe(1);
    await flush();
    expect(posts).toHaveLength(1);
  });

  it("leaves a plain Enter in the message to make a new line, and sends nothing", async () => {
    const view = open();
    write(view.tree, "The usage chart is empty");
    expect(press(view.tree, enter())).toEqual({ stopped: false, submitted: 0 });
    expect(press(view.tree, enter({ shiftKey: true }))).toEqual({ stopped: false, submitted: 0 });
    await flush();
    expect(posts).toHaveLength(0);
  });

  it("sends nothing empty: says what is missing beside the message instead, as Send does", async () => {
    const view = open();
    write(view.tree, "   ");
    press(view.tree, enter({ ctrlKey: true }));
    await flush();
    expect(posts).toHaveLength(0);
    expect(one(view.tree, e => e.props.id === "fb-body-error")).not.toBeNull();
    expect(message(view.tree).props["aria-invalid"]).toBe(true);
  });

  it("sends once while a report is out, however often the shortcut is pressed", async () => {
    const view = open();
    write(view.tree, "The usage chart is empty after a restart");
    press(view.tree, enter({ ctrlKey: true }));
    press(view.tree, enter({ ctrlKey: true }));
    await flush();
    press(view.tree, enter({ metaKey: true }));
    await flush();
    expect(posts).toHaveLength(1);
  });

  it("lets the draft go once a report sent from the keyboard has arrived", async () => {
    const view = open();
    write(view.tree, "The usage chart is empty after a restart");
    press(view.tree, enter({ ctrlKey: true }));
    await flush();
    posts[0].answer(true);
    await flush();
    view.unmount();
    expect(message(open().tree).props.value).toBe("");
  });

  it("keeps the draft when a report sent from the keyboard did not arrive", async () => {
    const view = open();
    write(view.tree, "The usage chart is empty after a restart");
    press(view.tree, enter({ ctrlKey: true }));
    await flush();
    posts[0].answer(false);
    await flush();
    expect(message(view.tree).props.value).toBe("The usage chart is empty after a restart");
    view.unmount();
    expect(message(open().tree).props.value).toBe("The usage chart is empty after a restart");
  });

  it("names the shortcut beside Send, in this platform's words, and to assistive tech on the button", () => {
    const hint = (tree: unknown) => el(tree, e => e.props.className === "fb-shortcut");
    const windows = open();
    expect(textOf(hint(windows.tree))).toBe("CtrlEnter to send");
    expect(hint(windows.tree).props["aria-hidden"]).toBe("true");
    expect(el(windows.tree, e => e.type === "button" && e.props.type === "submit").props["aria-keyshortcuts"]).toBe("Meta+Enter Control+Enter");
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    expect(textOf(hint(open().tree))).toBe("⌘Enter to send");
  });
});
