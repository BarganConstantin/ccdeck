// POST /api/prefs writes the fields the page edits, and keeps every other one
// as it was on disk.
//
// The route is a patch: whatever the body names is merged over the file. That
// is right for the switches the page draws, and wrong for the fields the deck
// writes itself — its LAN key, the decks somebody accepted or unpaired, which
// ticks an arrival made, the port it listens on — which the deck reads back at
// its next start. So the body is narrowed to the page's own fields first, and
// these tests post through the real route into a real prefs.json and read it
// back the way a restart does.
//
// The LAN engine is stood in for: this file is about what lands in the file.
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-prefs-route-fields-"));
const DECK = join(DIR, "deck");
const FILE = join(DECK, "prefs.json");
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CCDECK_HOME = DECK;
process.env.AGENTS_DECK_NO_LAN = "1";
if (!resolve(DECK).startsWith(resolve(DIR))) throw new Error("sandbox escaped");
afterAll(() => rmTempDir(DIR));

/** What the deck itself wrote before any page posted: a key, two pairings, an
 *  unpair, an arrival's tick, a port, a name for another deck, the reporter's
 *  state and the accounts it signed in. */
const MINE = { fp: "aaa-bbb-ccc-ddd", pub: "cHViLWtleS1taW5l", name: "laptop", at: 1_700_000_000_000 };
const ON_DISK = {
  notifications: false,
  tourSeen: false,
  autoUpdate: true,
  git: true,
  reports: true,
  report: {
    installId: "install-1", lastVersion: "3.36.0", lastActiveDay: "2026-10-04",
    rating: { askedAt: "", answer: "", snoozedUntil: "" },
  },
  accounts: { "work@example.com|org-1": { origin: "signed-in-here", signedInAt: 1_700_000_000_000 } },
  lan: {
    enabled: true, name: "desk", secret: "the-deck-key", shared: ["acct-1", "acct-2"], onward: ["acct-2"],
    manual: ["10.0.0.1:5000"], trusted: [MINE], unpaired: ["eee-fff-000-111"], port: 41234,
    aliases: { "aaa-bbb-ccc-ddd": "the laptop" },
  },
};
/** Every case starts from what the deck wrote, so none leans on another. */
const putBack = () => writeFileSync(FILE, JSON.stringify(ON_DISK) + "\n", { mode: 0o600 });
mkdirSync(DECK, { recursive: true });
putBack();

vi.mock("../../server/lan-deck.mjs", () => ({
  applyLanPrefs: vi.fn(async () => {}),
  resetLanLoaded: vi.fn(),
  forgetReach: vi.fn(),
}));

