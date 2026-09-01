// The hosts-file matcher, pinned against the file it once destroyed.
//
// The shell tool this feature descends from matched the relay host with a
// pattern that was neither anchored nor dot-escaped and did not require the
// tag. One test run removed five entries from a real /etc/hosts — among them an
// internal network mapping — because `.` matched any character and an
// unanchored pattern matched a substring. Everything in the first half of this
// file exists so that the same class of pattern cannot ship again: every trap
// line is asserted individually, and the DELETE COMMAND ITSELF is executed
// against a copy of a hosts file that contains all of them, so the claim being
// tested is "sed removes exactly these two lines", not "this regex looks right".
//
// The second half is the guard rail on the constraint that matters more than
// any of it: this module never elevates and never writes. It reads the module's
// own source, with comments removed and string bodies blanked, and fails if any
// elevation word or any way of running or writing anything survives into the
// executable text. The reason is in relay-guard.mjs's header — `isTrustedMutation`
// admits requests with no Origin header on purpose, so a route able to raise a
// password dialog would hand every local process a phishing primitive wearing
// ccdeck's name. "We would notice" is not a control; this is.
//
// Plain node throughout. Nothing here renders, and the module under test is
// pure functions over text.
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
import { withoutComments } from "./tsx-scan";

// @ts-expect-error — plain .mjs module, no types
import { RELAY_HOST, CLAUDE_EXT_ID, hostsPath, readKillswitch, killswitchCommand, extensionReport, verdict } from "../../server/relay-guard.mjs";

/** The line the feature writes, spelled out here rather than imported. A test
 *  that asks the module what it writes and then checks that it wrote that
 *  agrees with itself for free; this one disagrees the day the constant moves. */
const TAGGED = "0.0.0.0 bridge.claudeusercontent.com # ccdeck killswitch";

/**
 * Every line the matcher must refuse, one per entry, plus the two it must
 * claim. The names are what the failure message says out loud, so a broken
 * pattern reports which trap it fell into rather than "expected 1, got 3".
 */
const TRAP = {
  /** What we write. Claimed. */
  tagged: TAGGED,
  /** The same line as a hand edit: leading indent, tabs between the fields —
   *  the real /etc/hosts on macOS separates with tabs. Still ours. */
  taggedWithTabs: "\t0.0.0.0\tbridge.claudeusercontent.com\t#\tccdeck killswitch",
  /** A block somebody else installed. Real, so it counts as a block; untagged,
   *  so it is not ours to remove. */
  untagged: "0.0.0.0 bridge.claudeusercontent.com",
  /** Our own line, commented out — a killswitch somebody turned OFF. Claiming
   *  it would report protection that is not there. */
  commentedOut: "# 0.0.0.0 bridge.claudeusercontent.com # ccdeck killswitch",
  /** A different host that ends the same way. */
  neighbourHost: "0.0.0.0 notbridge.claudeusercontent.com # ccdeck killswitch",
  /** The dot-escaping trap: unescaped `.` matches these hyphens. */
  dashedHost: "0.0.0.0 bridge-claudeusercontent-com # ccdeck killswitch",
  /** The host inside prose. No mapping at all. */
  prose: "# we block bridge.claudeusercontent.com at the VPN instead, ticket 42",
  /** The `$` anchor trap: without it, the delete takes the trailing text too. */
  trailingJunk: `${TAGGED} and something else`,
  /** The host riding along as an alias of another mapping. */
  alias: "0.0.0.0 ads.example.test bridge.claudeusercontent.com",
  /** A mapping that resolves somewhere reachable — a proxy, or an internal
   *  sinkhole that answers. Not a block. */
  reachable: "10.4.0.9 bridge.claudeusercontent.com",
  /** Our exact line but for the case of the host. Live, so it is a block; not
   *  byte-identical, so it is not ours — and the shipped delete patterns are
   *  case-sensitive for the same reason. */
  uppercaseTagged: "0.0.0.0 BRIDGE.claudeusercontent.com # ccdeck killswitch",
  /** The host in the address column, which is not a mapping OF the host. */
  hostAsAddress: "bridge.claudeusercontent.com 0.0.0.0",
};

