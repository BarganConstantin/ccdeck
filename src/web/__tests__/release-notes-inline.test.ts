// The marks inside a release note.
//
// Every note in release-notes.json is written in Markdown and the modal printed
// the string raw, so the first window shown after an upgrade has been saying
// `**H**` and spelling its backticks since the feature shipped — 25 of 52
// notes, 52 bold spans and 54 code spans, the release published this morning
// among them. That is not a cosmetic complaint: the emphasis is where the
// author put the thing you have to know, and it is the mark, not the sentence,
// that says which.
//
// The load-bearing test here is the round trip over the REAL FILE. A renderer
// is allowed to drop delimiters and is not allowed to drop, reorder or invent
// anything else, and the file is the only input that will ever be given to it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseInline, plainOf, type Inline } from "../inline-markdown";
import { RELEASE_NOTES } from "../release-notes";

const at = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const modal = readFileSync(at("../components/ReleaseNotesModal.tsx"), "utf8");
const css = readFileSync(at("../styles.css"), "utf8");

const everyNote = RELEASE_NOTES.flatMap(v => v.notes.map(n => ({ version: v.version, ...n })));

/** The kinds present in a parse, flattened, for tests that care what was found
 *  rather than where. */
const kinds = (nodes: Inline[]): string[] =>
  nodes.flatMap(n => (n.kind === "bold" ? ["bold", ...kinds(n.kids)] : [n.kind]));

