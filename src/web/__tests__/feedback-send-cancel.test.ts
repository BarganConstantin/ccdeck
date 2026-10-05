// Cancel, Esc or the × pressed while a report said "Sending…" did not cancel
// it. Closing only took the dialog away; the send went on awaiting the images
// and then posted, so a report the person had just cancelled — screenshots
// and all — could start uploading after the dialog was gone, and a failure of
// that post was told to nobody. Closed now, a send not yet posted is never
// posted and one under way is aborted.
//
// Run on fake-react.ts's React: the hook is mounted, the images it waits for
// and the fetch it makes are held by the test, and unmount is the dialog
// closing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { flush, mount } from "./fake-react";
import type { FeedbackImages } from "../use-feedback-images";
import type { FeedbackDraft } from "../feedback";

vi.mock("react", async () => (await import("./fake-react")).react);

const { useFeedbackSend } = await import("../use-feedback-send");

const DRAFT: FeedbackDraft = { kind: "bug", body: "The usage chart is empty after a restart", contact: "" };

/** Images whose fits finish when the test says. */
let finishFits: (blobs: Blob[]) => void;
const images = { ready: () => new Promise<Blob[]>(resolve => { finishFits = resolve; }) } as unknown as FeedbackImages;

/** Every post made, with what it was handed. Each one is answered only when
 *  the test says, and fails the way fetch does when its signal is aborted. */
let posts: Array<{ init: RequestInit; answer: (ok: boolean) => void }>;

beforeEach(() => {
  posts = [];
  vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise((resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
    posts.push({ init, answer: ok => resolve({ ok, status: ok ? 200 : 502, json: async () => ({ ok }) }) });
  })));
});
afterEach(() => { vi.unstubAllGlobals(); });

function open() {
  return mount(() => useFeedbackSend(images), {});
}

describe("closing the feedback dialog while a report is sending", () => {
  it("posts nothing when it closes while the images are still being made ready", async () => {
    const view = open();
    void view.tree.send(DRAFT);
    view.unmount();
    finishFits([]);
    await flush();
    expect(posts).toHaveLength(0);
  });

  it("aborts the post when it closes while the post is out", async () => {
    const view = open();
    void view.tree.send(DRAFT);
    finishFits([]);
    await flush();
    expect(posts).toHaveLength(1);
    view.unmount();
    expect(posts[0].init.signal?.aborted).toBe(true);
  });

  it("still sends, and thanks, when nobody closes it", async () => {
    const view = open();
    const sent = view.tree.send(DRAFT);
    finishFits([]);
    await flush();
    expect(posts).toHaveLength(1);
    posts[0].answer(true);
    await sent;
    expect(view.tree.outcome).toEqual({ state: "sent" });
  });

  it("still says a failure that was not a close", async () => {
    const view = open();
    const sent = view.tree.send(DRAFT);
    finishFits([]);
    await flush();
    posts[0].answer(false);
    await sent;
    expect(view.tree.outcome.state).toBe("failed");
  });
});
