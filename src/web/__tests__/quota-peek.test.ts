// GET /api/quota?cached=1 IS A LOOK, NEVER A READ.
//
// The rail's usage meter is drawn while the Usage panel is shut, and the owner's
// rule for it (2026-11-01) is that it must not cause a read of Claude's quota
// of its own: no store read, no OAuth request, no `claude --print /usage`. It
// shows what the deck already read because the panel was open or a quota
// notification's watcher took one. These cases spy on every door a read goes
// through, call the route the way the meter does, and count what went through.
//
// Replaced wholesale, as in quota-account-switch.test.ts: claude-swap's store
// (a counter on activeAccountUsage and requestCollection), the CLI (a counter
// on exec.mjs's run) and the network (a throwing fetch with a counter), with
// every home the module resolves pointing into a temp directory.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withGapsSkipped } from "./skip-gaps";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-quota-peek-"));
const ENV_KEYS = ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CLAUDE_SWAP_BACKUP"] as const;
const PREV = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.CLAUDE_SWAP_BACKUP = join(DIR, "cswap");
const inside = (p: string) => resolve(p).startsWith(resolve(DIR));
for (const k of ENV_KEYS) {
  if (!inside(process.env[k]!)) throw new Error(`sandbox escaped: ${k}=${process.env[k]}`);
}
if (!inside(homedir())) throw new Error(`sandbox escaped: homedir ${homedir()}`);

const { world } = vi.hoisted(() => ({
  world: { cliOut: "Claude Code usage\n", entry: null as unknown, storeReads: 0, collects: 0, cliRuns: [] as string[][], fetches: [] as string[] },
}));
vi.mock("../../server/claude-accounts.mjs", () => ({
  activeAccountUsage: async () => { world.storeReads++; return world.entry; },
  requestCollection: async () => { world.collects++; return false; },
}));
vi.mock("../../server/exec.mjs", () => ({
  run: async (cmd: string, args: string[] = []) => {
    world.cliRuns.push([cmd, ...args]);
    return { ok: true, code: 0, killed: false, timedOut: false, stdout: world.cliOut, stderr: "" };
  },
  pathLookup: (name: string) => `/usr/bin/${name}`,
}));

const realFetch = globalThis.fetch;
globalThis.fetch = ((url: unknown) => {
  world.fetches.push(String(url));
  throw new Error("no network in this test");
}) as typeof fetch;

type Quota = {
  ok: boolean; reason?: string; session5hPct?: number; week7dPct?: number;
  fetchedAt?: number; readAt?: number; lapsed?: boolean; stale?: boolean; planLabel?: string;
};
type QuotaModule = {
  fetchClaudeQuota: (o?: { force?: boolean }) => Promise<Quota>;
  invalidateQuotaCache: () => void;
  peekClaudeQuota: (now?: number) => { reading: Quota | null; at: number; lapsed: boolean };
};
type Routes = { handleQuota: (req: unknown, res: unknown) => Promise<void> };

const MIN = 60_000;
const ahead = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
/** claude-swap's row for the active account, collected `ageMs` ago. */
const row = (pct: number, ageMs = MIN) => ({
  num: 2,
  email: "account-2@b.c",
  fetchedAt: Date.now() - ageMs,
  lastGood: {
    five_hour: { pct, resets_at: ahead(3) },
    seven_day: { pct: Math.round(pct / 3), resets_at: ahead(96) },
  },
});

let mod: QuotaModule;
let routes: Routes;

beforeEach(async () => {
  world.entry = null;
  world.cliOut = "Claude Code usage\n";
  world.storeReads = 0;
  world.collects = 0;
  world.cliRuns.length = 0;
  world.fetches.length = 0;
  // A fresh module per test: the caches and the self-poll floor are module state.
  vi.resetModules();
  mod = await import("../../server/quota.mjs") as unknown as QuotaModule;
  routes = await import("../../server/usage-routes.mjs") as unknown as Routes;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) {
    if (PREV[k] === undefined) delete process.env[k];
    else process.env[k] = PREV[k];
  }
  rmTempDir(DIR);
});