describe("the real file, every note", () => {
  it("has something to render, or this suite proves nothing", () => {
    expect(everyNote.length).toBeGreaterThan(40);
    expect(everyNote.filter(n => /\*\*|`/.test(n.body)).length).toBeGreaterThan(20);
  });

  it("balances every delimiter it opens", () => {
    // The round trip below is only a fair test while this holds: an odd
    // backtick would legitimately survive as text, and the two sides would
    // differ for a reason that is the author's and not the parser's.
    const odd = everyNote.filter(n =>
      (n.body.match(/`/g) ?? []).length % 2 !== 0 ||
      (n.body.match(/\*\*/g) ?? []).length % 2 !== 0);
    expect(odd.map(n => `${n.version}: ${n.title}`)).toEqual([]);
  });

  it("loses no character but the marks", () => {
    // Independent of the parser: the expected value is the body with the
    // delimiter characters deleted, by `replace`. If the parser dropped a
    // word, swallowed a paragraph looking for a partner, or emitted a run
    // twice, this is where it shows.
    for (const n of everyNote) {
      const expected = n.body.replace(/\*\*/g, "").replace(/`/g, "");
      expect(plainOf(parseInline(n.body)), `${n.version}: ${n.title}`).toBe(expected);
    }
  });

  it("leaves no mark on screen", () => {
    // The defect itself, stated over the whole file.
    for (const n of everyNote) {
      const shown = plainOf(parseInline(n.body));
      expect(shown, `${n.version}: ${n.title}`).not.toContain("**");
      expect(shown, `${n.version}: ${n.title}`).not.toContain("`");
    }
  });

  it("finds the bold and the code that are actually in there", () => {
    // A parser that returned one text run per note would pass every assertion
    // above. This is the one that says it did the work.
    const found = everyNote.flatMap(n => kinds(parseInline(n.body)));
    expect(found.filter(k => k === "bold").length).toBe(52);
    expect(found.filter(k => k === "code").length).toBe(54);
  });

  it("carries no markup in a title, and says so the day one does", () => {
    // Titles are rendered through splitNoteTitle, which is about the emoji's
    // side bearing and hands back the text character for character. None of
    // the 52 titles has a mark in it today. This is the assertion that turns
    // "and then somebody bolded a title" into a failing suite rather than into
    // the same defect in a second place.
    const marked = everyNote.filter(n => /\*\*|`/.test(n.title));
    expect(marked.map(n => `${n.version}: ${n.title}`)).toEqual([]);
  });
});

describe("code binds tighter than bold", () => {
  it("reads a code span inside a bold one, which the file really contains", () => {
    // `**\`month\` says which month.**` — 3.11.0, and one more in 3.9.0.
    const nodes = parseInline("**`month` says which month.**");
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe("bold");
    expect(kinds(nodes)).toEqual(["bold", "code", "text"]);
    expect(plainOf(nodes)).toBe("month says which month.");
  });

  it("leaves a ** inside a code span alone", () => {
    // No note does this yet. The one that would is a note about a glob or a
    // shell expansion — and without this the stray `**` closes the bold and
    // eats the rest of the paragraph.
    const nodes = parseInline("run `find . -name **/*.ts` first");
    expect(kinds(nodes)).toEqual(["text", "code", "text"]);
    expect(plainOf(nodes)).toBe("run find . -name **/*.ts first");
  });

  it("does not let a ** inside a code span close a bold that opened before it", () => {
    const nodes = parseInline("**use `a ** b` here** ok");
    expect(nodes[0].kind).toBe("bold");
    expect(plainOf(nodes)).toBe("use a ** b here ok");
  });
});

describe("what is not a mark", () => {
  it("leaves an unmatched backtick as a backtick", () => {
    // A typo in a data file. Showing the author their stray mark is the honest
    // failure; eating the rest of the note is not.
    const nodes = parseInline("a ` b c");
    expect(kinds(nodes)).toEqual(["text"]);
    expect(plainOf(nodes)).toBe("a ` b c");
  });

  it("leaves an unmatched ** as text", () => {
    expect(plainOf(parseInline("a ** b c"))).toBe("a ** b c");
    expect(kinds(parseInline("a ** b c"))).toEqual(["text"]);
  });

  it("refuses to bold across spaced delimiters", () => {
    // `2 ** 3` and `4 ** 5` in one paragraph is arithmetic, not one bold run
    // with the middle eaten.
    const nodes = parseInline("2 ** 3 and 4 ** 5");
    expect(kinds(nodes)).toEqual(["text"]);
    expect(plainOf(nodes)).toBe("2 ** 3 and 4 ** 5");
  });

  it("still bolds when only the outside has spaces, which is the normal case", () => {
    expect(kinds(parseInline("the **whole** point"))).toEqual(["text", "bold", "text", "text"]);
  });

  it("leaves an empty code span as two backticks", () => {
    expect(plainOf(parseInline("a `` b"))).toBe("a `` b");
  });

  it("does not nest bold inside bold, and keeps the marks it did not use", () => {
    // `**a **b** c**` is ambiguous input and nobody writes it. What comes out
    // is CommonMark's own reading — the first pair that can close, closes:
    // `<strong>a **b</strong> c**`. The delimiters that were not part of a
    // matched pair stay on screen as text, which is the same refusal as the
    // unmatched-backtick case above.
    //
    // The first version of this test asserted `a b c`, which would have meant
    // silently eating four characters the author typed.
    const nodes = parseInline("**a **b** c**");
    expect(nodes.filter(n => n.kind === "bold")).toHaveLength(1);
    expect(plainOf(nodes)).toBe("a **b c**");
    // And no bold inside the bold.
    const inner = nodes.find(n => n.kind === "bold");
    expect(inner && inner.kind === "bold" && kinds(inner.kids)).toEqual(["text"]);
  });

  it("returns nothing for nothing", () => {
    expect(parseInline("")).toEqual([]);
    expect(plainOf(parseInline(""))).toBe("");
  });
});

describe("how the modal renders them", () => {
  it("uses the parser at all", () => {
    expect(modal).toContain("parseInline(note.body)");
  });

  it("builds elements, never an HTML string", () => {
    // release-notes.json is data this repo ships, but the renderer that reads
    // it should not be the one place a future note — or a file edited inside a
    // published install — can spell a script tag.
    expect(modal).not.toContain("dangerouslySetInnerHTML");
    expect(readFileSync(at("../inline-markdown.ts"), "utf8")).not.toContain("innerHTML");
  });

  it("emits the tags the marks mean, not two styled spans", () => {
    // A screen reader announces emphasis and a code span from the tag. The note
    // whose point is `**do not upgrade past 3.4**` should carry that in the
    // markup and not only in the weight of the pixels.
    expect(modal).toMatch(/<strong[^>]*className="rn-strong"/);
    expect(modal).toMatch(/<code[^>]*className="rn-code"/);
  });

  it("makes emphasis a step up in colour, since the body is muted", () => {
    // Bold at the same tone as its paragraph is a difference you have to
    // already know is there.
    const body = css.slice(css.indexOf(".release-notes .rn-note-body {"));
    expect(body.slice(0, body.indexOf("}"))).toContain("color: var(--muted)");
    const strong = css.slice(css.indexOf(".release-notes .rn-strong {"));
    expect(strong.slice(0, strong.indexOf("}"))).toContain("color: var(--text)");
  });

  it("keeps a code span's spaces, which the paragraph's own rule would collapse", () => {
    // The body is `pre-line` so its blank lines survive as paragraphs — and
    // `pre-line` collapses runs of spaces, inside a code span too. A code span
    // says exactly what to type.
    const code = css.slice(css.indexOf(".release-notes .rn-code {"));
    expect(code.slice(0, code.indexOf("}"))).toContain("white-space: pre-wrap");
  });
});
