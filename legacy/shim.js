#!/usr/bin/env node
// The old names, kept working.
//
// This deck was published under three names for its whole life — `ccdeck`,
// `agents-deck` and `agent-dag` — and the README, the banner and the docs have
// pointed at `ccdeck` for a long time. Publishing one product three times is a
// cost paid on every release forever, and a person reading two different
// commands for one tool has to work out that they are the same tool.
//
// SO THE OTHER TWO STOP BEING THE DECK AND BECOME A DOOR TO IT. They depend on
// `ccdeck`, print the command to use next time, and hand over. Nothing anybody
// has typed into a script or an alias stops working, and nobody is left on a
// version that quietly never updates again.
//
// A DEPENDENCY RATHER THAN `npx ccdeck`. Spawning npx would mean a second
// registry resolution on every single start — slower, and a hard requirement on
// the network even when everything needed is already on disk. Declaring the
// dependency makes npm fetch the deck once, alongside this, and this then runs
// the binary out of node_modules. One resolution, no runtime fetch.
//
// WHAT IT MUST NOT DO is get in the way. The notice goes to stderr so a script
// reading stdout is unaffected, every argument is passed through untouched,
// the child inherits the terminal so the deck's own output is unchanged, and
// the exit code is the deck's. Somebody who never reads the notice still gets
// exactly the deck they asked for.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/** The name this copy was started as, for a notice that names the right thing.
 *
 *  From the manifest sitting beside this file, not from `npm_package_name`:
 *  npm sets that for lifecycle scripts and NOT for a bin, so the first version
 *  of this printed "this package is the old name" to anybody who ran it. */
function calledAs() {
  try {
    return require(new URL("./package.json", import.meta.url).pathname).name || "this package";
  } catch {
    return "this package";
  }
}
const CALLED_AS = calledAs();

/** Where the real deck's launcher is.
 *
 *  Resolved through `ccdeck`'s own manifest rather than by guessing a path:
 *  a dependency can be hoisted to a parent `node_modules`, nested under this
 *  one, or linked, and only the resolver knows which happened here. */
function deckLauncher() {
  let manifestPath;
  try {
    manifestPath = require.resolve("ccdeck/package.json");
  } catch {
    return null;
  }
  const root = dirname(manifestPath);
  let bin;
  try {
    bin = require(manifestPath).bin;
  } catch {
    return null;
  }
  // `bin` is a string for a single-binary package and a map for this one.
  const rel = typeof bin === "string" ? bin : bin?.ccdeck ?? Object.values(bin ?? {})[0];
  if (typeof rel !== "string") return null;
  const full = join(root, rel);
  return existsSync(full) ? full : null;
}

const launcher = deckLauncher();

if (!launcher) {
  // Say what to run rather than what went wrong internally: the reader's next
  // move is the same either way, and it is one command.
  process.stderr.write(
    `\n  ${CALLED_AS} is now a pointer to ccdeck, and ccdeck could not be found beside it.\n` +
    `  Run this instead:\n\n      npx ccdeck\n\n`,
  );
  process.exit(1);
}

process.stderr.write(
  `\n  ${CALLED_AS} is the old name for this deck. It still works and always will.\n` +
  `  The name it is published under now is ccdeck:\n\n      npx ccdeck\n\n` +
  `  Starting it for you.\n\n`,
);

// `inherit` on all three, so the deck owns the terminal exactly as it would if
// it had been started directly — its prompts, its colours, its Ctrl-C.
const child = spawn(process.execPath, [launcher, ...process.argv.slice(2)], { stdio: "inherit" });

// The deck's exit is this process's exit, signal included: a supervisor reading
// the code has to see what the deck actually did, not what a wrapper decided.
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
child.on("error", err => {
  process.stderr.write(`\n  Could not start ccdeck: ${err?.message ?? err}\n\n      npx ccdeck\n\n`);
  process.exit(1);
});
