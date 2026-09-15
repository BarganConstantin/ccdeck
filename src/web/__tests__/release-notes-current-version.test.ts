// THE RELEASE THAT SHIPS EITHER HAS AN ENTRY, OR SAYS IN WRITING THAT IT HAS
// NOTHING TO SAY.
//
// WHAT WAS OBSERVED (#963): package.json read 3.22.15 and the newest key in
// release-notes.json was 3.22.10. Five tagged releases — 3.22.11, .12, .13,
// .14, .15 — went out with no entry between them, and the suite stayed green
// the whole way, because every other assertion about this file is about the
// entries that ARE in it. Nothing anywhere asked whether the release being
// published had one.
//
// The feature exists to say what changed, and across those five releases it had
// three different ways of saying nothing. A reader got whichever one their own
// history put them in:
//
//   fresh install on 3.22.15    decideReleaseNotes takes the `!isVersion(stored)`
//                               branch and asks notesForVersion for an EXACT
//                               match on 3.22.15. Empty, so reason "first-run"
//                               — #717's welcome dialog fired for nobody who
//                               installed 3.22.11 through 3.22.15.
//   upgrade from ≤ 3.22.9       notesBetween reached back and found 3.22.10, so
//                               the modal opened and presented THAT as what is
//                               new in the update to 3.22.15 — five releases
//                               behind what the reader had just installed.
//   upgrade from 3.22.10–.14    notesBetween empty, reason "nothing-new".
//
// It survived because the file's own convention invites it. "No key at all" is
// the correct spelling of "this release has nothing to say", which is most
// releases — so by reading the file there is no way to tell a decision from a
// dropped step, and the release process dropping the step looks exactly like
// five quiet releases in a row.
//
// That ambiguity is what this closes, rather than the five missing entries,
// which are data and can go missing again. A deliberate silence is now spelled
// a SECOND time — the version written into the file's "//nothing-to-say" list,
// an act somebody has to perform — and a shipping release in neither place
// fails here instead of shipping a modal that says nothing.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  compareVersions,
  decideReleaseNotes,
  isVersion,
  RELEASE_NOTES,
  type VersionNotes,
} from "../release-notes";

const at = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const raw = JSON.parse(readFileSync(at("../../../release-notes.json"), "utf8")) as Record<string, unknown>;
const pkg = JSON.parse(readFileSync(at("../../../package.json"), "utf8")) as { version: string };

/** The versions whose author wrote down that they have nothing to say. */
const SILENT = (raw["//nothing-to-say"] ?? []) as string[];
/** The versions that have something to say, as the deck itself reads them. */
const WITH_NOTES = RELEASE_NOTES.map(v => v.version);

type Verdict = "has-notes" | "deliberately-silent" | "unaccounted" | "said-both";

/** The rule as a function, so the cases below exercise it rather than restate
 *  it, and so the two ways of failing it can be named.
 *
 *  Both spellings at once is its own verdict and not a pass: an author who
 *  wrote an entry AND listed the version as silent has said two things about
 *  one release, and which of them they meant is not for a test to guess. */
const verdictFor = (
  version: string,
  withNotes: readonly string[],
  silent: readonly string[],
): Verdict => {
  const noted = withNotes.includes(version);
  const quiet = silent.includes(version);
  if (noted && quiet) return "said-both";
  if (noted) return "has-notes";
  if (quiet) return "deliberately-silent";
  return "unaccounted";
};

describe("the version package.json is shipping", () => {
  it("has been accounted for, one way or the other", () => {
    // The whole guard, in one line. It fires at the release gate, which is the
    // one moment somebody is looking at this file anyway.
    expect(
      ["has-notes", "deliberately-silent"],
      `release-notes.json says nothing about ${pkg.version}. Either add an entry `
      + `for it, or — if this release genuinely has nothing a user would notice `
      + `— add "${pkg.version}" to the file's "//nothing-to-say" list.`,
    ).toContain(verdictFor(pkg.version, WITH_NOTES, SILENT));
  });

  it("catches the release that was simply forgotten", () => {
    // Not a hypothetical: these are the arguments the file actually presented
    // on the day #963 was filed, and the rule has to answer them the way the
    // reader experienced them.
    expect(verdictFor("3.22.15", ["3.22.10", "3.21.0"], [])).toBe("unaccounted");
    expect(verdictFor("3.22.11", ["3.22.10", "3.21.0"], [])).toBe("unaccounted");
  });

  it("lets a release say, in writing, that it has nothing to say", () => {
    // The half that keeps the convention alive. Most releases are invisible to
    // a user and a modal that opens for them is the thing that teaches people
    // to dismiss modals — so the guard must not make an entry compulsory, only
    // a decision.
    expect(verdictFor("4.0.1", ["4.0.0"], ["4.0.1"])).toBe("deliberately-silent");
  });

  it("refuses an author who has said both", () => {
    expect(verdictFor("4.0.1", ["4.0.1"], ["4.0.1"])).toBe("said-both");
  });
});

