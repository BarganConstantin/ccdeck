// The notifier that fires when there is no page to fire from.
//
// src/web/notify.ts covers a deck that is open and hidden. This covers the deck
// that is not open, which is the case the whole feature exists for — you walked
// away, four agents went quiet, and one of them has been holding a permission
// prompt since. The two are exclusive by construction: this one refuses to
// speak whenever `sseClients.size` is above zero, so it can never duplicate a
// surface a document is already drawing, and it can never arrive over a page
// somebody is looking at.
//
// Most of what is pinned here is the deck NOT speaking, and specifically not
// bursting. A desktop channel that fires twelve times in a second is one the
// user mutes inside a minute, and a muted channel is worse than an absent one
// because the deck goes on believing it told somebody. The replay gate is the
// sharpest of these: the server replays events.jsonl into itself at boot, and
// that log holds every permission prompt of the last 50MB, so without it
// starting the deck would announce the entire history of the machine at once.
import { describe, it, expect, vi } from "vitest";
import {
  blockNotice,
  createBlockNotifier,
  isPermissionPrompt,
  QUIET_MS,
  shouldNotify,
} from "../../server/block-notify.mjs";

const PROMPT = {
  hook_event_name: "Notification",
  notification_type: "permission_prompt",
  session_id: "abcdef1234",
  cwd: "/Users/me/src/vcrm-core",
  message: "Claude needs your permission to use Bash",
};

const IDLE = { ...PROMPT, notification_type: "idle_prompt" };

/** No page listening, live traffic, nothing said yet — the state in which this
 *  notifier is supposed to speak. Every test below changes one thing. */
const ALONE = { clients: 0, replay: false, lastAt: undefined, now: 10_000_000 };

describe("which events are a stopped session", () => {
  it("takes a permission prompt", () => {
    expect(isPermissionPrompt(PROMPT)).toBe(true);
  });

  it("leaves an idle prompt alone", () => {
    // #348 measured 16 idle to 5 permission on a real log. An idle prompt is a
    // turn that ended, not a session that cannot continue, and three quarters
    // noise is how this channel gets switched off.
    expect(isPermissionPrompt(IDLE)).toBe(false);
  });

  it("ignores every other hook event", () => {
    expect(isPermissionPrompt({ hook_event_name: "PreToolUse", tool_name: "Bash" })).toBe(false);
    expect(isPermissionPrompt(null)).toBe(false);
  });
});

describe("the gates", () => {
  it("speaks when nobody is listening", () => {
    expect(shouldNotify(PROMPT, ALONE)).toBe(true);
  });

  it("stays quiet while a page is connected", () => {
    // A document is a better surface than this in every way — it can be
    // clicked through to the session, it carries the tool guess, and it is
    // already showing a chip, a title, a favicon and a live region. Wherever
    // there is one, this stays out of the way.
    expect(shouldNotify(PROMPT, { ...ALONE, clients: 1 })).toBe(false);
  });

  it("stays quiet during a replay", () => {
    // The server replays its own events.jsonl at boot to rebuild the ring. That
    // log holds every permission prompt of the last 50MB, so this gate is the
    // difference between starting the deck and being shouted at by the entire
    // history of the machine.
    expect(shouldNotify(PROMPT, { ...ALONE, replay: true })).toBe(false);
  });

  it("stays quiet about a session it just announced", () => {
    expect(shouldNotify(PROMPT, { ...ALONE, lastAt: ALONE.now - 1_000 })).toBe(false);
  });

  it("speaks again once the session has been quiet long enough", () => {
    // A prompt answered inside the cooldown never needed a second notification.
    // One still standing after it is worth repeating to somebody who is, by
    // construction, not looking at any screen that says so.
    expect(shouldNotify(PROMPT, { ...ALONE, lastAt: ALONE.now - QUIET_MS - 1 })).toBe(true);
  });
});

describe("what lands on the desktop", () => {
  it("names the directory, because that is what the user calls it", () => {
    // A UUID identifies the session to the deck and to nobody else. The last
    // segment of cwd is the word the user has in their head, and a notification
    // title is the one line no platform truncates.
    expect(blockNotice(PROMPT, "ccdeck").title).toBe("vcrm-core — ccdeck");
  });

  it("falls back to a short session id when there is no cwd", () => {
    const { title } = blockNotice({ ...PROMPT, cwd: undefined }, "ccdeck");
    expect(title).toBe("abcdef12 — ccdeck");
  });

  it("quotes CC and adds nothing", () => {
    // The tab shows a guessed tool name beside the sentence; this deliberately
    // does not. That guess is the REDUCER's, derived from the newest call still
    // in flight, and nothing on the server tracks in-flight calls — rebuilding
    // it here would be a second, dimmer copy of a rule that already exists.
    expect(blockNotice(PROMPT, "ccdeck").body).toBe("Claude needs your permission to use Bash");
  });

  it("still says something when CC said nothing", () => {
    expect(blockNotice({ ...PROMPT, message: "" }, "ccdeck").body).toBe("Needs your permission");
  });
});

describe("the notifier as it runs", () => {
  function harness(over: Record<string, unknown> = {}) {
    const notify = vi.fn().mockResolvedValue(true);
    let clock = 10_000_000;
    const n = createBlockNotifier({
      notify, product: "ccdeck", now: () => clock, ...over,
    });
    return { n, notify, tick: (ms: number) => { clock += ms; } };
  }

  it("raises one notification for one prompt", () => {
    const { n, notify } = harness();
    expect(n.consider(PROMPT, { clients: 0 })).toBe("notified");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toBe("vcrm-core — ccdeck");
  });

  it("does not drum on a prompt nobody has answered", () => {
    // The same prompt can reach the server more than once — a retried hook, a
    // deck replaying somebody else's log into POST /api/event, or CC
    // re-notifying about a block still standing. The tab-side notifier dedupes
    // on `since`; there is no reducer here, so this is a cooldown instead.
    const { n, notify, tick } = harness();
    n.consider(PROMPT, { clients: 0 });
    tick(1_000);
    expect(n.consider(PROMPT, { clients: 0 })).toBe("skipped");
    tick(QUIET_MS);
    expect(n.consider(PROMPT, { clients: 0 })).toBe("notified");
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("keeps sessions apart", () => {
    // Two agents blocking at once is the case the deck was built for. A
    // cooldown that was global rather than per session would tell the user
    // about one of them and silently swallow the other.
    const { n, notify } = harness();
    n.consider(PROMPT, { clients: 0 });
    expect(n.consider({ ...PROMPT, session_id: "other", cwd: "/src/boom" }, { clients: 0 })).toBe("notified");
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("does nothing at all when switched off", () => {
    const { n, notify } = harness({ enabled: false });
    expect(n.consider(PROMPT, { clients: 0 })).toBe("off");
    expect(notify).not.toHaveBeenCalled();
  });

  it("survives a platform that cannot raise one", () => {
    // A Linux box with no notification daemon has no `notify-send`, and the
    // promise rejects. This runs on the path every hook event in the process
    // goes through, so a rejection here must reach the log and stop.
    const onError = vi.fn();
    const notify = vi.fn().mockRejectedValue(new Error("spawn notify-send ENOENT"));
    const n = createBlockNotifier({ notify, product: "ccdeck", onError });
    expect(() => n.consider(PROMPT, { clients: 0 })).not.toThrow();
    return Promise.resolve().then(() => {
      expect(onError).toHaveBeenCalled();
    });
  });
});
