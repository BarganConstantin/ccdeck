import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
// @ts-expect-error — plain JS server module, no types
import { loadPrefs, writePrefs, pagePatch, prefsPath } from "../../server/deck-prefs.mjs";
// @ts-expect-error — plain JS server module, no types
import { manifestFor, mayGiveInUse } from "../../server/lan-copies.mjs";

// 3.48.1: a ticked account goes to paired decks while this deck is on it too.
// Reported as "a teammate ticked their account and works on it, and it never
// reaches anybody": until 3.48.0 the login in use stayed home unless a switch was on
// (#2192), and every deck that saved any setting had written that switch's
// default, false, to disk with it.

const WORK = "work@example.com@@org-1";
const HOME = "home@example.com@@org-2";
const accounts = [
  { key: WORK, email: "work@example.com", alive: true, active: true },
  { key: HOME, email: "home@example.com", alive: true, active: false },
];

/** The `lan` block 3.48.0 wrote on any save: the whole normalised object. */
const saved3480 = {
  enabled: true, name: "Work PC", secret: "", shared: [WORK, HOME], onward: [], manual: [], trusted: [],
  unpaired: [], port: 0, autoAsk: true, autoAccept: true, pairingMode: "automatic", aliases: {},
  shareActive: true, sendInUse: false, tailscale: false, tailscaleAsk: true, tailscaleAccept: true,
};

function home(lan: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "ccdeck-send-in-use-"));
  const file = prefsPath(dir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ lan }));
  return dir;
}

describe("the login in use goes out with the other ticked ones (3.48.1)", () => {
  it("hands out the ticked account this deck is on, over prefs a 3.48.0 deck saved", async () => {
    const dir = home(saved3480);
    try {
      const { prefs } = await loadPrefs(dir);
      expect(prefs.lan.sendInUse).toBe(true);
      const listed = manifestFor(accounts, prefs.lan.shared, { sendInUse: prefs.lan.sendInUse === true, shareActive: true });
      const work = listed.find((a: { key: string }) => a.key === WORK);
      expect(work).toBeDefined();
      expect(work).not.toHaveProperty("shareable");
      expect(work).not.toHaveProperty("inUse");
      expect(mayGiveInUse(accounts, WORK, prefs.lan.sendInUse)).toBe(true);
    } finally {
      rmTempDir(dir);
    }
  });

  it("keeps a press of the switch made on 3.48.1, through later writes of other settings", async () => {
    const dir = home(saved3480);
    try {
      // The page's own write of the switch, as LanSetupModal sends it.
      const patch = pagePatch({ lan: { sendInUse: false } });
      expect(patch.lan).toEqual({ sendInUse: false, sendInUseSet: true });
      await writePrefs(patch, dir);
      // Another setting saved later writes the whole `lan` back: the choice stays.
      await writePrefs(pagePatch({ lan: { name: "Renamed" } }), dir);
      const { prefs } = await loadPrefs(dir);
      expect(prefs.lan.sendInUse).toBe(false);
      expect(prefs.lan.name).toBe("Renamed");
      expect(mayGiveInUse(accounts, WORK, prefs.lan.sendInUse)).toBe(false);
      const work = manifestFor(accounts, prefs.lan.shared, { sendInUse: false }).find((a: { key: string }) => a.key === WORK);
      expect(work).toMatchObject({ shareable: false, inUse: true });
    } finally {
      rmTempDir(dir);
    }
  });

  it("does not let a page set the marker by itself", () => {
    expect(pagePatch({ lan: { sendInUseSet: true } })).toEqual({});
  });
});
