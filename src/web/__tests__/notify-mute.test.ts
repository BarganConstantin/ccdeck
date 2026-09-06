// The deck could be told to start notifying with one press and could not be
// told to stop at all.
//
// 3.7.0 shipped the "notify me" button beside the blocked count. There was no
// counterpart. Turning the notifications off meant going into the browser's own
// site settings and revoking the permission — which no page can do for you, and
// which does nothing about the OTHER notifier, the one the server raises when
// no page is open. That one could only be silenced by quitting the deck and
// re-running it with `AGENTS_DECK_NO_NOTIFY=1` in front. So the person who
// wanted quiet was the one being asked to work for it, while the person who
// wanted noise got a button.
//
// The switch is one setting governing both notifiers, and it is kept by the
// SERVER rather than in localStorage for a reason a test can state: the second
// notifier runs in the case where no page exists, so a preference living in a
// page could not reach the code that reads it at the moment it runs. It is also
// one answer per machine rather than one per browser profile — two browsers
// open on one deck are one deck.
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { noticesFor } from "../notify";
import type { BlockedSession } from "../ambient-counts";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-notify-mute-"));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
if (!resolve(process.env.CLAUDE_CONFIG_DIR).startsWith(resolve(DIR))) throw new Error("sandbox escaped");
afterAll(() => rmTempDir(DIR));

// @ts-expect-error — plain .mjs server module, no types
const prefs = await import("../../server/deck-prefs.mjs");
// @ts-expect-error — ditto
const { createBlockNotifier } = await import("../../server/block-notify.mjs");

const blocked = (id: string): BlockedSession => ({
  id,
  label: id,
  waiting: { kind: "asked", message: `${id} needs your input: which one?`, since: 1_000 },
});

describe("the page-side notifier", () => {
  it("raises nothing at all while the switch is off", () => {
    const notices = noticesFor([blocked("a"), blocked("b")], new Set(), false, false);
    expect(notices).toEqual([]);
  });

  it("still raises when the switch is on, so the mute is the only thing silencing it", () => {
    // The other direction, and the case that keeps this file from passing over
    // a notifier that has stopped working for an unrelated reason.
    const notices = noticesFor([blocked("a")], new Set(), false, true);
    expect(notices).toHaveLength(1);
    expect(notices[0].body).toContain("which one?");
  });

  it("defaults to on for a caller that has not heard of the switch", () => {
    // Every call site and every test written before the mute existed means "not
    // muted". A parameter that silenced them by omission would be the worst
    // possible default for this particular feature.
    expect(noticesFor([blocked("a")], new Set(), false)).toHaveLength(1);
  });

  it("does not override the rules that were already there", () => {
    // A visible page still says nothing, switch or no switch: the four in-page
    // surfaces are already saying it, and the mute is not a licence to start
    // notifying over a tab somebody is looking at.
    expect(noticesFor([blocked("a")], new Set(), true, true)).toEqual([]);
  });
});

describe("the stored preference", () => {
  beforeEach(async () => { await prefs.writePrefs({ notifications: true }); });

  it("defaults to on where no file has ever been written", async () => {
    // Every existing install upgrades into this code with no prefs.json, and
    // 3.7.0's behaviour is notifications ON. A switch that quietly turned an
    // existing feature off on upgrade is a worse surprise than the noise.
    const empty = mkdtempSync(join(DIR, "fresh-"));
    expect(existsSync(prefs.prefsPath(empty))).toBe(false);
    expect((await prefs.readPrefs(empty)).notifications).toBe(true);
  });

  it("survives a restart, which an environment variable cannot", async () => {
    await prefs.writePrefs({ notifications: false });
    // Read back off the disk rather than from the returned object: the whole
    // point is that a new process finds it.
    expect((await prefs.readPrefs()).notifications).toBe(false);
    expect(JSON.parse(readFileSync(prefs.prefsPath(), "utf8")).notifications).toBe(false);
  });

  it("keeps fields the patch did not mention", async () => {
    // A patch, not a whole-state write — the opposite of browser-watch-store's
    // contract and deliberately so. These are independent booleans, and an
    // omitted field erasing a setting would be a bug with no upside.
    await prefs.writePrefs({ notifications: false });
    await prefs.writePrefs({});
    expect((await prefs.readPrefs()).notifications).toBe(false);
  });

  it("reads a corrupt or truncated file as nothing chosen yet", async () => {
    // Not an error the user can act on mid-session. It must not fail closed
    // either: a broken file silencing the notifications would be the deck
    // deciding something the user did not.
    expect(prefs.normalise(null).notifications).toBe(true);
    expect(prefs.normalise({ notifications: "yes" }).notifications).toBe(true);
    expect(prefs.normalise({ notifications: false }).notifications).toBe(false);
  });
});

