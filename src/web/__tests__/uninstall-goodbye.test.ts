// The goodbye at the end of `ccdeck --uninstall` (bin/cli/leaving.js), read
// against what the uninstall does to prefs.json on its way there.
//
// `--purge` deletes prefs.json, and the reporter read the install id out of
// that file only when it was first imported — at the goodbye, after the purge.
// So it found nothing, decided no report would go out, and the uninstall that
// most meant it was never counted and never asked why.
//
// uninstall() is called in-process, never through bin/deck.js: everything it
// would reach outside this sandbox — the hooks, the login item, the sound hook,
// the running decks — is a stand-in below, and only the key files and the
// reporter are real, on a temp CCDECK_HOME. The network is a stubbed fetch.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

const touched = vi.hoisted(() => ({ loginItem: 0, stop: 0 }));

vi.mock("../../server/installer.mjs", () => ({
  uninstallHooks: async () => ({ ok: true, changed: false, settingsPath: "settings.json" }),
  hasCodexInstalled: () => false,
}));
vi.mock("../../server/login-service.mjs", () => ({
  readServiceRecord: () => null,
  uninstallService: () => { touched.loginItem++; return { ok: true, existed: false }; },
  writeServiceRecord: () => { touched.loginItem++; },
}));
vi.mock("../../server/retire-sound-hook.mjs", () => ({
  retireSoundHook: async () => ({ ok: true, removed: false, restored: 0 }),
}));
vi.mock("../../server/running-deck.mjs", () => ({ liveDecks: async () => [] }));
vi.mock("../../server/stop-deck.mjs", () => ({ stopDeck: async () => { touched.stop++; return { ok: true }; } }));
// The reporter starts a CLI version probe on its first send; nothing to spawn here.
vi.mock("../../server/cli-versions.mjs", () => ({ detectCliVersions: async () => ({}) }));
// The real goodbye, with the person at the terminal answering "broken".
vi.mock("../../../bin/cli/leaving.js", async (importOriginal) => {
  const real = await importOriginal<{ sayGoodbye: (o: object) => Promise<boolean> }>();
  return { ...real, sayGoodbye: (o: object) => real.sayGoodbye({ ...o, ask: async () => "broken", out: () => {} }) };
});

const SANDBOX = mkdtempSync(join(tmpdir(), "ccdeck-uninstall-goodbye-"));
const ENV_KEYS = ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CCDECK_HOME",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "AGENTS_DECK_NO_REPORTS", "AGENTS_DECK_NO_INSTALL"] as const;
const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
const INSTALL_ID = "3f2b8c1e-7a4d-4e6b-9c0d-1a2b3c4d5e6f";

let n = 0;
let data = "";
let sent: Array<{ url: string; body: Record<string, unknown> }> = [];
let printed = "";

beforeEach(() => {
  const home = join(SANDBOX, `home-${++n}`);
  data = join(home, "deck-data");
  mkdirSync(data, { recursive: true });
  Object.assign(process.env, {
    HOME: home, USERPROFILE: home,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CODEX_HOME: join(home, ".codex"),
    CCDECK_HOME: data,
    XDG_CONFIG_HOME: join(home, "xdg-config"),
    XDG_DATA_HOME: join(home, "xdg-data"),
    XDG_STATE_HOME: join(home, "xdg-state"),
  });
  // no-lan.ts vetoes reports for the whole suite; these cases are about the one
  // that goes out, through the stubbed fetch below.
  delete process.env.AGENTS_DECK_NO_REPORTS;
  delete process.env.AGENTS_DECK_NO_INSTALL;
  sent = [];
  printed = "";
  vi.stubGlobal("fetch", async (url: string, init: { body?: string }) => {
    sent.push({ url, body: JSON.parse(String(init.body ?? "{}")) });
    return { ok: true, status: 200 };
  });
  const keep = (...args: unknown[]) => { printed += `${args.join(" ")}\n`; };
  vi.spyOn(console, "log").mockImplementation(keep);
  vi.spyOn(console, "error").mockImplementation(keep);
  // A fresh reporter and a fresh read of prefs.json for every case, as a fresh
  // `ccdeck --uninstall` process has.
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

afterAll(() => rmTempDir(SANDBOX));

async function runUninstall(flags: Record<string, boolean>): Promise<number> {
  // @ts-expect-error — plain .js module, no types
  const { uninstall } = await import("../../../bin/cli/uninstall.js");
  return uninstall(flags);
}

const prefsFile = () => join(data, "prefs.json");
const uninstallEvents = () => sent.filter(s => s.url.endsWith("/v1/app/events") && s.body.kind === "uninstall");

describe("a prefs.json the deck could not boot on", () => {
  // Half a file, as a power cut between the write and the rename leaves one.
  const TRUNCATED = '{"reports": true, "report": {"installId": "' + INSTALL_ID + '"}, "lan": {"secret": "k';

  // The reporter's first read is the deck's boot read, which moves a file it
  // cannot parse aside and announces fresh settings. The uninstall had just
  // printed that same path as the file holding the key.
  for (const vetoed of [false, true]) {
    it(`is left where the uninstall said it was${vetoed ? ", with reports vetoed" : ""}`, async () => {
      if (vetoed) process.env.AGENTS_DECK_NO_REPORTS = "1";
      writeFileSync(prefsFile(), TRUNCATED);

      expect(await runUninstall({ uninstall: true }), printed).toBe(0);

      expect(readdirSync(data)).toEqual(["prefs.json"]);
      expect(readFileSync(prefsFile(), "utf8")).toBe(TRUNCATED);
      expect(printed).toContain(`${prefsFile()}  (unreadable`);
      expect(printed).not.toMatch(/fresh settings|has been kept as/);
      expect(sent).toEqual([]);
    });
  }
});

describe("the goodbye after --purge", () => {
  for (const flags of [{ uninstall: true, purge: true }, { purge: true }]) {
    it(`goes out under the install id prefs.json held before ${JSON.stringify(flags)} removed it`, async () => {
      writeFileSync(prefsFile(), JSON.stringify({ reports: true, report: { installId: INSTALL_ID } }));

      expect(await runUninstall(flags), printed).toBe(0);

      expect(existsSync(prefsFile()), "the purge took the file").toBe(false);
      expect(printed).toContain(`removed ${prefsFile()}`);
      expect(uninstallEvents()).toEqual([
        { url: expect.any(String), body: expect.objectContaining({ installId: INSTALL_ID, kind: "uninstall", reason: "broken" }) },
      ]);
      expect(touched).toEqual({ loginItem: 0, stop: 0 });
    });
  }

  it("goes out the same without --purge, and leaves the file where it is", async () => {
    writeFileSync(prefsFile(), JSON.stringify({ reports: true, report: { installId: INSTALL_ID } }));
    expect(await runUninstall({ uninstall: true }), printed).toBe(0);
    expect(existsSync(prefsFile())).toBe(true);
    expect(uninstallEvents().map(s => s.body.installId)).toEqual([INSTALL_ID]);
  });

  it("still sends nothing for an install whose reports are off", async () => {
    writeFileSync(prefsFile(), JSON.stringify({ reports: false, report: { installId: INSTALL_ID } }));
    expect(await runUninstall({ uninstall: true, purge: true }), printed).toBe(0);
    expect(existsSync(prefsFile())).toBe(false);
    expect(sent).toEqual([]);
  });
});
