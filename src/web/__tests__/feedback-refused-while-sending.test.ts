// An image refused while Send waited for it was dropped, and the report went
// without it. Send waits for every image still being redrawn to fit; one that
// then turns out not to decode, or not to shrink far enough, is taken off the
// strip and refused beside it — and the send posted what was left, said
// "Thanks — feedback sent." over the refusal and closed the dialog, so the
// person never learnt their screenshot had not gone. A refusal said while Send
// waits now stops the send, and the dialog stays open saying why.
//
// Run on fake-react.ts's React: the images hook and the send hook together,
// as the dialog holds them, with the fit of each image answered by the test.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { flush, mount } from "./fake-react";
import type { FeedbackDraft } from "../feedback";
import type { Prepared } from "../feedback-images";

vi.mock("react", async () => (await import("./fake-react")).react);

/** Each fit under way, answered when the test says. The decoder is called
 *  first, which is the moment the hook shows the image as resizing. */
let fits: Array<(prepared: Prepared) => void>;
vi.mock("../feedback-images", async orig => ({
  ...(await orig<typeof import("../feedback-images")>()),
  browserDecoder: async () => null,
  prepareImage: async (file: Blob, _budget: number, decode: (file: Blob) => Promise<unknown>) => {
    await decode(file);
    return new Promise<Prepared>(resolve => fits.push(resolve));
  },
}));

const { useFeedbackImages } = await import("../use-feedback-images");
const { useFeedbackSend } = await import("../use-feedback-send");

const DRAFT: FeedbackDraft = { kind: "bug", body: "Here is what the canvas looked like", contact: "" };
const png = (name: string) => new File([new Uint8Array(64)], name, { type: "image/png" });
const FITTED: Prepared = { ok: true, blob: new Blob([new Uint8Array(32)], { type: "image/png" }), resized: { width: 8000, height: 6000 } };
const DAMAGED: Prepared = { ok: false, problem: "unreadable" };

let posts: Array<RequestInit>;

beforeEach(() => {
  fits = [];
  posts = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    posts.push(init);
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

function dialog() {
  return mount(() => {
    const images = useFeedbackImages();
    return { images, ...useFeedbackSend(images) };
  }, {});
}

/** One image pasted, and its fit begun: shown, still resizing. */
async function pasteBig(view: ReturnType<typeof dialog>, name: string) {
  view.tree.images.add([png(name)]);
  await flush();
}

describe("an image refused while Send waits for it", () => {
  it("stops the send, and says why, with the refusal still beside the images", async () => {
    const view = dialog();
    await pasteBig(view, "damaged.png");
    expect(view.tree.images.shots).toHaveLength(1);
    const sent = view.tree.send(DRAFT);
    fits[0](DAMAGED);
    await sent;
    expect(posts).toHaveLength(0);
    expect(view.tree.outcome.state).toBe("failed");
    expect(view.tree.outcome.state === "failed" && view.tree.outcome.message).toMatch(/image/i);
    expect(view.tree.images.problem).toMatch(/“damaged\.png” could not be read as an image/);
    expect(view.tree.images.shots).toHaveLength(0);
  });

  it("sends once it is pressed again, with what is there now", async () => {
    const view = dialog();
    await pasteBig(view, "damaged.png");
    const first = view.tree.send(DRAFT);
    fits[0](DAMAGED);
    await first;
    await view.tree.send(DRAFT);
    expect(posts).toHaveLength(1);
    expect(view.tree.outcome).toEqual({ state: "sent" });
  });

  it("does not stop for a refusal already said before Send was pressed", async () => {
    // That one was on screen when the person chose to send.
    const view = dialog();
    await pasteBig(view, "damaged.png");
    fits[0](DAMAGED);
    await flush();
    expect(view.tree.images.problem).not.toBe("");
    await view.tree.send(DRAFT);
    expect(posts).toHaveLength(1);
    expect(view.tree.outcome).toEqual({ state: "sent" });
  });

  it("sends an image that fits while Send waits for it", async () => {
    const view = dialog();
    await pasteBig(view, "canvas.png");
    const sent = view.tree.send(DRAFT);
    fits[0](FITTED);
    await sent;
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toBeInstanceOf(FormData);
    expect((posts[0].body as FormData).getAll("images")).toHaveLength(1);
    expect(view.tree.outcome).toEqual({ state: "sent" });
  });
});
