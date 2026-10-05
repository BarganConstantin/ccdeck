// pnpm dlx, bunx and yarn dlx are one-off runs, the way npx is.
//
// Only npm's `_npx` cache was recognised, so every other one-off runner looked
// like a global install. Two things followed. The first start wrote a login
// item naming bin/agent-dag.js inside the runner's cache or temp folder —
// bunx's is /tmp/bunx-<uid>-…, cleared at reboot — recorded it as installed so
// it was never offered again, and said "will now start when you log in". And
// the folder was writable, so the update mode was "install": the away-update
// ran `npm install -g ccdeck@latest` by itself, a global copy the user never
// asked for, which left the running copy's version where it was — so the same
// install ran again every thirty minutes the user was away.
//
// Nothing here installs or registers anything: the layouts are directories in
// a temp folder, and only the predicates and the refusal are asked about them.
import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";
import { sourceOf } from "./client-source";

// @ts-expect-error — plain .mjs module, no types
const { isOneOffRun, upgradeBlock, upgradeMode, upgradeCommand } = await import("../../server/self-update.mjs");
// @ts-expect-error — plain .mjs module, no types
const { shouldOfferService } = await import("../../server/login-service.mjs");

const LOGIN_ITEM = readFileSync(fileURLToPath(new URL("../../../bin/cli/login-item.js", import.meta.url)), "utf8");
const BANNER = sourceOf("components/VersionBanner.tsx");

const ROOT = mkdtempSync(join(tmpdir(), "ccdeck-one-off-"));
afterAll(() => rmTempDir(ROOT));
afterEach(() => vi.unstubAllEnvs());

/** A deck unpacked at `rel` under ROOT, writable, the way each runner leaves it. */
function deckAt(...rel: string[]): string {
  const dir = join(ROOT, ...rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "ccdeck", version: "3.0.0" }));
  return dir;
}

const RUNS: [runner: string, root: string][] = [
  ["pnpm dlx", deckAt("cache", "pnpm", "dlx", "k3v2", "1912a2e3a4c-5d1a", "node_modules", ".pnpm", "ccdeck@3.0.0", "node_modules", "ccdeck")],
  ["pnpm dlx before its cache", deckAt("dlx-48211", "node_modules", ".pnpm", "ccdeck@3.0.0", "node_modules", "ccdeck")],
  ["bunx", deckAt("bunx-1000-ccdeck@latest", "node_modules", "ccdeck")],
  ["yarn dlx", deckAt("xfs-1a2b3c4d", "dlx-48212", "node_modules", "ccdeck")],
];

describe("a deck started by a one-off runner", () => {
  for (const [runner, root] of RUNS) {
    it(`is not installed over, under ${runner}`, () => {
      vi.stubEnv("AGENTS_DECK_NO_INSTALL", "");
      vi.stubEnv("CCDECK_APP", "");
      const blocked = upgradeBlock(root);
      expect(blocked, "the away-update would run `npm i -g` from here").toBe("one_off");
      expect(upgradeMode(blocked)).toBeNull();
      // The command is still on screen, for the user to run if they want a
      // copy that stays.
      expect(upgradeCommand(root)).toBe("npm i -g ccdeck@latest");
    });

    it(`is not given a login item, under ${runner}`, () => {
      expect(isOneOffRun(root)).toBe(true);
      expect(shouldOfferService({ record: null, npx: isOneOffRun(root), env: {} })).toBe(false);
    });
  }

  it("is still npx's own answer under npx", () => {
    vi.stubEnv("AGENTS_DECK_NO_INSTALL", "");
    vi.stubEnv("CCDECK_APP", "");
    const npx = deckAt("npm", "_npx", "a1b2c3", "node_modules", "ccdeck");
    expect(isOneOffRun(npx)).toBe(true);
    expect(upgradeBlock(npx)).toBe("npx");
  });

  it("leaves a global install, and a directory that only looks like a cache, alone", () => {
    vi.stubEnv("AGENTS_DECK_NO_INSTALL", "");
    vi.stubEnv("CCDECK_APP", "");
    const global = deckAt("prefix", "lib", "node_modules", "ccdeck");
    expect(isOneOffRun(global)).toBe(false);
    expect(upgradeBlock(global)).toBeNull();
    for (const p of ["/home/u/dlx-tools/lib/node_modules/ccdeck", "/home/u/bunx/lib/node_modules/ccdeck", "C:\\Users\\u\\my_dlx\\node_modules\\ccdeck"]) {
      expect(isOneOffRun(p), p).toBe(false);
    }
  });

  it("is asked about by both login-item entry points, and explained in the banner", () => {
    // offerLoginItem's PKG_ROOT is this checkout, so the call site is read:
    // the first start and `--install-service` both ask the wider question.
    expect(LOGIN_ITEM).toContain("npx: isOneOffRun(PKG_ROOT),");
    expect(LOGIN_ITEM).toContain("if (isOneOffRun(PKG_ROOT)) {");
    expect(LOGIN_ITEM).not.toContain("npx: isNpxInstall(PKG_ROOT)");
    expect(BANNER).toMatch(/^\s+one_off: "/m);
  });
});