/** The route, called the way the page calls it, with the answer it sent. */
async function ask(query: string): Promise<{ status: number; body: Quota }> {
  const out = { status: 0, body: {} as Quota };
  const res = {
    headersSent: false,
    writeHead(status: number) { out.status = status; },
    end(text: string) { out.body = JSON.parse(text); },
  };
  await routes.handleQuota({ url: `/api/quota${query}` }, res);
  return out;
}

/** Everything a read would have gone through, as one number. */
const reads = () => world.storeReads + world.collects + world.cliRuns.length + world.fetches.length;

describe("/api/quota?cached=1 reads no source", () => {
  it("answers from memory and touches no store, collector, CLI or network", async () => {
    world.entry = row(63);
    const first = await mod.fetchClaudeQuota();
    expect(first).toMatchObject({ ok: true, session5hPct: 63 });
    const spent = reads();
    expect(spent, "the one real read went to the store").toBeGreaterThan(0);

    const answers = [];
    for (let i = 0; i < 5; i++) answers.push(await ask("?cached=1"));

    expect(reads(), "five looks, no read").toBe(spent);
    for (const a of answers) {
      expect(a.status).toBe(200);
      expect(a.body).toMatchObject({ ok: true, session5hPct: 63, week7dPct: 21 });
    }
  });

  it("says when the reading was taken, and that no window has reset since", async () => {
    world.entry = row(63, 4 * MIN);
    const read = await mod.fetchClaudeQuota();
    const { body } = await ask("?cached=1");
    // The store row's own time, not the moment the deck published it: a row
    // four minutes old is four minutes old, and the meter ages it from here.
    expect(body.readAt).toBe(read.fetchedAt);
    expect(Date.now() - body.readAt!).toBeGreaterThanOrEqual(4 * MIN);
    expect(body.lapsed).toBe(false);
  });

  it("flags a reading whose window has reset since it was taken", async () => {
    world.entry = row(63);
    await mod.fetchClaudeQuota();
    const held = mod.peekClaudeQuota();
    const later = held.reading!.session5hResetAt as number * 1000 + 1;
    expect(mod.peekClaudeQuota(later)).toMatchObject({ lapsed: true });
    expect(mod.peekClaudeQuota(Date.now())).toMatchObject({ lapsed: false });
  });

  it("still hands back the reading once the minute it is cached for has passed", async () => {
    world.entry = row(63);
    await mod.fetchClaudeQuota();
    const spent = reads();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 20 * MIN);
      const { body } = await ask("?cached=1");
      expect(body).toMatchObject({ ok: true, session5hPct: 63 });
      expect(Date.now() - body.readAt!, "its age is left for the meter to say").toBeGreaterThan(10 * MIN);
    } finally { vi.useRealTimers(); }
    expect(reads(), "an expired cache is shown old, not re-taken").toBe(spent);
  });

  it("holds the last reading through a failed one, with its own time", async () => {
    world.entry = row(63);
    await mod.fetchClaudeQuota();
    world.entry = null;
    const held = await withGapsSkipped(() => mod.fetchClaudeQuota({ force: true }));
    expect(held).toMatchObject({ ok: true, session5hPct: 63, stale: true });
    const spent = reads();
    const { body } = await ask("?cached=1");
    expect(body).toMatchObject({ ok: true, session5hPct: 63 });
    expect(reads()).toBe(spent);
  });

  it("says no_reading when nothing has been read, and reads nothing to find out", async () => {
    const { status, body } = await ask("?cached=1");
    expect(status).toBe(200);
    expect(body).toEqual({ ok: false, reason: "no_reading" });
    expect(reads()).toBe(0);
  });

  it("says no_reading again after an account switch, which empties both halves", async () => {
    world.entry = row(63);
    await mod.fetchClaudeQuota();
    expect((await ask("?cached=1")).body.ok).toBe(true);
    mod.invalidateQuotaCache();
    expect(await ask("?cached=1")).toMatchObject({ body: { ok: false, reason: "no_reading" } });
    expect(mod.peekClaudeQuota()).toEqual({ reading: null, at: 0, lapsed: false });
  });

  it("does not take a reading that is only a failure for one", async () => {
    // A failed read is cached for a few seconds as {ok:false}; it has no
    // numbers, so the meter is told there is nothing, not shown a failure.
    world.entry = null;
    world.cliOut = "";   // a CLI that prints nothing at all: cli_failed
    await withGapsSkipped(() => mod.fetchClaudeQuota());
    const spent = reads();
    expect(await ask("?cached=1")).toMatchObject({ body: { ok: false, reason: "no_reading" } });
    expect(reads()).toBe(spent);
  });

  it("wins over refresh=1: no spelling of the URL turns the look into a read", async () => {
    world.entry = row(63);
    await mod.fetchClaudeQuota();
    const spent = reads();
    for (const query of ["?refresh=1&cached=1", "?cached=1&refresh=1"]) {
      const { body } = await ask(query);
      expect(body, query).toMatchObject({ ok: true, session5hPct: 63 });
    }
    expect(reads(), "a forced read would have gone to the store, the collector or the CLI").toBe(spent);
  });

  it("leaves the module's caches and self-poll floor as it found them", async () => {
    world.entry = row(63);
    await mod.fetchClaudeQuota();
    const before = mod.peekClaudeQuota();
    await ask("?cached=1");
    await ask("?refresh=1&cached=1");
    expect(mod.peekClaudeQuota()).toEqual(before);
    // The next ordinary read behaves as if nobody had looked: served from the
    // minute's cache, so still not a single source touched.
    const spent = reads();
    await mod.fetchClaudeQuota();
    expect(reads()).toBe(spent);
  });
});

