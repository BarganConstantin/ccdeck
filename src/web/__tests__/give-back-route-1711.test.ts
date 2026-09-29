// #1711, the half after the password. A deck that booted on a settings folder
// it could not open is running on the defaults, and its LAN engine on a key it
// made up. Once the folder is given back the route reads the file again the
// way a boot does and hands the engine its own fields off it — and does
// neither for a deck whose copy already came from the file, where a re-read
// would only race the engine's own writes.
//
// The give-back itself and the engine are stood in for: this file is about
// what the route does with their answers, on every platform.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-give-back-route-"));
const DECK = join(DIR, "deck");
const FILE = join(DECK, "prefs.json");
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CCDECK_HOME = DECK;
process.env.AGENTS_DECK_NO_LAN = "1";
if (!resolve(DECK).startsWith(resolve(DIR))) throw new Error("sandbox escaped");
// A read no platform treats as ownership: the name is a folder, so the boot
// read is EISDIR on all three, and the deck starts on the defaults.
mkdirSync(FILE, { recursive: true });
afterAll(() => rmTempDir(DIR));

const lan = vi.hoisted(() => ({
  applyLanPrefs: vi.fn(async () => {}),
  resetLanLoaded: vi.fn(),
  forgetReach: vi.fn(),
}));
vi.mock("../../server/lan-deck.mjs", () => lan);
const giveBack = vi.hoisted(() => ({ giveBackDeckFolders: vi.fn() }));
vi.mock("../../server/prefs-give-back.mjs", () => giveBack);

// @ts-expect-error — plain .mjs server module, no types
const { handlePrefsGiveBack } = await import("../../server/prefs-routes.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { heldPrefs, prefsRead } = await import("../../server/prefs-state.mjs");

beforeAll(async () => { await prefsRead; });
beforeEach(() => { vi.clearAllMocks(); });

async function press() {
  let status = 0, body = "";
  const res = {
    headersSent: false,
    writeHead: (s: number) => { status = s; return res; },
    end: (b?: string) => { body = b ?? ""; },
  };
  await handlePrefsGiveBack({ method: "POST", headers: {} }, res);
  expect(body).not.toContain(DIR);
  return { status, out: JSON.parse(body) };
}

function becomeReadable(name: string) {
  rmSync(FILE, { recursive: true, force: true });
  writeFileSync(FILE, JSON.stringify({ lan: { name } }) + "\n", { mode: 0o600 });
}

describe("POST /api/prefs/give-back", () => {
  it("booted on the defaults, as a deck refused its folder does", () => {
    expect(heldPrefs.current().lan?.name ?? "").toBe("");
  });

  it("passes a refusal through as a reason alone, and reads nothing", async () => {
    giveBack.giveBackDeckFolders.mockResolvedValueOnce({ ok: false, reason: "cancelled" });
    expect(await press()).toEqual({ status: 409, out: { ok: false, reason: "cancelled" } });
    expect(lan.resetLanLoaded).not.toHaveBeenCalled();
    expect(lan.applyLanPrefs).not.toHaveBeenCalled();
  });

  it("keeps the copy it was running on when the file still cannot be read", async () => {
    giveBack.giveBackDeckFolders.mockResolvedValueOnce({ ok: true, changed: true });
    const before = heldPrefs.current();
    const { status, out } = await press();
    expect(status).toBe(200);
    expect(out).toMatchObject({ ok: true, changed: true });
    expect(heldPrefs.current()).toBe(before);
    expect(lan.applyLanPrefs).not.toHaveBeenCalled();
  });

  it("reads the file again once it can, and hands the engine its own fields off it", async () => {
    becomeReadable("read-again");
    giveBack.giveBackDeckFolders.mockResolvedValueOnce({ ok: true, changed: true });
    const { status, out } = await press();
    expect(status).toBe(200);
    expect(out).toMatchObject({ ok: true, changed: true, prefs: { lan: { name: "read-again" } } });
    expect(heldPrefs.current().lan.name).toBe("read-again");
    expect(lan.resetLanLoaded).toHaveBeenCalledTimes(1);
    expect(lan.applyLanPrefs).toHaveBeenCalledTimes(1);
    // Reset first: the apply is what reads the engine's fields, and only a
    // reset one reads them off the file.
    expect(lan.resetLanLoaded.mock.invocationCallOrder[0]).toBeLessThan(lan.applyLanPrefs.mock.invocationCallOrder[0]);
  });

  it("leaves a deck whose copy came from the file alone, even when the file moved on", async () => {
    becomeReadable("somebody-else-wrote-this");
    giveBack.giveBackDeckFolders.mockResolvedValueOnce({ ok: true, changed: false });
    const { status, out } = await press();
    expect(status).toBe(200);
    expect(out).toMatchObject({ ok: true, changed: false });
    expect(heldPrefs.current().lan.name).toBe("read-again");
    expect(lan.resetLanLoaded).not.toHaveBeenCalled();
    expect(lan.applyLanPrefs).not.toHaveBeenCalled();
    expect(await heldPrefs.reload()).toBe("held");
  });
});
