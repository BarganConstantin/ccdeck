// The rules that decide whether the deck is allowed to interrupt you.
//
// A system notification is the only surface the deck has that leaves the page,
// and it is also the only one the operating system will take away if it is
// abused: a channel that fires on things the user did not want gets muted, and
// a muted channel is worse than one that was never built, because the deck goes
// on believing it told somebody. So most of what is pinned here is the deck
// keeping quiet — the three gates in `noticesFor`, and the two directions of
// the dedupe key.
//
// The key is the part worth reading twice. It carries `since`, and that single
// choice answers both failures at once: the same block delivered five times by
// five decks sharing events.jsonl raises ONE notification, and a session that
// blocks again after you answered raises a SECOND one. Keyed on the session
// alone the deck would tell you about the first prompt of the session and go
// quiet for the rest of the day; keyed on the delivery it would tell you five
// times about one.
//
// Pure and DOM-free, the way block-announce.test.ts is: these call exactly the
// functions App.tsx calls, so the rule cannot drift from the rule that ships.
import { describe, it, expect } from "vitest";
import { blockKey, canAsk, nextRaised, noticeBody, noticesFor, seedRaised, shouldReseed } from "../notify";
import type { BlockedSession } from "../ambient-counts";
import type { WaitingBlock } from "../types";

const HIDDEN = false;
const VISIBLE = true;

function block(over: Partial<WaitingBlock> = {}): WaitingBlock {
  return { kind: "permission", message: "Claude needs your permission", since: 1_000, ...over };
}

function session(id: string, over: Partial<WaitingBlock> = {}, label = id): BlockedSession {
  return { id, label, waiting: block(over) };
}

describe("when the deck stays quiet", () => {
  it("says nothing while the page is visible", () => {
    // The chip, the tab title, the favicon and the chime are all already
    // carrying this. A notification over a page you are looking at is a thing
    // to dismiss, not a thing to learn.
    expect(noticesFor([session("s1")], new Set(), VISIBLE)).toEqual([]);
  });

  it("says nothing about an idle prompt", () => {
    // #348: a finished turn is not a stopped session, and it fires three times
    // as often. Counting both would put three quarters noise into the one
    // channel the OS lets the user switch off.
    expect(noticesFor([session("s1", { kind: "idle" })], new Set(), HIDDEN)).toEqual([]);
  });

  it("says nothing twice about one block", () => {
    const s = session("s1");
    const first = noticesFor([s], new Set(), HIDDEN);
    expect(first).toHaveLength(1);
    const raised = nextRaised([s], first, new Set());
    // The second frame, and the fifth delivery of the same notification from
    // the four other decks sharing the log, all land here.
    expect(noticesFor([s], raised, HIDDEN)).toEqual([]);
  });

  it("says nothing about blocks that were already standing when it started", () => {
    // A tab restored into the background by a session-restoring browser is the
    // case the visibility gate does not cover: hidden, and full of prompts from
    // before the reboot. Four notifications about lunchtime is how a user turns
    // the feature off in the first ten minutes.
    const standing = [session("s1"), session("s2")];
    expect(noticesFor(standing, seedRaised(standing), HIDDEN)).toEqual([]);
  });
});

describe("when it speaks", () => {
  it("raises one per blocked session, hidden and unseen", () => {
    const notices = noticesFor([session("s1"), session("s2")], new Set(), HIDDEN);
    expect(notices.map(n => n.sessionId)).toEqual(["s1", "s2"]);
  });

  it("puts the session name where nothing can clip it", () => {
    // Every platform truncates the body, and macOS collapses it to one line
    // when the tray is busy. The question is WHICH agent, so the answer goes in
    // the title.
    const [n] = noticesFor([session("s1", {}, "vcrm-core")], new Set(), HIDDEN);
    expect(n.title).toBe("vcrm-core");
  });

  it("speaks again when the same session blocks a second time", () => {
    // Answer the prompt, the session runs on, the next tool call blocks too.
    // That is news, and the only thing separating it from a duplicate delivery
    // is `since`.
    const first = session("s1", { since: 1_000 });
    const raised = nextRaised([first], noticesFor([first], new Set(), HIDDEN), new Set());
    const again = session("s1", { since: 9_000 });
    expect(noticesFor([again], raised, HIDDEN)).toHaveLength(1);
  });
});

