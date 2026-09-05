// `writeStore` writes what it is handed, so every caller must hand it
// everything.
//
// There is no merge with what is on disk, on purpose: a writer that read first
// would have to decide what wins, and two decks racing on that is worse than one
// deck writing a whole state. The cost is that an omitted field is an erased
// field, and that cost was paid once — the settings route wrote `{settings,
// episodes}` and so wiped every dismissal, which meant changing the reaction or
// the quiet gate brought back every episode the reader had reviewed. Measured
// live: two dismissals on disk before a settings POST, zero after.
//
// WHY THIS FILE STOPPED BEING A GREP. It used to open with "grepped rather than
// exercised, because the failure is a caller that forgets a field — which no
// test of `writeStore` itself can see". The first half of that is true and the
// conclusion did not follow. No test of the WRITER can see it; a test of the
// CALLER can, and the caller is an HTTP route. The defect was observed by
// counting dismissals on disk either side of a settings POST, which is four
// lines of test — and a regex over object literals cannot see a caller that
// names `dismissed` and hands it `undefined`, nor one whose spelling drifts out
// of the pattern, nor a new writer nobody grepped for.
//
// That first one is not hypothetical; it was run. Changing the settings route
// to `updateStore(cur => ({ ...cur, settings, dismissed: undefined }))` erases
// every dismissal — `writeNow` resolves it through `state.dismissed ?? []` —
// and the old sweep passes it, because the field is named. Exactly one case
// fails, and it is the one below that reads the file back.
//
// So the two halves are split by what each is good for. The sweep is an
// INVENTORY: it finds every writer in the server and fails when one appears
// that this file does not drive, which is the only thing text can honestly
// prove here. Everything else runs the real routes against a real store on
// disk, seeded with all three fields non-empty, and reads the file back.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { request } from "node:http";
import type { Server } from "node:http";

const serverDir = fileURLToPath(new URL("../../server", import.meta.url));

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-store-whole-"));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.XDG_CONFIG_HOME = join(DIR, "config");
if (!resolve(process.env.CLAUDE_CONFIG_DIR).startsWith(resolve(DIR))) throw new Error("sandbox escaped");

// @ts-expect-error — plain .mjs server modules, no types
const store = await import("../../server/browser-watch-store.mjs");
// @ts-expect-error — ditto
const server = await import("../../server/index.mjs");

/** Every `writeStore({...})` call in the server, with its object literal. */
function calls(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const name of readdirSync(serverDir)) {
    if (!name.endsWith(".mjs")) continue;
    const text = readFileSync(join(serverDir, name), "utf8");
    for (const m of text.matchAll(/(?<!update)writeStore\)?\(\s*(\{[^}]*\})/g)) out.push([name, m[1]]);
  }
  return out;
}

/** Every `updateStore(cur => …)` mutation in the server, with its body.
 *
 *  A different contract, for a caller that owns ONE field: it runs inside the
 *  write queue against the state on disk at that moment, so it either spreads
 *  `cur` or names every field itself. Both are whole states; only one of them
 *  has to be spelled out. */
function updates(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const name of readdirSync(serverDir)) {
    if (!name.endsWith(".mjs")) continue;
    const text = readFileSync(join(serverDir, name), "utf8");
    for (const m of text.matchAll(/updateStore\)?\(\s*(?:async\s*)?(?:cur|current)\s*=>\s*\(?(\{[^}]*\})/g)) {
      out.push([name, m[1]]);
    }
    // The multi-line form, where the callback has a body and a return.
    for (const m of text.matchAll(/updateStore\)?\(\s*(?:async\s*)?(?:cur|current)\s*=>\s*\{([\s\S]{0,400}?)\n\s*\}/g)) {
      out.push([name, m[1]]);
    }
  }
  return out;
}

/** A dismissal key that is on disk before every case below, and must still be
 *  there after. Two of them, because the defect erased a LIST and a bug that
 *  truncated it to one would look like a pass with a single entry. */
const KEPT = [store.episodeKey("news.example", 1_700_000_000_000), store.episodeKey("mail.example", 1_700_000_100_000)];

