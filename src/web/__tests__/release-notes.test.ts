// #712. The deck now says what changed after an upgrade, and the interesting
// half of that feature is every case in which it says nothing.
//
// Four ways to build it wrong, and one case each below:
//
//   A fresh install is told the whole history. "Nothing stored" and "show
//   everything" are the same null, and the wrong reading of it greets a new
//   user with a changelog for software they have never run.
//
//   Versions are compared as strings. "1.10.0" < "1.9.0" is true of text and
//   false of releases, so a deck on 1.10 would show 1.9's notes and then never
//   show anything again.
//
//   A stored version NEWER than the running one replays history. A downgrade,
//   an `npx ccdeck@1.40` for a bisect, or one browser profile pointed at two
//   machines — all of which must be silent, and none of which must drag the
//   marker back down.
//
//   The store throws instead of answering. A blocked profile then looks like a
//   first run on every single load, and a modal that reappears forever is worse
//   than one that never appears at all.
//
// Plain node, no DOM: the whole decision is a pure function over three values,
// which is the reason it is a module and not a hook.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  compareVersions,
  releaseNotesIntro,
  versionRangeLabel,
  decideReleaseNotes,
  isVersion,
  notesBetween,
  readNotes,
  readSeen,
  RELEASE_NOTES,
  RELEASE_NOTES_SEEN_KEY,
  writeSeen,
  type VersionNotes,
} from "../release-notes";
// The repo's other comparator, and the reason this one is allowed to exist:
// self-update.mjs opens with node:fs and node:child_process, so the browser
// bundle cannot import it. Held against this one below so the two cannot drift.
import { isOlder } from "../../server/self-update.mjs";
import { whatsNewLabel, whatsNewTitle } from "../version-chip";

const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** The same text with its comments gone — the only form an "appears nowhere"
 *  assertion may read, for the reason duplicated-helpers.test.ts gives: this
 *  repo's prose names the thing it is explaining, so a search over raw source
 *  finds the paragraph saying where a decision lives and calls it the decision. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");
}

const note = (title: string) => ({ title, body: `${title}, at length.` });

/** A file with something to say in three of its releases. */
const NOTES: VersionNotes[] = [
  { version: "1.48.0", notes: [note("c")] },
  { version: "1.45.0", notes: [note("b")] },
  { version: "1.43.0", notes: [note("a")] },
];

const shown = (d: { show: VersionNotes[] }) => d.show.map(v => v.version);

describe("comparing two versions", () => {
  it("orders by number and not by text, which is the whole trap", () => {
    // Every one of these is the wrong way round under a string comparison.
    expect(compareVersions("1.9.0", "1.10.0")).toBeLessThan(0);
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.9.0", "1.100.0")).toBeLessThan(0);
    expect(compareVersions("2.0.0", "10.0.0")).toBeLessThan(0);
    // …and the proof that the trap is real, so the assertions above are not
    // merely restating what `<` would have done anyway.
    expect("1.9.0" < "1.10.0").toBe(false);
  });

  it("reads a missing trailing segment as zero", () => {
    expect(compareVersions("1.30", "1.30.0")).toBe(0);
    expect(compareVersions("1.30", "1.30.1")).toBeLessThan(0);
    expect(compareVersions("1.45.0", "1.45.0")).toBe(0);
  });

  it("treats a prerelease as its release, the way the server's copy does", () => {
    // Not an opinion about semver: it is what self-update.mjs has always done,
    // and it is right here — a prerelease of 1.46.0 carries 1.46.0's notes.
    expect(compareVersions("1.46.0-rc1", "1.46.0")).toBe(0);
    expect(compareVersions("1.46.0-rc.2", "1.46.0-rc.1")).toBeGreaterThan(0);
    // A build tag whose parts are numbers reads as extra segments and therefore
    // as NEWER. Pinned as the inherited behaviour rather than as a design: this
    // repo has never published one, and the release it would be attached to is
    // the one whose notes the user would see either way.
    expect(compareVersions("1.46.0+build.7", "1.46.0")).toBeGreaterThan(0);
  });

  it("answers the same as the server's isOlder on every pair it can be asked", () => {
    const parts = ["0", "1", "2", "9", "10", "30", "99", "100"];
    const versions: string[] = [];
    for (const a of parts) for (const b of parts) for (const c of parts) versions.push(`${a}.${b}.${c}`);
    versions.push("1.30", "1.9", "2", "0.1.2-beta.1", "1.0.0+build.7", "1.0.0-rc1", "", "0.9.11", "0.10.0");
    const moved: Array<[string, string]> = [];
    for (const a of versions) for (const b of versions) {
      if ((compareVersions(a, b) < 0) !== isOlder(a, b)) moved.push([a, b]);
    }
    expect(moved).toEqual([]);
  });

  it("is written here rather than imported, and the file says why", () => {
    // A second comparator is a thing this repo has a test against
    // (duplicated-helpers.test.ts), so the exception is on the record: the
    // reason is stated in the source, and the equivalence above is what keeps
    // the exception honest.
    expect(src("../release-notes.ts")).toMatch(/self-update\.mjs/);
    expect(src("../release-notes.ts")).toMatch(/node:fs/);
  });
});

