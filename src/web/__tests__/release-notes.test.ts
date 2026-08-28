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
  splitNoteTitle,
  writeSeen,
  type VersionNotes,
} from "../release-notes";
// The repo's other comparator, and the reason this one is allowed to exist:
// self-update.mjs opens with node:fs and node:child_process, so the browser
// bundle cannot import it. Held against this one below so the two cannot drift.
import { isOlder } from "../../server/self-update.mjs";

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
    const auto = releaseNotesIntro({ since: "1.42.0", running: "1.48.0", entries: NOTES });
    expect(auto).toContain("v1.42.0");
    expect(auto).toContain("3 releases");
    // …and the way back, because the dialog being dismissible without regret
    // depends entirely on it. It has to name the control that exists, and since
    // #715 that is the version in the topbar — the separate What's new button
    // this sentence used to send people to is gone, and a dialog pointing at a
    // control that is not there is worse than one that points at nothing.
    expect(auto).toContain("Clicking the version in the topbar brings this back.");
    expect(auto).not.toMatch(/What's new button/);
    // The user opened it: a different sentence, not a missing one.
    const browsed = releaseNotesIntro({ since: null, running: "1.48.0", entries: NOTES });
    expect(browsed).not.toContain("v1.42.0");
    expect(browsed).toMatch(/newest first/i);
  });

  it("counts one release in the singular", () => {
    const one = { since: "1.47.0", running: "1.48.0", entries: NOTES.slice(0, 1) };
    expect(releaseNotesIntro(one)).toContain("one release");
    expect(releaseNotesIntro(one)).not.toContain("1 releases");
  });

  it("has something to say about an empty run rather than an empty box", () => {
    // #715 stopped gating the chip on the run being non-empty, so this sentence
    // is reachable by a click now rather than only by a caller's mistake: a
    // deck older than everything in its own notes file opens this, and has to
    // find a sentence in it rather than an empty dialog.
    for (const since of ["1.45.0", null]) {
      expect(releaseNotesIntro({ since, running: "1.0.0", entries: [] }).length).toBeGreaterThan(30);
    }
  });
});

// ── the sentence the browse route can most easily get wrong (#715) ──────────
//
// The chip opens this on any release, and most releases changed nothing a user
// would notice. What the reader sees then is a list headed by an OLDER version
// than the one in the topbar, and the failure there is not an empty box — it is
// a full one that reads as though v1.45.0's notes describe the v1.47.0 they are
// running.

describe("what the first line says about the release you are actually on", () => {
  const browse = (running: string | null, entries = NOTES) =>
    releaseNotesIntro({ since: null, running, entries });

  it("says so when the running release is the one at the top of the list", () => {
    const line = browse("1.48.0");
    expect(line).toContain("You are running v1.48.0");
    expect(line).toContain("this is what it changed");
  });

  it("says the running release had nothing, rather than letting an older one stand in", () => {
    // The case that made this function need `running` at all. 1.47.0 is not in
    // NOTES, so the list opens with 1.45.0. "Everything this build has to say"
    // is true here and still misleads, because the number on the chip that
    // opened it says 1.47.0.
    const line = browse("1.47.0", notesBetween(NOTES, null, "1.47.0"));
    expect(line).toContain("v1.47.0");
    expect(line).toContain("changed nothing you would notice");
    // And it must not read as an upgrade: nothing is new, nobody was caught up
    // anywhere, and this is the reader asking rather than the deck announcing.
    expect(line).not.toMatch(/caught up/);
    expect(line).not.toMatch(/Since then/);
  });

  it("claims nothing about the running release when it does not know one", () => {
    // /api/version never answered and the bundle's own number is standing in;
    // the browse route still opens, and the sentence stays true by saying less.
    for (const running of [null, "", "unknown"]) {
      const line = browse(running);
      expect(line, JSON.stringify(running)).toMatch(/newest first/);
      expect(line, JSON.stringify(running)).not.toMatch(/You are running/);
      expect(line, JSON.stringify(running)).not.toMatch(/changed nothing/);
    }
  });

  it("does not claim a release ahead of the run is the one you are on", () => {
    // Unreachable through the chip, which never asks for notes past the running
    // version, and reachable by any other caller. The answer stays honest by
    // naming no version at all.
    const line = browse("1.44.0");
    expect(line).not.toContain("You are running v1.44.0");
    expect(line).toMatch(/newest first/);
  });
});