// @ts-expect-error — plain .mjs server module, no types
const { handlePrefsWrite } = await import("../../server/prefs-routes.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { prefsRead } = await import("../../server/prefs-state.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { loadPrefs, normalise, PAGE_FIELDS } = await import("../../server/deck-prefs.mjs");

let before: Record<string, any>;
beforeAll(async () => {
  await prefsRead;
  before = await restart();
});
beforeEach(putBack);

/** POST `body` through the route, as a page would. */
async function post(body: unknown) {
  const req = Object.assign(new PassThrough(), { method: "POST", headers: { "content-type": "application/json" } });
  req.end(JSON.stringify(body));
  let status = 0, text = "";
  const res = {
    headersSent: false,
    writeHead: (s: number) => { status = s; return res; },
    end: (b?: string) => { text = b ?? ""; },
  };
  await handlePrefsWrite(req, res);
  return { status, out: JSON.parse(text) };
}

/** What a deck starting now would read. */
async function restart() {
  const { prefs, source } = await loadPrefs(DECK);
  expect(source).toBe("file");
  return prefs;
}

describe("POST /api/prefs and the fields the deck writes itself", () => {
  it("does not take a LAN key or a pairing from a page", async () => {
    const { status } = await post({
      lan: { secret: "a-key-from-a-page", trusted: [{ fp: "999-999-999-999", pub: "cGFnZQ==", name: "page" }] },
    });
    expect(status).toBe(200);
    const now = await restart();
    expect(now.lan.secret).toBe("the-deck-key");
    expect(now.lan.trusted).toEqual([MINE]);
  });

  it("keeps every other field the deck writes itself as it was on disk", async () => {
    await post({
      reports: false,
      report: { installId: "page-id", rating: { answer: "5" } },
      accounts: { "page@example.com|": { origin: "signed-in-here", signedInAt: 1 } },
      lan: { unpaired: [], onward: ["acct-1", "acct-2"], port: 1, aliases: { "999-999-999-999": "page" } },
    });
    const now = await restart();
    expect(now.reports).toBe(before.reports);
    expect(now.report).toEqual(before.report);
    expect(now.accounts).toEqual(before.accounts);
    for (const field of ["secret", "trusted", "unpaired", "onward", "port", "aliases"]) {
      expect(now.lan[field], `lan.${field}`).toEqual(before.lan[field]);
    }
  });

  it("takes the page's half of a body that names both", async () => {
    await post({ notifications: true, lan: { name: "renamed", secret: "a-key-from-a-page", port: 1 } });
    const now = await restart();
    expect(now.notifications).toBe(true);
    expect(now.lan.name).toBe("renamed");
    expect(now.lan.secret).toBe("the-deck-key");
    expect(now.lan.port).toBe(41234);
  });
});

// Every write the page and the desktop app make, in the shape they make it:
// use-os-notifications.ts and desktop/main.mjs, use-welcome-and-notes.ts,
// use-auto-restart.ts, git-pref.ts, git-handoffs.ts, use-lan-section.ts,
// LanAddDeckModal.tsx and LanSetupModal.tsx.
const WRITES: [string, unknown, (p: any) => unknown, unknown][] = [
  ["notifications", { notifications: true }, p => p.notifications, true],
  ["tourSeen", { tourSeen: true }, p => p.tourSeen, true],
  ["autoUpdate", { autoUpdate: false }, p => p.autoUpdate, false],
  ["git", { git: false }, p => p.git, false],
  ["gitApps", { gitApps: { editor: "zed" } }, p => p.gitApps, { git: "", editor: "zed", terminal: "" }],
  ["lan.enabled", { lan: { enabled: false } }, p => p.lan.enabled, false],
  ["lan.manual", { lan: { manual: ["10.0.0.1:5000", "10.0.0.2:5001"] } }, p => p.lan.manual, ["10.0.0.1:5000", "10.0.0.2:5001"]],
  ["lan.name", { lan: { name: "studio" } }, p => p.lan.name, "studio"],
  ["lan.shared", { lan: { shared: ["acct-1", "acct-2", "acct-3"] } }, p => p.lan.shared, ["acct-1", "acct-2", "acct-3"]],
  ["lan.shareActive", { lan: { shareActive: false } }, p => p.lan.shareActive, false],
  ["lan.pairingMode", { lan: { pairingMode: "invite" } }, p => p.lan.pairingMode, "invite"],
  ["lan.autoAsk", { lan: { autoAsk: false } }, p => p.lan.autoAsk, false],
  ["lan.autoAccept", { lan: { autoAccept: false } }, p => p.lan.autoAccept, false],
  ["lan.tailscale", { lan: { tailscale: true } }, p => p.lan.tailscale, true],
  ["lan.tailscaleAsk", { lan: { tailscaleAsk: false } }, p => p.lan.tailscaleAsk, false],
  ["lan.tailscaleAccept", { lan: { tailscaleAccept: false } }, p => p.lan.tailscaleAccept, false],
];

describe("POST /api/prefs and the fields the page edits", () => {
  for (const [name, body, read, want] of WRITES) {
    it(`takes ${name}`, async () => {
      const { status, out } = await post(body);
      expect(status).toBe(200);
      expect(out.ok).toBe(true);
      expect(read(await restart())).toEqual(want);
    });
  }

  it("still takes an arrival's mark away with an untick", async () => {
    // The one deck-written field a page write moves: `onward` is only ever a
    // subset of `shared`, so unticking acct-2 drops its mark, and ticking it
    // again is a person's tick.
    await post({ lan: { shared: ["acct-1"] } });
    expect((await restart()).lan.onward).toEqual([]);
    await post({ lan: { shared: ["acct-1", "acct-2"] } });
    expect((await restart()).lan.onward).toEqual([]);
  });
});

describe("the fields a page may write", () => {
  // A LIST, ON PURPOSE. Naming a field here is deciding that anything able to
  // post to the deck's port may set it, so a new preference stays the deck's
  // own until somebody makes that decision in PAGE_FIELDS and in this test.
  it("are these, and no others", () => {
    expect(PAGE_FIELDS).toEqual({
      top: ["notifications", "tourSeen", "autoUpdate", "git", "gitApps"],
      lan: [
        "enabled", "name", "shared", "manual", "shareActive", "pairingMode",
        "autoAsk", "autoAccept", "tailscale", "tailscaleAsk", "tailscaleAccept",
      ],
    });
  });

  it("leave every other preference to the deck, by name", () => {
    // Every field the file holds is on one list or the other, so a new one
    // cannot be added to the file without being sorted onto one.
    const DECKS_OWN = {
      top: ["reports", "report", "accounts"],
      lan: ["secret", "onward", "trusted", "unpaired", "port", "aliases"],
    };
    const held = normalise({});
    expect([...PAGE_FIELDS.top, ...DECKS_OWN.top].sort()).toEqual(Object.keys(held).filter(k => k !== "lan").sort());
    expect([...PAGE_FIELDS.lan, ...DECKS_OWN.lan].sort()).toEqual(Object.keys(held.lan).sort());
  });

  it("are each written through the route above", () => {
    const named = [...PAGE_FIELDS.top, ...PAGE_FIELDS.lan.map((k: string) => `lan.${k}`)];
    expect(WRITES.map(([name]) => name).sort()).toEqual(named.sort());
  });
});