describe("what counts as a version at all", () => {
  it("refuses the strings a junk marker is actually made of", () => {
    // "" is the one that matters: it is what getItem answers for a key some
    // other code wrote empty, and it compares OLDER than every release — so
    // reading it as a version replays the entire history on a profile that has
    // seen all of it.
    for (const v of ["", " ", "yes", "1", "1.45", "v1.45.0", null, undefined, 145, {}]) {
      expect(isVersion(v), JSON.stringify(v)).toBe(false);
    }
  });

  it("accepts what package.json actually spells", () => {
    for (const v of ["1.45.0", "0.0.1", "1.46.0-rc.1", "10.0.100"]) {
      expect(isVersion(v), v).toBe(true);
    }
  });
});

describe("a deck that has never run here", () => {
  it("shows nothing and records the version it is running", () => {
    const d = decideReleaseNotes({ stored: null, running: "1.45.0", notes: NOTES });
    expect(d.reason).toBe("first-run");
    expect(d.show).toEqual([]);
    expect(d.record).toBe("1.45.0");
  });

  it("is a different event from having seen these already", () => {
    // Both show nothing, and conflating them is how the marker either never
    // gets written or gets written when it must not be.
    const first = decideReleaseNotes({ stored: null, running: "1.45.0", notes: NOTES });
    const seen = decideReleaseNotes({ stored: "1.45.0", running: "1.45.0", notes: NOTES });
    expect(seen.reason).toBe("seen");
    expect(seen.record).toBeNull();
    expect(first.record).not.toBeNull();
  });

  it("stays silent on a first run even when the file is full of notes", () => {
    // The failure this whole branch exists to prevent, stated as a case: a
    // brand-new install on the newest release, with three releases' worth of
    // notes sitting in the package.
    const d = decideReleaseNotes({ stored: null, running: "1.48.0", notes: NOTES });
    expect(d.show).toEqual([]);
  });

  it("treats an unreadable or junk marker as a first run, not as very old", () => {
    for (const stored of ["", "  ", "null", "undefined", "1.45"]) {
      const d = decideReleaseNotes({ stored, running: "1.48.0", notes: NOTES });
      expect(d.reason, JSON.stringify(stored)).toBe("first-run");
      expect(d.show, JSON.stringify(stored)).toEqual([]);
    }
  });
});

describe("a deck that has been upgraded", () => {
  it("collects every release the user skipped into one appearance", () => {
    const d = decideReleaseNotes({ stored: "1.42.0", running: "1.48.0", notes: NOTES });
    expect(d.reason).toBe("new-notes");
    expect(shown(d)).toEqual(["1.48.0", "1.45.0", "1.43.0"]);
    expect(d.record).toBe("1.48.0");
  });

  it("includes the release it is running and excludes the one already seen", () => {
    // The two ends of the range, and both are load-bearing. Exclusive at the
    // bottom or the same notes come back every upgrade; inclusive at the top or
    // the notes for the release you just took are the ones you never see.
    const d = decideReleaseNotes({ stored: "1.45.0", running: "1.48.0", notes: NOTES });
    expect(shown(d)).toEqual(["1.48.0"]);
    const later = decideReleaseNotes({ stored: "1.48.0", running: "1.48.0", notes: NOTES });
    expect(shown(later)).toEqual([]);
  });

  it("records the new version even when the releases in between said nothing", () => {
    // The normal release, and the reason the modal is worth reading at all.
    const d = decideReleaseNotes({ stored: "1.45.0", running: "1.47.0", notes: NOTES });
    expect(d.reason).toBe("nothing-new");
    expect(d.show).toEqual([]);
    expect(d.record).toBe("1.47.0");
  });

  it("orders a run of releases newest first", () => {
    const jumbled: VersionNotes[] = [
      { version: "1.43.0", notes: [note("a")] },
      { version: "1.48.0", notes: [note("c")] },
      { version: "1.45.0", notes: [note("b")] },
    ];
    const d = decideReleaseNotes({ stored: "1.42.0", running: "1.48.0", notes: readNotes(
      Object.fromEntries(jumbled.map(v => [v.version, v.notes])),
    ) });
    expect(shown(d)).toEqual(["1.48.0", "1.45.0", "1.43.0"]);
  });

  it("does not show a release newer than the one running", () => {
    // dist/web on disk can be newer than the process serving it, and a note
    // about behaviour that is not live yet is a note about nothing.
    const d = decideReleaseNotes({ stored: "1.42.0", running: "1.45.0", notes: NOTES });
    expect(shown(d)).toEqual(["1.45.0", "1.43.0"]);
  });
});

