// One file's unified diff parsed the way the diff pane reads it: numbered
// hunks, the header's rename/new/deleted/mode/binary facts, the 400-line /
// 20 KB first view, the files that start collapsed, and the lines that are new
// since the version a reader last saw.
import { describe, expect, it } from "vitest";
import {
  budgetHunks, collapsedKind, DIFF_BUDGET, diffState, endingOnly, endingsChange, freshLines, groupDigits, lockOwner, parsePatch, unquotePath,
} from "../git-diff-parse";

const MODIFIED = [
  "diff --git a/src/auth/session.ts b/src/auth/session.ts",
  "index b82e9ce..23b4ef7 100644",
  "--- a/src/auth/session.ts",
  "+++ b/src/auth/session.ts",
  "@@ -22,5 +22,5 @@ export function getSession(id: string): Session | undefined {",
  " export const SESSION_COOKIE = \"shop_sid\";",
  " ",
  " export function sessionCookie(session: Session): string {",
  "-  return `${SESSION_COOKIE}=${session.id}; HttpOnly; SameSite=Lax; Path=/`;",
  "+  return `${SESSION_COOKIE}=${session.id}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=28800`;",
  " }",
  "",
].join("\n");

describe("a modified file", () => {
  it("numbers every line from its hunk's ranges", () => {
    const p = parsePatch(MODIFIED);
    expect(p.hunks).toHaveLength(1);
    const h = p.hunks[0];
    expect(h.range).toBe("@@ -22,5 +22,5 @@");
    expect(h.section).toBe("export function getSession(id: string): Session | undefined {");
    expect(h.lines.map(l => [l.kind, l.old, l.new])).toEqual([
      ["ctx", 22, 22], ["ctx", 23, 23], ["ctx", 24, 24], ["del", 25, null], ["add", null, 25], ["ctx", 26, 26],
    ]);
    expect(h.lines[1].text).toBe("");
    expect(p.lineCount).toBe(6);
    expect(p).toMatchObject({ renamed: false, created: false, deleted: false, binary: false });
  });

  it("reads several hunks, and a range without a count as one line", () => {
    const p = parsePatch("@@ -1 +1 @@\n-a\n+b\n@@ -10,2 +10,3 @@ fn()\n x\n+y\n z\n");
    expect(p.hunks.map(h => [h.oldStart, h.newStart, h.lines.length])).toEqual([[1, 1, 2], [10, 10, 3]]);
    expect(p.hunks[1].lines.map(l => l.new)).toEqual([10, 11, 12]);
  });

  it("keeps an empty context line whose leading space was stripped", () => {
    const p = parsePatch("@@ -1,3 +1,3 @@\n a\n\n-b\n+c\n");
    expect(p.hunks[0].lines.map(l => l.kind)).toEqual(["ctx", "ctx", "del", "add"]);
  });

  it("notes a missing newline at the end on the line before the marker", () => {
    const p = parsePatch("@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n");
    expect(p.hunks[0].lines).toEqual([
      { kind: "del", old: 1, new: null, text: "old", noEol: true },
      { kind: "add", old: null, new: 1, text: "new", noEol: true },
    ]);
  });

  it("drops a carriage return at the end of a line", () => {
    expect(parsePatch("@@ -1 +1 @@\r\n-a\r\n+b\r\n").hunks[0].lines.map(l => l.text)).toEqual(["a", "b"]);
  });
});

describe("what a diff's header says", () => {
  it("names a rename with nothing else changed, and its similarity", () => {
    const p = parsePatch("diff --git a/src/auth/token.ts b/src/auth/jwt.ts\nsimilarity index 100%\nrename from src/auth/token.ts\nrename to src/auth/jwt.ts\n");
    expect(p).toMatchObject({ renamed: true, from: "src/auth/token.ts", similarity: 100, hunks: [] });
  });

  it("names a new file, a deleted one and a copy", () => {
    expect(parsePatch("diff --git a/x b/x\nnew file mode 100644\n--- /dev/null\n+++ b/x\n@@ -0,0 +1 @@\n+hi\n").created).toBe(true);
    const gone = parsePatch("diff --git a/x b/x\ndeleted file mode 100644\n--- a/x\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n");
    expect(gone.deleted).toBe(true);
    expect(gone.hunks[0].lines.map(l => l.old)).toEqual([1, 2]);
    expect(parsePatch("diff --git a/a b/b\nsimilarity index 91%\ncopy from a\ncopy to b\n")).toMatchObject({ copied: true, from: "a", similarity: 91 });
  });

  it("names a mode change and a binary patch", () => {
    expect(parsePatch("diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n")).toMatchObject({ oldMode: "100644", newMode: "100755" });
    expect(parsePatch("diff --git a/l.png b/l.png\nindex 1..2 100644\nBinary files a/l.png and b/l.png differ\n").binary).toBe(true);
  });

  it("does not read a header-looking line inside a hunk as a header", () => {
    const p = parsePatch("@@ -1,2 +1,2 @@\n-rename from nowhere\n+new file mode 1\n context\n");
    expect(p).toMatchObject({ renamed: false, created: false });
    expect(p.hunks[0].lines).toHaveLength(3);
  });
});

