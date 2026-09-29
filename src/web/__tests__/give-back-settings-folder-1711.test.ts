// #1711. 3.30.0 told a Mac, precisely, that its settings folder belonged to
// another user — what a `sudo ccdeck` leaves, since sudo keeps HOME there — and
// then pointed at a log the person did not know how to find. Every settings
// write stayed refused, the share tick included, until they ran `sudo chown`.
//
// The failure line now offers to give the folder back through macOS's own
// password dialog. That is the one place the deck asks for administrator
// rights, so most of this file pins how narrow it is: which folders, which
// checks, what reaches the script and how, and what the page is told.
import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { rmTempDir } from "./rm-temp-dir";
import { afterGiveBack, offersGiveBack, refusalLine } from "../settings-give-back";
import { SettingsFailureLine } from "../components/SettingsFailureLine";
import { writeFailure } from "../use-lan-section";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-give-back-"));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CCDECK_HOME = join(DIR, "deck");
process.env.AGENTS_DECK_NO_LAN = "1";
if (!resolve(process.env.CCDECK_HOME).startsWith(resolve(DIR))) throw new Error("sandbox escaped");
afterAll(() => rmTempDir(DIR));

// @ts-expect-error — plain .mjs server module, no types
const giveBackModule = await import("../../server/prefs-give-back.mjs");
// @ts-expect-error — plain .mjs server module, no types
const refusal = await import("../../server/prefs-refusal.mjs");
const { giveBackDeckFolders, GIVE_BACK_SCRIPT, GIVE_BACK_PROMPT, GIVE_BACK_TIMEOUT_MS } = giveBackModule;

const ME = 501;
const STAFF = 20;
const ROOT = 0;
const HOME = "/Users/me";
const SETTINGS = "/Users/me/Library/Application Support/ccdeck";
const LOGS = "/Users/me/Library/Logs/ccdeck";
const LEGACY = "/Users/me/.claude/agent-dag";

type Entry = { uid: number; dir?: boolean; link?: boolean };
type RunAnswer = { ok: boolean; stderr?: string; code?: unknown; timedOut?: boolean };

/** A Mac's filesystem, as far as the give-back looks at it. `exec` stands in
 *  for osascript and, when it succeeds, does what chown would. */
function mac(entries: Record<string, Entry>, {
  env = {} as Record<string, string>,
  answer = { ok: true } as RunAnswer,
  real = (p: string) => p,
  chownWorks = true,
} = {}) {
  const calls: { cmd: string; args: string[]; opts: { timeout?: number } }[] = [];
  const warned: string[] = [];
  const fs = {
    lstat: async (p: string) => {
      const e = entries[p];
      if (!e) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
      return { uid: e.uid, isDirectory: () => e.dir !== false, isSymbolicLink: () => e.link === true };
    },
    realpath: async (p: string) => real(p),
  };
  const exec = async (cmd: string, args: string[], opts: { timeout?: number }) => {
    calls.push({ cmd, args, opts });
    if (answer.ok && chownWorks) for (const p of args.slice(5)) entries[p] = { ...entries[p], uid: ME };
    return answer;
  };
  const run = () => giveBackDeckFolders({
    platform: "darwin", getuid: () => ME, getgid: () => STAFF,
    env, home: HOME, fs, exec, warn: (s: string) => warned.push(s),
  });
  return { run, calls, warned, entries };
}