/**
 * Lines that have nothing to do with this feature, including the shape of the
 * one that was actually lost: a private address mapped to an internal name.
 * The first four are the real macOS /etc/hosts preamble.
 */
const INNOCENT = [
  "##",
  "# Host Database",
  "#",
  "127.0.0.1\tlocalhost",
  "255.255.255.255\tbroadcasthost",
  "::1             localhost",
  "10.4.0.9\tbuild.internal.example",
  "0.0.0.0 ads.example.test",
];

/** One file holding all of it, in a deliberately awkward order. */
const ADVERSARIAL = [...INNOCENT, ...Object.values(TRAP)].join("\n") + "\n";

/** The two lines — and only these two — that the feature owns. */
const OWNED = [TRAP.tagged, TRAP.taggedWithTabs];

const TMP = mkdtempSync(join(tmpdir(), "ccdeck-relay-guard-"));
afterAll(() => rmTempDir(TMP));

/** POSIX-only cases: they run `sh` and `sed`, neither of which is on Windows.
 *  The Windows delete pattern is checked by other means below rather than left
 *  unchecked — see "the shipped Windows pattern".
 *
 *  Spelled as a boolean fed to `it.runIf`, which is the form skip-gates.mjs can
 *  see and the form no-shell-hook-commands.test.ts already uses for the same
 *  condition. An alias for `it.skip` reads the same at the call site and is
 *  invisible to the register — which is exactly how six cases went quiet on the
 *  Windows leg without anything saying so. */
const posix = process.platform !== "win32";

/**
 * The half of a generated command that touches the hosts file, aimed at a copy
 * and stripped of EVERY `sudo` so a test can run it as an ordinary user.
 *
 * Every occurrence, not a leading one. The block command is now a pipe —
 * `printf … | sudo tee -a` — so the elevation sits in the middle, which is
 * where it belongs when only the write needs to be root. A leading-anchored
 * strip left it in place and the case became a password prompt in a test run.
 *
 * It cuts at the flush tool's name rather than at the first `;`, because a
 * command's own body may contain semicolons. Asserting the cut found something
 * is also how every command gets checked for HAVING a flush step at all.
 */
function fileHalf(command: string, file: string): string {
  const at = command.search(/(?:dscacheutil|command -v resolvectl|ipconfig) /);
  expect(at, `no DNS flush step in: ${command}`).toBeGreaterThan(0);
  const half = command.slice(0, at).replace(/[;\n]\s*$/, "").replaceAll(/\bsudo /g, "")
    .replaceAll("/etc/hosts", file);
  // Nothing may reach the shell still asking for root: a test that prompts for
  // a password is a test that hangs a CI run rather than failing it.
  expect(half, "sudo survived the strip").not.toMatch(/\bsudo\b/);
  return half;
}

/** Write a fixture, run a command against it, hand back what the file became. */
function afterRunning(command: string, contents: string, name: string): string {
  const file = join(TMP, name);
  writeFileSync(file, contents);
  execFileSync("/bin/sh", ["-c", fileHalf(command, file)]);
  return readFileSync(file, "utf8");
}

