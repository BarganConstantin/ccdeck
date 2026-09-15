// Four places where the deck behaved differently on a platform nobody develops
// it on, and three of them could not be seen from a Mac at all.
//
//   #794  the Linux browser table missed the two roots a default Ubuntu has
//   #795  the not-writable upgrade guard cannot fire on Windows
//   #796  a `~`-prefixed XDG_DATA_HOME split the deck from cswap
//   #797  hardcoded em dashes bypassed the ASCII glyph tier
//
// Every case here drives the real function with a platform argument rather than
// asking what platform it is running on, which is how this suite reaches all
// three from any one of them.
import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

// @ts-expect-error — plain .mjs server modules, no types
const { processName } = await import("../../server/browser-presence.mjs");
// @ts-expect-error — ditto
const { quitBrowser, available } = await import("../../server/browser-react.mjs");
// @ts-expect-error — ditto
const { browserRoots } = await import("../../server/browser-profiles.mjs");
// @ts-expect-error — ditto
const { unregisteredDetail, glyphs } = await import("../../server/term.mjs");
// @ts-expect-error — ditto
const { upgradeRefusalText } = await import("../../server/supervisor.mjs");
const { upgradeBlock } = await import("../../server/self-update.mjs");

describe("#794 — the Linux browser table", () => {
  it("names every root browserRoots emits, which is the invariant that was broken", () => {
    // Derived from the roots rather than listed here: the defect was that the
    // two lists disagreed, and a test carrying its own copy of one of them
    // could disagree in the same direction.
    const roots = browserRoots("linux", { home: "/home/u" }) as Array<{ key: string }>;
    expect(roots.length, "no Linux roots at all — this case would be vacuous").toBeGreaterThan(4);
    const missing = roots.map(r => r.key).filter(k => !processName(k, "linux"));
    expect(missing, `these roots have no process name on linux: ${missing.join(", ")}`).toEqual([]);
  });

  it("keeps darwin and win32 complete too, so the fix did not trade one gap for another", () => {
    for (const platform of ["darwin", "win32"] as const) {
      const roots = browserRoots(platform, { home: "/home/u" }) as Array<{ key: string }>;
      const missing = roots.map(r => r.key).filter(k => !processName(k, platform));
      expect(missing, `${platform}: ${missing.join(", ")}`).toEqual([]);
    }
  });

  it("can quit a browser the darwin display-name table has never heard of", async () => {
    // The early exit. `quitBrowser` consulted the macOS display-name table at
    // the top of the function, so `chromium-snap` answered `unknown_browser` on
    // Linux before the branch that knows how to kill it was reached — while
    // `available("linux")` was offering the reaction the whole time.
    expect(available("linux")).toContain("quit-browser");
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const run = (cmd: string, args: string[]) => { calls.push({ cmd, args }); return Promise.resolve({ ok: true }); };
    const r = await quitBrowser("chromium-snap", "linux", { run });
    expect(r.reason, `quit answered ${r.reason}`).toBe("quit");
    expect(calls[0].cmd).toBe("pkill");
    expect(calls[0].args).toEqual(["-x", "chromium"]);
  });

  it("still refuses a browser nothing knows, rather than killing something arbitrary", async () => {
    const r = await quitBrowser("not-a-browser", "linux", { run: () => Promise.resolve({ ok: true }) });
    expect(r).toEqual({ ok: false, reason: "unknown_browser" });
  });
});