/** One archived episode, likewise. Shaped by the store's own normaliser rather
 *  than guessed, so a change to the row's shape reaches this file. */
const EPISODE = {
  host: "news.example",
  startMs: 1_700_000_000_000,
  endMs: 1_700_000_060_000,
  visits: 3,
  browser: "Chrome",
};

/**
 * Put a whole, current state on disk before each case.
 *
 * Written THROUGH `writeStore` rather than as a hand-rolled JSON literal, and
 * that is the opposite of the usual rule about fixtures laid down by the thing
 * under test. The reason is a trap this file fell into on its first run: the
 * store carries a version, `readStore` DROPS the episodes and the dismissals of
 * any file whose version it does not recognise, and `STORE_VERSION` is not
 * exported. A literal fixture therefore has to hardcode the number — and on the
 * day it is bumped, every case here would go green against a state the server
 * had quietly emptied, which is the exact failure these cases exist to catch.
 *
 * So the writer lays the fixture and the fixture is then CHECKED: read it back
 * and confirm both dismissals and the episode survived. A version bump, or a
 * writer that stopped round-tripping, fails here rather than everywhere.
 */
async function seed() {
  await store.writeStore({
    settings: { ...store.DEFAULTS, quietMinutes: 7 },
    episodes: [EPISODE],
    dismissed: [...KEPT],
  });
  const back = await store.readStore();
  if (back.migrated) throw new Error("the fixture is not a state this build can read — STORE_VERSION moved");
  if (back.dismissed.length !== KEPT.length || back.episodes.length !== 1) {
    throw new Error(`the fixture did not survive its own write: ${JSON.stringify(back)}`);
  }
}

const onDisk = () => JSON.parse(readFileSync(store.storePath(), "utf8"));

let http: Server;
let port = 0;

function post(path: string, body: unknown): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify(body);
  return new Promise((done, fail) => {
    const req = request({
      host: "127.0.0.1", port, path, method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
        // Both mutation gates in one shape: a loopback Origin that matches the
        // Host is what the deck's own page sends and what a rebound page cannot.
        host: `127.0.0.1:${port}`,
        origin: `http://127.0.0.1:${port}`,
      },
    }, res => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", d => { text += d; });
      res.on("end", () => done({ status: res.statusCode ?? 0, body: text }));
    });
    req.on("error", fail);
    req.setTimeout(10_000, () => req.destroy(new Error(`POST ${path} timed out`)));
    req.end(payload);
  });
}

beforeAll(async () => {
  http = await server.startServer({ port: 0, persist: false, open: false, claude: false, codex: false });
  port = (http.address() as { port: number }).port;
}, 30_000);

afterAll(async () => {
  await new Promise(r => http.close(r));
  rmTempDir(DIR);
});

beforeEach(async () => { await seed(); });

describe("the writers this file knows about are all the writers there are", () => {
  it("finds the call sites at all", () => {
    // If a rename ever slips them out of this sweep, the inventory below passes
    // by finding nothing — which is the failure mode this half exists to avoid.
    // Most callers moved to `updateStore` when the three writers were
    // serialized, so both sweeps have to find something.
    expect(calls().length + updates().length).toBeGreaterThanOrEqual(3);
    expect(updates().length).toBeGreaterThanOrEqual(2);
  });

  it("has a behaviour case for every file that writes the store", () => {
    // The inventory, and the only claim text can honestly make here. A new
    // writer in a file nothing below drives is the case this catches: the
    // regexes cannot tell whether a literal is right, but they can tell that
    // somebody added one and did not come here.
    const writing = new Set([...calls(), ...updates()].map(([file]) => file));
    expect([...writing].sort()).toEqual(["browser-watch.mjs", "index.mjs"]);
  });
});

