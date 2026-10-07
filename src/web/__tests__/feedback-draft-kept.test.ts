// A report written in the feedback dialog was lost the moment the dialog
// closed. The message, the kind, the contact and the screenshots were the
// dialog's own state, and the dialog is drawn only while it is open, so
// closing it — to take another screenshot, to check something, or by a stray
// Escape — threw all of it away, and opening it again showed an empty form.
// The draft is kept now until the report is sent or the person discards it.
//
// Run on fake-react.ts's React: the dialog itself is mounted, written in,
// handed a pasted screenshot, closed (unmounted) and opened (mounted) again.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { flush, mount, one, type Drawn } from "./fake-react";
import type { FeedbackImages } from "../use-feedback-images";
import type { FeedbackPrefill } from "../feedback";

vi.mock("react", async () => (await import("./fake-react")).react);
vi.mock("../components/use-modal-dismiss", async orig => ({
  ...(await orig<typeof import("../components/use-modal-dismiss")>()),
  useModalDismiss: () => ({ current: null }),
}));
vi.mock("../components/SuccessMark", () => ({ default: () => null }));

const { default: FeedbackDialog } = await import("../components/FeedbackDialog");
const { default: FeedbackShots } = await import("../components/FeedbackShots");
const { default: FeedbackDetails } = await import("../components/FeedbackDetails");
const { default: FeedbackKinds } = await import("../components/FeedbackKinds");
const { draftKey, feedbackDrafts, feedbackSeed, DISCARD_LABEL, DISCARD_ARMED_LABEL } = await import("../feedback-draft");
const { CONFIRM_GAP_MS } = await import("../panel-press");

/** A PNG small enough to be sent as it is, so no canvas is asked for. */
function png(name: string): File {
  const bytes = new Uint8Array(64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 400);
  view.setUint32(20, 300);
  return new File([bytes], name, { type: "image/png" });
}

const ACCOUNT_ISSUE: FeedbackPrefill = { initialKind: "other", initialBody: "Account issue: rate limited." };

/** The message field as the document holds it: where focus is. */
const page = { activeElement: null as unknown };
const messageNode = { tagName: "TEXTAREA", focus: () => { page.activeElement = messageNode; } };

/** Every post made, answered when the test says. */
let posts: Array<{ init: RequestInit; answer: (ok: boolean) => void }>;

beforeEach(() => {
  for (const prefill of [{}, ACCOUNT_ISSUE]) feedbackDrafts.forget(draftKey(feedbackSeed(prefill)));
  page.activeElement = null;
  posts = [];
  vi.stubGlobal("document", page);
  vi.stubGlobal("window", { setTimeout: () => 0, clearTimeout: () => {} });
  vi.stubGlobal("HTMLTextAreaElement", class {});
  vi.stubGlobal("HTMLInputElement", class {});
  vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => new Promise(resolve => {
    // The facts the dialog asks for when it opens are never answered.
    if (init?.method !== "POST") return;
    posts.push({ init, answer: ok => resolve({ ok, status: ok ? 200 : 502, json: async () => ({ ok }) }) });
  })));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const el = (tree: unknown, match: (e: Drawn) => boolean) => one(tree, match) as Drawn;
const handler = (e: Drawn, name: string) => e.props[name] as (ev?: unknown) => void;
const message = (tree: unknown) => el(tree, e => e.type === "textarea");
const surface = (tree: unknown) => el(tree, e => typeof e.props.className === "string" && e.props.className.startsWith("modal feedback-dialog"));
const imagesOf = (tree: unknown) => el(tree, e => e.type === FeedbackShots).props.images as FeedbackImages;
const contactOf = (tree: unknown) => el(tree, e => e.type === FeedbackDetails).props.contact as string;
const kindOf = (tree: unknown) => el(tree, e => e.type === FeedbackKinds).props.kind as string;
const discardButton = (tree: unknown) =>
  one(tree, e => e.type === "button" && typeof e.props.className === "string" && e.props.className.includes("fb-discard"));

