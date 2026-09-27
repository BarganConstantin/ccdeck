// Every client source file, for the sweeps that read code rather than run it.
//
// The walk below was written three times — board-scope-687, panel-memo-revision
// and render-path-cost-612-613 each carried a byte-identical copy — which is one
// copy per test that needed it and no copies left over for the next one. It is
// here now, once.
//
// `clientText` is the part that did not exist, and it is the reason this file
// was worth making. Seventy-six test files name `../App.tsx` and assert on its
// text, which is a fine way to pin an invariant a runtime test cannot reach and
// a poor way to say where the invariant lives: lifting one concern out of
// `Inner` into a hook breaks those assertions by construction, with the
// behaviour byte-identical. An assertion whose intent is *the client wires it
// this way* should read the client, not one of its files, and then a move is
// invisible to it. An assertion that genuinely means *this file* keeps naming
// the file — `sourceOf` is for those, and theme-first-paint.test.ts is the kind
// of case that wants it.
//
// Comments are stripped through tsx-scan's `withoutComments` rather than a
// fourth local regex, because this suite's prose quotes the code it retired: a
// scan that keeps comments finds the shape a fix removed, written down in the
// explanation of its own fix. Two tests still carry their own strippers, one of
// which drops comment lines instead of blanking them. Consolidating those
// changes what those tests see, so it is deliberately not part of this change.
//
// Everything is cached. 370 of this suite's 608 files read source as text, and
// re-walking the tree and re-stripping it per file is work nobody asked for.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { withoutComments } from "./tsx-scan";

/** `src/web`, with a trailing separator, resolved from this file. */
export const WEB_DIR = fileURLToPath(new URL("..", import.meta.url));

/**
 * Absolute paths of every `.ts` and `.tsx` under `dir`, tests excluded.
 *
 * `__tests__` is skipped by name rather than by path so a nested one is skipped
 * too, which is what the three copies did and what callers built on: a sweep
 * asserting something "appears nowhere in the client" must not find it in the
 * test that asserts its absence.
 */
export function clientSources(dir: string = WEB_DIR): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : clientSources(path);
    return path.endsWith(".ts") || path.endsWith(".tsx") ? [path] : [];
  });
}

/** Forward slashes on every platform, so a failure reads the same on Windows. */
const relative = (path: string) => path.slice(WEB_DIR.length).replaceAll("\\", "/");

let pairs: [string, string][] | null = null;

/**
 * `[relative path, source with comments stripped]` for the whole client, read
 * once per process.
 *
 * The path is relative and slash-normalised because it ends up in failure
 * messages, and `sources.find(([p]) => p === "App.tsx")` is how callers reach
 * one file — which is the shape the three copies already produced.
 */
export function clientPairs(): readonly [string, string][] {
  pairs ??= clientSources().map(p => [relative(p), withoutComments(readFileSync(p, "utf8"))]);
  return pairs;
}

let joined: string | null = null;

/**
 * The whole client as one string, comments gone.
 *
 * For an assertion that means *the client does this*, wherever it is written.
 * Prefer it over naming a file whenever the file is not the point, so that
 * moving the code does not move the test.
 *
 * Files are separated by a newline and nothing else, so a pattern cannot match
 * across two of them by accident of adjacency — and for the same reason a
 * pattern that must not span files should anchor on a line.
 */
export function clientText(): string {
  joined ??= clientPairs().map(([, src]) => src).join("\n");
  return joined;
}

/**
 * One client file by its relative path (`"App.tsx"`, `"use-pause-gate.ts"`),
 * comments gone.
 *
 * Throws when the path is not a client source, because a silent `undefined`
 * turns into an assertion that passes against nothing — the failure mode this
 * whole file exists to avoid.
 */
export function sourceOf(rel: string): string {
  const hit = clientPairs().find(([p]) => p === rel);
  if (!hit) throw new Error(`no client source at ${rel} — paths are relative to src/web, e.g. "App.tsx"`);
  return hit[1];
}