describe("a settings change keeps everything that is not a setting", () => {
  it("leaves the dismissals alone, which is the defect this file is named for", async () => {
    const before = onDisk();
    expect(before.dismissed).toEqual(KEPT);

    const res = await post("/api/browser-watch", { quietMinutes: 11 });
    expect(res.status, `the settings route answered ${res.status}: ${res.body}`).toBe(200);

    const after = onDisk();
    expect(after.settings.quietMinutes, "the setting the route was asked to change did not change").toBe(11);
    expect(after.dismissed, "a settings change erased the dismissals").toEqual(KEPT);
  });

  it("leaves the archived episodes alone too", async () => {
    const res = await post("/api/browser-watch", { gapMinutes: 9 });
    expect(res.status).toBe(200);
    const after = onDisk();
    expect(after.settings.gapMinutes).toBe(9);
    expect(after.episodes.map((e: { host: string }) => e.host), "a settings change erased the archive")
      .toEqual([EPISODE.host]);
  });

  it("keeps the settings it was not asked about", async () => {
    // The other direction of the same contract, one level in: a route that
    // wrote only the field it was handed would blank every other setting.
    const res = await post("/api/browser-watch", { gapMinutes: 9 });
    expect(res.status).toBe(200);
    expect(onDisk().settings.quietMinutes, "the setting nobody touched was reset").toBe(7);
  });
});

describe("a dismissal keeps everything that is not a dismissal", () => {
  it("adds the new key and keeps the old ones", async () => {
    const res = await post("/api/browser-watch/dismiss", { host: "shop.example", startMs: 1_700_000_200_000 });
    expect(res.status, `the dismiss route answered ${res.status}: ${res.body}`).toBe(200);
    const after = onDisk();
    expect(after.dismissed).toContain(store.episodeKey("shop.example", 1_700_000_200_000));
    for (const kept of KEPT) expect(after.dismissed, "dismissing one episode dropped another").toContain(kept);
  });

  it("leaves the settings and the archive where they were", async () => {
    await post("/api/browser-watch/dismiss", { host: "shop.example", startMs: 1_700_000_200_000 });
    const after = onDisk();
    expect(after.settings.quietMinutes, "a dismissal reset a setting").toBe(7);
    expect(after.episodes.map((e: { host: string }) => e.host), "a dismissal erased the archive")
      .toEqual([EPISODE.host]);
  });
});

describe("the writer's own contract", () => {
  it("writes exactly what it is handed, which is why the callers must be whole", async () => {
    // The premise every case above rests on, stated by exercising it rather
    // than by quoting the comment that describes it: hand `writeStore` a state
    // with a field missing and the field is GONE. If this ever started merging,
    // the callers would no longer have to be whole and this file would be
    // enforcing a rule that had quietly stopped existing.
    await store.writeStore({ settings: { ...store.DEFAULTS }, episodes: [] });
    expect(onDisk().dismissed, "writeStore merged instead of replacing").toEqual([]);
  });

  it("re-reads inside the queue, so updateStore cannot lose a concurrent write", async () => {
    // Why the routes use `updateStore` and not a read-then-write. Two mutations
    // issued together, each owning a different field: with a read outside the
    // queue the second would write back the first's stale value.
    // Real keys, not "a" and "b". `readStore` drops any dismissal without the
    // NUL separator, so two made-up strings would be written and then filtered
    // out on the next read — and the case would fail for a reason that has
    // nothing to do with the queue. That is how it failed the first time.
    const first = store.episodeKey("first.example", 1_700_000_300_000);
    const second = store.episodeKey("second.example", 1_700_000_400_000);
    await Promise.all([
      store.updateStore((cur: { dismissed: string[] }) => ({ ...cur, dismissed: [...cur.dismissed, first] })),
      store.updateStore((cur: { dismissed: string[] }) => ({ ...cur, dismissed: [...cur.dismissed, second] })),
    ]);
    const after = onDisk();
    expect(after.dismissed, "one of two concurrent mutations was lost").toContain(first);
    expect(after.dismissed).toContain(second);
    for (const kept of KEPT) expect(after.dismissed).toContain(kept);
  });

  it("says in the writer itself that this is the contract", () => {
    // So the next person to add a field reads why they have to update the
    // callers rather than discovering it the way this was discovered.
    const src = readFileSync(join(serverDir, "browser-watch-store.mjs"), "utf8");
    expect(src).toMatch(/IT WRITES WHAT IT IS HANDED/);
    // And the other half of the contract, for the callers that own one field.
    expect(src).toMatch(/Read, change, write — with nothing else writing in between/);
  });
});
