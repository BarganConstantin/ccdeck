// #1317. The Projects modal asked for its report and for ccusage together and
// waited on both through one Promise.all, so the optional dollar enrichment — a
// walk of the whole Claude log tree that may run to its ninety-second deadline —
// held the whole report on `Loading…` long after the report itself had
// answered. These drive the modal's real loader against a deck whose answers
// are released by hand, and pin what may be on screen at each step: the report
// as soon as it lands, pricing.ts's dollars until ccusage answers, ccusage's
// dollars in place when it does, the estimate kept when it fails, and no
// range's late answer on another range.
import { describe, expect, it } from "vitest";
import {
  INITIAL_LOAD, loadProjects, projectsLoad, projectsUrls, reportLoading,
  type Get, type ProjectsEvent, type ProjectsLoad,
} from "../account-projects-load";
import { ccCellsFrom, reconcile, toUsage, type Counters, type DayInput } from "../account-projects-reconcile";
import { costForUsage } from "../pricing";
import { sourceOf } from "./client-source";

const NOW = new Date(2026, 8, 23, 12).getTime();
const DAY = "2026-09-23";
const M = "claude-opus-5";
const TOKENS: Counters = { i: 20_000, o: 400_000, cr: 6_000_000, cc: 600_000, c1h: 0, c5m: 0 };
/** What pricing.ts alone makes of TOKENS — the estimate the report opens on. */
const ESTIMATE = costForUsage(toUsage(TOKENS), M, NOW).total;
const close = (a: number, b: number) => Math.abs(a - b) < 1e-6;

/** The part of a report the dollars are made from. */
interface Report { daily: DayInput[]; unattributed: Record<string, Counters> | null }
const report = (path = "/u/ccdeck"): Report => ({
  daily: [{ day: DAY, projects: [{ path, models: { [M]: TOKENS } }], unattributed: null }],
  unattributed: null,
});

/** ccusage saw exactly our tokens on DAY and priced them at `cost` — and saw
 *  Codex too, whose dollars must never reach a Claude account's projects. */
const ccusage = (cost: number) => ({
  ok: true,
  days: [{
    period: DAY,
    modelBreakdowns: [
      { modelName: M, inputTokens: TOKENS.i, outputTokens: TOKENS.o, cacheReadTokens: TOKENS.cr, cacheCreationTokens: TOKENS.cc, cost },
      { modelName: "gpt-5-codex", inputTokens: 1_000, outputTokens: 1_000, cost: 99 },
    ],
  }],
});

type Answer = Awaited<ReturnType<Get>>;
const answer = (json: unknown, status = 200): Answer => ({ ok: status >= 200 && status < 300, status, json: async () => json });

/** A deck that holds every answer until the test releases it. */
function slowDeck() {
  const held: Array<{ url: string; answer: (a: Answer) => void; fail: (e: unknown) => void }> = [];
  const get: Get = url => new Promise<Answer>((answer, fail) => { held.push({ url, answer, fail }); });
  const nth = (path: string, n: number) => {
    const h = held.filter(x => x.url.startsWith(path))[n];
    if (!h) throw new Error(`nothing asked ${path} a ${n + 1}th time`);
    return h;
  };
  return {
    get,
    urls: () => held.map(h => h.url),
    report: (n = 0) => nth("/api/account-projects?", n),
    ccusage: (n = 0) => nth("/api/ccusage?", n),
  };
}

/** Every callback already queued behind a released answer has run. */
const settle = () => new Promise(r => setTimeout(r, 0));

/** The modal less React: its effect's lines, and the reducer they feed. */
function modal() {
  const deck = slowDeck();
  let state: ProjectsLoad<Report> = INITIAL_LOAD;
  let gen = 0;
  const dispatch = (e: ProjectsEvent<Report>) => { state = projectsLoad(state, e); };
  return {
    deck,
    open(days: number) {
      gen += 1;
      dispatch({ type: "start", gen });
      loadProjects<Report>({ num: 2, days, gen, dispatch, get: deck.get, now: NOW });
    },
    get state() { return state; },
  };
}

/** The dollars the modal draws for the report on screen, the way it draws them. */
function dollars(s: ProjectsLoad<Report>) {
  const shown = s.report!;
  const range = shown.cost.phase === "ready" ? shown.cost.range : null;
  return reconcile(shown.data.daily, shown.data.unattributed, ccCellsFrom(range), NOW);
}