describe("hostsPath", () => {
  it("is /etc/hosts everywhere but Windows", () => {
    expect(hostsPath("darwin", {})).toBe("/etc/hosts");
    expect(hostsPath("linux", {})).toBe("/etc/hosts");
    // Not a supported platform, but answering the POSIX path is the only
    // answer that can be right by accident.
    expect(hostsPath("freebsd", {})).toBe("/etc/hosts");
  });

  it("reads SystemRoot on Windows, in any of its spellings", () => {
    const want = "C:\\WINDOWS\\System32\\drivers\\etc\\hosts";
    expect(hostsPath("win32", { SystemRoot: "C:\\WINDOWS" })).toBe(want);
    // Windows' own environment is case-insensitive; a plain object handed in
    // by a caller or a test is not, which is how the variable that is always
    // set in production reads as missing.
    expect(hostsPath("win32", { systemroot: "C:\\WINDOWS" })).toBe(want);
    expect(hostsPath("win32", { SYSTEMROOT: "C:\\WINDOWS" })).toBe(want);
    expect(hostsPath("win32", { SystemRoot: "  C:\\WINDOWS  " })).toBe(want);
  });

  it("never answers a drive-less path when SystemRoot is missing", () => {
    // `\System32\drivers\etc\hosts` is rooted but drive-relative: it names a
    // different file on every drive the deck might be started from, and reading
    // the wrong one means reporting "not blocked" for a machine that is.
    for (const env of [{}, { SystemRoot: "" }, { SystemRoot: "   " }] as const) {
      const path = hostsPath("win32", env);
      expect(path, `drive-less for env ${JSON.stringify(env)}`).toMatch(/^[A-Za-z]:\\/);
      expect(path).toBe("C:\\Windows\\System32\\drivers\\etc\\hosts");
    }
    // A missing env object at all, which is what a caller building one for a
    // child process can hand over.
    expect(hostsPath("win32", undefined)).toMatch(/^[A-Za-z]:\\/);
  });

  it("uses backslashes on Windows whatever the host platform is", () => {
    // The Windows leg has to be right when computed from macOS or Linux, which
    // is where this suite runs: `join` would use the host separator.
    expect(hostsPath("win32", { SystemRoot: "C:\\WINDOWS" })).not.toMatch(/\//);
  });
});

describe("readKillswitch", () => {
  it("claims the tagged line and nothing else in the adversarial file", () => {
    const state = readKillswitch(ADVERSARIAL);
    expect(state.ours).toEqual(OWNED);
  });

  // Each trap on its own, so a widened pattern names the line it swallowed.
  const claimed: [keyof typeof TRAP, boolean][] = [
    ["tagged", true],
    ["taggedWithTabs", true],
    ["untagged", false],
    ["commentedOut", false],
    ["neighbourHost", false],
    ["dashedHost", false],
    ["prose", false],
    ["trailingJunk", false],
    ["alias", false],
    ["reachable", false],
    ["uppercaseTagged", false],
    ["hostAsAddress", false],
  ];
  for (const [name, ours] of claimed) {
    it(`${ours ? "claims" : "refuses"} ${name}`, () => {
      expect(readKillswitch(TRAP[name]).ours).toEqual(ours ? [TRAP[name]] : []);
    });
  }

  it("surfaces every other live mapping as foreign", () => {
    // Not deleted, not ignored: a mapping somebody else put there is the thing
    // most likely to explain a verdict the user did not expect.
    expect(readKillswitch(ADVERSARIAL).foreign).toEqual([
      TRAP.untagged, TRAP.trailingJunk, TRAP.alias, TRAP.reachable, TRAP.uppercaseTagged,
    ]);
  });

  it("matches the host case-insensitively for foreign, exactly for ours", () => {
    // DNS is case-insensitive and so is the hosts file, so an odd-cased line is
    // a real mapping and must be surfaced. It is not claimed as ours, because
    // what `ours` means is what the delete commands will actually remove, and
    // both of those are case-sensitive on purpose.
    const state = readKillswitch(TRAP.uppercaseTagged);
    expect(state.foreign).toEqual([TRAP.uppercaseTagged]);
    expect(state.ours).toEqual([]);
    expect(state.blocked).toBe(true);
  });

  it("reads a CRLF file without leaving the CR on the line", () => {
    // Every Windows hosts file is CRLF. A `\r` clinging to the end of the line
    // defeats the `$` anchor, so a real killswitch would read as foreign on the
    // one platform where the file always looks like this.
    const state = readKillswitch(`127.0.0.1\tlocalhost\r\n${TAGGED}\r\n`);
    expect(state.ours).toEqual([TAGGED]);
    expect(state.blocked).toBe(true);
  });

  it("counts a sinkhole address as a block whoever wrote it", () => {
    for (const address of ["0.0.0.0", "127.0.0.1", "::1", "::"]) {
      expect(readKillswitch(`${address} ${RELAY_HOST}`).blocked, address).toBe(true);
    }
  });

  it("refuses to call it blocked when anything still resolves", () => {
    // A hosts file answers on the first match, so one reachable mapping above
    // ours defeats the block while leaving our line right there in the file.
    // Reporting "protected" in that state is the worst thing this panel can do.
    const both = `${TRAP.reachable}\n${TAGGED}\n`;
    const state = readKillswitch(both);
    expect(state.ours).toEqual([TAGGED]);
    expect(state.foreign).toEqual([TRAP.reachable]);
    expect(state.blocked).toBe(false);
    // And the adversarial file, which holds one of those, is not blocked either.
    expect(readKillswitch(ADVERSARIAL).blocked).toBe(false);
  });

  it("has nothing to say about a file it was not given", () => {
    // The caller's read can fail — no such file in a stripped container, EACCES
    // under a hardened profile — and a panel that cannot see the file has
    // nothing to report, which is not the same as a crash.
    for (const input of [undefined, null, 0, {}, ["0.0.0.0 x"]]) {
      expect(readKillswitch(input)).toEqual({ blocked: false, ours: [], foreign: [] });
    }
    expect(readKillswitch("")).toEqual({ blocked: false, ours: [], foreign: [] });
  });
});

describe("killswitchCommand", () => {
  const platforms = ["darwin", "linux", "win32"] as const;

  it("always says it needs admin and never runs anything itself", () => {
    for (const platform of platforms) {
      for (const on of [true, false]) {
        const result = killswitchCommand(platform, { on });
        expect(result.needsAdmin, `${platform} on=${on}`).toBe(true);
        expect(typeof result.command).toBe("string");
        expect(result.command.length).toBeGreaterThan(0);
        expect(result.note.length).toBeGreaterThan(0);
      }
    }
  });

  it("refuses to guess which direction was meant", () => {
    // The two commands are opposites. A caller that forgot the field would
    // otherwise get whichever one a default named — silently lifting a block
    // the user asked to install.
    expect(() => killswitchCommand("darwin", {})).toThrow(/on: true/);
    expect(() => killswitchCommand("darwin", { on: "yes" })).toThrow(TypeError);
  });

  it("says what blocking does not do, without overstating it", () => {
    const note = killswitchCommand("darwin", { on: true }).note;
    expect(note).toMatch(/does not close one the extension already holds/);
    expect(note).toMatch(/until the browser restarts/);
    // The unblock makes the narrower promise instead: it removes one line.
    expect(killswitchCommand("darwin", { on: false }).note).toMatch(/Removes only the line/);
  });

  it("tells the user they are the one running it", () => {
    expect(killswitchCommand("linux", { on: true }).note).toMatch(/Paste it in a terminal yourself/);
    expect(killswitchCommand("win32", { on: true }).note).toMatch(/started as Administrator/);
    for (const platform of platforms) {
      expect(killswitchCommand(platform, { on: true }).note, platform).toMatch(/ccdeck never runs it/);
    }
  });

  it("flushes DNS the way each platform does it", () => {
    expect(killswitchCommand("darwin", { on: true }).command)
      .toMatch(/dscacheutil -flushcache.*killall -HUP mDNSResponder/s);
    expect(killswitchCommand("win32", { on: true }).command).toMatch(/ipconfig \/flushdns/);
    // A flush tool that is not installed must not fail the paste, so Linux
    // probes for resolvectl instead of running it, and the whole clause ends in
    // a `|| true`. A cache nobody cleared expires on its own; a paste that
    // exits non-zero is a user who thinks the block did not happen.
    const linux = killswitchCommand("linux", { on: true }).command;
    expect(linux).toMatch(/command -v resolvectl >\/dev\/null 2>&1 && sudo resolvectl flush-caches/);
    expect(linux.trimEnd()).toMatch(/\|\| true$/);
    expect(killswitchCommand("linux", { on: true }).note).toMatch(/skipped, not failed/);
  });

  it("uses the in-place flag each sed actually has", () => {
    // BSD sed wants the backup suffix as its own argument and reads an empty
    // one as "no backup"; GNU sed reads a following argument as the script.
    expect(killswitchCommand("darwin", { on: false }).command).toContain("sed -i '' '/");
    expect(killswitchCommand("linux", { on: false }).command).toContain("sed -i '/");
  });

  it.runIf(posix)("appends the tagged line and leaves the rest of the file alone", () => {
    // The blank line is deliberate and it is what buys the one-line command.
    // Rather than testing whether the file already ends in a terminator — three
    // lines of `sh -c` with nested quotes, in front of somebody about to run
    // this as root — the append always leads with a newline, which is correct
    // both ways. A hosts file ignores blank lines and the stock macOS one ships
    // with one already; what must not change is any line that carries meaning.
    const before = INNOCENT.join("\n") + "\n";
    const after = afterRunning(killswitchCommand(process.platform, { on: true }).command, before, "block-lf");
    expect(after).toBe(before + "\n" + TAGGED + "\n");
    expect(after.split("\n").filter(l => l.trim() !== ""))
      .toEqual([...INNOCENT.filter(l => l.trim() !== ""), TAGGED]);
    expect(readKillswitch(after).ours).toEqual([TAGGED]);
    expect(readKillswitch(after).blocked).toBe(true);
  });

  it.runIf(posix)("adds the newline the file was missing before appending", () => {
    // A hosts file whose last line has no terminator is an ordinary file and
    // what several config-management tools leave behind. Appending to it welds
    // our text onto that last line and produces one corrupt entry out of two
    // valid ones — silently, and only on the machines shaped that way.
    const before = INNOCENT.join("\n");
    const after = afterRunning(killswitchCommand(process.platform, { on: true }).command, before, "block-nolf");
    expect(after).toBe(before + "\n" + TAGGED + "\n");
    expect(after).not.toContain("0.0.0.0 ads.example.test0.0.0.0");
    expect(readKillswitch(after).ours).toEqual([TAGGED]);
  });

  it.runIf(posix)("puts nothing but the line, and its leading blank, into an empty file", () => {
    const after = afterRunning(killswitchCommand(process.platform, { on: true }).command, "", "block-empty");
    expect(after).toBe("\n" + TAGGED + "\n");
    expect(readKillswitch(after).blocked).toBe(true);
  });

  it.runIf(posix)("deletes its own two lines out of the adversarial file and no others", () => {
    // The regression, run rather than reasoned about. Every trap line is in
    // this file, including the private-address mapping shaped like the one the
    // original pattern destroyed.
    const after = afterRunning(killswitchCommand(process.platform, { on: false }).command, ADVERSARIAL, "unblock");
    const gone = ADVERSARIAL.split("\n").filter(line => !after.split("\n").includes(line));
    expect(gone).toEqual(OWNED);
    for (const line of INNOCENT) expect(after, `lost an innocent line: ${line}`).toContain(line);
    expect(after).toContain("10.4.0.9\tbuild.internal.example");
    expect(readKillswitch(after).ours).toEqual([]);
  });

  it.runIf(posix)("round-trips every line that carries meaning, leaving one blank behind", () => {
    // Block then unblock is the sequence a user who changed their mind runs.
    // What comes back is every line that means anything, in order, unchanged —
    // plus the blank line the append leads with, which the delete does not
    // reach. That is the whole price of the one-line command, and it is a
    // blank line in a file that already ships with one: the stock macOS
    // /etc/hosts has a blank line and ten lines total.
    //
    // Toggling repeatedly therefore leaves a blank line each time. Pinned here
    // rather than hidden, so that if it ever stops being acceptable this case
    // is where the argument is.
    const before = INNOCENT.join("\n") + "\n";
    const blocked = afterRunning(killswitchCommand(process.platform, { on: true }).command, before, "round-a");
    const restored = afterRunning(killswitchCommand(process.platform, { on: false }).command, blocked, "round-b");
    const meaningful = (t: string) => t.split("\n").filter(l => l.trim() !== "");
    expect(meaningful(restored)).toEqual(meaningful(before));
    expect(readKillswitch(restored).blocked).toBe(false);
    expect(restored).toBe(before + "\n");
  });

  it.runIf(posix)("removes a line pasted twice, because the block is not idempotent", () => {
    const twice = `${TAGGED}\n${TAGGED}\n${INNOCENT.join("\n")}\n`;
    const after = afterRunning(killswitchCommand(process.platform, { on: false }).command, twice, "double");
    expect(after).toBe(INNOCENT.join("\n") + "\n");
  });

  it("ships a Windows delete pattern that agrees with the matcher line for line", () => {
    // powershell is not on this runner, and a leg nobody can run is a leg
    // nobody has checked — so the pattern is lifted out of the command and
    // evaluated here. That is legitimate for exactly this pattern: anchors,
    // escaped dots, `[ \t]` classes and `+`/`*` mean the same thing in .NET and
    // in JavaScript. What it does not prove is the PowerShell around it, which
    // is why `-cnotmatch` gets its own assertion below.
    const command = killswitchCommand("win32", { on: false }).command;
    const pattern = command.match(/\$p = '([^']+)'/);
    expect(pattern, `no delete pattern in: ${command}`).toBeTruthy();
    const shipped = new RegExp(pattern![1]);
    for (const [name, line] of Object.entries(TRAP)) {
      expect(shipped.test(line), `${name} disagrees with readKillswitch`)
        .toBe(readKillswitch(line).ours.length === 1);
    }
    for (const line of INNOCENT) expect(shipped.test(line), line).toBe(false);
  });

  it("makes the Windows delete case-sensitive on purpose", () => {
    // PowerShell's comparison operators are case-INSENSITIVE by default, which
    // would let the delete take a line `readKillswitch` refuses to claim. A
    // command that removes more than the module says it will is the exact
    // failure this feature exists not to repeat.
    const command = killswitchCommand("win32", { on: false }).command;
    expect(command).toContain("-cnotmatch");
    expect(command).not.toMatch(/[^c]-notmatch/);
  });

  it("guards the Windows append against the same missing newline", () => {
    // Add-Content would have been shorter and appends its terminator AFTER the
    // value and never before it, which is this corruption spelled in
    // PowerShell.
    const command = killswitchCommand("win32", { on: true }).command;
    expect(command).toContain("EndsWith(\"`n\")");
    expect(command).toContain(`$t += "${TAGGED}`);
    expect(command).not.toContain("Add-Content");
    // The path is resolved by the elevated shell, not by this process.
    expect(command).toContain("$env:SystemRoot");
  });
});