describe("what kind of answer the server gave", () => {
  it("tells a patch from a binary, an oversize diff, a folder and a failed read", () => {
    expect(diffState({ ok: true, binary: false, patch: "", added: 0, removed: 0 })).toBe("text");
    expect(diffState({ ok: true, binary: true })).toBe("binary");
    expect(diffState({ ok: true, tooLarge: true, limit: 1 << 20, oldSize: 1, newSize: 2 })).toBe("too-large");
    expect(diffState({ ok: true, directory: true })).toBe("directory");
    expect(diffState({ ok: false, reason: "timeout" })).toBe("error");
  });
});

describe("the first view of a long diff", () => {
  const big = (n: number, width = 10) => {
    const body = Array.from({ length: n }, (_, i) => `+${String(i).padStart(width, "x")}`).join("\n");
    return parsePatch(`@@ -0,0 +1,${n} @@\n${body}\n`);
  };

  it("draws 400 lines first, then 400 more a step", () => {
    const p = big(1336);
    expect(budgetHunks(p.hunks, 1)).toMatchObject({ shown: DIFF_BUDGET.lines, total: 1336 });
    expect(budgetHunks(p.hunks, 2).shown).toBe(800);
    expect(budgetHunks(p.hunks, Infinity).shown).toBe(1336);
  });

  it("stops at 20 KB when the lines are long", () => {
    const p = big(300, 199); // 200 bytes a line with its newline
    const b = budgetHunks(p.hunks, 1);
    expect(b.shown).toBeLessThan(300);
    expect(b.shown).toBe(Math.ceil(DIFF_BUDGET.bytes / 200));
  });

  it("cuts inside a hunk and keeps the hunks before it whole", () => {
    const p = parsePatch(`@@ -1,2 +1,2 @@\n-a\n+b\n@@ -100,500 +100,500 @@\n${Array.from({ length: 500 }, () => " c").join("\n")}\n`);
    const b = budgetHunks(p.hunks, 1);
    expect(b.hunks[0]).toBe(p.hunks[0]);
    expect(b.hunks[1].lines).toHaveLength(398);
  });

  it("draws a short diff whole", () => {
    expect(budgetHunks(parsePatch(MODIFIED).hunks, 1)).toMatchObject({ shown: 6, total: 6 });
  });
});

describe("files that start collapsed", () => {
  it("knows the lock files and the tool that writes each", () => {
    expect(lockOwner("package-lock.json")).toBe("npm");
    expect(lockOwner("web/yarn.lock")).toBe("Yarn");
    expect(lockOwner("Cargo.lock")).toBe("Cargo");
    expect(lockOwner("go.sum")).toBe("Go");
    expect(lockOwner("src/lock.ts")).toBeNull();
    expect(collapsedKind("pnpm-lock.yaml")).toBe("lock");
  });

  it("knows generated files by their path", () => {
    for (const p of ["src/generated/api-types.ts", "app/__generated__/schema.ts", "dist/app.min.js", "api/user.pb.go", "proto/user_pb2.py", "lib/model.g.dart"]) {
      expect(collapsedKind(p), p).toBe("generated");
    }
    expect(collapsedKind("src/generator.ts")).toBeNull();
  });

  it("knows a generated file by the mark in its first lines, once the diff is at hand", () => {
    const p = parsePatch("@@ -1,3 +1,4 @@\n // @generated by codegen\n+export type A = 1;\n x\n y\n");
    expect(collapsedKind("src/api.ts", p)).toBe("generated");
    expect(collapsedKind("src/api.ts", parsePatch("@@ -40,2 +40,2 @@\n-// @generated\n+x\n"))).toBeNull();
    expect(collapsedKind("src/api.ts", parsePatch(MODIFIED))).toBeNull();
  });
});

