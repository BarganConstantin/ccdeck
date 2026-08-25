// A control byte in a source file, and the search tool that goes quiet about it.
//
// `src/server/index.mjs` carried two raw NUL bytes: a separator written as the
// byte itself rather than as an escape, once in a comment and once in the
// template literal that builds the session-name signature. The string the
// program computed was correct, and nothing about the running deck was wrong.
//
// What was wrong is that grep classifies a file containing NUL as binary and
// skips it. Not "reports it differently": skips it, printing nothing and exiting
// 1, with `-c` and under `LC_ALL=C` alike. The file it happened to is the
// largest server file in the repo — every HTTP route, the SSE fan-out, the event
// ring, the transcript scanner — so `grep -rn` across src/ silently answered
// "not found" for 3272 lines of it.
//
// That is the worst shape a search failure can take. A zero-hit grep reads as
// proof of absence, and it was believed: a review agent reported a real defect
// in `nameBySession`, the grep run to check it came back empty, and the finding
// was nearly thrown away as fabricated. The same false negative had already sent
// an earlier search for the account routes to the wrong conclusion.
//
// So this is not a style rule. Source files are read by tools that treat a NUL
// as a signal to stop, and none of those tools says so. A control byte is also
// invisible in every editor that renders it as nothing, which is why review
// cannot be the thing that catches this.
//
// Written as an escape instead, the same separator is ASCII text: it produces
// the identical string at runtime and leaves the file searchable. The rule below
// is about bytes, so escapes are never what it catches.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const repo = fileURLToPath(new URL("../../..", import.meta.url));

/** Where hand-written source lives. `dist/` is a build artefact and
 *  `node_modules/` is not ours; both may legitimately hold binary content. */
const ROOTS = ["src", "bin", "hook", ".github"];

/** Extensions that are text by definition. Deliberately an allowlist rather
 *  than a denylist: a `.png` added under src/ some day is not a regression, and
 *  a new text extension missing from this list is a smaller loss than a sweep
 *  that starts failing on a legitimate binary. */
const TEXT = /\.(mjs|cjs|js|jsx|ts|tsx|css|html|json|md|yml|yaml)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (TEXT.test(entry)) out.push(full);
  }
  return out;
}

describe("source files a search tool can actually read", () => {
  it("contains no NUL byte anywhere under src, bin, hook or .github", () => {
    const guilty: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(join(repo, root))) {
        const bytes = readFileSync(file);
        const at = bytes.indexOf(0);
        if (at === -1) continue;
        // The line number, because "somewhere in a 3272-line file" is not a
        // useful failure message for a character that renders as nothing.
        const line = bytes.subarray(0, at).toString("utf8").split("\n").length;
        guilty.push(`${file.slice(repo.length)}:${line}`);
      }
    }
    expect(
      guilty,
      "a raw NUL byte makes grep skip the whole file in silence — write it as an escape instead",
    ).toEqual([]);
  });
});
