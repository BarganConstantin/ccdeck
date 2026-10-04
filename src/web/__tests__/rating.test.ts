// "How useful is ccdeck to you?" — the one question the deck asks about itself
// (rating.mjs, reports.mjs, use-rating-ask.ts, RatingBanner.tsx).
//
// What these pin: it is asked only after seven days the deck was used, only
// while reports are on, never in the minutes after a launch; "Not now" puts it
// off a month, once, and the second time ends it; an answer is sent once, as a
// "rated" report carrying the number and a range of days and nothing else, and
// retried while it cannot get through; the days used survive a restart without
// a day counted twice; and the page's route refuses anything but a whole number
// from 0 to 10 or "later".
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain JS module, no types
import { normalise } from "../../server/deck-prefs.mjs";
import {
  RATING_AFTER_DAYS, RATING_AFTER_LAUNCH_MS, RATING_AGAIN_AFTER_MS, daysUsedBucket, normaliseRating, ratingDue,
  // @ts-expect-error — plain JS module, no types
} from "../../server/rating.mjs";
// @ts-expect-error — plain JS module, no types
import { createReporter } from "../../server/reports.mjs";
// @ts-expect-error — plain JS module, no types
import { handleRatingRead, handleRatingWrite } from "../../server/reports-routes.mjs";
// @ts-expect-error — plain JS module, no types
import { createUsageDay } from "../../server/usage-day.mjs";
import RatingBanner from "../components/RatingBanner";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const UP = RATING_AFTER_LAUNCH_MS;

type Call = { method: string; url: string; body: Record<string, unknown> | undefined };

/** A deck that has been used on `days` days, with a prefs store in memory and an
 *  API that records what it is sent. */
function deck({ days = RATING_AFTER_DAYS, env = {} as Record<string, string>, saved = {} as Record<string, unknown> } = {}) {
  let clock = new Date("2026-10-04T09:00:00Z");
  let prefs = normalise(saved);
  const store = {
    current: () => prefs,
    update: async (mutate: (prev: typeof prefs) => Partial<typeof prefs> | undefined) => {
      prefs = normalise({ ...prefs, ...(mutate(prefs) ?? {}) });
      return prefs;
    },
  };
  const calls: Call[] = [];
  let status = 202;
  const usage = createUsageDay({ now: () => clock });
  for (let i = 0; i < days; i++) {
    usage.noteUse({ session_id: `s${i}` });
    clock = new Date(clock.getTime() + DAY);
  }
  let up = UP;
  const reporter = createReporter({
    fetchImpl: async (url: string, init: { method: string; body?: string }) => {
      calls.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined });
      if (status === 0) throw new Error("offline");
      return { ok: status >= 200 && status < 300, status };
    },
    now: () => clock,
    prefs: store,
    env,
    facts: { version: "3.37.0", os: "linux", arch: "x64", channel: "npm", runtime: "node-22.18.0" },
    home: "/home/alice",
    usage,
    setup: () => ({}),
    uptime: () => up,
  });
  return {
    reporter, calls, usage,
    prefs: () => prefs,
    rated: () => calls.filter(c => c.body?.kind === "rated").map(c => c.body),
    later: (ms: number) => { clock = new Date(clock.getTime() + ms); },
    justLaunched: () => { up = 30_000; },
    goOffline: () => { status = 0; },
    goOnline: () => { status = 202; },
  };
}

/** A deck that has checked in once, so it has an install id. */
async function checkedIn(over: Parameters<typeof deck>[0] = {}) {
  const d = deck(over);
  await d.reporter.checkIn();
  return d;
}

describe("when it is asked", () => {
  it("is after seven days the deck was used, not before", async () => {
    expect((await checkedIn({ days: RATING_AFTER_DAYS - 1 })).reporter.ratingAsk()).toBe(false);
    expect((await checkedIn({ days: RATING_AFTER_DAYS })).reporter.ratingAsk()).toBe(true);
  });

  it("counts days with a session, not days the deck ran or sessions in a day", () => {
    const usage = createUsageDay({ now: () => new Date("2026-10-04T09:00:00Z") });
    for (let i = 0; i < 40; i++) usage.noteUse({ session_id: `s${i}` });
    usage.noteProject("/home/alice/.claude/projects/p/x.jsonl");
    expect(usage.daysUsed()).toBe(1);
  });

  it("never in the minutes after a launch", async () => {
    const d = await checkedIn();
    d.justLaunched();
    expect(d.reporter.ratingAsk()).toBe(false);
  });

  it("never while reports are off, vetoed, or before there is an install to send under", async () => {
    expect((await checkedIn({ saved: { reports: false } })).reporter.ratingAsk()).toBe(false);
    expect((await checkedIn({ env: { AGENTS_DECK_NO_REPORTS: "1" } })).reporter.ratingAsk()).toBe(false);
    expect(deck().reporter.ratingAsk()).toBe(false);
  });

  it("is put off a month by 'Not now', once; the second time it stops", async () => {
    const d = await checkedIn();
    expect(await d.reporter.rateLater()).toBe(true);
    expect(d.reporter.ratingAsk()).toBe(false);
    d.later(RATING_AGAIN_AFTER_MS - HOUR);
    expect(d.reporter.ratingAsk()).toBe(false);
    d.later(HOUR);
    expect(d.reporter.ratingAsk()).toBe(true);
    await d.reporter.rateLater();
    d.later(10 * RATING_AGAIN_AFTER_MS);
    expect(d.reporter.ratingAsk()).toBe(false);
    expect(d.rated()).toEqual([]);
  });

  it("never again once answered", async () => {
    const d = await checkedIn();
    await d.reporter.rate(8);
    d.later(400 * DAY);
    expect(d.reporter.ratingAsk()).toBe(false);
  });
});

