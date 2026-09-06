// relay-guard.mjs was written, tested, and plugged into nothing.
//
// #799. `grep -rn "relay-guard" src bin hook` outside the suite returned one
// import — `RELAY_HOST` — while `hostsPath`, `readKillswitch`,
// `killswitchCommand`, `extensionReport` and `verdict` each greped to their own
// declaration and relay-guard.test.ts and nothing else. The feed the module
// needs was built and dropped on the floor too: `securePrefsPath` sat on every
// profile record with no production reader.
//
// That is not a dead-code problem, it is a TRUTHFULNESS one. The module header
// promises "the one command that closes it … hands back the command that would
// change it, as text, for the user to paste", and a reader auditing this repo's
// security posture would have believed the killswitch and the grant report
// ship. The issue offered two honest ways out — wire it up, or delete the six
// exports and rewrite the header. This is the first.
//
// What is asserted here is the WIRING, in both directions: that the snapshot
// carries the module's answer, and that the module still cannot do the two
// things it refuses to do.
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-relay-wired-"));
afterAll(() => rmTempDir(DIR));

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const watch = read("../../server/browser-watch.mjs");
const modal = read("../components/BrowserWatchModal.tsx");

// @ts-expect-error — plain .mjs server module, no types
const { browserWatchSnapshot } = await import("../../server/browser-watch.mjs");
// @ts-expect-error — ditto
const { CLAUDE_EXT_ID, RELAY_HOST } = await import("../../server/relay-guard.mjs");

/** A profile directory carrying the extension and a Secure Preferences that
 *  grants everything the report can name. */
function profileDir(name: string): string {
  const dir = join(DIR, name);
  mkdirSync(join(dir, "Extensions", CLAUDE_EXT_ID), { recursive: true });
  writeFileSync(join(dir, "Secure Preferences"), JSON.stringify({
    extensions: {
      settings: {
        [CLAUDE_EXT_ID]: {
          disable_reasons: [],
          granted_permissions: {
            explicit_host: ["<all_urls>"],
            scriptable_host: [],
            api: ["debugger", "tabs", "scripting", "downloads", "nativeMessaging"],
          },
        },
      },
    },
  }));
  return dir;
}

/** A snapshot with every browser read stubbed out — this file is about the
 *  relay half and nothing else. */
async function snapshot(profiles: unknown[], hosts: string | null) {
  return browserWatchSnapshot({
    readBrowsers: true,
    deps: {
      readStore: async () => ({ settings: { enabled: false, reaction: "notify", quietMinutes: 15, gapMinutes: 15, windowDays: 7 }, episodes: [], dismissed: [], migrated: false }),
      writeStore: async () => {},
      updateStore: async () => {},
      appendLog: async () => {},
      discoverProfiles: () => profiles,
      readProfileVisits: async () => ({ rows: [], degraded: false, reason: null, stamp: null }),
      hostsPath: () => join(DIR, "hosts"),
      readFile: async (file: string, enc: string) => {
        if (file === join(DIR, "hosts")) {
          if (hosts === null) throw new Error("ENOENT");
          return hosts;
        }
        return readFileSync(file, enc as BufferEncoding);
      },
    },
  });
}

const withExt = (name: string) => {
  const dir = profileDir(name);
  return {
    browser: "chrome", name: "Google Chrome", profile: name,
    dir, securePrefsPath: join(dir, "Secure Preferences"), hasClaudeExt: true,
    history: join(dir, "History"),
  };
};

