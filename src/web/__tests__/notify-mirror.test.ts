// "Notifications while closed": a closed deck standing in for its own sounds.
//
// With a tab open the deck plays a tone when a turn finishes and when Claude
// asks for something. With no tab open nothing plays — and those are exactly
// the moments somebody who walked away wanted to hear about. The notifier used
// to say permission prompts and questions only, which on a `bypassPermissions`
// machine is nearly nothing: the log that prompted this held 14 idle prompts
// against 1 permission prompt.
//
// So the server now raises a notification wherever the page would have played
// a tone. What is pinned here is that it is a MIRROR — the same events as
// sound.ts, checked against sound.ts itself — and that it keeps every gate the
// channel already had: silent while any page is listening, silent on a replay,
// and not saying one turn twice.
import { describe, it, expect, vi } from "vitest";
import {
  blockNotice,
  createBlockNotifier,
  isChimeEvent,
  QUIET_MS,
  shouldNotify,
  TURN_BODY_MAX,
  TURN_QUIET_MS,
} from "../../server/block-notify.mjs";
import { chimeFor } from "../sound";

const SID = "abcdef1234";
const CWD = "/Users/me/src/vcrm-core";
const STOP = {
  hook_event_name: "Stop",
  session_id: SID,
  cwd: CWD,
  last_assistant_message: "Done — the migration is in and the tests pass.",
};
const IDLE = {
  hook_event_name: "Notification",
  notification_type: "idle_prompt",
  session_id: SID,
  cwd: CWD,
  message: "Claude is waiting for your input",
};
const PERMISSION = { ...IDLE, notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" };
const CODEX_STOP = { hook_event_name: "Stop", session_id: "codex-1", cwd: "/Users/me/src/boom", provider: "codex" };
const ALONE = { clients: 0, replay: false, lastAt: undefined, now: 10_000_000 };

function harness(over: Record<string, unknown> = {}) {
  const notify = vi.fn().mockResolvedValue(true);
  let clock = 10_000_000;
  const n = createBlockNotifier({ notify, product: "ccdeck", now: () => clock, ...over });
  return { n, notify, tick: (ms: number) => { clock += ms; } };
}

describe("the same events as the sounds", () => {
  // The rule is written twice — sound.ts is bundled for the browser and
  // block-notify.mjs runs in bare node — so this is what keeps it one rule.
  const EVENTS = [
    STOP, CODEX_STOP, IDLE, PERMISSION,
    { ...IDLE, notification_type: "agent_needs_input" },
    { hook_event_name: "SubagentStop", session_id: SID },
    { hook_event_name: "PreToolUse", session_id: SID, tool_name: "Bash" },
    { hook_event_name: "UserPromptSubmit", session_id: SID },
    { hook_event_name: "SessionEnd", session_id: SID },
    { hook_event_name: "constructor", session_id: SID },
  ];

  it.each(EVENTS.map(e => [e.hook_event_name + ("notification_type" in e ? `/${e.notification_type}` : ""), e]))(
    "agrees with chimeFor about %s",
    (_name, raw) => {
      expect(isChimeEvent(raw)).toBe(chimeFor({ payload: raw }, false) !== null);
    },
  );
});

describe("when it speaks", () => {
  it("says a finished turn with what the agent last said", () => {
    const { n, notify } = harness();
    expect(n.consider(STOP, { clients: 0 })).toBe("notified");
    // And which tone it stands in for, so the desktop app can play that one.
    expect(notify).toHaveBeenCalledWith("vcrm-core — ccdeck", STOP.last_assistant_message, { chime: "done" });
  });

  it("says a Codex turn too, which carries no message", () => {
    expect(blockNotice(CODEX_STOP, "ccdeck")).toEqual({ title: "boom — ccdeck", body: "Finished its turn" });
  });

  it("cuts a long reply to one tray's worth, on a whole character", () => {
    const long = { ...STOP, last_assistant_message: "é".repeat(400) };
    const body = blockNotice(long, "ccdeck").body;
    expect([...body]).toHaveLength(TURN_BODY_MAX);
    expect(body.endsWith("…")).toBe(true);
  });

  it("flattens a multi-line reply", () => {
    const body = blockNotice({ ...STOP, last_assistant_message: "Done.\n\n- a\n- b" }, "ccdeck").body;
    expect(body).toBe("Done. - a - b");
  });

  it("says every turn, even two inside a minute", () => {
    // Every Stop is a different turn, and an open deck plays a tone for each.
    const { n, notify, tick } = harness();
    n.consider(STOP, { clients: 0 });
    tick(TURN_QUIET_MS);
    expect(n.consider(STOP, { clients: 0 })).toBe("notified");
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("says an idle prompt whose turn it did not already say", () => {
    // The tab was open when the turn ended and was closed since.
    const { n } = harness();
    expect(n.consider(IDLE, { clients: 0 })).toBe("notified");
  });

  it("does not let a finished turn swallow a permission prompt", () => {
    const { n, tick } = harness();
    n.consider(STOP, { clients: 0 });
    tick(1_000);
    expect(n.consider(PERMISSION, { clients: 0 })).toBe("notified");
  });
});

describe("when it keeps quiet", () => {
  it("says nothing while switched off", () => {
    const { n, notify } = harness({ enabled: false });
    expect(n.consider(STOP, { clients: 0 })).toBe("off");
    expect(notify).not.toHaveBeenCalled();
  });

  it("says nothing while a tab is open — the tab is playing the sound", () => {
    expect(shouldNotify(STOP, ALONE)).toBe(true);
    expect(shouldNotify(STOP, { ...ALONE, clients: 1 })).toBe(false);
  });

  it("says nothing on a replay, or the boot would read out the whole log", () => {
    expect(shouldNotify(STOP, { ...ALONE, replay: true })).toBe(false);
  });

  it("says one Stop once when it is delivered twice", () => {
    const { n, tick } = harness();
    n.consider(STOP, { clients: 0 });
    tick(TURN_QUIET_MS - 1);
    expect(n.consider(STOP, { clients: 0 })).toBe("skipped");
  });

  it("does not repeat a turn a minute later as an idle prompt", () => {
    // The tab plays both tones because a tone is gone in a second. A
    // notification sits in the tray, and two for one turn is drumming.
    const { n, notify, tick } = harness();
    n.consider(STOP, { clients: 0 });
    tick(60_000);
    expect(n.consider(IDLE, { clients: 0 })).toBe("skipped");
    tick(QUIET_MS);
    expect(n.consider(IDLE, { clients: 0 })).toBe("notified");
    expect(notify).toHaveBeenCalledTimes(2);
  });
});