describe("the opt-out list", () => {
  it("is a list, of versions, and nothing else", () => {
    // It is hand-edited under the same time pressure as the rest of the file.
    // A version misspelled here silences nothing and excuses nothing — the
    // guard above would still fail, but on a release the author believes they
    // already dealt with, which is the worst moment to be cryptic.
    expect(Array.isArray(raw["//nothing-to-say"])).toBe(true);
    expect(SILENT.filter(v => !isVersion(v))).toEqual([]);
  });

  it("names no version that also has an entry", () => {
    expect(SILENT.filter(v => WITH_NOTES.includes(v))).toEqual([]);
  });

  it("names no version the package has not reached", () => {
    // Through compareVersions, for the reason release-notes-file.test.ts spells
    // out at its own version check: "3.9.0" > "3.10.0" is true as strings.
    const ahead = SILENT.filter(v => compareVersions(v, pkg.version) > 0);
    expect(ahead, `ahead of package.json ${pkg.version}`).toEqual([]);
  });

  it("is a note to the author, and never reaches the deck as a release", () => {
    // readNotes drops it for the same reason it drops the "//" block: it is not
    // a version. Worth pinning, because the modal rendering a key called
    // "//nothing-to-say" would be a comment shown to a user.
    expect(isVersion("//nothing-to-say")).toBe(false);
    expect(WITH_NOTES).not.toContain("//nothing-to-say");
  });
});

describe("the three silences, reproduced", () => {
  // The file exactly as it stood: one entry, five releases back.
  const OBSERVED: VersionNotes[] = [{
    version: "3.22.10",
    notes: [{
      title: "🧩 Sessions spread across the canvas",
      body: "Sessions now spread across the canvas in columns instead of one tall column.",
    }],
  }];
  const RUNNING = "3.22.15";

  it("showed a fresh install nothing at all", () => {
    const d = decideReleaseNotes({ stored: null, running: RUNNING, notes: OBSERVED });
    expect(d.reason).toBe("first-run");
    expect(d.show).toEqual([]);
  });

  it("showed an upgrade from 3.22.9 the 3.22.10 notes as what was new", () => {
    // The loudest of the three, and the only one that opened a window: the
    // reader is told what is new in the version they installed, and is shown a
    // release five behind it under that heading.
    const d = decideReleaseNotes({ stored: "3.22.9", running: RUNNING, notes: OBSERVED });
    expect(d.reason).toBe("new-notes");
    expect(d.show.map(v => v.version)).toEqual(["3.22.10"]);
  });

  it("showed an upgrade from 3.22.14 nothing", () => {
    const d = decideReleaseNotes({ stored: "3.22.14", running: RUNNING, notes: OBSERVED });
    expect(d.reason).toBe("nothing-new");
    expect(d.show).toEqual([]);
  });

  it("gives all three the shipping release once its entry exists", () => {
    const filled: VersionNotes[] = [
      { version: RUNNING, notes: [{ title: "🖱️ Clicking a card opens its details", body: "Selecting an agent is inspecting it." }] },
      ...OBSERVED,
    ];
    expect(decideReleaseNotes({ stored: null, running: RUNNING, notes: filled }).reason).toBe("welcome");
    expect(decideReleaseNotes({ stored: "3.22.14", running: RUNNING, notes: filled }).reason).toBe("new-notes");
    // And the upgrader from far back now leads with what they just installed,
    // rather than with the newest thing that happened to have an entry.
    const far = decideReleaseNotes({ stored: "3.22.9", running: RUNNING, notes: filled });
    expect(far.show.map(v => v.version)).toEqual([RUNNING, "3.22.10"]);
  });
});

describe("the file as it stands, through the decision the deck makes", () => {
  // The cases above are about the rule; these are about this repository on the
  // day the suite runs, which is what a reader of the published package gets.
  const silentOnPurpose = SILENT.includes(pkg.version);

  it("does not leave a fresh install of the shipping version guessing", () => {
    const d = decideReleaseNotes({ stored: null, running: pkg.version, notes: RELEASE_NOTES });
    if (silentOnPurpose) {
      // Quiet, and quiet on purpose — which is the branch the list exists to
      // make legible.
      expect(d.reason).toBe("first-run");
    } else {
      expect(d.reason).toBe("welcome");
      expect(d.show.map(v => v.version)).toEqual([pkg.version]);
    }
  });

  it("leads an upgrader's modal with the release they just took", () => {
    const d = decideReleaseNotes({ stored: "1.0.0", running: pkg.version, notes: RELEASE_NOTES });
    expect(d.show.length).toBeGreaterThan(0);
    if (!silentOnPurpose) expect(d.show[0].version).toBe(pkg.version);
    // Whatever it leads with, it must not be older than the newest entry the
    // build knows about — that is the shape of the 3.22.10-under-3.22.15 bug.
    expect(compareVersions(d.show[0].version, WITH_NOTES[0])).toBe(0);
  });
});
