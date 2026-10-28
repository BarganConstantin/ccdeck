// The feedback dialog with a ccdeck account connected (feedback conversations,
// design 4.6), and without one.
//
// Without an account — the flag off, not connected, revoked — it is exactly
// the dialog it was: one form, "Send feedback", the contact under Add details,
// and Send to /api/feedback. With one it is "Feedback" with two tabs, Write and
// Your conversations; Write says who it goes as, offers Send without my
// account (kept with the draft), leaves the contact out while it goes as the
// account and sends to the account's route; ticked, everything is as before.
// It opens on Write from every door but one: the topbar's Feedback pressed
// while it shows the dot.
//
// Drawn with react-dom/server, as crash-pane-alert.test.ts draws the crash
// pane; the send is the hook itself on fake-react.ts's React.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import FeedbackDialog from "../components/FeedbackDialog";
import ErrorBoundary from "../components/ErrorBoundary";
import { publishFeedbackAccount, type FeedbackAccount } from "../feedback-unread";
import { draftKey, feedbackDrafts, feedbackSeed } from "../feedback-draft";
import {
  ACCOUNT_UNAVAILABLE, CONTACT_LABEL, SEND_WITHOUT_ACCOUNT, SENT_LINE, SENT_LINE_ACCOUNT, WHERE_IT_GOES, WHERE_IT_GOES_ACCOUNT,
  accountFailure, accountSentAs, outcomeAnnouncement, sentLine,
} from "../feedback";
import { withoutComments } from "./tsx-scan";

const read = (rel: string) => withoutComments(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));
const ACCOUNT: FeedbackAccount = { connected: true, email: "me@example.com", unread: 2, latestAt: "2026-10-28T09:12:00Z" };
const html = (props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(FeedbackDialog, { onClose: () => {}, ...props }));
/** The text a screen reader would be handed, tags and all whitespace gone. */
const words = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

beforeEach(() => { feedbackDrafts.forget(draftKey(feedbackSeed({}))); });
afterEach(() => { publishFeedbackAccount(null); feedbackDrafts.forget(draftKey(feedbackSeed({}))); });