describe("#795 — asking whether a directory is writable", () => {
  it("is done by writing on Windows, because access() there cannot say no", () => {
    // libuv's fs__access short-circuits to success for anything carrying
    // FILE_ATTRIBUTE_DIRECTORY and never consults the ACL, and both arguments
    // are always directories — so `not_writable` could never be reported and
    // the banner offered an update that dies in npm with EPERM.
    //
    // WHICH BRANCH RUNS WHERE is the one thing still read out of the source,
    // because no machine but a Windows one can tell accessSync's answer from a
    // write's — everywhere else the two agree. What each branch ANSWERS is
    // driven below, on every leg.
    const src = read("../../server/self-update.mjs");
    expect(src).toContain('if (process.platform !== "win32") {');
  });

  // Both branches of dirWritable, driven through upgradeBlock against a
  // directory that can be written and one that cannot be reached at all (#994).
  //
  // These were three `toContain`s — the probe's `writeFileSync(… { flag: "wx" })`,
  // its `unlinkSync(probe)`, and POSIX's `accessSync(p, FS.W_OK)` — which held
  // just as well of a probe whose `catch` answered `true`. Every write that
  // failed would then read as writable: #795's own symptom, the banner
  // offering an update that dies in npm with EPERM, brought back by a different
  // line with all three strings still in place.
  //
  // `process.platform` is forced for the length of one synchronous call, so
  // the Windows branch runs on Linux and macOS as well and the POSIX branch on
  // Windows. The unreachable directory is a path through a regular FILE, which
  // refuses a write and an access check alike on every platform and for root
  // too — a read-only directory would read as writable to root, and does
  // nothing at all on Windows.
  for (const platform of ["win32", "linux"] as const) {
    it(`answers from the filesystem on the ${platform} branch, and leaves nothing behind`, () => {
      const sandbox = mkdtempSync(join(tmpdir(), "ccdeck-795-"));
      const optedOut = process.env.AGENTS_DECK_NO_INSTALL;
      delete process.env.AGENTS_DECK_NO_INSTALL;
      const real = Object.getOwnPropertyDescriptor(process, "platform")!;
      try {
        const pkg = join(sandbox, "lib", "pkg");
        mkdirSync(pkg, { recursive: true });
        const blocker = join(sandbox, "not-a-dir");
        writeFileSync(blocker, "");

        let open: unknown, shut: unknown;
        Object.defineProperty(process, "platform", { ...real, value: platform });
        try {
          open = upgradeBlock(pkg);
          shut = upgradeBlock(join(blocker, "pkg"));
        } finally {
          Object.defineProperty(process, "platform", real);
        }

        expect(open, "a directory this process can write reads as blocked").toBeNull();
        expect(shut, "a directory nothing can write reads as writable").toBe("not_writable");
        // `wx` so a collision reads as "not writable" instead of clobbering a
        // file, and the probe is removed whichever way the write went.
        expect(readdirSync(pkg), "the probe was left in the package").toEqual([]);
        expect(readdirSync(join(sandbox, "lib")), "the probe was left beside it").toEqual(["pkg"]);
      } finally {
        if (optedOut === undefined) delete process.env.AGENTS_DECK_NO_INSTALL;
        else process.env.AGENTS_DECK_NO_INSTALL = optedOut;
        rmTempDir(sandbox);
      }
    });
  }
});

// #796 — XDG_DATA_HOME with a leading tilde — is driven through backupRoot()
// in backup-root-shared.test.ts now, beside the other shapes the variable can
// take (#994). It was pinned here as three `toContain`s over the resolver's
// source, which held of a resolver that sent every `~` to the home fallback
// before reaching the expansion: all three strings survive a line like that
// being added above them.

describe("#797 — punctuation the console may not have", () => {
  it("takes the dash as a parameter, like renameNotice already did", () => {
    const ascii = glyphs(false);
    const unicode = glyphs(true);
    expect(ascii.dash).toBe("-");
    expect(unicode.dash).toBe("—");

    const said = unregisteredDetail({ file: "/tmp/d.json", claude: false, dash: ascii.dash });
    expect(said, "an em dash survived into the ASCII tier").not.toContain("—");
    expect(said).toContain(" - ");
    // And the default is still the em dash, so every caller that does not pass
    // one reads as it always did.
    expect(unregisteredDetail({ file: "/tmp/d.json", claude: false })).toContain("—");
  });

  it("does the same for the upgrade refusal, the other sentence that had one", () => {
    const ascii = glyphs(false).dash;
    for (const opts of [{ reason: "exhausted", attempt: 3 }, { reason: "waiting", waitMs: 90_000 }]) {
      const said = upgradeRefusalText({ ...opts, dash: ascii }, "3.9.0");
      expect(said, `an em dash survived: ${said}`).not.toContain("—");
    }
    expect(upgradeRefusalText({ reason: "exhausted", attempt: 3 }, "3.9.0")).toContain("—");
  });

  it("leaves no hardcoded em dash in the four bin and supervisor lines", () => {
    // The sites the audit named. Comments are allowed to contain one — this
    // reads the code only.
    for (const rel of ["../../../bin/deck.js", "../../../bin/agent-dag.js", "../../server/supervisor.mjs"]) {
      const code = read(rel)
        .split("\n")
        .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join("\n");
      const offending = [...code.matchAll(/console\.(?:error|log)\(`[^`]*[—–][^`]*`/g)].map(m => m[0].slice(0, 80));
      expect(offending, `hardcoded dash in a printed string: ${offending.join(" | ")}`).toEqual([]);
    }
  });
});
