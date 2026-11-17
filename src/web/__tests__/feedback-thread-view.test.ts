// One conversation in the deck (FeedbackThread.tsx, use-feedback-conversations
// useThread): drawn as one — the person's messages on the right, the team's on
// the left with the signature once over each run, events as neutral lines in
// the API's own words, a type this deck does not know drawn the same way — the
// screenshots linked to the web only where a browser may be sent, links in what
// was written made safely; and kept as one: read posted when it is seen and only
// then, a newer team item announced, a reply refused keeping every word.
//
// The markup through react-dom/server; the hook's half is
// feedback-thread-kept.test.ts, on fake-react.ts's React.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fixture } from "./account-fake-api";
import { withoutComments } from "./tsx-scan";
import { Timeline } from "../components/FeedbackThread";

const read = (rel: string) => withoutComments(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));
const THREAD = fixture("feedback-thread.response.json");
const ID = THREAD.thread.id as string;

describe("the timeline, drawn", () => {
  const draw = (items: unknown[], webUrl = THREAD.thread.webUrl) =>
    renderToStaticMarkup(createElement(Timeline, { items: items as never, webUrl, now: Date.parse("2026-10-28T18:00:00Z") }));

  it("puts the person on the right and the team on the left, the signature once over a run", () => {
    const html = draw(THREAD.items);
    const runs = [...html.matchAll(/<div class="fc-run" data-side="(user|team)">/g)].map(m => m[1]);
    expect(runs).toEqual(["user", "team", "user"]);
    expect(html.match(/class="fc-signature"/g)).toHaveLength(1);
    expect(html).toContain('<p class="fc-signature">Constantin · ccdeck team</p>');
    // The person's runs say whose they are to a screen reader.
    expect(html.match(/<p class="vis-hidden">You<\/p>/g)).toHaveLength(2);
    // And the admin's email is nowhere: the signature is all a user is told.
    expect(html).not.toMatch(/@/);
  });

  it("draws every event as a quiet line of the API's own text, and an unknown one the same way", () => {
    const html = draw([...THREAD.items, { seq: 10, at: "2026-10-28T17:00:00Z", type: "poll", side: "team", text: "A kind of event this deck never heard of." }]);
    const events = [...html.matchAll(/<p class="fc-event" data-type="([a-z]+)">/g)].map(m => m[1]);
    expect(events).toEqual(["status", "issue", "duplicate", "status", "released", "reopened", "status", "other"]);
    expect(html).toContain("A kind of event this deck never heard of.");
    expect(html).toContain("What you asked for is in ccdeck 3.49.0.");
  });

  it("links the opening message's screenshots to the web, and only to an address a browser may be sent", () => {
    expect(draw(THREAD.items)).toContain(`<a class="fc-link fc-images" href="${THREAD.thread.webUrl}" target="_blank" rel="noopener noreferrer">1 image — view on the web</a>`);
    for (const bad of ["http://evil.example/conversations/x", "javascript:alert(1)", ""]) {
      expect(draw(THREAD.items, bad), bad).not.toContain("view on the web");
    }
  });

  it("makes the links in what was written safe ones, and leaves a script address as text", () => {
    const html = draw([
      { seq: 0, at: "2026-10-28T08:00:00Z", type: "message", side: "user", text: "See https://github.com/BarganConstantin/ccdeck/issues/123.", images: [] },
      { seq: 1, at: "2026-10-28T08:01:00Z", type: "message", side: "team", text: "javascript:alert(1) <b>no</b>", signature: "ccdeck team" },
    ]);
    expect(html).toContain('<a class="fc-link" href="https://github.com/BarganConstantin/ccdeck/issues/123" rel="noopener noreferrer nofollow ugc" target="_blank">https://github.com/BarganConstantin/ccdeck/issues/123</a>.');
    expect(html).toContain("javascript:alert(1) &lt;b&gt;no&lt;/b&gt;");
    expect(read("../components/FeedbackThread.tsx")).not.toMatch(/dangerouslySetInnerHTML/);
  });

  it("puts a divider before each day", () => {
    const html = draw(THREAD.items);
    expect(html.match(/<p class="fc-day"><span>Today<\/span><\/p>/g)).toHaveLength(1);
  });
});

describe("the composer", () => {
  const src = read("../components/FeedbackThread.tsx");

  it("is never greyed out: busy while a reply is out, and the hook refuses a second press (#518)", () => {
    expect(src).toMatch(/<button type="submit" className="btn primary fc-send" aria-keyshortcuts="Meta\+Enter Control\+Enter" \{\.\.\.selfPressProps\(t\.sending\)\}>/);
    expect(src).not.toMatch(/disabled=\{/);
    expect(read("../use-feedback-conversations.ts")).toMatch(/if \(!selfPressAccepted\(sendingRef\.current\)\) return false;/);
  });

  it("sends with ⌘/Ctrl+Enter, and takes the caret when a thread opens", () => {
    expect(src).toMatch(/if \(!isSendShortcut\(e\.nativeEvent\)\) return;/);
    expect(src).toMatch(/useEffect\(\(\) => \{ composerRef\.current\?\.focus\(\); \}, \[\]\);/);
    expect(src).toMatch(/maxLength=\{BODY_MAX\}/);
  });
});

