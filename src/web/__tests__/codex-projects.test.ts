// The Projects report of a Codex profile (codex-projects.mjs): per project and per
// day, in the Claude report's shape, folded with the same foldCodexCost the
// session cards use. Every home here is a temp directory with a fake auth.json
// (an account id and nothing else); no real ~/.codex is read.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

// The route reaches the report through import(); the route tests below replace it
// with a recorder so no real Codex home is consulted.
const reportSpy = vi.hoisted(() => vi.fn());
vi.mock("../../server/codex-projects.mjs", async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, codexProjectsReport: (...args: unknown[]) => reportSpy(...args) };
});

// @ts-expect-error — .mjs server module, no types
const actualModule = await vi.importActual<typeof import("../../server/codex-projects.mjs")>("../../server/codex-projects.mjs");
const codexProjectsReport = (actualModule as unknown as { codexProjectsReport: (a: unknown, o?: unknown) => Promise<any> }).codexProjectsReport;
// @ts-expect-error — .mjs server module, no types
const { codexProfileId } = await import("../../server/codex-selection.mjs");
// @ts-expect-error — .mjs server module, no types
const { handleCodexProfileProjects } = await import("../../server/account-routes.mjs");
// @ts-expect-error — .mjs server module, no types
const { GUARDED_READS } = await import("../../server/request-gates.mjs");

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-codex-projects-"));
afterAll(() => rmTempDir(DIR));

/** A project folder as the report names it: resolved, so a Windows runner
 *  reads `/work/alpha` as `D:\work\alpha`, as canonicalCwd does. */
const at = (path: string) => resolve(path);

const ACCOUNT = "acct-a-SECRET";
const OTHER = "acct-b-SECRET";
let n = 0;

/** A Codex home signed in as `account` (null: no auth.json), and the selection
 *  that trusts it. */
async function makeHome(account: string | null = ACCOUNT) {
  const home = join(DIR, `home-${++n}`);
  mkdirSync(join(home, "sessions"), { recursive: true });
  if (account) writeFileSync(join(home, "auth.json"), JSON.stringify({ tokens: { account_id: account } }));
  const id = await codexProfileId(home);
  return { home, id, selection: { homes: [home], profiles: [{ home, id }] } };
}

const iso = (y: number, mo: number, d: number, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi).toISOString();
const NOW = new Date(2026, 5, 15, 12, 0).getTime();
const opts = (selection: unknown) => ({ selection, now: NOW, cacheMs: 0 });

type Totals = { input_tokens: number; cached_input_tokens?: number; output_tokens?: number; cache_write_input_tokens?: number };
const meta = (ts: string, cwd: string | null, creator?: string) => JSON.stringify({
  type: "session_meta", timestamp: ts, payload: { id: "s", ...(cwd ? { cwd } : {}), ...(creator ? { creator_account_id: creator } : {}) },
});
const ctx = (ts: string, model = "gpt-5.5") => JSON.stringify({ type: "turn_context", timestamp: ts, payload: { model } });
const tier = (ts: string, service_tier: string) => JSON.stringify({
  type: "event_msg", timestamp: ts, payload: { type: "thread_settings_applied", thread_settings: { service_tier } },
});
const tok = (ts: string, t: Totals) => JSON.stringify({
  type: "event_msg", timestamp: ts, payload: { type: "token_count", info: { total_token_usage: { cached_input_tokens: 0, output_tokens: 0, ...t } } },
});

/** Write a rollout under the day folder its name says; `mtime` is the file's last
 *  write (defaults to NOW, the file being active). */
