// The notes file is data, written by a person at release time, and this is the
// half of #712 that keeps it honest.
//
// release-notes.ts is deliberately forgiving: a mis-keyed release or a
// half-written entry is dropped rather than allowed to take a running deck down
// over a JSON file. That forgiveness is only safe if nothing malformed can ever
// reach a user, because a note that is silently dropped is a note the one person
// who needed it never sees — which is the entire failure mode this feature has.
// So the runtime shrugs and this refuses.
//
// It also holds the two things that are easy to do and easy to forget: shipping
// the file inside the package, and writing entries somebody would actually read.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isVersion, readNotes, RELEASE_NOTES, splitNoteTitle } from "../release-notes";

/** A title that OPENS with an emoji, whatever comes after it — deliberately
 *  looser than splitNoteTitle's own pattern, which additionally demands the one
 *  space. The gap between the two is the whole assertion below: a title this
 *  matches and that one does not is a title whose emoji will render without its
 *  gap, and the file is where that gets refused. */
const LEADS_WITH_EMOJI = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|[\u200D\uFE0F])/u;

const at = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const rawText = readFileSync(at("../../../release-notes.json"), "utf8");
const raw = JSON.parse(rawText) as Record<string, unknown>;
const pkg = JSON.parse(readFileSync(at("../../../package.json"), "utf8")) as {
  version: string;
  files: string[];
};

/** Every key that is meant to be a release — everything except the block the
 *  file carries its own instructions in. */
const versionKeys = Object.keys(raw).filter(k => k !== "//");

describe("the shape of release-notes.json", () => {
  it("keys every entry by a version, so none is quietly dropped", () => {
    // "1.46" instead of "1.46.0" parses, validates as JSON, and vanishes at
    // runtime. This is the assertion that turns that into a red suite.
    const bad = versionKeys.filter(k => !isVersion(k));
    expect(bad).toEqual([]);
  });

  it("loses nothing between the file and what the deck reads", () => {
    // The strict statement of the rule above: whatever the file calls a
    // release, readNotes must have kept. It compares counts AND names, so an
    // entry swapped for another one cannot balance the books.
    expect(readNotes(raw).map(v => v.version).sort()).toEqual([...versionKeys].sort());
  });

  it("gives every release a non-empty list of notes", () => {
    for (const key of versionKeys) {
      const notes = raw[key];
      expect(Array.isArray(notes), key).toBe(true);
      expect((notes as unknown[]).length, key).toBeGreaterThan(0);
    }
  });

  it("gives every note a title and a body and nothing else", () => {
    // The extra-field half matters: a `"summary"` written where `"body"` was
    // meant is an entry that renders with half its content and no complaint.
    for (const key of versionKeys) {
      for (const note of raw[key] as Array<Record<string, unknown>>) {
        expect(Object.keys(note).sort(), key).toEqual(["body", "title"]);
        expect(typeof note.title, key).toBe("string");
        expect(typeof note.body, key).toBe("string");
        expect(String(note.title).trim(), key).not.toBe("");
        expect(String(note.body).trim(), key).not.toBe("");
      }
    }
  });

  it("carries its own instructions, so the next author does not have to find them", () => {
    // The `"//"` block is the whole maintenance story: the file explains what
    // belongs in it, in itself, at the moment somebody opens it to add a line.
    expect(Array.isArray(raw["//"])).toBe(true);
    const guidance = (raw["//"] as string[]).join(" ");
    expect(guidance).toMatch(/would a user notice/i);
    // The half that is easy to leave out and is the reason the modal stays
    // worth reading: no key at all is the expected answer.
    expect(guidance).toMatch(/valid/i);
  });
});

