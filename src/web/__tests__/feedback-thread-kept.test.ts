// One conversation, kept (use-feedback-conversations.ts useThread): read is
// posted up to the highest item shown when the thread is seen — opened in a
// visible page, or the page coming back — and never again for what was read;
// a newer team item is announced once; a reply that is refused keeps every
// word in the box and the draft past the thread, and one that goes clears it.
//
// The hook on fake-react.ts's React, with fetch and the document's visibility
// held by the test (feedback-thread-view.test.ts draws the markup).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixture } from "./account-fake-api";
import { flush, mount } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);

const { useThread, replyDrafts } = await import("../use-feedback-conversations");
const THREAD = fixture("feedback-thread.response.json");
const ID = THREAD.thread.id as string;

describe("the thread, kept", () => {
  let visible = true;
  const listeners = new Set<() => void>();
  let posts: Array<{ url: string; body: any }>;
  let replyAnswer: { status: number; body: unknown };
  let threadBody: any;

  beforeEach(() => {
    visible = true;
    listeners.clear();
    posts = [];
    threadBody = structuredClone(THREAD);
    replyAnswer = { status: 201, body: fixture("feedback-reply.response.json") };
    vi.stubGlobal("document", {
      get visibilityState() { return visible ? "visible" : "hidden"; },
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        posts.push({ url, body });
        if (url.endsWith("/replies")) return { status: replyAnswer.status, json: async () => replyAnswer.body };
        return { status: 200, json: async () => ({ unread: 0, latestAt: "2026-10-28T16:20:00Z" }) };
      }
      return { status: 200, json: async () => structuredClone(threadBody) };
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  async function open(latestAt: string | null = "2026-10-28T16:20:00Z") {
    replyDrafts.clear();
    const said: string[] = [];
    const view = mount((p: { latestAt: string | null }) => useThread(ID, p.latestAt, w => said.push(w)), { latestAt });
    await flush();
    return { view, said, replyDrafts };
  }
  const reads = () => posts.filter(p => p.url.endsWith("/read"));

  it("is read up to the highest item shown when it opens in a visible page", async () => {
    await open();
    expect(reads()).toEqual([{ url: `/api/account/feedback/threads/${ID}/read`, body: { seq: 9 } }]);
  });

  it("is not read while the page is hidden, and is read when it comes back", async () => {
    visible = false;
    await open();
    expect(reads()).toEqual([]);
    visible = true;
    for (const fn of listeners) fn();
    await flush();
    expect(reads()).toEqual([{ url: `/api/account/feedback/threads/${ID}/read`, body: { seq: 9 } }]);
  });

  it("is not read again for what was already read", async () => {
    threadBody.thread.readSeq = 9;
    await open();
    expect(reads()).toEqual([]);
  });

  it("says a new reply from the team, once, when a newer one arrives", async () => {
    const { view, said } = await open();
    threadBody.items.push({ seq: 10, at: "2026-10-28T17:00:00Z", type: "message", side: "team", text: "One more thing.", signature: "ccdeck team" });
    threadBody.thread.lastSeq = 10;
    view.rerender({ latestAt: "2026-10-28T17:00:00Z" });
    await flush();
    expect(said).toEqual(["New reply from the ccdeck team."]);
    expect(reads().at(-1)!.body).toEqual({ seq: 10 });
  });

  it("keeps every word of a refused reply, says why, and keeps the draft past the thread", async () => {
    const { view, replyDrafts } = await open();
    (view.tree as any).setDraft("Still happens on 3.49.0.");
    replyAnswer = { status: 502, body: { ok: false, reason: "unavailable" } };
    await (view.tree as any).reply();
    await flush();
    expect((view.tree as any).draft).toBe("Still happens on 3.49.0.");
    expect((view.tree as any).failure).toBe("Your account's conversations can't be reached right now. Try again; your text is still here.");
    expect(replyDrafts.get(ID)).toBe("Still happens on 3.49.0.");
    replyAnswer = { status: 429, body: { ok: false, reason: "too_many", limit: 50, retryAfterSec: 600 } };
    await (view.tree as any).reply();
    expect((view.tree as any).failure).toMatch(/^You've reached today's limit of 50 replies\./);
    replyAnswer = { status: 404, body: { ok: false, reason: "not_found" } };
    await (view.tree as any).reply();
    expect((view.tree as any).failure).toBe("This conversation is no longer available.");
  });

  it("clears the box once a reply has gone, and says so", async () => {
    const { view, said, replyDrafts } = await open();
    (view.tree as any).setDraft("Still happens on 3.48.1, see the second screenshot.");
    await (view.tree as any).reply();
    await flush();
    expect((view.tree as any).draft).toBe("");
    expect(replyDrafts.has(ID)).toBe(false);
    expect(said).toContain("Reply sent.");
    expect(posts.find(p => p.url.endsWith("/replies"))!.body).toEqual({ body: "Still happens on 3.48.1, see the second screenshot." });
  });
});