describe("what an answer sends", () => {
  it("is one 'rated' report: the number, a range of days used, and the usual facts", async () => {
    const d = await checkedIn({ days: 12 });
    expect(await d.reporter.rate(9)).toBe(true);
    const { installId } = d.prefs().report;
    // toEqual: this is the whole of what leaves for the question.
    expect(d.rated()).toEqual([{
      installId, kind: "rated", version: "3.37.0", os: "linux", arch: "x64", channel: "npm", runtime: "node-22.18.0",
      score: 9, daysUsed: "7-13",
    }]);
    await d.reporter.checkIn();
    expect(d.rated()).toHaveLength(1);
  });

  it("keeps the first answer: a second tab answering again changes nothing", async () => {
    const d = await checkedIn();
    await d.reporter.rate(3);
    expect(await d.reporter.rate(10)).toBe(false);
    expect(d.rated().map(b => b?.score)).toEqual([3]);
  });

  it("takes only a whole number from 0 to 10", async () => {
    const d = await checkedIn();
    for (const bad of [-1, 11, 7.5, "7", null, undefined, Number.NaN]) {
      expect(await d.reporter.rate(bad), String(bad)).toBe(false);
    }
    expect(d.rated()).toEqual([]);
    expect(await d.reporter.rate(0)).toBe(true);
  });

  it("is tried again at the next check-in when the API cannot be reached", async () => {
    const d = await checkedIn();
    d.goOffline();
    expect(await d.reporter.rate(6)).toBe(true);
    expect(d.prefs().report.rating).toMatchObject({ score: 6, sent: false });
    d.goOnline();
    await d.reporter.checkIn();
    expect(d.prefs().report.rating.sent).toBe(true);
    await d.reporter.checkIn();
    // The one that failed, and the one that got through: never a third.
    expect(d.rated().map(b => b?.score)).toEqual([6, 6]);
  });

  it("sends nothing for a question put off, and nothing at all with reports off", async () => {
    const d = await checkedIn();
    await d.reporter.rateLater();
    expect(d.rated()).toEqual([]);
    const off = await checkedIn({ saved: { reports: false } });
    expect(await off.reporter.rate(9)).toBe(false);
    expect(off.calls).toEqual([]);
  });

  it("says how long the deck had been used only as a range", () => {
    expect([1, 6, 7, 13, 14, 29, 30, 89, 90, 400].map(daysUsedBucket))
      .toEqual(["1-6", "1-6", "7-13", "7-13", "14-29", "14-29", "30-89", "30-89", "90+", "90+"]);
  });
});

describe("the days used", () => {
  it("survive a restart, and the day of the restart is not counted twice", () => {
    let clock = new Date("2026-10-01T09:00:00Z");
    const first = createUsageDay({ now: () => clock });
    for (let i = 0; i < 3; i++) {
      first.noteUse({ session_id: `a${i}` });
      clock = new Date(clock.getTime() + DAY);
    }
    first.noteUse({ session_id: "today-before" });
    const saved = JSON.parse(JSON.stringify(first.saved()));
    expect(saved).toMatchObject({ daysUsed: 4, lastUsedDay: "2026-10-04" });

    // The next run hears a session before the prefs are read, on the same day.
    const second = createUsageDay({ now: () => clock });
    second.noteUse({ session_id: "today-after" });
    second.restore(saved);
    expect(second.daysUsed()).toBe(4);
    second.restore(saved);
    expect(second.daysUsed()).toBe(4);
    clock = new Date(clock.getTime() + DAY);
    second.noteUse({ session_id: "tomorrow" });
    expect(second.daysUsed()).toBe(5);
  });

  it("are a count and one date in prefs.json, never the days themselves", () => {
    expect(normalise({ report: { usage: { daysUsed: 9, lastUsedDay: "2026-10-04" } } }).report.usage)
      .toMatchObject({ daysUsed: 9, lastUsedDay: "2026-10-04" });
    expect(normalise({ report: { usage: { daysUsed: "9", lastUsedDay: "yesterday" } } }).report.usage)
      .toMatchObject({ daysUsed: 0, lastUsedDay: "" });
  });

  it("and the question's own state reads back as written, or as never asked", () => {
    expect(normaliseRating({ score: 7, sent: true, later: 1, laterAt: "2026-10-04T09:00:00.000Z" }))
      .toEqual({ score: 7, sent: true, later: 1, laterAt: "2026-10-04T09:00:00.000Z" });
    expect(normaliseRating({ score: 12, sent: true, later: -3, laterAt: "soon" }))
      .toEqual({ score: null, sent: false, later: 0, laterAt: "" });
    expect(ratingDue(null, RATING_AFTER_DAYS, new Date(), UP)).toBe(true);
    expect(ratingDue({ later: 1 }, RATING_AFTER_DAYS, new Date(), UP)).toBe(false);
  });
});