describe("the report does not wait for ccusage (#1317)", () => {
  it("asks for both at once, for the same window", () => {
    // Neither read is chained behind the other: both are out before either
    // answers. ccusage is asked for the tally's own span, day for day.
    const m = modal();
    m.open(7);
    expect(m.deck.urls()).toEqual([
      "/api/account-projects?num=2&days=7",
      "/api/ccusage?since=20260917&until=20260923",
    ]);
    expect(projectsUrls(2, 0, NOW).ccusage).toBe("/api/ccusage?since=20260726&until=20260923");
    expect(reportLoading(m.state)).toBe(true);
  });

  it("draws the report the moment it lands, with ccusage still running", async () => {
    const m = modal();
    m.open(1);
    m.deck.report().answer(answer(report()));
    await settle();

    // ccusage has not answered, and nothing is loading any more.
    expect(reportLoading(m.state)).toBe(false);
    expect(m.state.error).toBeNull();
    expect(m.state.report?.cost).toEqual({ phase: "running" });
    // The rows are there, priced by pricing.ts, and not passed off as ccusage's.
    const d = dollars(m.state);
    expect(d.projects.map(p => p.path)).toEqual(["/u/ccdeck"]);
    expect(d.reconciled).toBe(false);
    expect(close(d.totalCost, ESTIMATE)).toBe(true);
  });

  it("reconciles the same report's dollars in place when ccusage lands", async () => {
    const m = modal();
    m.open(1);
    m.deck.report().answer(answer(report()));
    await settle();
    const shown = m.state.report!.data;

    // ccusage prices the day half again above pricing.ts's table.
    m.deck.ccusage().answer(answer(ccusage(ESTIMATE * 1.5)));
    await settle();

    expect(m.state.report!.data).toBe(shown);
    expect(m.state.report!.cost.phase).toBe("ready");
    const d = dollars(m.state);
    expect(d.reconciled).toBe(true);
    // ccusage's rate on our tokens, and not a cent of Codex's $99.
    expect(close(d.totalCost, ESTIMATE * 1.5)).toBe(true);
    expect(close(d.projects[0].cost, ESTIMATE * 1.5)).toBe(true);
  });

  it("pairs a ccusage answer that beat its report, so a cached range opens reconciled", async () => {
    const m = modal();
    m.open(30);
    m.deck.ccusage().answer(answer(ccusage(ESTIMATE * 1.5)));
    await settle();
    // Nothing to draw it on yet, and it does not stand in for the report.
    expect(m.state.report).toBeNull();
    expect(reportLoading(m.state)).toBe(true);

    m.deck.report().answer(answer(report()));
    await settle();
    expect(m.state.report!.cost.phase).toBe("ready");
    expect(close(dollars(m.state).totalCost, ESTIMATE * 1.5)).toBe(true);
  });
});