// ── the emoji that read as flush against the first word (#715) ──────────────
//
// Reported from a screenshot as "🔊Pick a volume". The space is in the JSON,
// survives the bundle and reaches the DOM — Chrome measures it at 3.332px
// against a 3.324px word space at the same size — so nothing strips it and
// nothing is missing from the data. What is missing is the side bearing a
// colour glyph does not have, and supplying that is the renderer's job. This is
// the half of it that can be wrong.

describe("splitting a note title at its leading emoji", () => {
  it("takes the emoji off and leaves the space on the text", () => {
    const { icon, rest } = splitNoteTitle("🔊 Pick a volume");
    expect(icon).toBe("🔊");
    // The space stays in `rest` on purpose: it is what keeps the rendered
    // string identical to the title, so the accessible name, a find-in-page and
    // a copy out of the dialog are all unchanged by the split.
    expect(rest).toBe(" Pick a volume");
  });

  it("is lossless on every string it is given", () => {
    // The invariant the whole thing rests on. A split that dropped a character
    // would be a renderer quietly editing release notes.
    for (const title of [
      "🔊 Pick a volume", "✨ This box is new", "🔕 The deck no longer puts anything there",
      "No emoji at all", "", " ", "🔊", "🔊 ", "🔊  two spaces", "🔊Pick a volume",
      "👍🏽 A skin tone", "👨‍👩‍👧 A joined family", "🇬🇧 A flag", "❤️ A variation selector",
      "1.46.0 is out", "— an em dash", "🔊 🔕 two of them",
    ]) {
      const { icon, rest } = splitNoteTitle(title);
      expect((icon ?? "") + rest, JSON.stringify(title)).toBe(title);
    }
  });

  it("leaves a title that does not open with one exactly as it was", () => {
    for (const title of ["The deck no longer puts anything there", "1.46.0 changed a default", ""]) {
      expect(splitNoteTitle(title), title).toEqual({ icon: null, rest: title });
    }
  });

  it("keeps a multi-codepoint emoji whole rather than splitting it in half", () => {
    // A ZWJ sequence, a skin tone and a flag are each ONE thing on screen.
    // Taking only the first codepoint would strand the rest of the glyph at the
    // head of the sentence, which is a far worse bug than the one being fixed.
    expect(splitNoteTitle("👨‍👩‍👧 A joined family").icon).toBe("👨‍👩‍👧");
    expect(splitNoteTitle("👍🏽 A skin tone").icon).toBe("👍🏽");
    expect(splitNoteTitle("🇬🇧 A flag").icon).toBe("🇬🇧");
    expect(splitNoteTitle("❤️ A variation selector").icon).toBe("❤️");
  });

  it("refuses the two shapes the data must not be written in", () => {
    // No space at all: the one case a reader really WOULD see as flush, and it
    // is a data error. Handing it the optical gap here would hide it from the
    // file test whose job is to fail on it.
    expect(splitNoteTitle("🔊Pick a volume").icon).toBeNull();
    // Two spaces: the paper-over this function exists to make unnecessary. It
    // gains nothing from the split, and the file test refuses it as well.
    expect(splitNoteTitle("🔊  Pick a volume").icon).toBeNull();
  });

  it("does not treat a bare emoji with nothing after it as a title's icon", () => {
    // An icon with no sentence beside it is not a note title, and pulling it
    // into a box of its own would leave the paragraph empty.
    expect(splitNoteTitle("🔊").icon).toBeNull();
    expect(splitNoteTitle("🔊 ").icon).toBeNull();
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

  it("opens the browse route with nothing marked seen, so it shows everything", () => {
    // `since: null` is what makes the browse route a browse: it is not an
    // announcement, so it neither reads nor writes the marker.
    expect(app).toMatch(/setReleaseNotes\(\{ entries: everyReleaseNote, since: null \}\)/);
  });

  it("does not gate the way back on the run being non-empty (#715)", () => {
    // #712 drew a button only where there was something to read, which was
    // reasonable for a button that would otherwise be an empty word in the
    // topbar. The chip is there either way, so the gate would now only mean a
    // click that does nothing at all — and the dialog has a sentence for the
    // empty case precisely so it does not need one.
    expect(code(app)).not.toMatch(/everyReleaseNote\.length > 0/);
  });

  it("opens the notes before it asks npm, because only one of the two is local", () => {
    // The ordering, in the one place it can be read off. The dialog is drawn
    // from a JSON file inlined into this bundle and the check is a round trip
    // to a registry that may not be reachable at all; awaiting the check first
    // would leave the button visibly dead for the length of it, and dead
    // forever on a deck with no route out.
    const chip = /onClick=\{\(\) => \{ openReleaseNotes\(\); loadVersion\(true\); \}\}/;
    expect(app).toMatch(chip);
    // Not the other way round, and not `await`ed: both are the same defect
    // written differently.
    expect(app).not.toMatch(/loadVersion\(true\)[^}]*openReleaseNotes/);
    expect(app).not.toMatch(/await loadVersion\(true\)/);
  });

  it("keeps the check the chip has always done, exactly as it was", () => {
    // #715 adds a job to this click. It must not quietly drop the one that was
    // already there: forcing the check is the only way to tell "no update
    // exists" from "no check has run", which on a machine that only ever runs
    // `npx ccdeck` is the whole point of the chip.
    expect(app).toMatch(/loadVersion\(true\)/);
    expect(app).toMatch(/fetch\(force \? "\/api\/version\?refresh=1" : "\/api\/version"\)/);
  });

  it("is reachable from the drift branch too, which is the branch that persists", () => {
    // A deck that is behind stays behind until somebody upgrades it, and while
    // the amber chip is the one drawn it is the ONLY way back into a dismissed
    // dialog. Leaving this branch alone would have taken #712's reachability
    // away for exactly as long as the drift lasted.
    expect(app).toMatch(/onClick=\{\(\) => \{ openReleaseNotes\(\); showNotice\(\); \}\}/);
    // And it reveals rather than toggles: a click that opens a modal AND
    // silently reverses the strip behind it is a click nobody can predict the
    // second time. Putting the banner away stayed with the × that spelled it.
    expect(code(app)).not.toMatch(/toggleNotice/);
    expect(app).toMatch(/className="ver-close" onClick=\{dismissNotice\}/);
  });

  it("tells the dialog the same version the chip is wearing", () => {
    // One value, defaulted once, so the sentence in the dialog and the number
    // on the control that opened it cannot disagree about which release the
    // reader is on.
    expect(app).toMatch(/const chipVersion = version\?\.running \?\? __APP_VERSION__;/);
    expect(app).toMatch(/running=\{chipVersion\}/);
  });

  it("draws the dialog out of the shared modal parts and nothing else", () => {
    expect(modal).toMatch(/const dialogRef = useModalDismiss\(onClose\);/);
    expect(modal).toMatch(/className="modal-backdrop"/);
    expect(modal).toMatch(/role="dialog"\n\s*aria-modal="true"/);
    // No decision logic in the component: it draws what it is handed. The title
    // split is release-notes.ts's for the same reason — the component calls it,
    // it does not carry a regex of its own.
    expect(code(modal)).not.toMatch(/compareVersions|localStorage|decideReleaseNotes/);
    expect(code(modal)).not.toMatch(/Extended_Pictographic/);
    expect(modal).toMatch(/splitNoteTitle\(note\.title\)/);
  });

  it("hands the first line the running version rather than answering for it", () => {
    // A component that passed `running: null` here would compile, render, and
    // quietly go back to the sentence that never names the release you are on —
    // which is the whole thing #715 added the argument for.
    expect(modal).toMatch(/releaseNotesIntro\(\{ since, running, entries \}\)/);
  });

  it("gives the leading emoji a box of its own and the text the space", () => {
    // The whole fix, in the two lines that carry it: an element the sheet can
    // put a margin on, and the rest of the title — space included — beside it,
    // so what a reader copies out of this dialog is the title unchanged.
    expect(modal).toMatch(/\{icon && <span className="rn-note-icon">\{icon\}<\/span>\}/);
    expect(modal).toMatch(/\{rest\}/);
    // The rule's OWN body, not "somewhere after the selector": `[\s\S]*?` runs
    // straight through a closing brace and would have found the margin on some
    // later rule entirely, which is a green test for a stylesheet that no
    // longer separates anything.
    const rule = /\.release-notes \.rn-note-icon \{([^}]*)\}/.exec(src("../styles.css"));
    expect(rule, ".rn-note-icon has no rule at all").not.toBeNull();
    expect(rule![1]).toMatch(/margin-right:\s*[^;]+;/);
    // Never a second space in the markup either — that is the same paper-over
    // the JSON was not allowed to carry.
    expect(modal).not.toMatch(/&nbsp;/);
  });
});