describe("the route without cached=1 is unchanged", () => {
  it("still reads, and still sends the reading a plan label and no readAt", async () => {
    world.entry = row(63);
    const { body } = await ask("");
    expect(body).toMatchObject({ ok: true, session5hPct: 63 });
    expect(body).not.toHaveProperty("readAt");
    expect(world.storeReads).toBeGreaterThan(0);
  });

  it("checks cached=1 before it can reach fetchClaudeQuota (source pin)", () => {
    const src = readFileSync(fileURLToPath(new URL("../../server/usage-routes.mjs", import.meta.url)), "utf8");
    const handler = src.slice(src.indexOf("export async function handleQuota("), src.indexOf("export async function handleCodexUsage"));
    expect(handler.indexOf('get("cached") === "1"')).toBeGreaterThan(-1);
    expect(handler.indexOf('get("cached") === "1"')).toBeLessThan(handler.indexOf("fetchClaudeQuota("));
    // The look's branch returns before any call that could read.
    const look = handler.slice(handler.indexOf('get("cached") === "1"'), handler.indexOf("const force"));
    expect(look).not.toMatch(/fetchClaudeQuota|force/);
  });

  it("peekClaudeQuota touches no source and no state (source pin)", () => {
    const src = readFileSync(fileURLToPath(new URL("../../server/quota.mjs", import.meta.url)), "utf8");
    const start = src.indexOf("export function peekClaudeQuota");
    const body = src.slice(start, src.indexOf("\n}\n", start))
      .split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
    expect(body).not.toMatch(/\bawait\b|_inflight|_lastSelfPollAt|storeQuota|fetchOAuthUsage|readCliUsage|requestCollection|publish\(/);
    expect(body).not.toMatch(/\b_(?:cache|cacheAt|lastGood|lastGoodAt|lastGoodFor|generation)\s*=[^=]/);
  });
});
