// The page's errors reach the deck's own server only while reports are on, and
// only a few of them: once each, ten a page, never the browser's own noise
// (#1853). The server decides again whether anything leaves the machine.
import { describe, it, expect } from "vitest";
import { forwardPageErrors } from "../report-errors";
import { feedbackFailure } from "../feedback";

function page() {
  const listeners = new Map<string, (event: any) => void>();
  return {
    addEventListener: (type: string, fn: (event: any) => void) => listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
    fire: (type: string, event: unknown) => listeners.get(type)?.(event),
    listening: () => listeners.size,
  };
}

describe("errors the page caught", () => {
  it("go to the deck's server only while reports are on", () => {
    const target = page();
    const sent: { message: string; stack?: string }[] = [];
    // Off is also what the page holds until it has read /api/prefs: reports are
    // on by default, but a page that has not asked yet cannot know that nobody
    // switched them off (use-reports.ts).
    let on = false;
    forwardPageErrors(() => on, target, body => sent.push(body));

    target.fire("error", { error: new Error("before the page knew") });
    on = true;
    const error = new Error("Cannot read properties of undefined (reading 'agents')");
    target.fire("error", { error });

    expect(sent).toEqual([{ message: error.message, stack: error.stack }]);
  });

  it("carry a rejected promise's reason too", () => {
    const target = page();
    const sent: { message: string }[] = [];
    forwardPageErrors(() => true, target, body => sent.push(body));

    target.fire("unhandledrejection", { reason: new Error("fetch failed") });
    target.fire("unhandledrejection", { reason: "plain string" });

    expect(sent.map(s => s.message)).toEqual(["fetch failed", "plain string"]);
  });

  it("send each message once, ten a page, and never the browser's noise", () => {
    const target = page();
    const sent: { message: string }[] = [];
    forwardPageErrors(() => true, target, body => sent.push(body));

    target.fire("error", { message: "ResizeObserver loop completed with undelivered notifications." });
    target.fire("error", { message: "Script error." });
    target.fire("error", { error: new Error("same") });
    target.fire("error", { error: new Error("same") });
    for (let i = 0; i < 20; i++) target.fire("error", { error: new Error(`other ${i}`) });

    expect(sent.length).toBe(10);
    expect(sent[0].message).toBe("same");
  });

  it("stops listening when the page is done with it", () => {
    const target = page();
    const stop = forwardPageErrors(() => true, target, () => {});
    expect(target.listening()).toBe(2);
    stop();
    expect(target.listening()).toBe(0);
  });
});

describe("what a failed feedback send says", () => {
  it("names the launch-time veto, the hourly limit, a refusal and an unreachable server", () => {
    expect(feedbackFailure(403, "vetoed")).toContain("AGENTS_DECK_NO_INSTALL=1");
    expect(feedbackFailure(429, "too_many")).toContain("your text is still here");
    // It said "the title or the text" while a title could be typed. The title
    // is worked out from the message now, so a refusal names the message.
    expect(feedbackFailure(400, "invalid")).toContain("did not accept the message");
    expect(feedbackFailure(0, null)).toContain("could not be reached");
  });
});