describe("a stored version newer than the running one", () => {
  it("shows nothing rather than replaying history", () => {
    const d = decideReleaseNotes({ stored: "1.48.0", running: "1.45.0", notes: NOTES });
    expect(d.reason).toBe("ahead");
    expect(d.show).toEqual([]);
  });

  it("leaves the marker where it is, so the newer deck stays quiet too", () => {
    // The half a `Math.min`-shaped implementation gets wrong. Dropping the
    // marker to 1.45.0 here would replay 1.46 through 1.48 the next time the
    // same profile opened the newer deck.
    const d = decideReleaseNotes({ stored: "1.48.0", running: "1.45.0", notes: NOTES });
    expect(d.record).toBeNull();
  });

  it("does not throw on any pair of versions it could be handed", () => {
    for (const stored of ["1.48.0", "0.0.1", "99.99.99", "1.45.0-rc1"]) {
      for (const running of ["1.45.0", "2.0.0", "1.45.0"]) {
        expect(() => decideReleaseNotes({ stored, running, notes: NOTES })).not.toThrow();
      }
    }
  });
});

describe("a deck that does not know what it is running", () => {
  it("shows nothing and writes nothing until /api/version answers", () => {
    for (const running of [null, "", "unknown"]) {
      const d = decideReleaseNotes({ stored: "1.42.0", running, notes: NOTES });
      expect(d.reason, JSON.stringify(running)).toBe("no-version");
      expect(d.show).toEqual([]);
      // Writing here would record a version the deck cannot name, and the next
      // real answer would be compared against it.
      expect(d.record).toBeNull();
    }
  });
});

describe("everything up to the running version, for the chip", () => {
  it("is the same range with nothing seen yet", () => {
    expect(notesBetween(NOTES, null, "1.48.0").map(v => v.version))
      .toEqual(["1.48.0", "1.45.0", "1.43.0"]);
    expect(notesBetween(NOTES, null, "1.44.0").map(v => v.version)).toEqual(["1.43.0"]);
  });

  it("is empty on a deck older than everything in the file", () => {
    expect(notesBetween(NOTES, null, "1.0.0")).toEqual([]);
  });
});

describe("a browser that refuses to remember", () => {
  /** Safari with "Block All Cookies", Chrome with site data blocked: the
   *  accessor itself throws, so a try around getItem alone never runs. */
  const hostile = {
    getItem() { throw new DOMException("The operation is insecure.", "SecurityError"); },
    setItem() { throw new DOMException("The operation is insecure.", "SecurityError"); },
  };

  it("reads as 'nothing seen' instead of throwing", () => {
    expect(readSeen(hostile)).toBeNull();
    expect(readSeen(null)).toBeNull();
  });

  it("reports a write that did not stick rather than pretending", () => {
    expect(writeSeen(hostile, "1.45.0")).toBe(false);
    expect(writeSeen(null, "1.45.0")).toBe(false);
  });

  it("lands on silence, not on a modal every single load", () => {
    // The full path, with the store standing in for a locked-down profile:
    // nothing readable means first run, and first run shows nothing. A blocked
    // store therefore costs the notes and never repeats them.
    const d = decideReleaseNotes({ stored: readSeen(hostile), running: "1.48.0", notes: NOTES });
    expect(d.show).toEqual([]);
    expect(writeSeen(hostile, d.record!)).toBe(false);
  });

  it("round-trips through a store that works", () => {
    const map = new Map<string, string>();
    const store = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => { map.set(k, v); },
    };
    expect(writeSeen(store, "1.45.0")).toBe(true);
    expect(map.get(RELEASE_NOTES_SEEN_KEY)).toBe("1.45.0");
    expect(readSeen(store)).toBe("1.45.0");
  });

  it("refuses a stored value that is not a version", () => {
    const map = new Map<string, string>([[RELEASE_NOTES_SEEN_KEY, ""]]);
    const store = { getItem: (k: string) => map.get(k) ?? null, setItem: () => {} };
    expect(readSeen(store)).toBeNull();
  });
});