function rollout(home: string, started: [number, number, number], id: string, lines: string[], mtime = NOW) {
  const [y, m, d] = started;
  const p2 = (v: number) => String(v).padStart(2, "0");
  const dir = join(home, "sessions", String(y), p2(m), p2(d));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-${y}-${p2(m)}-${p2(d)}T09-00-00-${id}.jsonl`);
  writeFileSync(path, lines.join("\n") + "\n");
  utimesSync(path, mtime / 1000, mtime / 1000);
  return path;
}

describe("codexProjectsReport", () => {
  beforeEach(() => reportSpy.mockReset());

  it("splits two projects and buckets each record into the local day it was written, across midnight", async () => {
    const { home, id, selection } = await makeHome();
    rollout(home, [2026, 6, 14], "00000000-0000-4000-8000-000000000001", [
      meta(iso(2026, 6, 14, 9), "/work/alpha", ACCOUNT), ctx(iso(2026, 6, 14, 9)),
      tok(iso(2026, 6, 14, 23, 50), { input_tokens: 100, output_tokens: 10 }),
      tok(iso(2026, 6, 15, 0, 10), { input_tokens: 250, output_tokens: 30 }),
    ]);
    rollout(home, [2026, 6, 15], "00000000-0000-4000-8000-000000000002", [
      meta(iso(2026, 6, 15, 9), "/work/beta", ACCOUNT), ctx(iso(2026, 6, 15, 9)),
      tok(iso(2026, 6, 15, 10), { input_tokens: 40, output_tokens: 4 }),
    ]);
    const r = await codexProjectsReport({ id, days: 0 }, opts(selection));
    expect(r.ok).toBe(true);
    expect(r.trackedSince).toBeNull();
    expect(r.days).toBe(0);
    expect(r.projects.map((p: any) => [p.path, p.name])).toEqual([[at("/work/alpha"), "alpha"], [at("/work/beta"), "beta"]]);
    expect(r.projects[0].models["gpt-5.5"]).toMatchObject({ i: 250, o: 30 });
    expect(r.projects[1].models["gpt-5.5"]).toMatchObject({ i: 40, o: 4 });
    expect(r.unattributed).toBeNull();
    expect(r.daily.map((d: any) => d.day)).toEqual(["2026-06-14", "2026-06-15"]);
    const [d14, d15] = r.daily;
    expect(d14.projects).toEqual([{ path: at("/work/alpha"), models: { "gpt-5.5": expect.objectContaining({ i: 100, o: 10 }) } }]);
    expect(d15.projects.map((p: any) => [p.path, p.models["gpt-5.5"].i])).toEqual([[at("/work/alpha"), 150], [at("/work/beta"), 40]]);
    expect(d14.unattributed).toBeNull();
  });

  it("cuts windows of 1, 7, 30 days and all of it by the local day", async () => {
    const { home, id, selection } = await makeHome();
    rollout(home, [2026, 3, 1], "00000000-0000-4000-8000-000000000003", [
      meta(iso(2026, 3, 1, 9), "/work/alpha", ACCOUNT), ctx(iso(2026, 3, 1, 9)),
      tok(iso(2026, 4, 1), { input_tokens: 1 }),
      tok(iso(2026, 5, 25), { input_tokens: 11 }),
      tok(iso(2026, 6, 10), { input_tokens: 111 }),
      tok(iso(2026, 6, 15, 8), { input_tokens: 1111 }),
    ]);
    const total = async (days: number) => {
      const r = await codexProjectsReport({ id, days }, opts(selection));
      return r.projects[0]?.models["gpt-5.5"].i ?? 0;
    };
    expect(await total(1)).toBe(1000);
    expect(await total(7)).toBe(1100);
    expect(await total(30)).toBe(1110);
    expect(await total(0)).toBe(1111);
    expect(((await codexProjectsReport({ id, days: 7 }, opts(selection))) as any).days).toBe(7);
  });

  it("files a rollout written by another sign-in under unattributed, and keeps it off the daily columns of its own", async () => {
    const { home, id, selection } = await makeHome();
    rollout(home, [2026, 6, 15], "00000000-0000-4000-8000-000000000004", [
      meta(iso(2026, 6, 15, 9), "/work/alpha", ACCOUNT), ctx(iso(2026, 6, 15, 9)),
      tok(iso(2026, 6, 15, 10), { input_tokens: 70 }),
    ]);
    rollout(home, [2026, 6, 15], "00000000-0000-4000-8000-000000000005", [
      meta(iso(2026, 6, 15, 9), "/work/alpha", OTHER), ctx(iso(2026, 6, 15, 9)),
      tok(iso(2026, 6, 15, 10), { input_tokens: 500 }),
    ]);
    rollout(home, [2026, 6, 12], "00000000-0000-4000-8000-000000000006", [
      meta(iso(2026, 6, 12, 9), "/work/alpha", OTHER), ctx(iso(2026, 6, 12, 9)),
      tok(iso(2026, 6, 12, 10), { input_tokens: 9 }),
    ]);
    rollout(home, [2026, 6, 15], "00000000-0000-4000-8000-000000000007", [
      meta(iso(2026, 6, 15, 9), null, ACCOUNT), ctx(iso(2026, 6, 15, 9)),
      tok(iso(2026, 6, 15, 10), { input_tokens: 3 }),
    ]);
    const r = await codexProjectsReport({ id, days: 0 }, opts(selection));
    expect(r.projects).toHaveLength(1);
    expect(r.projects[0].models["gpt-5.5"].i).toBe(70);
    expect(r.unattributed["gpt-5.5"].i).toBe(512);
    expect(r.daily.map((d: any) => d.day)).toEqual(["2026-06-15"]);
    expect(r.daily[0].unattributed["gpt-5.5"].i).toBe(503);
  });

  it("counts a rollout with no creator for its project, and one when the home has no login", async () => {
    const withLogin = await makeHome();
    rollout(withLogin.home, [2026, 6, 15], "00000000-0000-4000-8000-000000000008", [
      meta(iso(2026, 6, 15, 9), "/work/alpha"), ctx(iso(2026, 6, 15, 9)),
      tok(iso(2026, 6, 15, 10), { input_tokens: 5 }),
    ]);
    const noLogin = await makeHome(null);
    rollout(noLogin.home, [2026, 6, 15], "00000000-0000-4000-8000-000000000009", [
      meta(iso(2026, 6, 15, 9), "/work/alpha", OTHER), ctx(iso(2026, 6, 15, 9)),
      tok(iso(2026, 6, 15, 10), { input_tokens: 6 }),
    ]);
    const a = await codexProjectsReport({ id: withLogin.id, days: 7 }, opts(withLogin.selection));
    expect(a.projects[0].models["gpt-5.5"].i).toBe(5);
    const b = await codexProjectsReport({ id: noLogin.id, days: 7 }, opts(noLogin.selection));
    expect(b.projects[0].models["gpt-5.5"].i).toBe(6);
    expect(b.unattributed).toBeNull();
  });

  it("maps Codex fields to Counters: cache-inclusive input, and the fast share", async () => {
    const { home, id, selection } = await makeHome();
    rollout(home, [2026, 6, 15], "00000000-0000-4000-8000-00000000000a", [
      meta(iso(2026, 6, 15, 9), "/work/alpha", ACCOUNT), ctx(iso(2026, 6, 15, 9)),
      tier(iso(2026, 6, 15, 9, 1), "priority"),
      tok(iso(2026, 6, 15, 10), { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50, cache_write_input_tokens: 30 }),
      tier(iso(2026, 6, 15, 10, 1), "default"),
      tok(iso(2026, 6, 15, 11), { input_tokens: 1100, cached_input_tokens: 850, output_tokens: 60, cache_write_input_tokens: 30 }),
    ]);
    const r = await codexProjectsReport({ id, days: 1 }, opts(selection));
    expect(r.projects[0].models["gpt-5.5"]).toEqual({
      i: 1100, o: 60, cr: 850, cc: 30, c1h: 0, c5m: 0,
      s: { fast: { i: 1000, o: 50, cr: 800, cc: 30, c1h: 0, c5m: 0 } },
    });
    // No speed share at all when nothing was billed at one.
    const plain = await makeHome();
    rollout(plain.home, [2026, 6, 15], "00000000-0000-4000-8000-00000000000b", [
      meta(iso(2026, 6, 15, 9), "/work/alpha", ACCOUNT), ctx(iso(2026, 6, 15, 9)),
      tok(iso(2026, 6, 15, 10), { input_tokens: 10, output_tokens: 1 }),
    ]);
    const p = await codexProjectsReport({ id: plain.id, days: 1 }, opts(plain.selection));
    expect(p.projects[0].models["gpt-5.5"]).toEqual({ i: 10, o: 1, cr: 0, cc: 0, c1h: 0, c5m: 0 });
  });

  it("drops a file's earlier days when a cumulative total goes down, as the session card does", async () => {
    const { home, id, selection } = await makeHome();
    rollout(home, [2026, 6, 13], "00000000-0000-4000-8000-00000000000c", [
      meta(iso(2026, 6, 13, 9), "/work/alpha", ACCOUNT), ctx(iso(2026, 6, 13, 9)),
      tok(iso(2026, 6, 13, 10), { input_tokens: 500 }),
      tok(iso(2026, 6, 14, 10), { input_tokens: 900 }),
      tok(iso(2026, 6, 15, 9), { input_tokens: 100 }),
      tok(iso(2026, 6, 15, 10), { input_tokens: 150 }),
    ]);
    const r = await codexProjectsReport({ id, days: 0 }, opts(selection));
    expect(r.projects[0].models["gpt-5.5"].i).toBe(50);
    expect(r.daily.map((d: any) => d.day)).toEqual(["2026-06-15"]);
  });

  it("folds the lines before the window, so the first delta inside it is a delta", async () => {
    const { home, id, selection } = await makeHome();
    rollout(home, [2026, 6, 1], "00000000-0000-4000-8000-00000000000d", [
      meta(iso(2026, 6, 1, 9), "/work/alpha", ACCOUNT), ctx(iso(2026, 6, 1, 9)),
      tok(iso(2026, 6, 1, 10), { input_tokens: 10_000 }),
      tok(iso(2026, 6, 15, 10), { input_tokens: 10_100 }),
    ]);
    const r = await codexProjectsReport({ id, days: 1 }, opts(selection));
    expect(r.projects[0].models["gpt-5.5"].i).toBe(100);
  });

  it("counts a resumed rollout by its mtime, not its name, and leaves an untouched old one out", async () => {
    const { home, id, selection } = await makeHome();
    rollout(home, [2026, 5, 1], "00000000-0000-4000-8000-00000000000e", [
      meta(iso(2026, 5, 1, 9), "/work/alpha", ACCOUNT), ctx(iso(2026, 5, 1, 9)),
      tok(iso(2026, 5, 1, 10), { input_tokens: 300 }),
      tok(iso(2026, 6, 15, 9), { input_tokens: 360 }),
    ]);
    rollout(home, [2026, 5, 2], "00000000-0000-4000-8000-00000000000f", [
      meta(iso(2026, 5, 2, 9), "/work/old", ACCOUNT), ctx(iso(2026, 5, 2, 9)),
      tok(iso(2026, 5, 2, 10), { input_tokens: 999 }),
    ], new Date(2026, 4, 2, 10).getTime());
    const week = await codexProjectsReport({ id, days: 7 }, opts(selection));
    expect(week.projects.map((p: any) => p.path)).toEqual([at("/work/alpha")]);
    expect(week.projects[0].models["gpt-5.5"].i).toBe(60);
    const all = await codexProjectsReport({ id, days: 0 }, opts(selection));
    expect(all.projects.map((p: any) => p.path)).toEqual([at("/work/alpha"), at("/work/old")]);
  });

  it("reads a compressed rollout, selected by the start its name carries", async () => {
    const zlib = await import("node:zlib");
    if (typeof (zlib as any).zstdCompressSync !== "function") return; // Node older than 22.15
    const { home, id, selection } = await makeHome();
    const lines = [
      meta(iso(2026, 6, 10, 9), "/work/cold", ACCOUNT), ctx(iso(2026, 6, 10, 9)),
      tok(iso(2026, 6, 10, 10), { input_tokens: 77 }),
    ];
    const path = rollout(home, [2026, 6, 10], "00000000-0000-4000-8000-000000000010", ["x"]);
    const zst = path.replace(/\.jsonl$/, ".jsonl.zst");
    writeFileSync(zst, (zlib as any).zstdCompressSync(Buffer.from(lines.join("\n") + "\n")));
    utimesSync(path, 0, 0);
    const r = await codexProjectsReport({ id, days: 7 }, opts(selection));
    expect(r.projects.map((p: any) => [p.path, p.models["gpt-5.5"].i])).toEqual([[at("/work/cold"), 77]]);
  });

  it("answers an unknown or malformed id with unknown_profile", async () => {
    const { selection } = await makeHome();
    expect(await codexProjectsReport({ id: "0".repeat(20), days: 7 }, opts(selection))).toEqual({ ok: false, reason: "unknown_profile" });
    expect(await codexProjectsReport({ id: "../../etc", days: 7 }, opts(selection))).toEqual({ ok: false, reason: "unknown_profile" });
  });

  it("never puts the account id or the home path in the report", async () => {
    const { home, id, selection } = await makeHome();
    rollout(home, [2026, 6, 15], "00000000-0000-4000-8000-000000000011", [
      meta(iso(2026, 6, 15, 9), "/work/alpha", OTHER), ctx(iso(2026, 6, 15, 9)),
      tok(iso(2026, 6, 15, 10), { input_tokens: 5 }),
    ]);
    rollout(home, [2026, 6, 15], "00000000-0000-4000-8000-000000000012", [
      meta(iso(2026, 6, 15, 9), "/work/beta", ACCOUNT), ctx(iso(2026, 6, 15, 9)),
      tok(iso(2026, 6, 15, 10), { input_tokens: 5 }),
    ]);
    const text = JSON.stringify(await codexProjectsReport({ id, days: 0 }, opts(selection)));
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain(ACCOUNT);
    expect(text).not.toContain(OTHER);
    expect(text).not.toContain(home);
  });
});

describe("GET /api/codex-profile-projects", () => {
  beforeEach(() => reportSpy.mockReset());
  const call = async (query: string) => {
    const out: { status?: number; body?: any } = {};
    const res = {
      headersSent: false,
      writeHead(status: number) { out.status = status; },
      end(body: string) { out.body = JSON.parse(body); },
    };
    await handleCodexProfileProjects({ url: `/api/codex-profile-projects?${query}` }, res);
    return out;
  };

  it("rejects a missing or malformed id before any report is built", async () => {
    for (const q of ["", "id=", "id=nope", `id=${"A".repeat(20)}`, `id=${"a".repeat(21)}`, "id=../../x"]) {
      const r = await call(q);
      expect(r.status, q).toBe(400);
      expect(r.body.ok).toBe(false);
    }
    expect(reportSpy).not.toHaveBeenCalled();
  });

  it("clamps days to 1, 7, 30 or 0, defaulting to 7", async () => {
    reportSpy.mockResolvedValue({ ok: true });
    const id = "a".repeat(20);
    const asked = async (days: string | null) => {
      reportSpy.mockClear();
      await call(`id=${id}${days === null ? "" : `&days=${days}`}`);
      return reportSpy.mock.calls[0][0];
    };
    expect(await asked("1")).toEqual({ id, days: 1 });
    expect(await asked("30")).toEqual({ id, days: 30 });
    expect(await asked("0")).toEqual({ id, days: 0 });
    for (const odd of [null, "7", "3", "9999", "-1", "abc", "1.5"]) expect((await asked(odd)).days, String(odd)).toBe(7);
  });

  it("answers 404 for an unknown profile and 200 with the report otherwise", async () => {
    const id = "b".repeat(20);
    reportSpy.mockResolvedValueOnce({ ok: false, reason: "unknown_profile" });
    expect(await call(`id=${id}`)).toEqual({ status: 404, body: { ok: false, reason: "unknown_profile" } });
    reportSpy.mockResolvedValueOnce({ ok: true, projects: [] });
    expect((await call(`id=${id}&days=1`)).status).toBe(200);
  });

  it("is a guarded read", () => {
    expect(GUARDED_READS.has("/api/codex-profile-projects")).toBe(true);
  });
});
