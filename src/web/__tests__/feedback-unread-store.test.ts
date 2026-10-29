// What the feedback doors know about a ccdeck account (feedback-unread.ts): a
// store in the main bundle that the account's own chunk publishes to and the
// topbar's dot and the dialog's tabs read. It imports nothing of the account,
// so a deck with the account off loads no account code to draw either; it
// holds null there for good.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mailsReplies, publishFeedbackAccount, readFeedbackAccount, unreadOf, useFeedbackAccount } from "../feedback-unread";
import { feedbackAccountOf, type AccountView } from "../account-bridge";
import { withoutComments } from "./tsx-scan";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("the store", () => {
  it("is null until something publishes, and wakes its readers only on a change", () => {
    expect(readFeedbackAccount()).toBeNull();
    const seen: unknown[] = [];
    const Reader = () => { seen.push(useFeedbackAccount()); return null; };
    renderToStaticMarkup(createElement(Reader));
    expect(seen).toEqual([null]);
    publishFeedbackAccount({ connected: true, email: "me@example.com", unread: 2, latestAt: "2026-10-28T09:12:00Z" });
    const first = readFeedbackAccount();
    expect(first).toEqual({ connected: true, email: "me@example.com", unread: 2, latestAt: "2026-10-28T09:12:00Z", mail: true });
    publishFeedbackAccount({ connected: true, email: "me@example.com", unread: 2, latestAt: "2026-10-28T09:12:00Z" });
    expect(readFeedbackAccount(), "the same account again keeps the same object").toBe(first);
    renderToStaticMarkup(createElement(Reader));
    expect(seen.at(-1)).toBe(first);
    publishFeedbackAccount(null);
    expect(readFeedbackAccount()).toBeNull();
  });

  it("cleans what it is handed: no negative count, no empty address", () => {
    publishFeedbackAccount({ connected: true, email: "", unread: -3, latestAt: null });
    expect(readFeedbackAccount()).toEqual({ connected: true, email: null, unread: 0, latestAt: null, mail: true });
    publishFeedbackAccount(null);
  });

  it("says whether replies are mailed: only false is false, and a change of it alone wakes the readers", () => {
    publishFeedbackAccount({ connected: true, email: "me@example.com", unread: 0, latestAt: null });
    const mailed = readFeedbackAccount();
    expect(mailed?.mail).toBe(true);
    expect(mailsReplies(mailed)).toBe(true);
    publishFeedbackAccount({ connected: true, email: "me@example.com", unread: 0, latestAt: null, mail: false });
    expect(readFeedbackAccount()).not.toBe(mailed);
    expect(readFeedbackAccount()?.mail).toBe(false);
    expect(mailsReplies(readFeedbackAccount())).toBe(false);
    expect(mailsReplies(null)).toBe(true);
    publishFeedbackAccount(null);
  });

  it("counts nothing unread unless the account is connected", () => {
    expect(unreadOf(null)).toBe(0);
    expect(unreadOf({ connected: false, email: null, unread: 4, latestAt: null })).toBe(0);
    expect(unreadOf({ connected: true, email: null, unread: 4, latestAt: null })).toBe(4);
  });

  it("imports nothing at all, so nothing of the account rides into the main bundle with it", () => {
    const src = withoutComments(read("../feedback-unread.ts"));
    expect([...src.matchAll(/^import[^"]*"([^"]+)"/gm)].map(m => m[1])).toEqual(["react"]);
    expect(src).not.toMatch(/import\(/);
  });
});

describe("what the account's chunk publishes", () => {
  const view = (over: Partial<AccountView>): AccountView => ({
    enabled: true, vetoed: false, state: "connected", connect: null, account: { email: "me@example.com" },
    device: { id: "d", name: "laptop", consoleUrl: null }, suggestedName: "laptop", tokenStorage: "file",
    status: null, sync: null, revokedReason: null, problem: null, feedback: { unread: 1, latestAt: "2026-10-28T09:12:00Z" },
    ...over,
  });

  it("is the address, the count and when, while connected", () => {
    expect(feedbackAccountOf(view({}))).toEqual({ connected: true, email: "me@example.com", unread: 1, latestAt: "2026-10-28T09:12:00Z", mail: true });
    // Before the first frame the deck has no summary: nothing unread.
    expect(feedbackAccountOf(view({ feedback: null }))).toEqual({ connected: true, email: "me@example.com", unread: 0, latestAt: null, mail: true });
    // The API mails no replies: the dialog is told so.
    expect(feedbackAccountOf(view({ feedback: { unread: 1, latestAt: null, mail: false } }))?.mail).toBe(false);
  });

  it("is not connected, with nothing lit, in every other state", () => {
    for (const state of ["disconnected", "connecting", "revoked", "error"] as const) {
      expect(feedbackAccountOf(view({ state })), state).toEqual({ connected: false, email: null, unread: 0, latestAt: null, mail: true });
    }
    expect(feedbackAccountOf(null)).toBeNull();
  });

  it("is published by the bridge App mounts only while the account is on, and taken back when it goes", () => {
    const bridge = withoutComments(read("../components/AccountBridge.tsx"));
    expect(bridge).toMatch(/useEffect\(\(\) => \{ publishFeedbackAccount\(feedbackAccountOf\(view\)\); \}, \[view\]\);/);
    expect(bridge).toMatch(/useEffect\(\(\) => \(\) => publishFeedbackAccount\(null\), \[\]\);/);
    const app = read("../App.tsx");
    expect(app).toContain("{account.on && <Suspense fallback={null}><AccountBridge appliers={accountAppliers} /></Suspense>}");
    expect(app).toMatch(/import \{ unreadOf, useFeedbackAccount \} from "\.\/feedback-unread";/);
  });
});
