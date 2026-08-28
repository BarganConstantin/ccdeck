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
import { isVersion, readNotes, RELEASE_NOTES } from "../release-notes";

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

  it("is not a vacuous sweep — the detector finds the phrases it is looking for", () => {
    const EMPTY = /\b(various (fixes|improvements)|bug ?fixes|misc(ellaneous)?|minor (fixes|changes)|general improvements|under the hood)\b/i;
    for (const s of ["Various fixes", "bugfixes and polish", "Misc", "under the hood"]) {
      expect(EMPTY.test(s), s).toBe(true);
    }
    expect(EMPTY.test("The deck no longer keeps a sound hook in your settings.json")).toBe(false);
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