describe("which folders are given back", () => {
  it("gives the settings folder back through one password dialog, and nothing else", async () => {
    const m = mac({ [SETTINGS]: { uid: ROOT } });
    expect(await m.run()).toEqual({ ok: true, changed: true });
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0].cmd).toBe("osascript");
    expect(m.calls[0].args).toEqual(["-e", GIVE_BACK_SCRIPT, "--", `${ME}:${STAFF}`, GIVE_BACK_PROMPT, SETTINGS]);
  });

  it("waits minutes on the dialog rather than exec's default twenty seconds", async () => {
    const m = mac({ [SETTINGS]: { uid: ROOT } });
    await m.run();
    expect(m.calls[0].opts.timeout).toBe(GIVE_BACK_TIMEOUT_MS);
    expect(GIVE_BACK_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });

  it("takes the log folder and the legacy folder along when the same sudo run left them too", async () => {
    const m = mac({ [SETTINGS]: { uid: ROOT }, [LOGS]: { uid: ROOT }, [LEGACY]: { uid: ROOT } });
    await m.run();
    expect(m.calls[0].args.slice(5)).toEqual([SETTINGS, LOGS, LEGACY]);
  });

  it("leaves out a folder that is already yours or does not exist", async () => {
    const m = mac({ [SETTINGS]: { uid: ROOT }, [LOGS]: { uid: ME } });
    await m.run();
    expect(m.calls[0].args.slice(5)).toEqual([SETTINGS]);
  });

  it("gives back the log folder alone when the settings folder is already yours", async () => {
    const m = mac({ [SETTINGS]: { uid: ME }, [LOGS]: { uid: ROOT } });
    expect(await m.run()).toEqual({ ok: true, changed: true });
    expect(m.calls[0].args.slice(5)).toEqual([LOGS]);
  });

  it("never opens the dialog when nothing belongs to anybody else", async () => {
    const m = mac({ [SETTINGS]: { uid: ME }, [LOGS]: { uid: ME } });
    expect(await m.run()).toEqual({ ok: true, changed: false });
    expect(m.calls).toHaveLength(0);
  });

  it("names each folder once when CLAUDE_CONFIG_DIR makes the settings folder the legacy one", async () => {
    const legacy = "/Users/me/.claude-work/agent-dag";
    const m = mac({ [legacy]: { uid: ROOT } }, { env: { CLAUDE_CONFIG_DIR: "/Users/me/.claude-work" } });
    await m.run();
    expect(m.calls[0].args.slice(5)).toEqual([legacy]);
  });
});

describe("what the deck will not take root for", () => {
  const refuses = async (m: ReturnType<typeof mac>) => {
    expect(await m.run()).toEqual({ ok: false, reason: "not_eligible" });
    expect(m.calls).toHaveLength(0);
  };

  it("a settings folder that is a symlink", async () => {
    await refuses(mac({ [SETTINGS]: { uid: ROOT, link: true } }));
  });

  it("a settings path that is a file rather than a folder", async () => {
    await refuses(mac({ [SETTINGS]: { uid: ROOT, dir: false } }));
  });

  it("a CCDECK_HOME outside the user's home", async () => {
    await refuses(mac({ "/opt/ccdeck": { uid: ROOT } }, { env: { CCDECK_HOME: "/opt/ccdeck" } }));
  });

  it("a CCDECK_HOME that is the user's home itself", async () => {
    await refuses(mac({ [HOME]: { uid: ROOT } }, { env: { CCDECK_HOME: HOME } }));
  });

  it("a CCDECK_HOME named anything but the deck's own folder names", async () => {
    await refuses(mac({ "/Users/me/Documents": { uid: ROOT } }, { env: { CCDECK_HOME: "/Users/me/Documents" } }));
  });

  it("a folder inside the home whose real path leaves it", async () => {
    await refuses(mac({ [SETTINGS]: { uid: ROOT } }, { real: p => (p === SETTINGS ? "/private/etc/ccdeck" : p) }));
  });

  it("a folder whose real path cannot be read", async () => {
    await refuses(mac({ [SETTINGS]: { uid: ROOT } }, {
      real: p => { if (p === SETTINGS) throw new Error("EACCES"); return p; },
    }));
  });

  it("a log folder that fails the checks is skipped, not given back with the rest", async () => {
    const m = mac({ [SETTINGS]: { uid: ROOT }, [LOGS]: { uid: ROOT, link: true } });
    await m.run();
    expect(m.calls[0].args.slice(5)).toEqual([SETTINGS]);
  });

  it("anything but macOS, and a deck already running as root", async () => {
    const fs = { lstat: async () => ({ uid: ROOT, isDirectory: () => true, isSymbolicLink: () => false }), realpath: async (p: string) => p };
    let ran = 0;
    const exec = async () => { ran++; return { ok: true }; };
    for (const deps of [
      { platform: "linux", getuid: () => ME, getgid: () => STAFF },
      { platform: "win32", getuid: () => ME, getgid: () => STAFF },
      { platform: "darwin", getuid: () => ROOT, getgid: () => ROOT },
      { platform: "darwin", getuid: () => undefined, getgid: () => STAFF },
    ]) {
      expect(await giveBackDeckFolders({ ...deps, env: {}, home: HOME, fs, exec }), deps.platform).toEqual({ ok: false, reason: "unsupported" });
    }
    expect(ran).toBe(0);
  });
});