describe("without an account", () => {
  it("is the dialog it always was, whichever way there is none", () => {
    const none = html();
    for (const markup of [none, html({ account: null }), html({ account: { ...ACCOUNT, connected: false } })]) {
      expect(markup).toBe(none);
    }
    expect(none).toContain('<span id="feedback-title" class="modal-tool-name">Send feedback</span>');
    expect(none).not.toMatch(/role="tab|data-account|fc-|Your conversations|Send without my account/);
    expect(none).toContain('id="fb-contact"');
    expect(words(none)).toContain(CONTACT_LABEL);
    for (const line of WHERE_IT_GOES) expect(words(none)).toContain(line.replace(/\s+/g, " "));
  });

  it("is that dialog while the account's chunk has published a disconnected account", () => {
    publishFeedbackAccount({ ...ACCOUNT, connected: false });
    expect(html()).toBe(html({ account: null }));
  });
});

describe("with an account connected", () => {
  it("is Feedback, two tabs, opening on Write", () => {
    publishFeedbackAccount(ACCOUNT);
    const markup = html();
    expect(markup).toContain('<span id="feedback-title" class="modal-tool-name">Feedback</span>');
    expect(markup).toContain('data-account="true"');
    expect(markup).toMatch(/<div class="fc-tabs" role="tablist" aria-label="Feedback">/);
    expect(markup).toMatch(/<button type="button" id="fc-tab-write" class="fc-tab" role="tab" aria-selected="true" aria-controls="fc-panel-write" tabindex="0">Write<\/button>/);
    expect(markup).toMatch(/id="fc-tab-conversations" class="fc-tab" role="tab" aria-selected="false" aria-controls="fc-panel-conversations" tabindex="-1" aria-label="Your conversations, 2 unread">Your conversations<span class="fc-tab-count" aria-hidden="true">2<\/span>/);
    expect(markup).toMatch(/<div class="fc-panel" id="fc-panel-write" role="tabpanel" aria-labelledby="fc-tab-write"><div class="fb-stage">/);
    expect(markup).toMatch(/<div class="fc-panel" id="fc-panel-conversations" role="tabpanel" aria-labelledby="fc-tab-conversations" hidden="">/);
  });

  it("says who it goes as, offers the way without the account, and asks for no contact", () => {
    const markup = html({ account: ACCOUNT });
    expect(words(markup)).toContain(accountSentAs("me@example.com"));
    expect(accountSentAs("me@example.com")).toBe("Sent as me@example.com — you'll get replies here and by email");
    expect(accountSentAs(null)).toBe("Sent from your ccdeck account — you'll get replies here and by email");
    expect(markup).toMatch(/<label class="fc-anon"><input type="checkbox"\/>Send without my account<\/label>/);
    expect(markup).not.toContain('id="fb-contact"');
    for (const line of WHERE_IT_GOES_ACCOUNT) expect(words(markup)).toContain(line);
    expect(words(markup)).not.toContain(WHERE_IT_GOES[1]);
  });

  it("is today's form again with Send without my account ticked, and the draft keeps the tick", () => {
    const seed = feedbackSeed({});
    feedbackDrafts.keep(draftKey(seed), { kind: "bug", body: "The panel is empty", contact: "", images: { ready: [], waiting: [] }, anonymous: true }, seed);
    expect(feedbackDrafts.read(draftKey(seed))?.anonymous).toBe(true);
    const markup = html({ account: ACCOUNT });
    expect(markup).toMatch(/<input type="checkbox" checked=""\/>Send without my account/);
    expect(markup).toContain('id="fb-contact"');
    expect(words(markup)).not.toContain("Sent as me@example.com");
    for (const line of WHERE_IT_GOES) expect(words(markup)).toContain(line.replace(/\s+/g, " "));
  });

  it("opens on Your conversations only when asked to, and only with an account", () => {
    const on = html({ account: ACCOUNT, initialTab: "conversations" });
    expect(on).toMatch(/id="fc-tab-conversations" class="fc-tab" role="tab" aria-selected="true"/);
    expect(on).toMatch(/id="fc-panel-write" role="tabpanel" aria-labelledby="fc-tab-write" hidden=""/);
    expect(html({ account: null, initialTab: "conversations" })).toBe(html({ account: null }));
  });

  it("offers the account to the crash pane's report too, as it was when the deck went down", () => {
    const pane = (account: FeedbackAccount | null) => {
      const boundary = new ErrorBoundary({ children: null });
      boundary.state = { error: new Error("boom"), componentStack: null, reportOpen: true, account };
      return renderToStaticMarkup(boundary.render() as ReactElement);
    };
    expect(pane(ACCOUNT)).toContain('role="tablist"');
    expect(pane(null)).not.toContain('role="tablist"');
    const boundary = read("../components/ErrorBoundary.tsx");
    expect(boundary).toMatch(/return \{ error, account: readFeedbackAccount\(\) \};/);
  });
});

describe("every door but one opens on Write", () => {
  it("passes a tab only from the topbar's dotted Feedback", () => {
    const app = read("../App.tsx");
    expect(app).toMatch(/const openFeedbackConversations = useCallback\(\(\) => dialogs\.openFeedback\(\{ initialTab: "conversations" \}\), \[dialogs\.openFeedback\]\);/);
    expect(read("../components/DeckDialogs.tsx")).toMatch(/initialTab=\{feedbackPrefill\?\.initialTab\}/);
    // Nothing else names a tab: Settings › About, quick open, the rating
    // banner, the account popover and the crash pane open the form.
    const web = fileURLToPath(new URL("..", import.meta.url));
    const files = (dir: string): string[] => readdirSync(dir).flatMap(n => {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) return n === "__tests__" ? [] : files(p);
      return /\.tsx?$/.test(n) ? [p] : [];
    });
    const naming = files(web).filter(p => /initialTab: "conversations"/.test(readFileSync(p, "utf8"))).map(p => p.slice(web.length));
    expect(naming).toEqual(["App.tsx"]);
  });
});

describe("the words for how it went", () => {
  it("thanks and announces the way it was sent", () => {
    expect(sentLine(false)).toBe(SENT_LINE);
    expect(sentLine(true)).toBe(SENT_LINE_ACCOUNT);
    expect(SENT_LINE_ACCOUNT).toBe("Sent — replies will show in Your conversations and by email.");
    expect(outcomeAnnouncement("sent", true)).toBe(SENT_LINE_ACCOUNT);
    expect(outcomeAnnouncement("sent")).toBe(SENT_LINE);
  });

  it("says a limit with when to come back, and keeps the anonymous words for images and size", () => {
    const at = Date.parse("2026-10-28T12:00:00Z");
    expect(accountFailure(429, { reason: "too_many", limit: 10, retryAfterSec: 3900 }, at))
      .toMatch(/^You've reached today's limit of 10 new conversations\. You can try again at \d\d:05; your text is still here\.$/);
    expect(accountFailure(400, { reason: "invalid", errors: { images: ["Image 1 is not a PNG or a JPEG."] } }))
      .toBe("The server did not accept an image. Image 1 is not a PNG or a JPEG. Remove it and send again; your text is still here.");
    expect(accountFailure(413, { reason: "too_large" })).toMatch(/images are too large/);
    for (const reason of ["unavailable", "not_connected", "revoked", "too_many"]) {
      expect(accountFailure(502, { reason }), reason).toBe(ACCOUNT_UNAVAILABLE);
    }
    expect(accountFailure(0, null)).toBe(ACCOUNT_UNAVAILABLE);
    expect(ACCOUNT_UNAVAILABLE).toContain(SEND_WITHOUT_ACCOUNT);
  });
});
