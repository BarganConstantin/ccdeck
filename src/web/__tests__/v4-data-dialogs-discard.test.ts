// Feedback's Discard, as V4 draws it armed: the first press arms it (the quiet
// "Confirm discard"), a second press discards, and typing again takes the
// arming back. Run on fake-react.ts's React, like feedback-draft-kept.test.ts.
import "./web-globals";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mount, one, type Drawn } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);
vi.mock("../components/use-modal-dismiss", async orig => ({
  ...(await orig<typeof import("../components/use-modal-dismiss")>()),
  useModalDismiss: () => ({ current: null }),
}));
vi.mock("../components/SuccessMark", () => ({ default: () => null }));

const { default: FeedbackDialog } = await import("../components/FeedbackDialog");
const { draftKey, feedbackDrafts, feedbackSeed, discardLabel, discardArmedLabel } = await import("../feedback-draft");
const { CONFIRM_GAP_MS } = await import("../panel-press");

const page = { activeElement: null as unknown };
const messageNode = { tagName: "TEXTAREA", focus: () => { page.activeElement = messageNode; } };

beforeEach(() => {
  feedbackDrafts.forget(draftKey(feedbackSeed({})));
  page.activeElement = null;
  vi.stubGlobal("document", page);
  vi.stubGlobal("window", { setTimeout: () => 0, clearTimeout: () => {} });
  vi.stubGlobal("HTMLTextAreaElement", class {});
  vi.stubGlobal("HTMLInputElement", class {});
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const el = (tree: unknown, match: (e: Drawn) => boolean) => one(tree, match) as Drawn;
const handler = (e: Drawn, name: string) => e.props[name] as (ev?: unknown) => void;
const message = (tree: unknown) => el(tree, e => e.type === "textarea");
const discardButton = (tree: unknown) =>
  one(tree, e => e.type === "button" && typeof e.props.className === "string" && e.props.className.includes("fb-discard"));

function commit(tree: unknown) {
  const area = one(tree, e => e.type === "textarea");
  if (area?.ref && typeof area.ref === "object") (area.ref as { current: unknown }).current = messageNode;
}
const open = () => mount(FeedbackDialog, { onClose: vi.fn() }, { commit });
const write = (tree: unknown, words: string) => handler(message(tree), "onChange")({ target: { value: words } });

describe("Feedback's Discard, armed (V4's Figma)", () => {
  it("is quiet until there is something to discard, then says 'Discard'", () => {
    const view = open();
    expect(discardButton(view.tree)).toBeNull();
    write(view.tree, "The board jumps when a session ends.");
    expect(discardButton(view.tree)!.props.children).toBe(discardLabel());
  });

  it("arms on the first press: 'Confirm discard', the armed class, and the words still in the field", () => {
    const view = open();
    write(view.tree, "The board jumps when a session ends.");
    handler(discardButton(view.tree)!, "onClick")();
    const armed = discardButton(view.tree)!;
    expect(armed.props.children).toBe(discardArmedLabel());
    expect(discardArmedLabel()).toBe("Confirm discard");
    expect(armed.props.className).toMatch(/\barmed\b/);
    expect(message(view.tree).props.value).toBe("The board jumps when a session ends.");
  });

  it("discards on the second press, and empties the form", () => {
    const view = open();
    write(view.tree, "The board jumps when a session ends.");
    handler(discardButton(view.tree)!, "onClick")();
    vi.advanceTimersByTime(CONFIRM_GAP_MS + 1);
    handler(discardButton(view.tree)!, "onClick")();
    expect(message(view.tree).props.value).toBe("");
    expect(discardButton(view.tree)).toBeNull();
  });

  it("disarms when the message is typed in again, so a later press arms rather than discards", () => {
    const view = open();
    write(view.tree, "The board jumps when a session ends.");
    handler(discardButton(view.tree)!, "onClick")();
    expect(discardButton(view.tree)!.props.className).toMatch(/\barmed\b/);

    write(view.tree, "The board jumps when a session ends. Again.");
    const back = discardButton(view.tree)!;
    expect(back.props.children).toBe(discardLabel());
    expect(back.props.className).not.toMatch(/\barmed\b/);

    vi.advanceTimersByTime(CONFIRM_GAP_MS + 1);
    handler(back, "onClick")();
    // That press armed it again; it did not discard.
    expect(message(view.tree).props.value).toBe("The board jumps when a session ends. Again.");
    expect(discardButton(view.tree)!.props.children).toBe(discardArmedLabel());
  });
});