/** What the document does with a render: the message's ref gets its node. */
function commit(tree: unknown) {
  const area = one(tree, e => e.type === "textarea");
  if (area?.ref && typeof area.ref === "object") (area.ref as { current: unknown }).current = messageNode;
}

function open(prefill: FeedbackPrefill = {}) {
  return mount(FeedbackDialog, { onClose: vi.fn(), ...prefill }, { commit });
}

function write(tree: unknown, words: string) {
  handler(message(tree), "onChange")({ target: { value: words } });
}

async function paste(tree: unknown, file: File) {
  handler(surface(tree), "onPaste")({ clipboardData: { files: [file], types: ["Files"] }, target: {}, preventDefault() {} });
  await imagesOf(tree).ready();
  await flush();
}

async function sendAndAnswer(tree: unknown, ok: boolean) {
  handler(el(tree, e => e.type === "form"), "onSubmit")({ preventDefault() {} });
  await flush();
  posts[posts.length - 1].answer(ok);
  await flush();
}

describe("a feedback draft, closed and opened again", () => {
  it("keeps a feedback draft's text and image when the dialog is closed and opened again", async () => {
    const first = open();
    write(first.tree, "The usage chart is empty after a restart");
    await paste(first.tree, png("chart.png"));
    expect(imagesOf(first.tree).shots).toHaveLength(1);
    first.unmount();

    const again = open();
    await flush();
    expect(message(again.tree).props.value).toBe("The usage chart is empty after a restart");
    expect(imagesOf(again.tree).shots.map(shot => shot.name)).toEqual(["chart.png"]);
    expect(await imagesOf(again.tree).ready()).toHaveLength(1);
  });

  it("keeps the kind and the contact with it", async () => {
    const first = open();
    handler(el(first.tree, e => e.type === FeedbackKinds), "onChange")("idea");
    write(first.tree, "A quieter chime at night");
    handler(el(first.tree, e => e.type === FeedbackDetails), "onContact")("bob@example.org");
    first.unmount();

    const again = open();
    expect(kindOf(again.tree)).toBe("idea");
    expect(message(again.tree).props.value).toBe("A quieter chime at night");
    expect(contactOf(again.tree)).toBe("bob@example.org");
  });

  it("keeps a draft that is only a screenshot", async () => {
    const first = open();
    await paste(first.tree, png("canvas.png"));
    first.unmount();

    const again = open();
    expect(imagesOf(again.tree).shots.map(shot => shot.name)).toEqual(["canvas.png"]);
  });

  it("opens empty once the report has been sent", async () => {
    const first = open();
    write(first.tree, "The usage chart is empty after a restart");
    await paste(first.tree, png("chart.png"));
    await sendAndAnswer(first.tree, true);
    expect(posts).toHaveLength(1);
    first.unmount();

    const again = open();
    expect(message(again.tree).props.value).toBe("");
    expect(imagesOf(again.tree).shots).toHaveLength(0);
    expect(discardButton(again.tree)).toBeNull();
  });

  it("keeps the draft when the send fails", async () => {
    const first = open();
    write(first.tree, "The usage chart is empty after a restart");
    await paste(first.tree, png("chart.png"));
    await sendAndAnswer(first.tree, false);
    first.unmount();

    const again = open();
    expect(message(again.tree).props.value).toBe("The usage chart is empty after a restart");
    expect(imagesOf(again.tree).shots).toHaveLength(1);
  });

  it("keeps the draft when the dialog is closed while it sends", async () => {
    const first = open();
    write(first.tree, "The usage chart is empty after a restart");
    handler(el(first.tree, e => e.type === "form"), "onSubmit")({ preventDefault() {} });
    await flush();
    first.unmount();
    expect(posts[0].init.signal?.aborted).toBe(true);

    const again = open();
    expect(message(again.tree).props.value).toBe("The usage chart is empty after a restart");
  });

  it("keeps nothing when nothing was written: a kind picked alone is not a draft", () => {
    const first = open();
    handler(el(first.tree, e => e.type === FeedbackKinds), "onChange")("idea");
    expect(discardButton(first.tree)).toBeNull();
    first.unmount();

    const again = open();
    expect(kindOf(again.tree)).toBe("bug");
  });

  it("keeps a seeded report's draft apart from the blank one", () => {
    const blank = open();
    write(blank.tree, "The chime is loud");
    blank.unmount();

    const seeded = open(ACCOUNT_ISSUE);
    expect(message(seeded.tree).props.value).toBe("Account issue: rate limited.");
    expect(kindOf(seeded.tree)).toBe("other");
    write(seeded.tree, "Account issue: rate limited. It has been an hour.");
    seeded.unmount();

    expect(message(open().tree).props.value).toBe("The chime is loud");
    expect(message(open(ACCOUNT_ISSUE).tree).props.value).toBe("Account issue: rate limited. It has been an hour.");
  });

  it("shows no Discard for a seeded report until it is written in", () => {
    const seeded = open(ACCOUNT_ISSUE);
    expect(discardButton(seeded.tree)).toBeNull();
    write(seeded.tree, "Account issue: rate limited. Still.");
    expect(discardButton(seeded.tree)).not.toBeNull();
  });
});