describe("what the machine is allowed to overrule", () => {
  it("lets AGENTS_DECK_NO_NOTIFY win over a stored on", () => {
    // Whoever launched the deck and whoever is at the keyboard are not always
    // the same person, and only one of them is making a claim about the
    // machine. A page posting to /api/prefs must not be able to put this deck
    // back on the desktop.
    expect(prefs.notificationsOn({ notifications: true }, { AGENTS_DECK_NO_NOTIFY: "1" })).toBe(false);
    expect(prefs.notificationsOn({ notifications: true }, {})).toBe(true);
  });

  it("does not let the variable's absence overrule a stored off", () => {
    expect(prefs.notificationsOn({ notifications: false }, {})).toBe(false);
  });

  it("says whether the MACHINE vetoed it, separately from whether it is off", () => {
    // Two different sentences for the menu, and the first spelling derived the
    // second from the first. The browser caught it in one press: switching the
    // setting off on a deck launched with no variable made the switch read
    // "off — set at launch", which is the deck telling the user their own press
    // was somebody else's doing.
    expect(prefs.notificationsVetoed({ AGENTS_DECK_NO_NOTIFY: "1" })).toBe(true);
    expect(prefs.notificationsVetoed({})).toBe(false);
    // The case that was wrong: off by choice, with no veto anywhere.
    expect(prefs.notificationsOn({ notifications: false }, {})).toBe(false);
    expect(prefs.notificationsVetoed({})).toBe(false);
  });
});

describe("the desktop notifier's switch is live", () => {
  const PROMPT = {
    hook_event_name: "Notification",
    notification_type: "agent_needs_input",
    session_id: "s1",
    cwd: "/w/paycore",
    message: "paycore needs your input: which one?",
  };

  it("is asked per event, so a mute takes effect without a restart", () => {
    // It used to be read once at construction, on the argument that a switch
    // changing under a running process is one two events can disagree about.
    // True while the only way to set it was an environment variable, which
    // cannot change under a running process — and wrong now: a mute that waits
    // for a restart is not a mute, and two events disagreeing is the CORRECT
    // behaviour when somebody pressed the switch between them.
    let on = true;
    const raised: string[] = [];
    let clock = 1_000_000;
    const notifier = createBlockNotifier({
      notify: (title: string) => { raised.push(title); },
      product: "ccdeck",
      now: () => (clock += 10 * 60_000),
      enabled: () => on,
    });

    expect(notifier.consider(PROMPT, { clients: 0 })).toBe("notified");
    on = false;
    expect(notifier.consider(PROMPT, { clients: 0 })).toBe("off");
    on = true;
    expect(notifier.consider(PROMPT, { clients: 0 })).toBe("notified");
    expect(raised).toHaveLength(2);
  });

  it("still accepts a plain boolean, which is what every other caller passes", () => {
    const notifier = createBlockNotifier({ notify: () => {}, product: "ccdeck", enabled: false });
    expect(notifier.consider(PROMPT, { clients: 0 })).toBe("off");
  });
});
