// The account notifications wired to the real modules: the auto-switch loop
// that reports its ticks, the quota modules that say whose reading each one is,
// and the records file a restart reads back.
//
// account-notify.test.ts pins the rules against an injected clock. This file
// pins that the doors are where the rules assume them: that a switch the loop
// made reaches the desktop once and a switch somebody pressed does not, that a
// notification which cannot be raised costs the tick nothing, and that a
// reading carries the account it was taken for — the one thing that keeps one
// account's notifications off another.
//
// Nothing here spawns anything or reaches the network: exec.mjs is replaced
// wholesale, fetch answers from this file, and HOME, the deck's data folder,
// the Claude config, Codex's home and claude-swap's store all point inside one
// temp directory checked before anything is imported.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-account-notify-"));
const ENV_KEYS = ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CLAUDE_SWAP_BACKUP", "CCDECK_HOME"] as const;
const PREV = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.CLAUDE_SWAP_BACKUP = join(DIR, "cswap");
process.env.CCDECK_HOME = join(DIR, "deck");
const inside = (p: string) => resolve(p).startsWith(resolve(DIR));
for (const k of ENV_KEYS) if (!inside(process.env[k]!)) throw new Error(`sandbox escaped: ${k}=${process.env[k]}`);
if (!inside(homedir())) throw new Error(`sandbox escaped: homedir ${homedir()}`);

const { proc } = vi.hoisted(() => ({ proc: { calls: [] as string[][], engine: "" } }));

vi.mock("../../server/exec.mjs", () => ({
  run: async (cmd: string, args: string[] = []) => {
    proc.calls.push([cmd, ...args]);
    const okay = { ok: true, code: 0, killed: false, timedOut: false, stdout: "", stderr: "" };
    if (args[0] === "auto") return { ...okay, stdout: proc.engine };
    return okay;
  },
  runDetached: () => {},
  pathLookup: (name: string) => `/usr/bin/${name}`,
}));

// Codex's usage endpoint, answered here; nothing may refresh a token.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown) => {
  const url = String((input as { url?: string })?.url ?? input);
  if (url.includes("/oauth/token")) throw new Error("test: nothing here may refresh");
  const body = url.includes("rate-limit-reset-credits") ? {} : {
    email: "coder@x.com",
    rate_limit: { primary_window: { used_percent: 91, limit_window_seconds: 18000, resets_at: Math.floor(Date.now() / 1000) + 3600 } },
  };
  return { ok: !url.includes("rate-limit-reset-credits"), status: url.includes("rate-limit-reset-credits") ? 404 : 200, headers: { get: () => null }, json: async () => body };
}) as unknown as typeof globalThis.fetch;

const ROOT = join(DIR, "cswap");
const MIN = 60_000;
const account = (num: number) => ({ email: `account-${num}@b.c`, organizationUuid: `org-${num}` });

/** A real claude-swap store, `activeNum` live, every row a minute old. */
function writeStore(activeNum: number, pct: Record<number, number>, alias: Record<number, string> = {}) {
  mkdirSync(join(ROOT, "cache"), { recursive: true });
  const nums = Object.keys(pct).map(Number);
  writeFileSync(join(ROOT, "sequence.json"), JSON.stringify({
    activeAccountNumber: activeNum,
    sequence: nums.map(String),
    accounts: Object.fromEntries(nums.map(n => [String(n), { ...account(n), ...(alias[n] ? { alias: alias[n] } : {}) }])),
  }));
  writeFileSync(join(ROOT, "cache", "usage.json"), JSON.stringify({
    schemaVersion: 2,
    accounts: Object.fromEntries(nums.map(n => [String(n), {
      ...account(n),
      fetchedAt: (Date.now() - MIN) / 1000,
      lastGood: {
        five_hour: { pct: pct[n], resets_at: new Date(Date.now() + 3 * 3600_000).toISOString() },
        seven_day: { pct: 10, resets_at: new Date(Date.now() + 96 * 3600_000).toISOString() },
      },
    }])),
  }));
}

/** The engine's own JSON as claude-swap 0.26 writes it: a poll, then a switch
 *  off account 2 at 94% onto account 3. */
const SWITCHED = [
  JSON.stringify({ event: "poll", active: { number: 2, email: "account-2@b.c" }, threshold: 90, headroomPct: { "2": 6, "3": 80 }, windowsPct: { "2": { "5h": 94, "7d": 10 } } }),
  JSON.stringify({ event: "switch", trigger: "proactive", from: { number: 2, email: "account-2@b.c" }, to: { number: 3, email: "account-3@b.c" }, warnings: [], dryRun: false }),
].join("\n");

type Watch = typeof import("../../server/account-watch.mjs");
type Auto = { setAutoEnabled: (on: boolean) => Promise<unknown>; autoStatus: () => Promise<{ lastTick: { event: string } | null }> };
type Quota = { fetchClaudeQuota: () => Promise<{ ok: boolean; stale?: boolean }>; quotaAccount: (r: unknown) => unknown };

let watch: Watch;
let auto: Auto;
let quota: Quota;
const said: { title: string; body: string }[] = [];
const settings = { swap: true, quota: false, reset: false };
let notify: (title: string, body: string) => unknown = (title, body) => { said.push({ title, body }); };

const rest = (ms: number) => new Promise(r => setTimeout(r, ms));

/** One deck-managed tick, waited out — and the notifier after it. */
async function tickOnce(engine: string) {
  proc.engine = engine;
  const before = (await auto.autoStatus()).lastTick;
  await auto.setAutoEnabled(true);
  for (let i = 0; i < 400 && (await auto.autoStatus()).lastTick === before; i++) await rest(5);
  await auto.setAutoEnabled(false);
  // The notifier hears the tick after it is recorded, and reads the store on
  // the way: give that its moment before anything is asserted about it.
  await rest(150);
  return (await auto.autoStatus()).lastTick;
}

