// A feedback draft across a reload of the tab: the words come back, the
// screenshots do not — they stay in memory only, being megabytes — and the
// dialog says so in one quiet line until one is added again.
//
// A reload is a fresh copy of the deck's modules over the same sessionStorage:
// vi.resetModules, then the dialog imported again. The mocked "react" is kept
// by the mocks registry across the reset, so it also hands over the
// fake-react.ts it was made from, and the dialog is mounted by that one.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Drawn } from "./fake-react";
import type { FeedbackImages } from "../use-feedback-images";
import { imagesLostLine } from "../feedback-draft";

vi.mock("react", async () => {
  const fake = await import("./fake-react");
  return { ...fake.react, fake };
});
vi.mock("../components/use-modal-dismiss", async orig => ({
  ...(await orig<typeof import("../components/use-modal-dismiss")>()),
  useModalDismiss: () => ({ current: null }),
}));
vi.mock("../components/SuccessMark", () => ({ default: () => null }));

/** A PNG small enough to be sent as it is, so no canvas is asked for. */
function png(name: string): File {
  const bytes = new Uint8Array(64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 400);
  view.setUint32(20, 300);
  return new File([bytes], name, { type: "image/png" });
}

const data = new Map<string, string>();
const sessionStorage = {
  getItem: (key: string) => data.get(key) ?? null,
  setItem: (key: string, value: string) => { data.set(key, value); },
  removeItem: (key: string) => { data.delete(key); },
};

beforeEach(() => {
  data.clear();
  vi.stubGlobal("window", { sessionStorage, setTimeout: () => 0, clearTimeout: () => {} });
  vi.stubGlobal("document", { activeElement: null });
  vi.stubGlobal("HTMLTextAreaElement", class {});
  vi.stubGlobal("HTMLInputElement", class {});
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
});
afterEach(() => { vi.unstubAllGlobals(); });

/** The page as a fresh load of it finds itself. */
async function loadPage() {
  vi.resetModules();
  const { default: FeedbackDialog } = await import("../components/FeedbackDialog");
  const { default: FeedbackShots } = await import("../components/FeedbackShots");
  const { fake } = (await import("react")) as unknown as { fake: typeof import("./fake-react") };
  const { flush, mount, one } = fake;
  const el = (tree: unknown, match: (e: Drawn) => boolean) => one(tree, match) as Drawn;
  const images = (tree: unknown) => el(tree, e => e.type === FeedbackShots).props.images as FeedbackImages;
  return {
    open: () => mount(FeedbackDialog, { onClose: vi.fn() }),
    message: (tree: unknown) => el(tree, e => e.type === "textarea"),
    images,
    lostLine: (tree: unknown) => one(tree, e => e.type === "p" && e.props.className === "fb-hint"),
    paste: async (tree: unknown, file: File) => {
      const surface = el(tree, e => typeof e.props.className === "string" && e.props.className.startsWith("modal feedback-dialog"));
      (surface.props.onPaste as (ev: unknown) => void)({ clipboardData: { files: [file], types: ["Files"] }, target: {}, preventDefault() {} });
      await images(tree).ready();
      await flush();
    },
  };
}

describe("a feedback draft through a reload of the tab", () => {
  it("keeps the words, and says the screenshot has to be added again", async () => {
    const before = await loadPage();
    const view = before.open();
    (before.message(view.tree).props.onChange as (ev: unknown) => void)({ target: { value: "The usage chart is empty" } });
    await before.paste(view.tree, png("chart.png"));
    expect(before.lostLine(view.tree)).toBeNull();
    // A reload unmounts nothing: what it finds is what was written as it changed.

    const after = await loadPage();
    const again = after.open();
    expect(after.message(again.tree).props.value).toBe("The usage chart is empty");
    expect(after.images(again.tree).shots).toHaveLength(0);
    expect(after.lostLine(again.tree)?.props.children).toBe(imagesLostLine(1));

    await after.paste(again.tree, png("chart-again.png"));
    expect(after.lostLine(again.tree)).toBeNull();
  });

  it("describes the message, which has the focus, by that line until an image is added again", async () => {
    // Seen under the field and heard on arriving in it: the line changes what
    // Send will send, and a screen reader is told so where the caret is.
    const before = await loadPage();
    const view = before.open();
    (before.message(view.tree).props.onChange as (ev: unknown) => void)({ target: { value: "The usage chart is empty" } });
    await before.paste(view.tree, png("chart.png"));
    expect(before.message(view.tree).props["aria-describedby"]).toBeUndefined();

    const after = await loadPage();
    const again = after.open();
    expect(after.lostLine(again.tree)?.props.id).toBe("fb-images-lost");
    expect(after.message(again.tree).props["aria-describedby"]).toBe("fb-images-lost");

    await after.paste(again.tree, png("chart-again.png"));
    expect(after.message(again.tree).props["aria-describedby"]).toBeUndefined();
  });

  it("opens empty after a reload when nothing was written", async () => {
    await loadPage();
    const after = await loadPage();
    const view = after.open();
    expect(after.message(view.tree).props.value).toBe("");
    expect(after.lostLine(view.tree)).toBeNull();
  });
});