describe("what the page is told", () => {
  it("cancelled, when the person closes the dialog", async () => {
    const m = mac({ [SETTINGS]: { uid: ROOT } }, { answer: { ok: false, stderr: "0:180: execution error: User canceled. (-128)" } });
    expect(await m.run()).toEqual({ ok: false, reason: "cancelled" });
  });

  it("timed_out, when nobody answers it", async () => {
    const m = mac({ [SETTINGS]: { uid: ROOT } }, { answer: { ok: false, timedOut: true } });
    expect(await m.run()).toEqual({ ok: false, reason: "timed_out" });
  });

  it("refused, with what macOS said kept for the log and out of the answer", async () => {
    const m = mac({ [SETTINGS]: { uid: ROOT } }, { answer: { ok: false, stderr: "chown: Operation not permitted" } });
    const out = await m.run();
    expect(out).toEqual({ ok: false, reason: "refused" });
    expect(JSON.stringify(out)).not.toContain("/Users");
    expect(m.warned.join("\n")).toContain(SETTINGS);
    expect(m.warned.join("\n")).toContain("Operation not permitted");
  });

  it("still_foreign, when chown answered and the folder is still somebody else's", async () => {
    const m = mac({ [SETTINGS]: { uid: ROOT } }, { chownWorks: false });
    expect(await m.run()).toEqual({ ok: false, reason: "still_foreign" });
  });

  it("busy, to a second press while the first dialog is still open", async () => {
    let answer!: (r: RunAnswer) => void;
    const entries: Record<string, Entry> = { [SETTINGS]: { uid: ROOT } };
    const fs = {
      lstat: async (p: string) => {
        const e = entries[p];
        if (!e) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return { uid: e.uid, isDirectory: () => true, isSymbolicLink: () => false };
      },
      realpath: async (p: string) => p,
    };
    const exec = () => new Promise<RunAnswer>(r => { answer = r; });
    const deps = { platform: "darwin", getuid: () => ME, getgid: () => STAFF, env: {}, home: HOME, fs, exec };
    const first = giveBackDeckFolders(deps);
    await new Promise(r => setTimeout(r, 0));
    expect(await giveBackDeckFolders(deps)).toEqual({ ok: false, reason: "busy" });
    entries[SETTINGS] = { uid: ME };
    answer({ ok: true });
    expect(await first).toEqual({ ok: true, changed: true });
    expect(await giveBackDeckFolders(deps)).toEqual({ ok: true, changed: false });
  });
});

describe("the script that runs as root", () => {
  it("is a constant: no path, no uid, nothing of the request in its source", () => {
    expect(GIVE_BACK_SCRIPT).not.toMatch(/\/Users|\d{3}:\d/);
    expect(GIVE_BACK_SCRIPT).toContain("with administrator privileges");
    expect(GIVE_BACK_SCRIPT).toContain('"/usr/sbin/chown -x -R -P -- "');
  });

  it("quotes every item it puts on the command line", () => {
    const quoted = GIVE_BACK_SCRIPT.match(/quoted form of \(([^)]+)\)/g) ?? [];
    expect(quoted).toEqual(["quoted form of (item 1 of argv)", "quoted form of (target as text)"]);
    expect(GIVE_BACK_SCRIPT).toContain("with prompt (item 2 of argv)");
  });
});

describe("the refusal says when the press is on offer", () => {
  const blocked = (owner: string, on: string) => refusal.unreadablePrefs("/x/prefs.json", "the read failed", { code: "EACCES", owner, on });

  it("on macOS, for a settings folder another user owns", () => {
    expect(refusal.prefsRefusalDetail(blocked("other", "folder"), "darwin")).toEqual({ code: "EACCES", owner: "other", on: "folder", fix: "give_back" });
  });

  it("nowhere else, and for no other case", () => {
    expect(refusal.prefsRefusalDetail(blocked("other", "folder"), "linux")).not.toHaveProperty("fix");
    expect(refusal.prefsRefusalDetail(blocked("other", "folder"), "win32")).not.toHaveProperty("fix");
    expect(refusal.prefsRefusalDetail(blocked("other", "file"), "darwin")).not.toHaveProperty("fix");
    expect(refusal.prefsRefusalDetail(blocked("you", "folder"), "darwin")).not.toHaveProperty("fix");
    expect(refusal.prefsRefusalDetail(blocked("unknown", "folder"), "darwin")).not.toHaveProperty("fix");
  });
});

