// The deck's command line as one text, for the assertions that say what it does
// NOT do — and the one place that knows which files make up the worker.
//
// bin/deck.js is being taken apart one concern at a time, and the pieces land
// in bin/cli/. An assertion that means "this piece does this" reads the file
// that owns it. A negative, a count or a slice cannot do that: "no printed
// string carries an em dash", asked of deck.js alone, passes vacuously the
// moment the string moves out of it — which is the one outcome a negative must
// never have. So those read this instead: deck.js and every file lifted out of
// it, in one string, so whatever file now owns the code is still inside the
// sweep.
//
// Raw rather than comment-stripped, joined by a newline and nothing else, the
// way accounts-surface.ts does it, so a line-anchored pattern cannot span two
// files and each test keeps stripping comments its own way.
//
// `copyWorker` is the other half. Six boot tests build an install layout by
// hand — the real bin/ beside a src/server/ of `export *` shims — and they used
// to copy bin/deck.js alone, which is no longer a worker that can start: it
// imports what was lifted out of it. A file extracted from deck.js is added to
// CLI_FILES in the same change, and every layout picks it up from here.
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root, with a trailing separator, resolved from this file. */
export const REPO_DIR = fileURLToPath(new URL("../../../", import.meta.url));

/** The worker and what was lifted out of it, relative to the repo root. */
export const CLI_FILES = [
  "bin/deck.js",
  "bin/cli/help.js",
  "bin/cli/package.js",
  "bin/cli/uninstall.js",
  "bin/cli/login-item.js",
  "bin/cli/one-shot.js",
  "bin/cli/screen.js",
  "bin/cli/startup.js",
] as const;

let joined: string | null = null;

/** Every file in CLI_FILES, raw, joined by a newline. */
export function cliSurface(): string {
  joined ??= CLI_FILES.map(rel => readFileSync(join(REPO_DIR, rel), "utf8")).join("\n");
  return joined;
}

/** One file of the worker, raw. `rel` is relative to the repo root. */
export function cliSource(rel: (typeof CLI_FILES)[number]): string {
  return readFileSync(join(REPO_DIR, rel), "utf8");
}

/**
 * Copy the worker into a package being assembled by hand: every file in
 * CLI_FILES, from `fromBin` (a real `bin/`) to `toBin`, keeping the layout
 * under `bin/`. agent-dag.js is not part of it — the supervisor is copied, or
 * stubbed, by each test on its own terms.
 */
export function copyWorker(fromBin: string, toBin: string): void {
  for (const rel of CLI_FILES) {
    const under = rel.slice("bin/".length);
    mkdirSync(dirname(join(toBin, under)), { recursive: true });
    copyFileSync(join(fromBin, under), join(toBin, under));
  }
}
