// Internal #101: a reader names a session in the deck. This file is the
// server's half without a server: the store the names are kept in
// (session-deck-names.mjs), the route that writes one, and the boot's
// announce for a session the log replay put back.
//
// The name is the deck's own, kept in session-names.json in the deck's data
// folder and keyed by provider and session id; nothing here writes either
// provider's files. Every path below is a fresh temp folder.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
// @ts-expect-error — plain .mjs server module, no types
import * as names from "../../server/session-deck-names.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { announceKeptNames, handleSessionNameWrite } from "../../server/session-name-route.mjs";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-deck-names-"));
let n = 0;
/** A file of names nobody has written yet, in a folder that may not exist. */
const fresh = () => join(DIR, `case-${++n}`, "session-names.json");
const onDisk = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const UUID = "0b9a2f7e-1c3d-4e5f-8a9b-0c1d2e3f4a5b";

beforeEach(() => names.resetDeckNamesForTest());
afterAll(() => { names.resetDeckNamesForTest(); rmTempDir(DIR); });

describe("a name as it is kept", () => {
  it("is one line with its spaces collapsed and its ends trimmed", () => {
    expect(names.cleanDeckName("  Fix   the\tlogin\npage  ")).toBe("Fix the login page");
  });

  it("drops the characters that hide or reorder text, so two names never look the same", () => {
    const hidden = String.fromCharCode(0x200b, 0x200e, 0x202e, 0x2066, 0xfeff, 0x07, 0x85);
    expect(names.cleanDeckName(`Re${hidden}view`)).toBe("Re view");
  });

  it("is cut at DECK_NAME_MAX characters, counted as characters and not UTF-16 units", () => {
    const long = "é😀".repeat(100);
    const kept = names.cleanDeckName(long);
    expect([...kept].length).toBe(names.DECK_NAME_MAX);
    // Never half a surrogate pair at the cut.
    expect(kept.endsWith("😀") || kept.endsWith("é")).toBe(true);
  });

  it("answers null for nothing left, and for null: the name cleared", () => {
    expect(names.cleanDeckName("   \n ")).toBeNull();
    expect(names.cleanDeckName(null)).toBeNull();
  });

  it("answers undefined for anything that is not a name", () => {
    for (const v of [undefined, 3, {}, [], true]) expect(names.cleanDeckName(v)).toBeUndefined();
  });
});

describe("where a name is kept", () => {
  it("is keyed by provider and session id, a missing provider being Claude's", () => {
    expect(names.deckNameKey("claude", UUID)).toBe(`claude:${UUID}`);
    expect(names.deckNameKey("codex", UUID)).toBe(`codex:${UUID}`);
    expect(names.deckNameKey(undefined, UUID)).toBe(`claude:${UUID}`);
  });

  it("is nowhere for a provider the deck does not name or an id that could be a path", () => {
    expect(names.deckNameKey("gemini", UUID)).toBeNull();
    for (const id of ["", "../x", "a/b", "a\\b", ".hidden", "x".repeat(200), 7]) {
      expect(names.deckNameKey("claude", id)).toBeNull();
    }
  });

  it("is the deck's data folder, never a provider's", () => {
    expect(names.deckNamesPath("/data/ccdeck")).toBe(join("/data/ccdeck", "session-names.json"));
  });
});

