// CLI_FILES is the list every CLI negative sweeps and every hand-built package
// copies, so a file lifted out of bin/deck.js and left off it is invisible to
// both: a negative that should now fail passes, and a boot test's package has
// a worker that cannot import it. This pins the list to what bin/cli/ holds.
import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { CLI_FILES, REPO_DIR, cliSurface } from "./cli-surface";

describe("the CLI surface", () => {
  it("lists bin/deck.js and every file in bin/cli/", () => {
    const onDisk = readdirSync(join(REPO_DIR, "bin", "cli"))
      .filter(f => f.endsWith(".js"))
      .map(f => `bin/cli/${f}`)
      .sort();
    const listed = CLI_FILES.filter(f => f !== "bin/deck.js").sort();
    expect(listed).toEqual(onDisk);
    expect(CLI_FILES[0]).toBe("bin/deck.js");
  });

  it("reads every one of them", () => {
    const surface = cliSurface();
    // A line only help.js has, one only second-start.js has, and deck.js's
    // call into it: the first file lifted out, the latest, and the entry.
    expect(surface).toContain("export function printHelp()");
    expect(surface).toContain("export async function settleSecondStart(");
    expect(surface).toContain("await settleSecondStart(");
  });
});
