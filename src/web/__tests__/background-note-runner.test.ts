// The line a backgrounded deck leaves names the runner that started it.
//
// Since the deck learnt that pnpm dlx, bunx and yarn dlx are one-off copies
// like npx's, it stopped offering them a login item — but the launcher still
// asked only `isNpxInstall` what to print once the deck had gone to the
// background. A `pnpm dlx ccdeck` run was told "`ccdeck --stop` ends it", a
// command that is not on PATH after a one-off run, and was never told how to
// get a copy that starts at login, which an npx run is.
//
// None of these runners leaves the package's command on PATH, so both lines go
// through the runner that was used: the one that ends the deck, and the one
// that installs it for good.
import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";

// @ts-expect-error — plain .mjs module, no types
const { oneOffRunner } = await import("../../server/self-update.mjs");
// @ts-expect-error — plain .mjs module, no types
const { backgroundNote } = await import("../../server/detach.mjs");
// @ts-expect-error — plain .mjs module, no types
const { glyphs, palette } = await import("../../server/term.mjs");

const ROOT = mkdtempSync(join(tmpdir(), "ccdeck-runner-note-"));
afterAll(() => rmTempDir(ROOT));

/** Where each runner unpacks the package, under ROOT. */
function deckAt(...rel: string[]): string {
  const dir = join(ROOT, ...rel);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const RUNS: [runner: string, root: string][] = [
  ["npx", deckAt(".npm", "_npx", "4f1c2a", "node_modules", "ccdeck")],
  ["pnpm dlx", deckAt("cache", "pnpm", "dlx", "k3v2", "1912a2e3a4c-5d1a", "node_modules", ".pnpm", "ccdeck@3.0.0", "node_modules", "ccdeck")],
  ["pnpm dlx", deckAt("dlx-48211", "node_modules", ".pnpm", "ccdeck@3.0.0", "node_modules", "ccdeck")],
  ["bunx", deckAt("bunx-1000-ccdeck@latest", "node_modules", "ccdeck")],
  ["yarn dlx", deckAt("xfs-1a2b3c4d", "dlx-48212", "node_modules", "ccdeck")],
];

const plain = { tone: palette("none"), g: glyphs(true) };

describe("the background line after a one-off run", () => {
  for (const [runner, root] of RUNS) {
    it(`ends it and installs it through ${runner}`, () => {
      expect(oneOffRunner(root)).toBe(runner);
      const note = backgroundNote({ runner: oneOffRunner(root), invokedAs: null, product: "ccdeck", ...plain });
      expect(note).toContain(`\`${runner} ccdeck --stop\` ends it`);
      expect(note).toContain(`\`${runner} ccdeck --install\` also starts it at login`);
    });
  }

  it("says the plain command for a copy that stays", () => {
    const global = deckAt("usr", "lib", "node_modules", "ccdeck");
    expect(oneOffRunner(global)).toBeNull();
    expect(backgroundNote({ runner: oneOffRunner(global), invokedAs: "ccdeck", ...plain }))
      .toBe("  —  running in the background · `ccdeck --stop` ends it\n\n");
  });

  it("is asked by the launcher of the copy it is running from", () => {
    const launcher = readFileSync(fileURLToPath(new URL("../../../bin/agent-dag.js", import.meta.url)), "utf8");
    expect(launcher).toContain("const runner = oneOffRunner(PKG_ROOT);");
    expect(launcher).toMatch(/backgroundNote\(\{ runner, /);
  });
});
