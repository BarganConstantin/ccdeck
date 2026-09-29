// Which package this worker belongs to, and the name it was started under.
//
// Worked out from where THIS file is, so a copy of bin/ in another tree — an npx
// cache, a package a test assembled by hand — answers for that tree and not for
// the one it was copied from. Lifted out of bin/deck.js so that every file in
// bin/cli/ imports the three answers instead of having them handed down.
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { PRODUCT } from "../../src/server/brand.mjs";
import { invokedName } from "../../src/server/invoked-as.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PKG_ROOT = resolve(__dirname, "../..");

/**
 * The version package.json names right now, or null when it cannot be read.
 *
 * Asked twice in a deck's life, and the second answer is only worth having
 * because it can differ from the first: once at boot, for the version this
 * process runs, and again as a restart is about to land, for the version it
 * will land on — whatever an upgrade has installed underneath it since.
 */
export function versionOnDisk() {
  try { return JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")).version ?? null; }
  catch { return null; }
}

export const PKG_VERSION = versionOnDisk() ?? "0.0.0";

// The command the user typed, handed down by the supervisor — the worker's own
// argv[1] is bin/deck.js under every one of the three names. Null when it cannot be
// proven, and null is the answer that prints nothing.
export const INVOKED_AS = invokedName({ pkgRoot: PKG_ROOT });

// The command a hint tells somebody to type: the one they typed, or ours when
// that cannot be told (#1501). INVOKED_AS stays null in that case for the one
// caller that must say nothing rather than guess — the rename notice.
export const COMMAND = INVOKED_AS ?? PRODUCT;