describe("reading the notes file", () => {
  it("skips the key the file carries its own instructions in", () => {
    const parsed = readNotes({ "//": ["how to write this file"], "1.45.0": [note("x")] });
    expect(parsed.map(v => v.version)).toEqual(["1.45.0"]);
  });

  it("drops what it cannot use rather than failing a running deck", () => {
    const parsed = readNotes({
      "1.45": [note("mis-keyed")],
      "1.46.0": "not a list",
      "1.47.0": [],
      "1.48.0": [{ title: "", body: "no title" }, { title: "no body", body: "  " }],
      "1.49.0": [note("kept")],
    });
    expect(parsed.map(v => v.version)).toEqual(["1.49.0"]);
  });

  it("answers an empty list for anything that is not an object", () => {
    for (const v of [null, undefined, "", 7, []]) expect(readNotes(v)).toEqual([]);
  });

  it("sorts newest first however the file is written", () => {
    const parsed = readNotes({ "1.9.0": [note("old")], "1.10.0": [note("new")] });
    expect(parsed.map(v => v.version)).toEqual(["1.10.0", "1.9.0"]);
  });
});

describe("the notes that actually shipped", () => {
  it("carries the one entry this feature was built for", () => {
    const v145 = RELEASE_NOTES.find(v => v.version === "1.45.0");
    expect(v145).toBeDefined();
    const text = v145!.notes.map(n => `${n.title} ${n.body}`).join(" ");
    expect(text).toMatch(/settings\.json/);
    expect(text).toMatch(/Codex/);
  });

  it("would be shown to somebody upgrading past it, and to nobody else", () => {
    expect(shown(decideReleaseNotes({ stored: "1.44.1", running: "1.45.0", notes: RELEASE_NOTES })))
      .toContain("1.45.0");
    expect(decideReleaseNotes({ stored: null, running: "1.45.0", notes: RELEASE_NOTES }).show)
      .toEqual([]);
    expect(decideReleaseNotes({ stored: "1.45.0", running: "1.45.0", notes: RELEASE_NOTES }).show)
      .toEqual([]);
  });
});

describe("what the dialog says about itself", () => {
  it("names one release on its own and several as a span", () => {
    expect(versionRangeLabel([])).toBe("");
    expect(versionRangeLabel(NOTES.slice(0, 1))).toBe("v1.48.0");
    // Oldest first: a span is read in the direction it was travelled, even
    // though the list beneath it runs newest first.
    expect(versionRangeLabel(NOTES)).toBe("v1.43.0 – v1.48.0");
  });

  it("answers 'why is this here' differently for the two ways in", () => {
    // The deck raised it: the first line has to name what the user has been
    // caught up to, or an unasked-for dialog is just an interruption.
    const auto = releaseNotesIntro("1.42.0", NOTES);
    expect(auto).toContain("v1.42.0");
    expect(auto).toContain("3 releases");
    // …and the way back, because the dialog being dismissible without regret
    // depends entirely on it. It has to name the control that exists: the
    // button, not the version chip beside it, which asks npm for a newer
    // release and has nothing to do with these notes.
    expect(auto).toContain("What's new button in the topbar");
    expect(auto).not.toMatch(/version chip/i);
    // The user opened it: a different sentence, not a missing one.
    const browsed = releaseNotesIntro(null, NOTES);
    expect(browsed).not.toContain("v1.42.0");
    expect(browsed).toMatch(/newest first/i);
  });

  it("counts one release in the singular", () => {
    expect(releaseNotesIntro("1.47.0", NOTES.slice(0, 1))).toContain("one release");
    expect(releaseNotesIntro("1.47.0", NOTES.slice(0, 1))).not.toContain("1 releases");
  });

  it("has something to say about an empty run rather than an empty box", () => {
    for (const since of ["1.45.0", null]) {
      expect(releaseNotesIntro(since, []).length).toBeGreaterThan(30);
    }
  });
});