beforeEach(async () => {
  proc.calls.length = 0;
  said.length = 0;
  Object.assign(settings, { swap: true, quota: false, reset: false });
  notify = (title, body) => { said.push({ title, body }); };
  rmTempDir(ROOT);
  rmTempDir(join(DIR, "deck"));
  vi.resetModules();
  watch = await import("../../server/account-watch.mjs");
  watch.connectAccountNotify({ notify: (t: string, b: string) => notify(t, b), settings: () => settings, product: "ccdeck", onError: () => {} });
  auto = await import("../../server/cswap-auto.mjs") as unknown as Auto;
  quota = await import("../../server/quota.mjs") as unknown as Quota;
});

afterEach(async () => {
  await auto.setAutoEnabled(false);
});

afterAll(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) {
    if (PREV[k] === undefined) delete process.env[k];
    else process.env[k] = PREV[k];
  }
  rmTempDir(DIR);
});

describe("a switch the auto-switch loop made", () => {
  it("reaches the desktop once, named as the store names the accounts", async () => {
    writeStore(3, { 2: 94, 3: 20 }, { 3: "work" });
    const tick = await tickOnce(SWITCHED);
    expect(tick?.event).toBe("switch");
    expect(said).toEqual([{ title: "Claude auto-switch — ccdeck", body: "Switched to work · account-2@b.c reached 90%" }]);
    // And the records the next start reads back carry the crossing.
    const file = join(DIR, "deck", "account-notify.json");
    expect(existsSync(file)).toBe(true);
    const records = JSON.parse(readFileSync(file, "utf8")).windows;
    expect(records["claude|account-2@b.c@@org-2|five_hour"]?.said).toEqual([90]);
  });

  it("is not said with the swap switch off", async () => {
    settings.swap = false;
    writeStore(3, { 2: 94, 3: 20 });
    await tickOnce(SWITCHED);
    expect(said).toEqual([]);
  });

  it("costs the tick nothing when the notification cannot be raised", async () => {
    notify = () => { throw new Error("no notification daemon"); };
    writeStore(3, { 2: 94, 3: 20 });
    const tick = await tickOnce(SWITCHED);
    expect(tick?.event, "the tick did not finish as a switch").toBe("switch");
    notify = () => Promise.reject(new Error("osascript missing"));
    const again = await tickOnce(SWITCHED);
    expect(again?.event).toBe("switch");
  });
});

describe("a switch somebody pressed", () => {
  it("never reaches the notifier", async () => {
    writeStore(2, { 2: 94, 3: 20 });
    const { switchClaudeAccount } = await import("../../server/claude-accounts.mjs");
    const r = await switchClaudeAccount(3);
    expect(r.ok).toBe(true);
    await rest(30);
    expect(said).toEqual([]);
  });

  it("because only the loop's tick calls the door a swap is said through", () => {
    // The census that keeps the test above true: a second caller of
    // noteAutoTick would be a second way for a swap to be announced.
    const server = fileURLToPath(new URL("../../server/", import.meta.url));
    const callers = readdirSync(server).filter(f => f.endsWith(".mjs") && f !== "account-watch.mjs")
      .filter(f => /\bnoteAutoTick\(/.test(readFileSync(join(server, f), "utf8")));
    expect(callers).toEqual(["cswap-auto-loop.mjs"]);
  });
});

describe("whose reading it is", () => {
  it("is carried by a Claude reading taken this time, and not by one held over", async () => {
    writeStore(2, { 2: 40 });
    const reading = await quota.fetchClaudeQuota();
    expect(reading.ok).toBe(true);
    expect(quota.quotaAccount(reading)).toEqual({ email: "account-2@b.c", organizationUuid: "org-2" });
    expect(quota.quotaAccount({ ...reading, stale: true })).toBeNull();
    expect(quota.quotaAccount(null)).toBeNull();
  });

  it("is carried by a Codex reading, workspace and address", async () => {
    mkdirSync(process.env.CODEX_HOME!, { recursive: true });
    const exp = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
    const access = `h.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.s`;
    writeFileSync(join(process.env.CODEX_HOME!, "auth.json"), JSON.stringify({
      tokens: { access_token: access, refresh_token: "r", account_id: "acct-1" },
    }));
    const codex = await import("../../server/codex-quota.mjs");
    const reading = await codex.fetchCodexQuota({ force: true });
    expect(reading.ok).toBe(true);
    expect(codex.codexQuotaAccount(reading)).toEqual({ accountId: "acct-1", email: "coder@x.com" });
    expect(codex.codexQuotaAccount({ ...reading, stale: true })).toBeNull();
  });
});

describe("the deck's own quota reads", () => {
  it("are not made while both quota switches are off", async () => {
    writeStore(2, { 2: 95 });
    await watch.watchOnce(() => ({ claude: true, codex: false }));
    expect(said).toEqual([]);
    expect(existsSync(join(DIR, "deck", "account-notify.json"))).toBe(false);
  });

  it("find the live account's crossing once the threshold switch is on", async () => {
    settings.quota = true;
    writeStore(2, { 2: 95, 3: 10 }, { 2: "personal" });
    await watch.watchOnce(() => ({ claude: true, codex: false }));
    await watch.watchOnce(() => ({ claude: true, codex: false }));
    expect(said.map(s => s.title)).toEqual(["Claude · personal — ccdeck"]);
    expect(said[0].body).toMatch(/^5-hour usage reached 90% · resets in 2h 5\dm$/);
  });
});
