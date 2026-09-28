// The version this process is running, read once, at import.
//
// Two modules report it and must agree: index.mjs, which answers /api/version
// with it and hands it to the away-update, and lan-deck.mjs, whose card tells
// paired decks what this one runs. It was a constant in index.mjs until the
// LAN engine moved out, and a second read in the second file would be a second
// answer to "what is running", taken at a slightly different moment. So it is
// read here, and both import it; index.mjs imports this statically, so the
// read still happens at boot.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Resolved the way index.mjs resolves it, from a file in the same directory.
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Read at import — i.e. at boot, before an upgrade can overwrite these files.
// Reading it later would report whatever npm has since installed and hide the
// exact drift /api/version exists to expose. See src/server/self-update.mjs.
export const RUNNING_VERSION = (() => {
  try { return JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"))?.version ?? null; }
  catch { return null; }
})();