describe("the topbar button's copy", () => {
  it("names what the notes are about, which the visible word does not", () => {
    // "What's new" on its own is a category. After an upgrade the question is
    // what it is new SINCE, and the accessible name is where that goes.
    expect(whatsNewLabel({ running: "1.45.0", releases: 1 })).toContain("v1.45.0");
  });

  it("says the notes are scarce on purpose, in both numbers", () => {
    const one = whatsNewTitle({ running: "1.45.0", releases: 1 });
    expect(one).toContain("One release");
    // Both verbs, not just the first: the sentence used to switch number in the
    // middle and read "It shows … and stay available", which is the kind of
    // thing only a person looking at the tooltip finds.
    expect(one).toContain("It shows");
    expect(one).toContain("stays available");
    const many = whatsNewTitle({ running: "1.48.0", releases: 4 });
    expect(many).toContain("4 releases");
    expect(many).toContain("They show");
    expect(many).toContain("stay available");
    expect(many).not.toContain("stays available");
  });
});

describe("how App.tsx wires it up", () => {
  const app = src("../App.tsx");
  const modal = src("../components/ReleaseNotesModal.tsx");

  it("decides from the version the SERVER is running, not the bundle's", () => {
    // An upgrade replaces dist/web on disk before the process restarts, so the
    // page can be newer than the code answering it. Announcing behaviour that
    // is not live yet is announcing nothing.
    expect(app).toMatch(/decideReleaseNotes\(\{ stored, running: version\?\.running \?\? null, notes: RELEASE_NOTES \}\)/);
  });

  it("holds the decision open until /api/version has answered", () => {
    // The ref must NOT be stamped on the no-version branch, or a deck whose
    // first poll had not landed would never look again.
    const guard = app.slice(app.indexOf('if (decision.reason === "no-version") return;'));
    expect(guard.slice(0, 200)).toMatch(/releaseNotesDecidedRef\.current = true;/);
    const before = app.slice(0, app.indexOf('if (decision.reason === "no-version") return;'));
    expect(before).not.toMatch(/releaseNotesDecidedRef\.current = true;/);
  });

  it("shows it at most once even when the store refuses to remember", () => {
    // Without the ref, a blocked profile reads "nothing stored" on every poll,
    // decides "first run" every time — and if the notes had been shown on that
    // branch they would be shown forever. The ref is the belt; first-run being
    // silent is the braces.
    expect(app).toMatch(/if \(releaseNotesDecidedRef\.current\) return;/);
  });

  it("records what the decision said to record, and only that", () => {
    expect(app).toMatch(/if \(decision\.record\) writeSeen\(store, decision\.record\);/);
    // Never a bare `writeSeen(store, running)` — that is the shape that drags
    // the marker backwards on a downgrade.
    expect(app).not.toMatch(/writeSeen\(store, version/);
  });

  it("gates the canvas shortcuts while it is up, like every other dialog", () => {
    // A click on the dialog's prose drops focus to <body>, and from there a
    // stray "c" would reach Clear behind it.
    expect(app).toMatch(/\|\| keyHelpOpen \|\| releaseNotes != null;/);
  });

  it("offers the topbar button only where there is something to read", () => {
    expect(app).toMatch(/\{everyReleaseNote\.length > 0 && \(\(\) => \{/);
    expect(app).toMatch(/aria-haspopup="dialog"/);
  });

  it("opens the button's route with nothing marked seen, so it shows everything", () => {
    // `since: null` is what makes the browse route a browse: it is not an
    // announcement, so it neither reads nor writes the marker.
    expect(app).toMatch(/setReleaseNotes\(\{ entries: everyReleaseNote, since: null \}\)/);
  });

  it("leaves the version chip's own click alone", () => {
    // The chip asks npm now, which is the only way to tell "no update" from
    // "no check ran". #712 adds a control; it does not take one over.
    expect(app).toMatch(/onClick=\{\(\) => loadVersion\(true\)\}/);
  });

  it("draws the dialog out of the shared modal parts and nothing else", () => {
    expect(modal).toMatch(/const dialogRef = useModalDismiss\(onClose\);/);
    expect(modal).toMatch(/className="modal-backdrop"/);
    expect(modal).toMatch(/role="dialog"\n\s*aria-modal="true"/);
    // No decision logic in the component: it draws what it is handed.
    expect(code(modal)).not.toMatch(/compareVersions|localStorage|decideReleaseNotes/);
  });
});
