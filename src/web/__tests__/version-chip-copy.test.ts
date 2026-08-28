// The version chip is the deck's manual "ask npm now" control and, since #715,
// its way into the release notes as well. It renders as a dim version number:
// everything that tells you it is a button, everything that tells you what npm
// last said, and both of the things a click does, live in the two strings these
// pin. Copy that is merely plain is the reported bug; copy that is wrong would
// be worse, and there are now four ways to get it wrong — the fourth being a
// branch that describes a dead control while the click still opens the notes.
import { describe, it, expect } from "vitest";
import { versionChipLabel, versionChipTitle } from "../version-chip";

const BASE = { running: "1.33.77" };

describe("versionChipTitle", () => {
  it("says what npm has, when it said so, and both things a click does", () => {
    const t = versionChipTitle({ ...BASE, latest: "1.34.0", checkedAgo: "12m ago" });
    expect(t).toBe("npm has v1.34.0 · checked 12m ago · re-checked periodically · click for what's new, and to check npm now");
  });

  it("names the notes before the check, because that is the order they happen in", () => {
    // The notes are inlined in this bundle and the check is a network round
    // trip: the dialog is up before the request leaves (App.tsx holds the
    // ordering itself). A tooltip promising the check first would be describing
    // the slower half as though it were the response to the click.
    const t = versionChipTitle({ ...BASE, latest: "1.34.0" });
    expect(t.indexOf("what's new")).toBeGreaterThan(-1);
    expect(t.indexOf("what's new")).toBeLessThan(t.indexOf("check npm now"));
  });

  it("does not claim a check ran when none has", () => {
    expect(versionChipTitle(BASE)).toContain("npm not reached yet");
    expect(versionChipTitle(BASE)).not.toContain("· checked ");
  });

  // The dist-tag moves before the tarball is servable, so a pending version
  // means the registry answered — the opposite of what a null `latest` alone
  // would have the chip say.
  it("distinguishes a version npm cannot serve yet from npm being unreachable", () => {
    const t = versionChipTitle({ ...BASE, latest: null, latestPending: "1.34.1", checkedAgo: "just now" });
    expect(t).toContain("v1.34.1");
    expect(t).toContain("cannot serve yet");
    expect(t).not.toContain("not reached");
  });

  it("prefers the installable version when both are known", () => {
    const t = versionChipTitle({ ...BASE, latest: "1.34.0", latestPending: "1.34.1" });
    expect(t).toContain("npm has v1.34.0");
    expect(t).not.toContain("1.34.1");
  });

  it("stops offering a check while one is in flight, and still offers the notes", () => {
    const t = versionChipTitle({ ...BASE, latest: "1.34.0", checking: true });
    expect(t).toBe("Asking npm for the newest release… · click for what's new");
    expect(t).not.toContain("check npm now");
  });

  it("explains itself rather than offering a check that cannot happen", () => {
    const t = versionChipTitle({ ...BASE, checkDisabled: true, checking: true });
    expect(t).toContain("AGENTS_DECK_NO_UPDATE_CHECK");
    expect(t).not.toContain("check npm now");
  });

  it("still says what a click does when no check will ever run (#715)", () => {
    // The branch that used to describe a chip with nothing to do. It has
    // something to do now, and the notes are the half that never needed the
    // network in the first place — so the one configuration where the check is
    // switched off is exactly the one where saying "click" is most useful.
    const t = versionChipTitle({ ...BASE, checkDisabled: true });
    expect(t).toContain("click for what's new");
  });

  it("offers the notes in every state there is", () => {
    // The claim in one sweep: no combination of registry answers, in-flight
    // checks or disabled lookups produces a tooltip that fails to mention what
    // the click always does.
    for (const c of [
      BASE,
      { ...BASE, latest: "1.34.0", checkedAgo: "12m ago" },
      { ...BASE, latestPending: "1.34.1" },
      { ...BASE, checking: true },
      { ...BASE, checkDisabled: true },
      { ...BASE, checkDisabled: true, checking: true },
    ]) {
      expect(versionChipTitle(c), JSON.stringify(c)).toContain("what's new");
    }
  });
});

describe("versionChipLabel", () => {
  it("names the version and both actions, since the button shows only the first", () => {
    const l = versionChipLabel(BASE);
    expect(l).toContain("v1.33.77");
    expect(l).toContain("show what's new");
    expect(l).toContain("check npm for a newer release");
  });

  it("announces the check in flight without dropping the notes", () => {
    const l = versionChipLabel({ ...BASE, checking: true });
    expect(l).toContain("checking npm");
    expect(l).toContain("show what's new");
  });

  it("says what the button still does when checks are off", () => {
    // It used to be `…, update checks are off` and nothing else, which named a
    // control that did nothing. Pressing it opens the notes, so the name has to
    // lead with that and leave the caveat second — a reader deciding whether to
    // press should not have to sit through "off" to find out.
    const l = versionChipLabel({ ...BASE, checkDisabled: true, checking: true });
    expect(l).toBe("Version v1.33.77, show what's new — update checks are off");
  });

  it("puts the constant half first in every state", () => {
    for (const c of [BASE, { ...BASE, checking: true }, { ...BASE, checkDisabled: true }]) {
      expect(versionChipLabel(c), JSON.stringify(c))
        .toMatch(/^Version v1\.33\.77, show what's new/);
    }
  });
});