describe("the body", () => {
  it("quotes CC and hedges the deck", () => {
    // Two claims of different strength, kept on different lines. The sentence
    // is what CC said; the tool is what the deck inferred from where the
    // notification sat in the stream, and it is wrong sometimes.
    const body = noticeBody(block({ tool: { name: "Bash", preview: "rm -rf node_modules" } }));
    expect(body).toBe("Claude needs your permission\nLikely on: Bash · rm -rf node_modules");
  });

  it("never blends the guess into the quotation", () => {
    // The failure this prevents: "Needs permission for rm -rf node_modules"
    // reads as something CC said. It is not, and this is the notification
    // somebody reads while deciding whether to approve that command.
    const body = noticeBody(block({ tool: { name: "Bash", preview: "rm -rf node_modules" } }));
    expect(body).toContain("Likely on:");
  });

  it("says only what CC said when there is no guess", () => {
    expect(noticeBody(block())).toBe("Claude needs your permission");
  });

  it("still says something when CC said nothing", () => {
    // An older log line, or a re-wording upstream. A notification with an empty
    // body is a notification that wasted an interruption.
    expect(noticeBody(block({ message: "" }))).toBe("Needs your permission");
  });
});

describe("the memo the caller carries", () => {
  it("forgets blocks that are no longer standing", () => {
    // Without this the set grows for the life of a tab that is expected to stay
    // open for days. Safe because the key carries `since`: a block that cleared
    // and came back is a different key, so forgetting cannot cause a repeat.
    const s = session("s1");
    const raised = nextRaised([s], noticesFor([s], new Set(), HIDDEN), new Set());
    expect(raised.has(blockKey("s1", s.waiting))).toBe(true);
    expect(nextRaised([], [], raised).size).toBe(0);
  });

  it("keeps a standing block's key across a frame that raised nothing", () => {
    const s = session("s1");
    const raised = nextRaised([s], noticesFor([s], new Set(), HIDDEN), new Set());
    expect(nextRaised([s], [], raised)).toEqual(raised);
  });
});

describe("when the notifier starts watching", () => {
  it("seeds on mount, whatever the answer is", () => {
    // Four prompts already standing when the deck opens must not become four
    // notifications about lunchtime.
    expect(shouldReseed(null, "default")).toBe(true);
    expect(shouldReseed(null, "granted")).toBe(true);
    expect(shouldReseed(null, "denied")).toBe(true);
  });

  it("seeds again the moment the user allows", () => {
    // THE BUG THIS EXISTS FOR. Seeding used to sit behind the `granted` check,
    // so on the ordinary path — open the deck, see a session blocked, press the
    // button, allow — the seed had not run when permission arrived, and the
    // NEXT block was adopted as history rather than announced. The first
    // notification after a user asked to be notified was silence. They press
    // the button, get nothing, and conclude it is broken.
    expect(shouldReseed("default", "granted")).toBe(true);
  });

  it("does not re-seed while the answer stands", () => {
    // Re-seeding on every frame would adopt every new block as history and the
    // deck would never say anything at all — the same silence, permanently.
    expect(shouldReseed("granted", "granted")).toBe(false);
    expect(shouldReseed("default", "default")).toBe(false);
  });

  it("seeds on a refusal too, so a later change of mind is not a burst", () => {
    // Permission can be revoked and re-granted from the browser's own site
    // settings, with the page open the whole time.
    expect(shouldReseed("granted", "denied")).toBe(true);
    expect(shouldReseed("denied", "granted")).toBe(true);
  });
});

describe("what the button is allowed to offer", () => {
  it("offers to ask only when the browser has not been asked", () => {
    expect(canAsk("default", true)).toBe(true);
  });

  it("does not offer once granted", () => {
    expect(canAsk("granted", true)).toBe(false);
  });

  it("does not offer after a refusal", () => {
    // `requestPermission()` resolves "denied" again without showing anything,
    // so a button that kept offering would silently do nothing — the exact
    // failure browser-react.mjs refuses to ship for its own reactions.
    expect(canAsk("denied", true)).toBe(false);
  });

  it("does not offer where the API is absent", () => {
    expect(canAsk("default", false)).toBe(false);
  });
});