describe("extensionReport", () => {
  // Shaped after a real "Secure Preferences" read on the authoring machine:
  // `disable_reasons: []`, `<all_urls>` in both explicit_host and
  // scriptable_host, and all five sensitive APIs granted. Notably there was no
  // `state` key at all, which is why nothing here reads one.
  const live = {
    extensions: {
      settings: {
        [CLAUDE_EXT_ID]: {
          disable_reasons: [],
          granted_permissions: {
            api: ["activeTab", "alarms", "debugger", "downloads", "identity",
                  "nativeMessaging", "notifications", "storage", "tabs",
                  "unlimitedStorage", "webNavigation", "tabGroups", "scripting"],
            explicit_host: ["<all_urls>"],
            scriptable_host: ["<all_urls>", "https://claude.ai/*"],
          },
        },
      },
    },
  };

  it("reads the real shape", () => {
    expect(extensionReport(live)).toEqual({
      present: true,
      enabled: true,
      allUrls: true,
      // In the module's own order, not the file's, so the panel renders the
      // same list twice running.
      sensitiveApis: ["debugger", "nativeMessaging", "downloads", "tabs", "scripting"],
    });
  });

  it("reports a disabled extension as disabled, which is the good news", () => {
    // A non-empty disable_reasons is Chrome saying why it turned the extension
    // off. A report that shows a disabled extension as a live threat is a
    // report the user stops reading.
    const off = structuredClone(live);
    off.extensions.settings[CLAUDE_EXT_ID].disable_reasons = [1];
    const report = extensionReport(off);
    expect(report.enabled).toBe(false);
    // Still present, and still holding everything it was granted.
    expect(report.present).toBe(true);
    expect(report.allUrls).toBe(true);
  });

  it("counts every-site reach through either host key", () => {
    const only = (key: string, hosts: string[]) => extensionReport({
      extensions: { settings: { [CLAUDE_EXT_ID]: { granted_permissions: { [key]: hosts } } } },
    }).allUrls;
    expect(only("explicit_host", ["<all_urls>"])).toBe(true);
    // Content-script reach into every page is the same exposure through a
    // different key; missing it under-reports the one thing the flag is for.
    expect(only("scriptable_host", ["<all_urls>"])).toBe(true);
    expect(only("explicit_host", ["*://*/*"])).toBe(true);
    // Broad, but not every site — and the flag should mean what it says.
    expect(only("explicit_host", ["https://*/*"])).toBe(false);
    expect(only("explicit_host", ["https://claude.ai/*"])).toBe(false);
    expect(only("explicit_host", [])).toBe(false);
  });

  it("names only the APIs worth alarm", () => {
    const apis = (api: string[]) => extensionReport({
      extensions: { settings: { [CLAUDE_EXT_ID]: { granted_permissions: { api } } } },
    }).sensitiveApis;
    expect(apis(["storage", "alarms", "notifications"])).toEqual([]);
    expect(apis(["tabs", "debugger"])).toEqual(["debugger", "tabs"]);
    expect(apis(["scripting"])).toEqual(["scripting"]);
  });

  it("answers absent for a profile that does not have it", () => {
    const absent = { present: false, enabled: false, allUrls: false, sensitiveApis: [] };
    expect(extensionReport({ extensions: { settings: {} } })).toEqual(absent);
    expect(extensionReport(live, "someotherextensionidxxxxxxxxxxxx")).toEqual(absent);
  });

  it("does not mistake a prototype member for an installed extension", () => {
    // `settings["constructor"]` is a function on every object alive and
    // `settings["__proto__"]` is a prototype; either sails past a truthiness
    // check. The id is a caller-supplied string.
    const empty = { extensions: { settings: {} } };
    for (const id of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(extensionReport(empty, id).present, id).toBe(false);
    }
  });

  it("survives a file that is not the shape we expect", () => {
    // Chrome owns this file and we only read it. A field that is a string where
    // an array was expected is a Chrome release note nobody has read yet, not a
    // reason to throw inside a panel.
    const absent = { present: false, enabled: false, allUrls: false, sensitiveApis: [] };
    for (const input of [null, undefined, {}, [], "text", { extensions: 7 }, { extensions: { settings: "no" } }]) {
      expect(extensionReport(input)).toEqual(absent);
    }
    const odd = { extensions: { settings: { [CLAUDE_EXT_ID]: {
      disable_reasons: "disabled", granted_permissions: { api: "tabs", explicit_host: "<all_urls>" },
    } } } };
    // A string is not a non-empty array of reasons, so this reads as enabled —
    // the conservative direction: it reports the extension as live.
    expect(extensionReport(odd)).toEqual({
      present: true, enabled: true, allUrls: false, sensitiveApis: [],
    });
  });
});