describe("what a note is allowed to say", () => {
  const everyNote = RELEASE_NOTES.flatMap(v => v.notes.map(n => ({ version: v.version, ...n })));

  it("has something to say", () => {
    expect(everyNote.length).toBeGreaterThan(0);
  });

  it("writes the title as a sentence the eye can catch", () => {
    for (const n of everyNote) {
      // Long enough to be a claim, short enough to be scanned in a heading, and
      // not punctuated as prose — it is a headline, and the body is beneath it.
      expect(n.title.length, n.version).toBeGreaterThan(15);
      expect(n.title.length, n.version).toBeLessThanOrEqual(100);
      expect(n.title.endsWith("."), n.version).toBe(false);
    }
  });

  it("writes a body a user could act on", () => {
    for (const n of everyNote) expect(n.body.length, n.version).toBeGreaterThan(60);
  });

  it("refuses the phrases a decaying changelog is made of", () => {
    // #712's own objection, made mechanical. A modal that says "various fixes"
    // teaches people to dismiss the modal, and then it is worthless on the day
    // it is not saying that.
    const EMPTY = /\b(various (fixes|improvements)|bug ?fixes|misc(ellaneous)?|minor (fixes|changes)|general improvements|under the hood)\b/i;
    const offenders = everyNote
      .filter(n => EMPTY.test(n.title) || EMPTY.test(n.body))
      .map(n => `${n.version}: ${n.title}`);
    expect(offenders).toEqual([]);
  });

  it("does not send the reader to a control that was taken away", () => {
    // A note is written once and read for years, and this file already carried
    // one telling people to click a "What's new button" that #715 deleted. A
    // changelog that describes an interface the reader cannot find is worse
    // than one that says nothing, because it is the entry teaching them the
    // dialog is unreliable.
    const everyWord = RELEASE_NOTES.flatMap(v => v.notes.map(n => `${v.version}: ${n.title} ${n.body}`));
    expect(everyWord.filter(t => /What's new button/i.test(t))).toEqual([]);
  });

  it("separates a leading emoji from the first word with exactly one space", () => {
    // The data half of #715. The renderer supplies the optical gap an emoji
    // glyph has no side bearing for, and it can only do that for a title it can
    // split — which means one space, no more and no fewer.
    //
    // Both failures are silent without this. "🔊Pick" renders genuinely flush
    // and looks like the bug that was reported; "🔊  Pick" is the paper-over
    // the renderer fix exists to make unnecessary, and it would sail past a
    // reviewer as a stray keystroke. splitNoteTitle refuses both, so either one
    // costs the note its gap and nothing says so.
    const bad = RELEASE_NOTES.flatMap(v => v.notes
      .filter(n => LEADS_WITH_EMOJI.test(n.title) && splitNoteTitle(n.title).icon === null)
      .map(n => `${v.version}: ${JSON.stringify(n.title)}`));
    expect(bad).toEqual([]);
  });

  it("is not a vacuous emoji sweep either — the rule catches both ways of breaking it", () => {
    // The file may carry no emoji at all today, and a rule that can only pass
    // is not a rule. These are what it is watching for.
    expect(splitNoteTitle("🔊 Pick a volume and a sound").icon).toBe("🔊");
    for (const bad of ["🔊Pick a volume and a sound", "🔊  Pick a volume and a sound"]) {
      expect(LEADS_WITH_EMOJI.test(bad), bad).toBe(true);
      expect(splitNoteTitle(bad).icon, bad).toBeNull();
    }
    // And a plain title is not dragged into the rule by it.
    expect(LEADS_WITH_EMOJI.test("The deck no longer puts anything there")).toBe(false);
  });

  it("is not a vacuous sweep — the detector finds the phrases it is looking for", () => {
    const EMPTY = /\b(various (fixes|improvements)|bug ?fixes|misc(ellaneous)?|minor (fixes|changes)|general improvements|under the hood)\b/i;
    for (const s of ["Various fixes", "bugfixes and polish", "Misc", "under the hood"]) {
      expect(EMPTY.test(s), s).toBe(true);
    }
    expect(EMPTY.test("The deck no longer keeps a sound hook in your settings.json")).toBe(false);
  });
});

describe("the blank lines in a body, which are load-bearing", () => {
  it("is how the entries are actually written", () => {
    // Not a hypothetical. Every release written so far splits its body into
    // what changed and what to do about it, and the split is a `\n\n`.
    const bodies = versionKeys.flatMap(k => (raw[k] as { body: string }[]).map(n => n.body));
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.some(b => b.includes("\n\n")), "no entry separates its thoughts any more — if that is deliberate, this case and the CSS below can go").toBe(true);
  });

  it("renders as a break rather than collapsing into a space", () => {
    // `.rn-note-body` is a bare <p> holding the raw string, and HTML collapses
    // a newline to a space — so every `\n\n` above was silently ignored and
    // three releases shipped as one wall of text. The data and the rule that
    // makes it mean something live in different files, and nothing but this
    // connects them.
    const css = readFileSync(at("../styles.css"), "utf8");
    const rule = css.slice(css.indexOf(".release-notes .rn-note-body {"));
    expect(rule.slice(0, 1), "styles.css no longer has a .release-notes .rn-note-body rule").toBe(".");
    const body = rule.slice(0, rule.indexOf("}"));
    expect(body, "the paragraph breaks in release-notes.json collapse to spaces again")
      .toMatch(/white-space:\s*(pre-line|pre-wrap)\s*;/);
  });
});

describe("shipping the file", () => {
  it("is listed in package.json files, so it is in the tarball", () => {
    // The bundle inlines it at build time, so the deck would work without this
    // — but then the notes would exist only as minified strings inside a JS
    // chunk, and `npx ccdeck` would carry no readable record of what changed.
    expect(pkg.files).toContain("release-notes.json");
  });

  it("names no release the package has not reached", () => {
    // A note keyed ahead of package.json is written and not yet released, which
    // is the normal order — notes first, `npm version` second. Nobody is shown
    // it until the version it names is the version running, which is the point
    // of the range check in release-notes.ts. Pinned here as a claim about the
    // FILE rather than about the deck: at most one unreleased entry, so a typo
    // like "2.45.0" for "1.45.0" is caught the moment it is written.
    const ahead = RELEASE_NOTES.filter(v => v.version > pkg.version).map(v => v.version);
    expect(ahead.length).toBeLessThanOrEqual(1);
  });

  it("parses as the JSON a person hand-edits, trailing newline and all", () => {
    // Not decoration: this file is edited by hand under time pressure, at the
    // one moment in the release when nobody wants a surprise.
    expect(() => JSON.parse(rawText)).not.toThrow();
    expect(rawText.endsWith("\n")).toBe(true);
  });
});
