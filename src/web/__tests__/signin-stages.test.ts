// The sign-in dialog's stage list, as rules: which four stages there are and
// in what order, which stage each server state is, where an ended sign-in
// stopped and what that stage's failure is called, when the slow-browser hint
// appears, how often the server is asked, and when the success card hands off
// and celebrates. signin-progress-dialog.test.ts drives the same rules through
// the dialog itself.
import { describe, expect, it } from "vitest";
import {
  approveHint, asSentence, celebrates, doneTitle, failedStage, HANDOFF_MS, handoffHold, importHint, liveStage,
  loginPollMs, SIGN_IN_STAGES, SLOW_BROWSER_MS, stageAnnouncement, stageDetail, stageFailureTitle, stageOfStep,
  stageRows,
} from "../signin-stages";

describe("the four stages", () => {
  it("run link → approve → confirm → save, which is the order the server passes through them", () => {
    expect(SIGN_IN_STAGES).toEqual(["link", "approve", "confirm", "save"]);
  });
});

describe("which stage a server state is", () => {
  it("is link while the start request is out or the CLI has not printed its link", () => {
    expect(liveStage({ state: null, starting: true })).toBe("link");
    expect(liveStage({ state: "awaiting_url" })).toBe("link");
  });

  it("is approve once the link is out", () => {
    expect(liveStage({ state: "awaiting_code", step: null })).toBe("approve");
  });

  it("reads registering's step: confirm, then save for both saving and switching back", () => {
    expect(liveStage({ state: "registering", step: "confirm" })).toBe("confirm");
    expect(liveStage({ state: "registering", step: "save" })).toBe("save");
    expect(liveStage({ state: "registering", step: "restore" })).toBe("save");
  });

  it("places a registering with no step, or one this build does not know, at confirm", () => {
    expect(liveStage({ state: "registering", step: null })).toBe("confirm");
    expect(liveStage({ state: "registering", step: "reticulating" })).toBe("confirm");
    expect(liveStage({ state: "registering", step: "toString" })).toBe("confirm");
    expect(stageOfStep("constructor")).toBeNull();
  });

  it("is no stage once the sign-in is over, either way", () => {
    for (const state of ["done", "failed", "idle"]) expect(liveStage({ state }), state).toBeNull();
    expect(liveStage({ state: null, starting: false })).toBeNull();
  });
});

describe("where an ended sign-in stopped", () => {
  it("is the step the server left it on, when it failed after the browser", () => {
    expect(failedStage({ state: "failed", step: "confirm", url: "https://x" })).toBe("confirm");
    expect(failedStage({ state: "failed", step: "save", url: "https://x" })).toBe("save");
    expect(failedStage({ state: "failed", step: "restore", url: "https://x" })).toBe("save");
  });

  it("is approve for a failure with a link and no step — the window ran out, or the CLI quit", () => {
    expect(failedStage({ state: "failed", step: null, url: "https://x" })).toBe("approve");
  });

  it("is link for a failure that never printed a link, and for a start the server refused", () => {
    expect(failedStage({ state: "failed", step: null, url: null })).toBe("link");
    expect(failedStage({ state: null })).toBe("link");
  });

  it("is where the dialog last saw it, for a flow the server forgot", () => {
    expect(failedStage({ state: "idle", lastLive: "approve" })).toBe("approve");
    expect(failedStage({ state: "idle", lastLive: null })).toBe("link");
  });
});

describe("the rows", () => {
  const statuses = (rows: ReturnType<typeof stageRows>) => rows.map(r => r.status);

  it("ticks everything before the live stage and leaves everything after it waiting", () => {
    const rows = stageRows({ live: "approve" });
    expect(statuses(rows)).toEqual(["done", "active", "pending", "pending"]);
    expect(rows.map(r => r.label)).toEqual([
      "Sign-in page opened",
      "Waiting for you to approve in the browser",
      "Confirm who signed in",
      "Save the credentials",
    ]);
  });

  it("names the failure on the row it happened at", () => {
    const rows = stageRows({ failed: "save", state: "failed" });
    expect(statuses(rows)).toEqual(["done", "done", "done", "failed"]);
    expect(rows[3].label).toBe("claude-swap could not save the account");
  });

  it("calls a forgotten flow ended rather than failed", () => {
    expect(stageRows({ failed: "approve", state: "idle" })[1].label).toBe("Sign-in ended");
  });

  it("ticks all four for the handoff", () => {
    const rows = stageRows({ done: true });
    expect(statuses(rows)).toEqual(["done", "done", "done", "done"]);
    expect(rows[3].label).toBe("Credentials saved");
  });

  it("gives every stage its own failure heading", () => {
    const titles = SIGN_IN_STAGES.map(s => stageFailureTitle(s, "failed"));
    expect(titles).toEqual([
      "The sign-in page did not open",
      "The sign-in did not finish in the browser",
      "The sign-in could not be confirmed",
      "claude-swap could not save the account",
    ]);
  });

  it("says under save which of its two steps is running", () => {
    expect(stageDetail("save", "save")).toBe("claude-swap is recording the account.");
    expect(stageDetail("save", "restore")).toBe("Switching this machine back to the account you were using.");
  });
});