/** A request the route reads, and the answer it writes. */
function exchange(body?: unknown) {
  const req = Readable.from(body === undefined ? [] : [typeof body === "string" ? body : JSON.stringify(body)]);
  const res = {
    headersSent: false, status: 0, text: "",
    writeHead(status: number) { res.status = status; res.headersSent = true; },
    end(text: string) { res.text = text; },
  };
  return { req, res, json: () => JSON.parse(res.text) };
}

describe("the page's route", () => {
  it("says whether to ask", async () => {
    const d = await checkedIn();
    const x = exchange();
    handleRatingRead(x.req, x.res, { report: d.reporter });
    expect(x.res.status).toBe(200);
    expect(x.json()).toEqual({ ok: true, ask: true });
  });

  it("keeps a score or a 'later', and refuses anything else", async () => {
    const d = await checkedIn();
    for (const bad of [{ score: 11 }, { score: "5" }, { score: 2.5 }, {}, "not json", { later: "yes" }]) {
      const x = exchange(bad);
      await handleRatingWrite(x.req, x.res, { report: d.reporter });
      expect(x.res.status, JSON.stringify(bad)).toBe(400);
    }
    const later = exchange({ later: true });
    await handleRatingWrite(later.req, later.res, { report: d.reporter });
    expect(later.res.status).toBe(200);
    const answer = exchange({ score: 4 });
    await handleRatingWrite(answer.req, answer.res, { report: d.reporter });
    expect(answer.res.status).toBe(200);
    const again = exchange({ score: 9 });
    await handleRatingWrite(again.req, again.res, { report: d.reporter });
    expect(again.res.status).toBe(409);
    expect(d.rated().map(b => b?.score)).toEqual([4]);
  });

  it("is a gated mutation like every other page POST, and sits above the 404", () => {
    const src = readFileSync(new URL("../../server/index.mjs", import.meta.url), "utf8");
    const route = src.indexOf('url.pathname === "/api/rating")       return guard(handleRatingWrite');
    expect(route).toBeGreaterThan(src.indexOf("isAuthorizedMutation(req)"));
    expect(route).toBeLessThan(src.indexOf("AN UNMATCHED /api/ PATH IS A 404"));
  });
});

describe("the banner", () => {
  const props = {
    phase: "asking" as const, score: null, onAnswer: () => {}, onLater: () => {}, onClose: () => {}, onFeedback: () => {},
  };

  it("offers eleven numbered buttons, each named for a screen reader, and a way to put it off", () => {
    const html = renderToStaticMarkup(createElement(RatingBanner, props));
    expect(html).toContain("How useful is ccdeck to you?");
    const picks = [...html.matchAll(/<button[^>]*class="rating-pick"[^>]*aria-label="([^"]+)"[^>]*>(\d+)<\/button>/g)];
    expect(picks.map(m => m[2])).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
    expect(picks[0][1]).toMatch(/^0 out of 10/);
    expect(picks[10][1]).toMatch(/^10 out of 10/);
    expect(html).toMatch(/<button[^>]*>Not now<\/button>/);
    // A group named by its question, never a dialog and never a live alarm.
    expect(html).toMatch(/role="group"[^>]*aria-labelledby="rating-question"/);
    expect(html).not.toMatch(/role="(dialog|alert|alertdialog)"/);
    expect(html).not.toContain("autofocus");
  });

  it("thanks, and for a low score offers the feedback dialog without sending any words", () => {
    const low = renderToStaticMarkup(createElement(RatingBanner, { ...props, phase: "thanks", score: 4 }));
    expect(low).toContain("Thanks");
    expect(low).toMatch(/<button[^>]*>Tell us what would make it better<\/button>/);
    const high = renderToStaticMarkup(createElement(RatingBanner, { ...props, phase: "thanks", score: 9 }));
    expect(high).toContain("Thanks");
    expect(high).not.toContain("make it better");
  });
});
