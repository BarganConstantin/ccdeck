// A machine with no npm at all: the desktop app's first run without Node.
//
// Reproduced on a clean Windows VM with the 3.46.0 app: the boot logged
// `ccusage: install failed: npm install ccusage failed: '"npm.cmd"' is not
// recognized`, the npx fallback failed with the same words, and /api/ccusage
// answered run_failed at stage npx for as long as the deck ran. The managed
// install now comes from the registry when no npm can be found
// (ccusage-registry.mjs), and its failure is reported as itself rather than as
// an npx that was never going to be there.
//
// npm is taken away the way the machine lacks it: no npm-cli.js beside Node, no
// npm.cmd shim, nothing named npm on PATH. Every child is faked, and the
// registry is fake-npm-registry.ts, so nothing here is spawned or downloaded.
import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
import { REGISTRY, fakeRegistry } from "./fake-npm-registry";
import { CCUSAGE_REASONS, explainCcusageFailure } from "../admin-failure";

const { calls, fakeChild } = vi.hoisted(() => {
  type Sub = (v?: unknown) => void;
  return {
    calls: [] as { file: string; args: string[] }[],
    fakeChild: (stdout: string) => {
      const out: Sub[] = [], self: Record<string, Sub[]> = {};
      setTimeout(() => {
        out.forEach(cb => cb(stdout));
        self.close?.forEach(cb => cb(0));
      }, 0);
      return {
        pid: 4242,
        stdout: { on: (_ev: string, cb: Sub) => { out.push(cb); } },
        stderr: { on: () => {} },
        on: (ev: string, cb: Sub) => { (self[ev] ||= []).push(cb); },
        kill: () => {},
        unref: () => {},
      };
    },
  };
});

vi.mock("node:child_process", () => ({
  spawn: (file: string, args: string[] = []) => {
    calls.push({ file, args });
    return fakeChild(`{"daily":[],"totals":null}`);
  },
  execFile: () => { throw new Error("test: execFile blocked"); },
}));

// No npm-cli.js beside Node, and no npm.cmd shim — the two places npmSpec looks
// before PATH, which is emptied below.
vi.mock("../../server/npx.mjs", async (actual) => ({
  ...(await actual<Record<string, unknown>>()),
  npmCliLaunch: () => null,
}));
vi.mock("../../server/exec.mjs", async (actual) => ({
  ...(await actual<Record<string, unknown>>()),
  shimPath: () => null,
}));

// ~/.agents-deck/ccusage is resolved at import time, so HOME moves first.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-ccusage-bare-machine-"));
const prevEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  PATH: process.env.PATH,
  AGENTS_DECK_NO_INSTALL: process.env.AGENTS_DECK_NO_INSTALL,
  AGENTS_DECK_CCUSAGE: process.env.AGENTS_DECK_CCUSAGE,
  npm_config_registry: process.env.npm_config_registry,
};
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.PATH = FAKE_HOME;
delete process.env.AGENTS_DECK_NO_INSTALL;
delete process.env.AGENTS_DECK_CCUSAGE;
// `npm test` exports the real registry to everything it runs.
process.env.npm_config_registry = REGISTRY;

// @ts-expect-error — .mjs server module, no types
const { fetchCcusageDaily } = await import("../../server/ccusage.mjs");
// @ts-expect-error — .mjs server module, no types
const { npmAvailable } = await import("../../server/ccusage-install.mjs");

const CCUSAGE_DIR = join(FAKE_HOME, ".agents-deck", "ccusage");
const PKG_DIR = join(CCUSAGE_DIR, "node_modules", "ccusage");
if (!PKG_DIR.startsWith(FAKE_HOME)) throw new Error(`refusing to run: ${PKG_DIR} escaped ${FAKE_HOME}`);

afterAll(() => {
  vi.unstubAllGlobals();
  for (const [key, was] of Object.entries(prevEnv)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  rmTempDir(FAKE_HOME);
});

beforeEach(() => {
  calls.length = 0;
  rmTempDir(join(FAKE_HOME, ".agents-deck"));
});

const quietly = async <T>(work: () => Promise<T>): Promise<T> => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try { return await work(); } finally { spy.mockRestore(); }
};

const mentionsNpm = (c: { file: string; args: string[] }) => /\bnp[mx]\b|np[mx]\.cmd|np[mx]-cli/.test([c.file, ...c.args].join(" "));

describe("a machine with no npm", () => {
  it("is one this module can tell apart", () => {
    expect(npmAvailable()).toBe(false);
  });

  it("downloads ccusage from the registry and runs it, with no npm or npx child", async () => {
    const reg = fakeRegistry();
    vi.stubGlobal("fetch", reg.fetch);

    const res = await quietly(() => fetchCcusageDaily({ since: "20260401", force: true }));

    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8")).version).toBe("20.1.0");
    expect(calls.filter(mentionsNpm)).toEqual([]);
    // The run is the managed install's: `node <entry>` on macOS and Linux, the
    // native binary inside it on Windows. Either way, out of PKG_DIR.
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect([c.file, ...c.args].join(" ")).toContain(PKG_DIR);
  });

  it("reports a failed download as itself, not as an npx that is not there", async () => {
    vi.stubGlobal("fetch", fakeRegistry({ status: 503 }).fetch);

    const res = await quietly(() => fetchCcusageDaily({ since: "20260402", force: true }));

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("fetch_failed");
    expect(res.stage).toBeUndefined();
    expect(res.error).toMatch(/no npm/);
    expect(res.error).toMatch(/503/);
    expect(calls).toEqual([]);
    // And the modal leads with the download, in its own words.
    expect(explainCcusageFailure(res, "x")).toBe(CCUSAGE_REASONS.fetch_failed);
  });

  it("checks the registry for a newer ccusage once a day, instead of `npm view`", async () => {
    // An install from an earlier day, with no record of a check since.
    mkdirSync(join(PKG_DIR, "src"), { recursive: true });
    writeFileSync(join(PKG_DIR, "package.json"), JSON.stringify({ version: "20.0.0", bin: "./src/cli.js" }));
    writeFileSync(join(PKG_DIR, "src", "cli.js"), "");
    const reg = fakeRegistry({ version: "20.1.0" });
    vi.stubGlobal("fetch", reg.fetch);

    const res = await quietly(() => fetchCcusageDaily({ since: "20260403", force: true }));
    expect(res.ok).toBe(true);

    // The upgrade runs behind the answer, so wait for it to land.
    const deadline = Date.now() + 5_000;
    const version = () => JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8")).version;
    while (Date.now() < deadline && (!existsSync(join(PKG_DIR, "package.json")) || version() !== "20.1.0")) {
      await new Promise(r => setTimeout(r, 20));
    }
    expect(version()).toBe("20.1.0");
    expect(reg.asked[0]).toBe(`${REGISTRY}/ccusage/latest`);
    expect(calls.filter(mentionsNpm)).toEqual([]);
  });
});
