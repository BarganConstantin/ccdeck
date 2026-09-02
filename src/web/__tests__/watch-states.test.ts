// The states a monitoring panel is actually judged on.
//
// Each of these existed in the data with no designed form: a profile the deck
// could not read said so in a log line and nowhere else, and a machine with no
// browser open looked exactly like a quiet one.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { watchTrouble, type WatchBrowser } from "../components/BrowserWatchModal";

const browser = (over: Partial<WatchBrowser>): WatchBrowser => ({
  key: "brave", name: "Brave", installed: true, profiles: 1,
  withExtension: [], running: true,
  relay: { state: "unknown", count: 0, why: "" },
  ...over,
});
const profile = (over: Partial<{ name: string; profile: string; degraded: boolean; reason: string | null }> = {}) =>
  ({ name: "Brave", profile: "Default", degraded: false, reason: null, ...over });

describe("what the panel says when it is not simply watching", () => {
  it("says nothing at all when the ordinary case holds", () => {
    // Absent rather than green. A line that reads "everything is fine" on every
    // render is one its reader learns to skip, and then it says nothing on the
    // day it changes.
    expect(watchTrouble({ profiles: [profile()], browsers: [browser({})] })).toBeNull();
  });

  it("carries the reader's own reason when a profile cannot be read", () => {
    // "database is locked" and "no such file" are different problems with
    // different answers, and only the reader that failed knows which happened.
    // A sentence written here instead would flatten them into one.
    const t = watchTrouble({
      profiles: [profile({ degraded: true, reason: "database is locked" })],
      browsers: [browser({})],
    });
    expect(t?.kind).toBe("unreadable");
    expect(t?.text).toContain("database is locked");
    expect(t?.text).toContain("Brave/Default");
  });

  it("says the watch continues on what it can read", () => {
    // The thing somebody needs after "could not be read": whether the panel in
    // front of them is still working. It is.
    const t = watchTrouble({
      profiles: [profile({ degraded: true, reason: "no such file" }), profile({ name: "Google Chrome" })],
      browsers: [browser({})],
    });
    expect(t?.text).toContain("continues");
  });

  it("counts the rest rather than naming all of them", () => {
    const t = watchTrouble({
      profiles: [
        profile({ degraded: true, reason: "locked" }),
        profile({ degraded: true, reason: "locked" }),
        profile({ degraded: true, reason: "locked" }),
      ],
      browsers: [browser({})],
    });
    expect(t?.text).toContain("2 more");
  });

  it("distinguishes a machine with no browser open from a quiet one", () => {
    // These looked identical, and they are not: one means nothing happened, the
    // other means nothing COULD happen.
    const t = watchTrouble({ profiles: [profile()], browsers: [browser({ running: false })] });
    expect(t?.kind).toBe("none-running");
    // And it does not imply the record is gone — the history is still read.
    expect(t?.text).toContain("still");
  });

  it("tells a first-run machine what to do about it", () => {
    // Installed but never opened means no profile directory, so there is
    // nothing to read and no amount of waiting fixes it. The panel says which
    // action does.
    const t = watchTrouble({ profiles: [], browsers: [browser({ profiles: 0 })] });
    expect(t?.kind).toBe("no-profiles");
    expect(t?.text).toContain("Open one");
  });

  it("puts an unreadable profile ahead of a browser that is merely closed", () => {
    // Both are true at once on a machine that has just quit its browser. Only
    // one of them is something the reader might have to act on.
    const t = watchTrouble({
      profiles: [profile({ degraded: true, reason: "locked" })],
      browsers: [browser({ running: false })],
    });
    expect(t?.kind).toBe("unreadable");
  });
});

describe("the switch announces what it switches", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../components/BrowserWatchModal.tsx", import.meta.url)), "utf8");

  it("names itself from the label beside it, not from a label element", () => {
    // `<label htmlFor>` forwards a CLICK to a button — which is why the whole
    // label band operates this switch — but it does not NAME one: `<label>`
    // names form controls, and a button is not among them. Without this the
    // switch announced "switch, on" with no word for what it switches, which
    // on a panel that watches browsing is the worst control to leave unnamed.
    expect(source).toMatch(/aria-labelledby="bw-enabled-label"/);
    expect(source).toMatch(/id="bw-enabled-label"/);
    // Pointing at the VISIBLE text rather than repeating it, so the spoken
    // name and the printed one cannot drift apart.
    expect(source).toMatch(/<span className="bw-switch-label" id="bw-enabled-label">Watch browser activity<\/span>/);
  });

  it("keeps role and state on the control itself", () => {
    expect(source).toMatch(/role="switch"/);
    expect(source).toMatch(/aria-checked=\{snap\.settings\.enabled\}/);
  });
});
