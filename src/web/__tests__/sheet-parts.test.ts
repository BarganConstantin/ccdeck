// The sheet is a list of parts, and three things keep that list safe.
//
// It holds nothing but the list. @import has to come before every rule, so a
// rule written in styles.css itself can only go after all the imports. It
// would cascade after every part, whatever part its subject belongs to.
//
// Every part is on it exactly once, and no part imports another. A part left
// off the list is a stylesheet nobody loads. A part imported twice, or from
// inside another part, cascades twice, and the second copy wins.
//
// Every part begins and ends between two rules. The list is only the old file
// when it is read in order, and a part cut inside a block or a comment would
// hold half of something that cannot be moved without the other half.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sheetParts } from "./sheet-source";
import { clientPairs } from "./client-source";

const WEB_DIR = fileURLToPath(new URL("../", import.meta.url));

/** Where a scan of `css` ends: how many blocks are still open, and whether it
 *  is inside a comment. Quoted strings are skipped, since a brace in a
 *  `content: "{"` is not one. */
function endState(css: string): { depth: number; inComment: boolean } {
  let depth = 0, inComment = false;
  for (let i = 0; i < css.length; i++) {
    if (inComment) {
      if (css.startsWith("*/", i)) { inComment = false; i++; }
      continue;
    }
    if (css.startsWith("/*", i)) { inComment = true; i++; continue; }
    const c = css[i];
    if (c === '"' || c === "'") {
      const close = css.indexOf(c, i + 1);
      i = close < 0 ? css.length : close;
    } else if (c === "{") depth++;
    else if (c === "}") depth--;
  }
  return { depth, inComment };
}

describe("styles.css", () => {
  it("is the list of parts and nothing else", () => {
    const list = readFileSync(`${WEB_DIR}styles.css`, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map(line => line.trim())
      .filter(Boolean);
    expect(list.length).toBeGreaterThan(0);
    for (const line of list) expect(line).toMatch(/^@import "\.\/styles\/[a-z0-9-]+\.css";$/);
  });

  it("names every part in styles/ exactly once", () => {
    const listed = sheetParts().map(([path]) => path);
    const onDisk = readdirSync(`${WEB_DIR}styles`).filter(f => f.endsWith(".css")).map(f => `styles/${f}`);
    expect(new Set(listed).size, "a part is imported twice").toBe(listed.length);
    expect([...listed].sort()).toEqual([...onDisk].sort());
  });
});

describe("each part", () => {
  it("imports nothing itself", () => {
    for (const [path, css] of sheetParts()) expect(css, path).not.toMatch(/@import\b/);
  });

  it("begins and ends between two rules", () => {
    for (const [path, css] of sheetParts()) {
      expect(endState(css), path).toEqual({ depth: 0, inComment: false });
      expect(css.endsWith("\n"), `${path} ends mid-line`).toBe(true);
    }
  });

  it("is loaded only through the list", () => {
    // main.tsx imports styles.css. A component that imported a part directly
    // would put a second copy of it into the bundle, out of its place.
    const direct = clientPairs()
      .filter(([, text]) => /from\s+["'][^"']*styles\/[a-z0-9-]+\.css["']|import\s+["'][^"']*styles\/[a-z0-9-]+\.css["']/.test(text))
      .map(([file]) => file);
    expect(direct).toEqual([]);
  });
});
