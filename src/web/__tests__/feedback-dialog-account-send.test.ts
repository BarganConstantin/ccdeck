// Where Send goes (feedback conversations, design 4.6): with a ccdeck account
// connected and Send without my account not ticked, to the deck's account
// route, as the same JSON or the same form, and never with the contact; ticked
// — or with no account — to /api/feedback, exactly as before, contact and all.
// A refusal keeps the text and reads as the account's words.
//
// The send hook itself, on fake-react.ts's React, with fetch held by the test.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flush, mount } from "./fake-react";
import type { FeedbackImages } from "../use-feedback-images";
import type { FeedbackDraft } from "../feedback";

vi.mock("react", async () => (await import("./fake-react")).react);

const { useFeedbackSend, ACCOUNT_THREADS_ROUTE } = await import("../use-feedback-send");
const { ACCOUNT_UNAVAILABLE, SENT_LINE_ACCOUNT } = await import("../feedback");

const DRAFT: FeedbackDraft = { kind: "bug", body: "The usage chart is empty after a restart", contact: "me@example.com" };
const PNG = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" });

let attached: Blob[] = [];
const images = { ready: async () => attached } as unknown as FeedbackImages;
let posts: Array<{ url: string; init: RequestInit }>;
let answer: { status: number; body: unknown };

beforeEach(() => {
  posts = [];
  attached = [];
  answer = { status: 201, body: { thread: { id: "t" }, items: [] } };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    posts.push({ url, init });
    return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, json: async () => answer.body };
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

const send = async (asAccount: boolean) => {
  const view = mount(() => useFeedbackSend(images, { asAccount }), {});
  await view.tree.send(DRAFT);
  await flush();
  return view;
};

describe("Send, as the account", () => {
  it("posts the JSON to the account's route, without the contact", async () => {
    const view = await send(true);
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe(ACCOUNT_THREADS_ROUTE);
    expect(ACCOUNT_THREADS_ROUTE).toBe("/api/account/feedback/threads");
    expect(JSON.parse(String(posts[0].init.body))).toEqual({ kind: "bug", title: "The usage chart is empty after a restart", body: DRAFT.body });
    expect(view.tree.outcome).toEqual({ state: "sent" });
    expect(view.tree.sentAsAccount).toBe(true);
    expect(SENT_LINE_ACCOUNT).toMatch(/Your conversations/);
  });

  it("posts the form with its images to the same route, still without the contact", async () => {
    attached = [PNG];
    await send(true);
    const form = posts[0].init.body as FormData;
    expect(posts[0].url).toBe(ACCOUNT_THREADS_ROUTE);
    expect([...form.keys()]).toEqual(["kind", "title", "body", "images"]);
  });

  it("keeps the text and says why when the account's route refuses", async () => {
    answer = { status: 502, body: { ok: false, reason: "unavailable" } };
    const view = await send(true);
    expect(view.tree.outcome).toEqual({ state: "failed", message: ACCOUNT_UNAVAILABLE });
    answer = { status: 429, body: { ok: false, reason: "too_many", limit: 10, retryAfterSec: 60 } };
    const limited = await send(true);
    expect(limited.tree.outcome).toMatchObject({ state: "failed", message: expect.stringMatching(/today's limit of 10 new conversations/) });
  });

  it("does not take an anonymous answer for a conversation", async () => {
    answer = { status: 200, body: { ok: true } };
    const view = await send(true);
    expect(view.tree.outcome.state).toBe("failed");
  });
});

describe("Send without the account", () => {
  it("is /api/feedback with the contact, exactly as before", async () => {
    answer = { status: 200, body: { ok: true } };
    const view = await send(false);
    expect(posts[0].url).toBe("/api/feedback");
    expect(JSON.parse(String(posts[0].init.body))).toEqual({ kind: "bug", title: "The usage chart is empty after a restart", body: DRAFT.body, contact: "me@example.com" });
    expect(view.tree.outcome).toEqual({ state: "sent" });
    expect(view.tree.sentAsAccount).toBe(false);
  });

  it("sends the form with its contact there too", async () => {
    answer = { status: 200, body: { ok: true } };
    attached = [PNG];
    await send(false);
    expect(posts[0].url).toBe("/api/feedback");
    expect([...(posts[0].init.body as FormData).keys()]).toEqual(["kind", "title", "body", "contact", "images"]);
  });
});