describe("a server reason, shown as a sentence", () => {
  it("gets a capital and a full stop", () => {
    expect(asSentence("the sign-in window expired")).toBe("The sign-in window expired.");
  });

  it("keeps a lower-case product or command name as it is spelled", () => {
    expect(asSentence("claude-swap refused the import")).toBe("claude-swap refused the import.");
    expect(asSentence("cswap: could not read the credential")).toBe("cswap: could not read the credential.");
  });

  it("does not stack punctuation on a reason that already ends a sentence", () => {
    expect(asSentence("Set AGENTS_DECK_CLAUDE to its full path.")).toBe("Set AGENTS_DECK_CLAUDE to its full path.");
    expect(asSentence("Nothing to import.")).toBe("Nothing to import.");
  });

  it("says nothing for nothing", () => {
    expect(asSentence(null)).toBe("");
    expect(asSentence("   ")).toBe("");
  });
});

describe("the slow-browser hint", () => {
  const since = 1_000_000;

  it("stays quiet for the first ten seconds", () => {
    expect(approveHint({ since, now: since + SLOW_BROWSER_MS - 1, expiresAt: since + 300_000 })).toBeNull();
    expect(approveHint({ since: null, now: since + 60_000 })).toBeNull();
  });

  it("then offers the link, with the minutes the sign-in stays open", () => {
    const now = since + SLOW_BROWSER_MS;
    expect(approveHint({ since, now, expiresAt: now + 4 * 60_000 + 30_000 })).toBe(
      "Still waiting for the browser. If no tab opened, or you closed it, use the link above — the sign-in stays open 5 more minutes.");
    expect(approveHint({ since, now, expiresAt: now + 30_000 })).toMatch(/stays open 1 more minute\.$/);
  });

  it("leaves the count out when the server's clock cannot be trusted against this one", () => {
    const now = since + SLOW_BROWSER_MS;
    for (const expiresAt of [now + 20 * 60_000, now - 60_000, null]) {
      expect(approveHint({ since, now, expiresAt })).toBe(
        "Still waiting for the browser. If no tab opened, or you closed it, use the link above.");
    }
  });

  it("has an import twin that waits as long", () => {
    expect(importHint({ since, now: since + 9_999 })).toBeNull();
    expect(importHint({ since, now: since + 10_000 })).toMatch(/^Still importing\./);
  });
});

describe("asking the server", () => {
  it("asks often while registering, so a short step is seen running", () => {
    expect(loginPollMs("registering")).toBeLessThan(500);
  });

  it("asks at the old pace while the browser is up", () => {
    expect(loginPollMs("awaiting_code")).toBe(1500);
    expect(loginPollMs("awaiting_url")).toBe(1500);
  });
});

describe("the handoff into the success card", () => {
  it("holds the finished list while the ring closes, when the list was on screen", () => {
    expect(handoffHold({ fromStages: true, reducedMotion: false })).toBe(HANDOFF_MS);
  });

  it("goes straight to the card under reduced motion, and when the list was not up", () => {
    expect(handoffHold({ fromStages: true, reducedMotion: true })).toBe(0);
    expect(handoffHold({ fromStages: false, reducedMotion: false })).toBe(0);
  });

  it("throws confetti for a new account, not for a refresh, and never under reduced motion", () => {
    expect(celebrates({ added: true, reducedMotion: false })).toBe(true);
    expect(celebrates({ added: false, reducedMotion: false })).toBe(false);
    expect(celebrates({ added: true, reducedMotion: true })).toBe(false);
  });

  it("names an added account by its slot, and a refresh as one", () => {
    expect(doneTitle({ num: "3", added: true })).toBe("Account 3 added");
    expect(doneTitle({ num: null, added: true })).toBe("Account added");
    expect(doneTitle({ num: "2", added: false })).toBe("Credentials refreshed");
  });
});

describe("what a screen reader hears", () => {
  it("one sentence per stage the user did not just start themselves", () => {
    expect(stageAnnouncement("link")).toBeNull();
    expect(stageAnnouncement("approve")).toBe("Waiting for you to approve the sign-in in your browser.");
    expect(stageAnnouncement("confirm")).toBe("Approved. Confirming who signed in.");
    expect(stageAnnouncement("save")).toBe("Saving the credentials.");
    expect(stageAnnouncement(null)).toBeNull();
  });
});