describe("discarding a draft", () => {
  it("arms on the first press and empties the form on the second", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const view = open();
    write(view.tree, "The usage chart is empty after a restart");
    handler(el(view.tree, e => e.type === FeedbackDetails), "onContact")("bob@example.org");
    await paste(view.tree, png("chart.png"));

    const first = discardButton(view.tree)!;
    expect(first.props.children).toBe(DISCARD_LABEL);
    handler(first, "onClick")();
    const armed = discardButton(view.tree)!;
    expect(armed.props.children).toBe(DISCARD_ARMED_LABEL);
    expect(armed.props.className).toMatch(/\barmed\b/);
    expect(message(view.tree).props.value).toBe("The usage chart is empty after a restart");

    vi.advanceTimersByTime(CONFIRM_GAP_MS + 1);
    handler(armed, "onClick")();
    expect(message(view.tree).props.value).toBe("");
    expect(contactOf(view.tree)).toBe("");
    expect(imagesOf(view.tree).shots).toHaveLength(0);
    expect(discardButton(view.tree)).toBeNull();
    expect(page.activeElement).toBe(messageNode);
    view.unmount();

    const again = open();
    expect(message(again.tree).props.value).toBe("");
    expect(imagesOf(again.tree).shots).toHaveLength(0);
  });

  it("takes a double-click as one press, which only arms it", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const view = open();
    write(view.tree, "The usage chart is empty after a restart");
    handler(discardButton(view.tree)!, "onClick")();
    vi.advanceTimersByTime(CONFIRM_GAP_MS - 100);
    handler(discardButton(view.tree)!, "onClick")();
    expect(message(view.tree).props.value).toBe("The usage chart is empty after a restart");
  });

  it("puts a seeded report back to its seed, not to an empty form", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const view = open(ACCOUNT_ISSUE);
    write(view.tree, "Account issue: rate limited. Still.");
    handler(discardButton(view.tree)!, "onClick")();
    vi.advanceTimersByTime(CONFIRM_GAP_MS + 1);
    handler(discardButton(view.tree)!, "onClick")();
    expect(message(view.tree).props.value).toBe("Account issue: rate limited.");
    expect(kindOf(view.tree)).toBe("other");
  });

  it("takes down a failure's words, which were about the message it cleared", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const view = open();
    write(view.tree, "The usage chart is empty after a restart");
    await sendAndAnswer(view.tree, false);
    expect(one(view.tree, e => e.props.role === "alert")).not.toBeNull();
    handler(discardButton(view.tree)!, "onClick")();
    vi.advanceTimersByTime(CONFIRM_GAP_MS + 1);
    handler(discardButton(view.tree)!, "onClick")();
    expect(one(view.tree, e => e.props.role === "alert")).toBeNull();
  });
});