describe("the file of names", () => {
  it("keeps a name, and a new process reads it back", async () => {
    const path = fresh();
    await expect(names.writeDeckName("claude", UUID, "  Billing   fix ", { path, now: 5 })).resolves.toBe("Billing fix");
    expect(onDisk(path)).toEqual({ version: 1, names: { [`claude:${UUID}`]: { name: "Billing fix", at: 5 } } });
    expect(names.deckNameFor("claude", UUID)).toBe("Billing fix");

    names.resetDeckNamesForTest();
    expect(names.deckNameFor("claude", UUID)).toBeUndefined();
    await names.loadDeckNames(path);
    expect(names.deckNameFor("claude", UUID)).toBe("Billing fix");
    expect(names.heldDeckNames()).toEqual([["claude", UUID, "Billing fix"]]);
  });

  it("keeps two sessions of one folder apart, and a Codex id apart from a Claude one", async () => {
    const path = fresh();
    await names.writeDeckName("claude", "a1", "One", { path });
    await names.writeDeckName("claude", "a2", "Two", { path });
    await names.writeDeckName("codex", "a1", "Codex one", { path });
    expect(names.deckNameFor("claude", "a1")).toBe("One");
    expect(names.deckNameFor("claude", "a2")).toBe("Two");
    expect(names.deckNameFor("codex", "a1")).toBe("Codex one");
  });

  it("forgets a name cleared with null, and with a name that is only spaces", async () => {
    const path = fresh();
    await names.writeDeckName("claude", "a1", "One", { path });
    await names.writeDeckName("claude", "a2", "Two", { path });
    await expect(names.writeDeckName("claude", "a1", null, { path })).resolves.toBeNull();
    await expect(names.writeDeckName("claude", "a2", "   ", { path })).resolves.toBeNull();
    expect(onDisk(path).names).toEqual({});
    expect(names.deckNameFor("claude", "a1")).toBeUndefined();
  });

  it("refuses a session it does not name and a value that is not a name, writing nothing", async () => {
    const path = fresh();
    await expect(names.writeDeckName("claude", "../etc", "x", { path })).rejects.toThrow(TypeError);
    await expect(names.writeDeckName("claude", UUID, 42, { path })).rejects.toThrow(TypeError);
    expect(existsSync(path)).toBe(false);
  });

  it("leaves memory as it was when the write fails, so the caller can say so", async () => {
    const path = fresh();
    await names.writeDeckName("claude", UUID, "Kept", { path });
    const fail = () => Promise.reject(Object.assign(new Error("read-only"), { code: "EROFS" }));
    await expect(names.writeDeckName("claude", UUID, "Lost", { path, writeFile: fail })).rejects.toThrow("read-only");
    expect(names.deckNameFor("claude", UUID)).toBe("Kept");
    expect(onDisk(path).names[`claude:${UUID}`].name).toBe("Kept");
    // And the next write is not stuck behind the failed one.
    await expect(names.writeDeckName("claude", UUID, "Next", { path })).resolves.toBe("Next");
  });

  it("writes one at a time, so two quick saves both land", async () => {
    const path = fresh();
    await Promise.all([
      names.writeDeckName("claude", "a1", "One", { path }),
      names.writeDeckName("claude", "a2", "Two", { path }),
    ]);
    expect(Object.keys(onDisk(path).names).sort()).toEqual(["claude:a1", "claude:a2"]);
  });

  it("reads a file it cannot use as no names, and the deck still runs", async () => {
    const path = fresh();
    await names.writeDeckName("claude", "a1", "x", { path });
    writeFileSync(path, "{ not json");
    names.resetDeckNamesForTest();
    await expect(names.loadDeckNames(path)).resolves.toEqual(new Map());
  });

  it("skips entries a hand edit broke, and keeps the rest", () => {
    const got = names.normaliseDeckNames({
      names: {
        "claude:ok": { name: "Fine", at: 1 },
        "claude:../x": { name: "path", at: 1 },
        "gemini:abc": { name: "other", at: 1 },
        "codex:n": { name: 7 },
        "nocolon": { name: "x" },
        "claude:blank": { name: "   " },
      },
    });
    expect([...got.keys()]).toEqual(["claude:ok"]);
  });

  it("keeps the newest DECK_NAMES_CAP names", () => {
    const many = new Map();
    for (let i = 0; i <= names.DECK_NAMES_CAP; i++) many.set(`claude:s${i}`, { name: `n${i}`, at: i });
    const kept = names.capDeckNames(many);
    expect(kept.size).toBe(names.DECK_NAMES_CAP);
    expect(kept.has("claude:s0")).toBe(false);
    expect(kept.has(`claude:s${names.DECK_NAMES_CAP}`)).toBe(true);
  });
});