describe("the failure line", () => {
  const folderRefusal = { ok: false, reason: "prefs_unreadable", detail: { code: "EACCES", owner: "other", on: "folder", fix: "give_back" } };

  it("offers the press only when the deck said it is the fix", () => {
    expect(offersGiveBack(folderRefusal)).toBe(true);
    expect(offersGiveBack({ ...folderRefusal, detail: { ...folderRefusal.detail, fix: undefined } })).toBe(false);
    expect(offersGiveBack(null)).toBe(false);
    const line = refusalLine(writeFailure("share that account", folderRefusal), folderRefusal);
    expect(line).toEqual({ text: expect.stringContaining("cannot open its settings folder"), giveBack: true, done: false });
  });

  it("says the good news in the same place once the folder is given back", () => {
    expect(afterGiveBack({ ok: true, changed: true })).toMatchObject({ done: true, giveBack: false, text: expect.stringContaining("yours again") });
    expect(afterGiveBack({ ok: true, changed: false })).toMatchObject({ done: true, giveBack: false, text: expect.stringContaining("already yours") });
  });

  it("keeps the press for the answers after which pressing again can work", () => {
    for (const reason of ["cancelled", "timed_out", "busy"]) {
      expect(afterGiveBack({ ok: false, reason }), reason).toMatchObject({ giveBack: true, done: false });
    }
    expect(afterGiveBack(null)).toMatchObject({ giveBack: true, done: false, text: expect.stringContaining("did not answer") });
  });

  it("drops it, and points at the log, for the ones where it cannot", () => {
    for (const reason of ["refused", "not_eligible", "still_foreign", "unsupported", "anything-new"]) {
      expect(afterGiveBack({ ok: false, reason }), reason).toMatchObject({ giveBack: false, done: false, text: expect.stringContaining("log") });
    }
  });

  it("draws the press inside the red line, and only there", () => {
    const noop = () => {};
    const offered = renderToStaticMarkup(createElement(SettingsFailureLine, {
      line: { text: "Could not share that account.", giveBack: true, done: false }, onDismiss: noop, onAnswer: noop,
    }));
    expect(offered).toContain('class="ap-failure"');
    expect(offered).toContain("give it back");
    const plain = renderToStaticMarkup(createElement(SettingsFailureLine, {
      line: { text: "Could not share that account.", giveBack: false, done: false }, onDismiss: noop, onAnswer: noop,
    }));
    expect(plain).not.toContain("give it back");
    const done = renderToStaticMarkup(createElement(SettingsFailureLine, {
      line: afterGiveBack({ ok: true, changed: true }), onDismiss: noop, onAnswer: noop,
    }));
    expect(done).toContain("ap-failure-done");
    expect(done).not.toContain("give it back");
    expect(renderToStaticMarkup(createElement(SettingsFailureLine, { line: null, onDismiss: noop, onAnswer: noop }))).toBe("");
  });
});

describe("the route", () => {
  it("answers without a path, and reads the settings again once there is nothing left to give back", async () => {
    // @ts-expect-error — plain .mjs server module, no types
    const { handlePrefsGiveBack } = await import("../../server/prefs-routes.mjs");
    // @ts-expect-error — plain .mjs server module, no types
    const { heldPrefs } = await import("../../server/prefs-state.mjs");
    const deck = process.env.CCDECK_HOME!;
    mkdirSync(deck, { recursive: true });
    writeFileSync(join(deck, "prefs.json"), '{"notifications":false,"lan":{"name":"read-again"}}\n', { mode: 0o600 });
    let status = 0, body = "";
    const res = {
      writeHead: (s: number) => { status = s; return res; },
      setHeader: () => {},
      end: (b?: string) => { body = b ?? ""; },
    };
    await handlePrefsGiveBack({ method: "POST", headers: {} }, res);
    expect(body).not.toContain(DIR);
    const out = JSON.parse(body);
    if (process.platform === "darwin") {
      expect(status).toBe(200);
      expect(out).toMatchObject({ ok: true, changed: false });
      expect(heldPrefs.current().lan.name).toBe("read-again");
    } else {
      expect(status).toBe(409);
      expect(out).toEqual({ ok: false, reason: "unsupported" });
    }
  });

  it("keeps the copy it was running on when the file still cannot be read", async () => {
    // @ts-expect-error — plain .mjs server module, no types
    const { heldPrefs } = await import("../../server/prefs-state.mjs");
    const file = join(process.env.CCDECK_HOME!, "prefs.json");
    writeFileSync(file, '{"lan":{"name":"kept"}}\n', { mode: 0o600 });
    expect(await heldPrefs.reload()).toBe("file");
    // A read that fails for a reason no platform treats as ownership: the name
    // is a folder now, so the read is EISDIR on all three.
    rmSync(file);
    mkdirSync(file);
    try {
      expect(await heldPrefs.reload()).toBe("unreadable");
      expect(heldPrefs.current().lan.name).toBe("kept");
    } finally {
      rmSync(file, { recursive: true });
    }
  });
});