describe("counts", () => {
  it("groups thousands with commas, whatever the machine's locale", () => {
    expect([0, 7, 999, 1240, 1336, 1234567, -2048].map(groupDigits)).toEqual(["0", "7", "999", "1,240", "1,336", "1,234,567", "-2,048"]);
  });
});

describe("the lines that are new since the version a reader saw", () => {
  it("marks only what the newer version added", () => {
    const before = parsePatch("@@ -1,2 +1,3 @@\n a\n+b\n c\n");
    const after = parsePatch("@@ -1,2 +1,5 @@\n a\n+b\n+b2\n+b3\n c\n");
    expect([...freshLines(before, after)].sort()).toEqual(["0:2", "0:3"]);
  });

  it("uses each old line once, so a repeated line that grew is still new", () => {
    const before = parsePatch("@@ -0,0 +1 @@\n+x\n");
    const after = parsePatch("@@ -0,0 +1,2 @@\n+x\n+x\n");
    expect([...freshLines(before, after)]).toEqual(["0:1"]);
  });
});

describe("a generator's mark, and prose that only mentions one", () => {
  const head = (...lines: string[]) => parsePatch(`@@ -0,0 +1,${lines.length} @@\n${lines.map(l => `+${l}`).join("\n")}\n`);

  it("collapses a file whose first lines carry a generator's comment header", () => {
    for (const first of ["// Code generated by protoc-gen-go. DO NOT EDIT.", "# This file is autogenerated by pip-compile", "/* @generated */", " * @generated SignedSource<<x>>", "<!-- DO NOT EDIT: generated by docs-tool -->", "-- auto-generated by sqlc"]) {
      expect(collapsedKind("src/x.ts", head(first, "export const a = 1;")), first).toBe("generated");
    }
  });

  it("leaves a hand-written file alone when its text only mentions generated things", () => {
    expect(collapsedKind("src/cli.ts", head("const help = 'writes auto-generated CLI docs';", "export {};"))).toBeNull();
    expect(collapsedKind("edge/README.md", head("# cli-docs", "A small tool that writes auto-generated CLI docs.", "<!-- DO NOT EDIT below -->"))).toBeNull();
    expect(collapsedKind("notes.txt", head("# DO NOT EDIT this list by hand"))).toBeNull();
  });
});

describe("a rename from a path git had to quote", () => {
  it("reads the old path as it is, not as git quoted it", () => {
    const p = parsePatch('diff --git "a/edge/we<ird>&\\"q\'.txt" "b/edge/moved \\"q\\".txt"\nsimilarity index 66%\nrename from "edge/we<ird>&\\"q\'.txt"\nrename to "edge/moved \\"q\\".txt"\n');
    expect(p.from).toBe("edge/we<ird>&\"q'.txt");
  });

  it("decodes git's escapes, octal bytes as UTF-8 included", () => {
    expect(unquotePath('"a\\tb\\\\c\\"d"')).toBe('a\tb\\c"d');
    expect(unquotePath('"caf\\303\\251/\\360\\237\\216\\211.txt"')).toBe("café/🎉.txt");
    expect(unquotePath("plain/path.txt")).toBe("plain/path.txt");
  });
});

describe("a change of line endings alone", () => {
  const crlfToLf = "@@ -1,3 +1,3 @@\n-one\r\n-two\r\n-three\r\n+one\n+two\n+three\n";

  it("keeps that a line ended in a carriage return", () => {
    const lines = parsePatch(crlfToLf).hunks[0].lines;
    expect(lines.map(l => [l.kind, l.text, !!l.cr])).toEqual([
      ["del", "one", true], ["del", "two", true], ["del", "three", true], ["add", "one", false], ["add", "two", false], ["add", "three", false],
    ]);
  });

  it("pairs the lines that changed only their ending, and names the change when that is all that changed", () => {
    const p = parsePatch(crlfToLf);
    expect([...endingOnly(p.hunks[0].lines)].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    expect(endingsChange(p)).toBe("CRLF → LF");
    expect(endingsChange(parsePatch("@@ -1 +1 @@\n-a\n+a\r\n"))).toBe("LF → CRLF");
    // A line whose text changed too is an ordinary change.
    const mixed = parsePatch("@@ -1,2 +1,2 @@\n-one\r\n-two\r\n+one\n+2\n");
    expect([...endingOnly(mixed.hunks[0].lines)].sort()).toEqual([0, 2]);
    expect(endingsChange(mixed)).toBeNull();
    // A CRLF file with a real edit is not a change of endings.
    expect(endingsChange(parsePatch("@@ -1 +1 @@\n-a\r\n+b\r\n"))).toBeNull();
  });
});