describe("a ccusage that fails leaves the report usable", () => {
  const failures: Array<[string, (h: ReturnType<ReturnType<typeof slowDeck>["ccusage"]>) => void]> = [
    ["its own `ok: false`, a timeout", h => h.answer(answer({ ok: false, reason: "timeout" }))],
    ["an HTTP error", h => h.answer(answer(null, 500))],
    ["a deck that did not answer", h => h.fail(new TypeError("Failed to fetch"))],
    ["a body that is not JSON", h => h.answer({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token"); } })],
  ];

  for (const [how, fail] of failures) {
    it(`keeps the report on pricing.ts after ${how}`, async () => {
      const m = modal();
      m.open(7);
      m.deck.report().answer(answer(report()));
      fail(m.deck.ccusage());
      await settle();

      expect(reportLoading(m.state)).toBe(false);
      // ccusage failing is not the report failing.
      expect(m.state.error).toBeNull();
      expect(m.state.report!.cost).toEqual({ phase: "failed" });
      const d = dollars(m.state);
      expect(d.reconciled).toBe(false);
      expect(close(d.totalCost, ESTIMATE)).toBe(true);
    });
  }

  it("keeps it whichever of the two answers first", async () => {
    const m = modal();
    m.open(7);
    m.deck.ccusage().answer(answer({ ok: false, reason: "timeout" }));
    await settle();
    m.deck.report().answer(answer(report()));
    await settle();
    expect(m.state.report!.cost).toEqual({ phase: "failed" });
    expect(close(dollars(m.state).totalCost, ESTIMATE)).toBe(true);
  });
});

describe("a range the user has left cannot write", () => {
  it("never lets the last range's late ccusage answer reconcile the next range", async () => {
    const m = modal();
    m.open(1);
    m.deck.report(0).answer(answer(report()));
    await settle();
    m.open(7);

    // Today's ccusage run finishes after 7d was pressed. It is dropped: not
    // drawn on today's report still up under the dimming, and not held for the
    // 7d report to pick up.
    m.deck.ccusage(0).answer(answer(ccusage(ESTIMATE * 3)));
    await settle();
    expect(m.state.report!.days).toBe(1);
    expect(m.state.report!.cost).toEqual({ phase: "running" });
    expect(m.state.early).toBeNull();

    m.deck.report(1).answer(answer(report("/u/other")));
    await settle();
    expect(m.state.report!.days).toBe(7);
    expect(m.state.report!.cost).toEqual({ phase: "running" });
    expect(close(dollars(m.state).totalCost, ESTIMATE)).toBe(true);

    m.deck.ccusage(1).answer(answer(ccusage(ESTIMATE * 1.5)));
    await settle();
    expect(close(dollars(m.state).totalCost, ESTIMATE * 1.5)).toBe(true);
  });

  it("never lets the last range's late report replace the next range's", async () => {
    const m = modal();
    m.open(1);
    m.open(30);
    m.deck.report(1).answer(answer(report("/u/thirty")));
    await settle();
    m.deck.report(0).answer(answer(report("/u/today")));
    await settle();
    expect(m.state.report!.days).toBe(30);
    expect(dollars(m.state).projects.map(p => p.path)).toEqual(["/u/thirty"]);
  });

  it("never lets the last range's late failure take the next range's report down", async () => {
    const m = modal();
    m.open(1);
    m.open(30);
    m.deck.report(1).answer(answer(report("/u/thirty")));
    await settle();
    m.deck.report(0).answer(answer(null, 503));
    await settle();
    expect(m.state.error).toBeNull();
    expect(m.state.report!.days).toBe(30);
  });

  it("keeps the last report up, dimmed, while the next window loads", async () => {
    const m = modal();
    m.open(1);
    m.deck.report().answer(answer(report()));
    m.deck.ccusage().answer(answer(ccusage(ESTIMATE * 1.5)));
    await settle();
    m.open(7);
    // Loading again, over today's report — which keeps the dollars it was
    // reconciled against rather than dropping back to the estimate under the
    // dimming.
    expect(reportLoading(m.state)).toBe(true);
    expect(m.state.report!.days).toBe(1);
    expect(close(dollars(m.state).totalCost, ESTIMATE * 1.5)).toBe(true);
  });
});

describe("the report's own failure is said apart from ccusage", () => {
  it("ends the loading line with the report's failure, whatever ccusage does", async () => {
    const m = modal();
    m.open(1);
    m.deck.report().answer(answer({ ok: false, reason: "bad_account" }, 400));
    await settle();
    expect(reportLoading(m.state)).toBe(false);
    expect(m.state.error).toBe("HTTP 400");
    expect(m.state.report).toBeNull();

    // ccusage answering afterwards has no report to reconcile, and does not
    // bring anything back on screen.
    m.deck.ccusage().answer(answer(ccusage(ESTIMATE)));
    await settle();
    expect(m.state.report).toBeNull();
    expect(m.state.error).toBe("HTTP 400");
  });

  it("does not leave the last window's report standing under the new window's failure", async () => {
    const m = modal();
    m.open(1);
    m.deck.report(0).answer(answer(report()));
    await settle();
    m.open(7);
    m.deck.report(1).fail(new TypeError("Failed to fetch"));
    await settle();
    expect(m.state.report).toBeNull();
    expect(m.state.error).toBe("Failed to fetch");
  });
});

describe("the modal itself", () => {
  const src = sourceOf("components/AccountProjectsModal.tsx");

  it("no longer waits on the two reads as a pair", () => {
    expect(src).not.toMatch(/Promise\.all\(/);
    expect(src).not.toMatch(/fetch\(/);
  });

  it("loads through the loader and reducer above, under a fresh generation per window", () => {
    expect(src).toContain("useReducer(projectsLoad<Report>, INITIAL_LOAD)");
    expect(src).toMatch(/const gen = \+\+reqId\.current;\s*dispatch\(\{ type: "start", gen \}\);/);
    expect(src).toContain("loadProjects<Report>({ num, days, gen, dispatch });");
  });

  it("gates Loading… and aria-busy on the report alone", () => {
    expect(src).toContain("const loading = reportLoading(load);");
    expect(src).toContain('{loading && !report && <div className="ap-proj-state">Loading…</div>}');
    expect(src).toContain("aria-busy={loading}");
  });

  it("prices the report from the ccusage answer paired with it, the way dollars() above does", () => {
    expect(src).toContain('const ccRange = load.report?.cost.phase === "ready" ? load.report.cost.range : null;');
    expect(src).toContain("reconcile(report.daily ?? [], report.unattributed, ccCellsFrom(ccRange), now)");
  });

  it("says the dollars are still moving, and never calls a running ccusage unavailable", () => {
    expect(src).toContain('const costPending = load.report?.cost.phase === "running";');
    expect(src).toContain('{costPending && <span className="ap-proj-total-pending">Reconciling cost…</span>}');
    // The pending case is asked first, so the foot cannot fall through to
    // "ccusage unavailable" while ccusage is in fact still running.
    expect(src).toMatch(/\{costPending \? "Dollars estimated · ccusage still running"\s*: view\.reconciled \?/);
  });
});
