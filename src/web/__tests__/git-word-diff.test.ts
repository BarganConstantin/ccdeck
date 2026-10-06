// The words that changed inside a changed line: marked when a removed line
// and its replacement share enough, left alone when the line was rewritten or
// is too long to compare.
import { describe, expect, it } from "vitest";
import { hunkWordMarks, tokenize, wordDiff } from "../git-word-diff";
import { parsePatch } from "../git-diff-parse";

const slice = (text: string, ranges: Array<[number, number]>) => ranges.map(([s, e]) => text.slice(s, e));

describe("tokens", () => {
  it("are words, runs of white space and single other characters", () => {
    expect(tokenize("a.b(c_d, 42)  é")).toEqual(["a", ".", "b", "(", "c_d", ",", " ", "42", ")", "  ", "é"]);
  });
});

describe("one changed line", () => {
  it("marks the word that was added and nothing else", () => {
    const a = "  return `${SESSION_COOKIE}=${session.id}; HttpOnly; SameSite=Lax; Path=/`;";
    const b = "  return `${SESSION_COOKIE}=${session.id}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=28800`;";
    const d = wordDiff(a, b)!;
    expect(d.a).toEqual([]);
    expect(slice(b, d.b)).toEqual(["Secure;", "; Max-Age=28800"]);
  });

  it("marks a replaced word on both sides", () => {
    const d = wordDiff("const limit = 100;", "const limit = 250;")!;
    expect(slice("const limit = 100;", d.a)).toEqual(["100"]);
    expect(slice("const limit = 250;", d.b)).toEqual(["250"]);
  });

  it("joins two changed words across the space between them", () => {
    const d = wordDiff("cap retry at ten seconds", "cap retry at thirty whole seconds")!;
    expect(slice("cap retry at thirty whole seconds", d.b)).toEqual(["thirty whole"]);
  });

  it("leaves a rewritten line unmarked", () => {
    expect(wordDiff("import { Router } from \"express\";", "res.status(501).json({ error: 1 });")).toBeNull();
  });

  it("leaves very long lines uncompared rather than paying for them", () => {
    expect(wordDiff("x".repeat(900), "y".repeat(900))).toBeNull();
    const many = (w: string) => Array.from({ length: 200 }, (_, i) => `${w}${i}`).join(" ");
    expect(wordDiff(many("a"), many("b"))).toBeNull();
  });

  it("answers two empty lists for identical lines, and ignores a change of white space alone", () => {
    expect(wordDiff("same", "same")).toEqual({ a: [], b: [] });
    expect(wordDiff("a  b c", "a b c")).toEqual({ a: [], b: [] });
  });
});

describe("a hunk", () => {
  it("pairs each run of removed lines with the added run after it, in order", () => {
    const h = parsePatch([
      "@@ -1,5 +1,5 @@",
      " keep",
      "-const a = 1;",
      "-const b = 2;",
      "+const a = 10;",
      "+const b = 20;",
      "+const c = 30;",
      " end",
      "",
    ].join("\n")).hunks[0];
    const marks = hunkWordMarks(h.lines);
    expect([...marks.keys()].sort()).toEqual([1, 2, 3, 4]);
    expect(slice(h.lines[3].text, marks.get(3)!)).toEqual(["10"]);
    expect(marks.has(5)).toBe(false);
  });

  it("marks nothing in a run of added lines with no removed run before it", () => {
    const h = parsePatch("@@ -1 +1,3 @@\n x\n+y\n+z\n").hunks[0];
    expect(hunkWordMarks(h.lines).size).toBe(0);
  });
});
