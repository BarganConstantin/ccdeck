// #816: the tool dialog showed a call as escaped JSON — an Edit's strings as
// single lines of literal \n, a response carrying the whole edited file (one
// measured 94,877 characters), and nothing to copy. tool-view.ts turns the
// calls the deck sees most into what they are and everything else into its
// values with real newlines; these hold each shape.
import { describe, it, expect } from "vitest";
import { CLIP_CHARS, CLIP_LINES, clip, copyOf, linesOf, readable, toolView } from "../tool-view";

const EDIT_INPUT = { file_path: "/repo/src/a.ts", old_string: "const a = 1;\nconst b = \"x\";", new_string: "const a = 2;\nconst b = \"y\";" };
const EDIT_RESPONSE = {
  filePath: "/repo/src/a.ts",
  originalFile: "ORIGINAL ".repeat(10_000),
  structuredPatch: [{ oldStart: 3, oldLines: 2, newStart: 3, newLines: 2, lines: ["-const a = 1;", "+const a = 2;", " const c = 3;"] }],
  userModified: false,
};

describe("an Edit reads as a change (#816)", () => {
  const view = toolView("Edit", EDIT_INPUT, EDIT_RESPONSE);

  it("names the file and shows before and after with real newlines and no escapes", () => {
    expect(view.input[0]).toEqual({ label: "file", text: "/repo/src/a.ts", inline: true });
    const change = view.input[1];
    expect(change.label).toBe("change");
    expect(change.lines).toEqual([
      { text: "- const a = 1;", tone: "del" },
      { text: "- const b = \"x\";", tone: "del" },
      { text: "+ const a = 2;", tone: "add" },
      { text: "+ const b = \"y\";", tone: "add" },
    ]);
    expect(change.text).not.toMatch(/\\n|\\"/);
  });

  it("answers with the hunks that landed, and never the whole file", () => {
    const applied = view.response.find(b => b.label === "applied")!;
    expect(applied.lines?.[0]).toEqual({ text: "@@ -3,2 +3,2 @@", tone: "ctx" });
    expect(applied.lines?.slice(1)).toEqual([
      { text: "-const a = 1;", tone: "del" },
      { text: "+const a = 2;", tone: "add" },
      { text: " const c = 3;" },
    ]);
    expect(view.response.map(b => b.text).join("\n")).not.toContain("ORIGINAL");
  });

  it("says so when the user changed the edit before it landed", () => {
    const v = toolView("Edit", EDIT_INPUT, { ...EDIT_RESPONSE, userModified: true });
    expect(v.response.at(-1)).toEqual({ label: "note", text: "the user changed it before it was applied", inline: true });
  });

  it("numbers each change of a MultiEdit and says when one replaces every occurrence", () => {
    const v = toolView("MultiEdit", { file_path: "/f", edits: [
      { old_string: "a", new_string: "b" },
      { old_string: "c", new_string: "d", replace_all: true },
    ] }, null);
    expect(v.input.map(b => b.label)).toEqual(["file", "change 1", "change 2, every occurrence"]);
  });
});

describe("the other calls the deck sees most (#816)", () => {
  it("a Write is the file and its text; creating one says so", () => {
    const v = toolView("Write", { file_path: "/f.md", content: "# Title\n\nBody" }, { type: "create", filePath: "/f.md", content: "# Title\n\nBody", structuredPatch: [] });
    expect(v.input).toEqual([{ label: "file", text: "/f.md", inline: true }, { label: "content", text: "# Title\n\nBody" }]);
    expect(v.response).toEqual([{ label: "result", text: "created the file", inline: true }]);
  });

  it("a Read is the file, the range asked for, and the text that came back", () => {
    const v = toolView("Read", { file_path: "/f.ts", offset: 10, limit: 50 },
      { type: "text", file: { filePath: "/f.ts", content: "line ten\nline eleven", numLines: 50, startLine: 10, totalLines: 200 } });
    expect(v.input).toEqual([{ label: "file", text: "/f.ts", inline: true }, { label: "lines", text: "10–59", inline: true }]);
    expect(v.response).toEqual([{ label: "lines", text: "10–59 of 200", inline: true }, { label: "content", text: "line ten\nline eleven" }]);
  });

  it("a Read of an image says what it was rather than dumping it", () => {
    expect(toolView("Read", { file_path: "/p.png" }, { type: "image", file: { base64: "AAAA" } }).response)
      .toEqual([{ label: "result", text: "an image file", inline: true }]);
    expect(toolView("Read", { file_path: "/d.pdf" }, { type: "pdf", file: {} }).response)
      .toEqual([{ label: "result", text: "a pdf file", inline: true }]);
  });

  it("a Bash call is the command, then its output, with errors marked as errors", () => {
    const v = toolView("Bash", { command: "ls -la\necho done", description: "List files" },
      { stdout: "a\nb\n", stderr: "warning: x\n", interrupted: false });
    expect(v.input).toEqual([{ label: "command", text: "ls -la\necho done" }, { label: "why", text: "List files", inline: true }]);
    expect(v.response).toEqual([{ label: "output", text: "a\nb" }, { label: "errors", text: "warning: x", err: true }]);
  });

  it("a Bash call that was cut off says so, and one with no output says that", () => {
    expect(toolView("Bash", { command: "sleep 9" }, { stdout: "", stderr: "", interrupted: true }).response)
      .toEqual([{ label: "note", text: "interrupted before it finished", inline: true }]);
    expect(toolView("Bash", { command: "true" }, { stdout: "", stderr: "" }).response)
      .toEqual([{ label: "output", text: "none", inline: true }]);
  });
});

describe("everything else, unescaped (#816)", () => {
  it("prints an object's strings with their own newlines, nested by indent", () => {
    const out = readable({ pattern: "foo", options: { multiline: true, glob: "*.ts" }, body: "one\ntwo", empty: {} });
    expect(out).toBe(["pattern: foo", "options:", "  multiline: true", "  glob: *.ts", "body:", "  one", "  two", "empty: {}"].join("\n"));
    expect(out).not.toMatch(/\\n|"/);
  });

  it("falls back to that for any tool it has no view for, and for a shape it does not recognise", () => {
    expect(toolView("mcp__x__y", { q: "a\nb" }, "done").input).toEqual([{ text: "q:\n  a\n  b" }]);
    expect(toolView("Edit", { unexpected: true }, null).response).toEqual([{ text: "(none)" }]);
  });
});

describe("show all, and copy (#816)", () => {
  it("holds back everything past the line budget until asked", () => {
    const lines = Array.from({ length: 100 }, (_, n) => ({ text: `line ${n}` }));
    expect(clip(lines, false)).toEqual({ shown: lines.slice(0, CLIP_LINES), cut: true });
    expect(clip(lines, true)).toEqual({ shown: lines, cut: false });
  });

  it("cuts a single enormous line at the character budget", () => {
    const { shown, cut } = clip([{ text: "x".repeat(95_000) }], false);
    expect(cut).toBe(true);
    expect(shown[0].text.length).toBe(CLIP_CHARS + 1);
    expect(shown[0].text.endsWith("…")).toBe(true);
  });

  // The two cases above are both over budget, so clip's last line — the one
  // that says "nothing held back" — had never run (#1173). It is the answer for
  // almost every block the dialog shows, an Edit, a short Bash, a small Read,
  // and a wrong one puts "show all" under each of them, or drops the last line
  // of a block that exactly fills the budget.
  it("shows a block that fits in full, with nothing to show all of", () => {
    const lines = [{ text: "one" }, { text: "two" }, { text: "three" }];
    expect(clip(lines, false)).toEqual({ shown: lines, cut: false });
  });

  it("shows exactly the line budget in full, and holds back the line after it", () => {
    const at = Array.from({ length: CLIP_LINES }, () => ({ text: "a" }));
    expect(clip(at, false)).toEqual({ shown: at, cut: false });
    const over = [...at, { text: "a" }];
    expect(clip(over, false)).toEqual({ shown: at, cut: true });
  });

  it("shows exactly the character budget in full, and cuts the line that crosses it", () => {
    // A newline counts one character, so 2,999 + 1 + 3,000 is the budget to the
    // character. One more and the second line is cut to the room left, with
    // the ellipsis marking where.
    expect(CLIP_CHARS).toBe(6_000);
    const fits = [{ text: "p".repeat(2_999) }, { text: "q".repeat(3_000) }];
    expect(clip(fits, false)).toEqual({ shown: fits, cut: false });

    const crosses = [{ text: "p".repeat(2_999) }, { text: "q".repeat(3_001) }];
    const { shown, cut } = clip(crosses, false);
    expect(cut).toBe(true);
    expect(shown).toEqual([{ text: "p".repeat(2_999) }, { text: "q".repeat(3_000) + "…" }]);
  });

  it("reads a block's lines the same way whether it is a diff or text", () => {
    expect(linesOf({ text: "a\nb" })).toEqual([{ text: "a" }, { text: "b" }]);
  });

  it("copies the thing itself where a call has one, and the raw payload otherwise", () => {
    expect(copyOf("Bash", "input", { command: "ls -la", description: "x" })).toBe("ls -la");
    expect(copyOf("Bash", "response", { stdout: "out", stderr: "err" })).toBe("out\nerr");
    expect(copyOf("Read", "response", { file: { content: "text" } })).toBe("text");
    expect(copyOf("Edit", "input", EDIT_INPUT)).toBe(JSON.stringify(EDIT_INPUT, null, 2));
    expect(copyOf("Edit", "response", undefined)).toBe("");
  });
});