// ── The route, without a server ──────────────────────────────────────────────

type Answer = { status: number; body: { ok: boolean; name?: string | null; reason?: string } };
async function route(body: unknown, deps: Record<string, unknown>): Promise<Answer> {
  const req = Readable.from([Buffer.from(typeof body === "string" ? body : JSON.stringify(body))]);
  const out = { status: 0, body: null as unknown };
  const res = {
    headersSent: false,
    writeHead(status: number) { out.status = status; },
    end(text: string) { out.body = JSON.parse(text); this.headersSent = true; },
  };
  await handleSessionNameWrite(req, res, deps);
  return out as Answer;
}

describe("POST /api/session-name", () => {
  it("keeps the cleaned name and tells every page", async () => {
    const told: unknown[] = [];
    const wrote: unknown[] = [];
    const a = await route({ provider: "codex", sessionId: UUID, name: " Ship  it " }, {
      write: async (...args: unknown[]) => { wrote.push(args); return "Ship it"; },
      announce: (...args: unknown[]) => { told.push(args); },
    });
    expect(a).toEqual({ status: 200, body: { ok: true, name: "Ship it" } });
    expect(wrote).toEqual([["codex", UUID, "Ship it"]]);
    expect(told).toEqual([[UUID, "Ship it"]]);
  });

  it("clears with an empty name, and says so with null", async () => {
    const told: unknown[] = [];
    const a = await route({ sessionId: UUID, name: "" }, {
      write: async (_p: string, _s: string, name: unknown) => name,
      announce: (...args: unknown[]) => { told.push(args); },
    });
    expect(a).toEqual({ status: 200, body: { ok: true, name: null } });
    expect(told).toEqual([[UUID, null]]);
  });

  it("answers 400 for a body that names no session or holds no name, and writes nothing", async () => {
    const write = () => { throw new Error("must not write"); };
    for (const body of ["not json", "null", { name: "x" }, { sessionId: "../x", name: "x" },
      { provider: "gemini", sessionId: UUID, name: "x" }, { sessionId: UUID, name: 3 }, { sessionId: UUID }]) {
      const a = await route(body, { write, announce: write });
      expect(a, JSON.stringify(body)).toEqual({ status: 400, body: { ok: false, reason: "bad_request" } });
    }
  });

  it("answers 500 when the file cannot be written, and announces nothing", async () => {
    const told: unknown[] = [];
    const prev = console.error;
    const logged: string[] = [];
    console.error = (line: string) => { logged.push(String(line)); };
    try {
      const a = await route({ sessionId: UUID, name: "Secret project name" }, {
        write: async () => { throw Object.assign(new Error("/home/someone/.ccdeck denied"), { code: "EACCES" }); },
        announce: (...args: unknown[]) => { told.push(args); },
      });
      expect(a).toEqual({ status: 500, body: { ok: false, reason: "not_saved" } });
    } finally {
      console.error = prev;
    }
    expect(told).toEqual([]);
    // The code only: never the path, never the name.
    expect(logged.join("\n")).toContain("EACCES");
    expect(logged.join("\n")).not.toContain("Secret project name");
    expect(logged.join("\n")).not.toContain(".ccdeck");
  });
});

describe("the boot's announce", () => {
  it("tells each kept name whose session the replay put back, once and not logged", async () => {
    const path = fresh();
    await names.writeDeckName("claude", "back", "Came back", { path });
    await names.writeDeckName("codex", "gone", "Not in the ring", { path });
    const told: unknown[] = [];
    const count = announceKeptNames(
      [{ payload: { session_id: "back" } }, { payload: { session_id: "back" } }, { payload: {} }, null],
      (...args: unknown[]) => { told.push(args); },
    );
    expect(count).toBe(1);
    expect(told).toEqual([["back", "Came back", { persist: false }]]);
  });

  it("tells nothing before the names are read", () => {
    expect(announceKeptNames([{ payload: { session_id: "x" } }], () => { throw new Error("no"); })).toBe(0);
  });
});