describe("the snapshot carries what relay-guard can say", () => {
  it("reports the grants a profile actually holds, not just that a directory exists", async () => {
    // `hasExtension` is an existsSync on `Extensions/<id>` — it cannot see
    // `enabled`, `allUrls` or `sensitiveApis`, and those three are the whole
    // reason the preferences file is read.
    const snap = await snapshot([withExt("Default")], "127.0.0.1 localhost\n");
    expect(snap.relay, "the snapshot has no relay field").toBeTruthy();
    expect(snap.relay.relayHost).toBe(RELAY_HOST);
    expect(snap.relay.profiles).toHaveLength(1);
    expect(snap.relay.profiles[0].report).toEqual({
      present: true, enabled: true, allUrls: true,
      sensitiveApis: ["debugger", "nativeMessaging", "downloads", "tabs", "scripting"],
    });
  });

  it("says exposed when the extension is live and the relay resolves", async () => {
    const snap = await snapshot([withExt("P1")], "127.0.0.1 localhost\n");
    expect(snap.relay.anyExtension).toBe(true);
    expect(snap.relay.killswitch.blocked).toBe(false);
    expect(snap.relay.verdict).toBe("exposed");
  });

  it("says protected once the hosts file black-holes it", async () => {
    const snap = await snapshot([withExt("P2")], `0.0.0.0 ${RELAY_HOST} # ccdeck killswitch\n`);
    expect(snap.relay.killswitch.blocked).toBe(true);
    expect(snap.relay.killswitch.ours).toHaveLength(1);
    expect(snap.relay.verdict).toBe("protected");
  });

  it("says nothing-exposed with no extension anywhere, rather than protected", async () => {
    // `verdict`'s own rule, and the reason it is three states: collapsing these
    // two would tell a user with no extension that a block they never installed
    // is working.
    const bare = join(DIR, "bare");
    mkdirSync(bare, { recursive: true });
    const snap = await snapshot([{
      browser: "chrome", name: "Google Chrome", profile: "Bare",
      dir: bare, securePrefsPath: join(bare, "Secure Preferences"), hasClaudeExt: false,
      history: join(bare, "History"),
    }], "127.0.0.1 localhost\n");
    expect(snap.relay.profiles).toEqual([]);
    expect(snap.relay.verdict).toBe("nothing-exposed");
  });

  it("does not report an unreadable hosts file as an unblocked one", async () => {
    // The reassuring answer and the unreadable answer are the same value here,
    // which is why `hostsRead` is carried separately and the panel says so.
    const snap = await snapshot([withExt("P3")], null);
    expect(snap.relay.hostsRead).toBe(false);
    expect(snap.relay.killswitch.blocked).toBe(false);
  });

  it("hands back both commands as text, for the state the machine is in", async () => {
    const snap = await snapshot([withExt("P4")], "127.0.0.1 localhost\n");
    expect(snap.relay.command.block.command).toContain(RELAY_HOST);
    expect(snap.relay.command.unblock.command).toContain("sed");
    expect(snap.relay.command.block.needsAdmin).toBe(true);
  });

  it("caches the preferences read on mtime, because that file is megabytes", async () => {
    // The panel polls every ten seconds and Secure Preferences holds every
    // extension's settings. Keyed the way the History cache above it is.
    expect(watch).toContain("const extCache = new Map();");
    expect(watch).toContain("if (hit && hit.stamp === stamp) return hit.report;");
    // And a failed read is not cached, so the next poll retries rather than
    // holding "could not read" for the life of the process.
    expect(watch).toMatch(/catch \{[\s\S]{0,300}?return null;\s*\n\s*\}\s*\n\s*extCache\.set/);
  });

  it("skips every profile hasExtension already ruled out", async () => {
    expect(watch).toContain("if (!profile.hasClaudeExt) continue;");
  });
});

describe("the panel renders it", () => {
  it("has a section for the question, gated on the field being there", () => {
    expect(modal).toContain("{snap.relay && <RemoteControl relay={snap.relay} />}");
    expect(modal).toContain('<h4 className="bw-sec-head">Remote control</h4>');
  });

  it("offers the command that matches the state, rather than always the block", () => {
    expect(modal).toContain('const which = relay.killswitch.blocked ? "unblock" : "block";');
  });

  it("names the foreign line, which is the one the user has to go and look at", () => {
    // A hosts file resolves on the first match, so an entry pointing the relay
    // somewhere reachable defeats a block while our own line sits in the file.
    expect(modal).toContain("relay.killswitch.foreign.length > 0");
  });

  it("distinguishes could-not-read from nothing-granted on both reads", () => {
    expect(modal).toContain("const unreadable = relay.profiles.filter(p => p.report === null);");
    expect(modal).toContain("{!relay.hostsRead && (");
  });
});

describe("what wiring it up must not have changed", () => {
  it("leaves relay-guard unable to run or write anything", () => {
    // The module's own header, and relay-guard.test.ts pins it by reading the
    // source. The reading lives in browser-watch.mjs precisely so this stays
    // true — which is also why browser-profiles.mjs imports the extension id
    // FROM relay-guard and not the other way round (#798).
    const src = read("../../server/relay-guard.mjs");
    const imports = [...src.matchAll(/^import .*? from "([^"]+)";$/gm)].map(m => m[1]);
    expect(imports).toEqual(["node:path"]);
  });

  it("leaves the deck with no route that could run the command for you", () => {
    // index.mjs's `isTrustedMutation` deliberately lets an Origin-less request
    // through so hook.js and curl keep working. That reasoning holds only while
    // no route can do something the caller could not do for itself — the moment
    // one can raise a password dialog, any local process gets to make an
    // authentication prompt appear wearing ccdeck's name.
    expect(watch).not.toMatch(/\bexec(File)?(Sync)?\s*\(/);
    expect(watch).not.toMatch(/\bspawn(Sync)?\s*\(/);
    expect(modal).not.toContain("needsAdmin: false");
  });

  it("says where the module surfaces, in the module", () => {
    // The header promised a feature and named no surface, which is how it went
    // three releases without one.
    expect(read("../../server/relay-guard.mjs")).toContain("WHERE IT SURFACES.");
  });
});