describe("verdict", () => {
  it("is three states and not two", () => {
    // "protected" and "nothing-exposed" both mean no action today, and
    // collapsing them would tell a user with no extension installed that a
    // block they never made is working.
    expect(verdict({ anyExtension: false, blocked: false })).toBe("nothing-exposed");
    expect(verdict({ anyExtension: false, blocked: true })).toBe("nothing-exposed");
    expect(verdict({ anyExtension: true, blocked: true })).toBe("protected");
    expect(verdict({ anyExtension: true, blocked: false })).toBe("exposed");
  });

  it("says nothing-exposed when it was told nothing", () => {
    expect(verdict()).toBe("nothing-exposed");
    expect(verdict({})).toBe("nothing-exposed");
  });
});

// ── the guard rail on "never elevates, never writes" ────────────────────────

describe("the module cannot elevate or write", () => {
  const SOURCE = readFileSync(
    fileURLToPath(new URL("../../server/relay-guard.mjs", import.meta.url)), "utf8");
  /** Comments removed and every string body blanked: what is left is the code
   *  that RUNS. An elevation word surviving this is a call, not a command being
   *  written out for the user and not prose explaining why we do not. */
  const CODE = withoutComments(SOURCE, true);
  /** Comments removed, strings intact — for reading the import specifiers,
   *  which the blanked copy has emptied. */
  const WITH_STRINGS = withoutComments(SOURCE);

  it("has no elevation call anywhere in its executable text", () => {
    for (const word of [/\bsudo\b/, /administrator privileges/i, /\bRunAs\b/i,
                        /\bpkexec\b/, /\bosascript\b/, /Start-Process/i, /\bdoas\b/]) {
      expect(CODE, `elevation reached the code: ${word}`).not.toMatch(word);
    }
  });

  it("keeps the elevation where it belongs — in the text the user pastes", () => {
    // The positive half. Without it this file would still pass with the module
    // deleted, and the blanking would be proving nothing.
    expect(SOURCE).toMatch(/\bsudo\b/);
    expect(CODE).toContain("killswitchCommand");
    // Present, not first. The block command pipes into `sudo tee`, because only
    // the write needs root — which is both shorter to read and narrower in what
    // it elevates than wrapping the whole thing in `sudo sh -c`.
    expect(killswitchCommand("darwin", { on: true }).command).toMatch(/\bsudo\b/);
    expect(killswitchCommand("darwin", { on: false }).command).toMatch(/^sudo /);
    expect(killswitchCommand("win32", { on: true }).command).not.toMatch(/\bsudo\b/);
  });

  it("imports nothing that can run or write", () => {
    const specifiers = [...WITH_STRINGS.matchAll(/\bfrom\s+"([^"]+)"/g)].map(m => m[1]);
    expect(specifiers).toEqual(["node:path"]);
  });

  it("has no way to touch the file it reports on", () => {
    // Every one of these is absent by construction, and each is a way the
    // module could have been given hands: a process, a write, or a runtime
    // import that fetches either.
    for (const call of [/child_process/, /node:fs\b/, /\bspawn(Sync)?\s*\(/,
                        /\bexec(Sync|File|FileSync)?\s*\(/, /\bwriteFile/,
                        /\bappendFile/, /\brequire\s*\(/, /\bimport\s*\(/,
                        /\bcreateRequire\b/, /\bprocess\.binding\b/]) {
      expect(CODE, `the module gained hands: ${call}`).not.toMatch(call);
    }
  });

  it("takes text rather than a path, so there is nothing for it to open", () => {
    // The shape of the contract is the enforcement: the caller reads the file
    // and parses the JSON, and both entry points here are pure functions over
    // what came back.
    expect(readKillswitch(ADVERSARIAL).ours).toEqual(OWNED);
    expect(() => readKillswitch("/etc/hosts")).not.toThrow();
    // A path handed in by mistake is text with no mapping in it, not a read.
    expect(readKillswitch("/etc/hosts")).toEqual({ blocked: false, ours: [], foreign: [] });
  });
});
