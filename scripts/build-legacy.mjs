#!/usr/bin/env node
// Builds the tiny package that keeps an old name working.
//
// `node scripts/build-legacy.mjs <name> [outDir]` writes a complete, publishable
// package directory for one of the deck's retired names. The result is a
// manifest, the shim, and a README that says the one thing a reader of that
// page needs — nothing else, because everything else lives in ccdeck.
//
// The version it stamps is the deck's own, so `agent-dag@3.23.0` and
// `ccdeck@3.23.0` are the same release of the same product and a reader
// comparing the two version numbers is not misled. What it depends on is the
// deck at exactly that version's major line, so an old name never resolves to a
// deck older than itself.
import { mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

/** The names that are doors rather than the deck, and nothing else may be
 *  built: a typo here would publish a shim over a real package. */
const LEGACY = new Set(["agents-deck", "agent-dag"]);

const name = process.argv[2];
const outDir = resolve(process.argv[3] ?? join(ROOT, "dist", "legacy", String(name)));

if (!LEGACY.has(name)) {
  console.error(`build-legacy: ${name ?? "(no name)"} is not one of the retired names: ${[...LEGACY].join(", ")}`);
  process.exit(1);
}

const deck = require(join(ROOT, "package.json"));
const version = deck.version;
const major = String(version).split(".")[0];

// A CLEAN DIRECTORY EVERY TIME. A leftover file from a previous build would be
// published without ever appearing in this script, which is the kind of thing
// nobody finds until it is on the registry.
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const manifest = {
  name,
  version,
  // Said in the one place npm shows before anything is installed.
  description: `Renamed to ccdeck. This package installs and starts ccdeck for you — run \`npx ccdeck\` instead.`,
  license: deck.license,
  repository: deck.repository,
  homepage: deck.homepage,
  type: "module",
  // The same command that has always worked, pointing at the door.
  bin: { [name]: "shim.js" },
  files: ["shim.js", "README.md"],
  // The deck, at this release's own major line. Not `*`: a name from a
  // three-year-old lockfile must not silently pull a deck two majors newer
  // than the one it was pinned beside.
  dependencies: { ccdeck: `^${major}` },
  engines: deck.engines,
  keywords: deck.keywords,
};

writeFileSync(join(outDir, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
copyFileSync(join(ROOT, "legacy", "shim.js"), join(outDir, "shim.js"));
writeFileSync(join(outDir, "README.md"), `# ${name}

This is the old name for **[ccdeck](https://www.npmjs.com/package/ccdeck)**.

\`\`\`
npx ccdeck
\`\`\`

Running \`npx ${name}\` still works and will keep working — it installs ccdeck
and starts it. There is nothing else in this package, and it is not where the
deck is developed or documented.
`);

console.log(`build-legacy: ${name}@${version} -> ${outDir} (depends on ccdeck@^${major})`);
