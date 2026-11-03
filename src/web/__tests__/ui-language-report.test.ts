// The language chosen in the deck's own page rides on the usage reports as
// `uiLanguage`: the page tells the server (POST /api/ui-language), the server
// keeps it in prefs.json (report.uiLanguage) and the reporter adds it to the
// events that carry the install facts. Not the ping, not errors, not feedback,
// and nothing at all with reports off.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { LANGUAGES } from "../i18n/registry";
// @ts-expect-error — plain JS module, no types
import { normalise } from "../../server/deck-prefs.mjs";
// @ts-expect-error — plain JS module, no types
import { UI_LANGUAGE_MAX, uiLanguageCode } from "../../server/ui-language.mjs";
// @ts-expect-error — plain JS module, no types
import { createReporter, installFacts } from "../../server/reports.mjs";
// @ts-expect-error — plain JS module, no types
import { handleUiLanguageWrite } from "../../server/reports-routes.mjs";
// @ts-expect-error — plain JS module, no types
import { createUsageDay } from "../../server/usage-day.mjs";

type Call = { url: string; body: Record<string, any> | undefined };

function harness({ env = {} as Record<string, string>, saved = {} as Record<string, unknown> } = {}) {
  let prefs = normalise(saved);
  const store = {
    current: () => prefs,
    update: async (mutate: (prev: typeof prefs) => Partial<typeof prefs> | undefined) => {
      prefs = normalise({ ...prefs, ...(mutate(prefs) ?? {}) });
      return prefs;
    },
  };
  const calls: Call[] = [];
  const clock = new Date("2026-09-30T10:00:00Z");
  const fetchImpl = async (url: string, init: { body?: string }) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : undefined });
    return { ok: true, status: 202 };
  };
  const reporter = createReporter({
    fetchImpl, now: () => clock, prefs: store, env,
    facts: { version: "3.54.0", os: "linux", arch: "x64", channel: "npm", runtime: "node-22.18.0", locale: "en-US" },
    home: "/home/alice", root: "/home/alice/ccdeck",
    usage: createUsageDay({ now: () => clock }), firstRun: () => true,
  });
  return { reporter, store, calls, prefs: () => prefs };
}

describe("the language code the server accepts", () => {
  it("takes language tags and nothing else", () => {
    for (const ok of ["en", "ro", "pt-BR", "zh-Hans", "fil", "es-419"]) expect(uiLanguageCode(ok), ok).toBe(ok);
    for (const bad of ["", "e", "english", "ro_RO", "pt-BR-x-extra", "ro ", "../x", "r0", 5, null, undefined, "a".repeat(17)]) {
      expect(uiLanguageCode(bad), String(bad)).toBe("");
    }
    expect(UI_LANGUAGE_MAX).toBe(16);
  });

  it("takes every language the page ships", () => {
    for (const l of LANGUAGES) expect(uiLanguageCode(l.code), l.code).toBe(l.code);
  });
});

describe("the preference", () => {
  it("is empty until a page says it, and normalise keeps a good code and drops a bad one", () => {
    expect(normalise({}).report.uiLanguage).toBe("");
    expect(normalise({ report: { uiLanguage: "pt-BR" } }).report.uiLanguage).toBe("pt-BR");
    expect(normalise({ report: { uiLanguage: "not a language" } }).report.uiLanguage).toBe("");
    expect(normalise({ report: { uiLanguage: 7 } }).report.uiLanguage).toBe("");
  });

  it("is kept by the reporter, and survives what a restart reads back", async () => {
    const h = harness();
    expect(await h.reporter.setUiLanguage("ro")).toBe(true);
    expect(h.prefs().report.uiLanguage).toBe("ro");
    // What goes to disk and comes back is the same normalise.
    expect(normalise(JSON.parse(JSON.stringify(h.prefs()))).report.uiLanguage).toBe("ro");
    expect(await h.reporter.setUiLanguage("nope!")).toBe(false);
    expect(h.prefs().report.uiLanguage).toBe("ro");
  });

  it("is not kept with reports off or vetoed, and switching reports off forgets it", async () => {
    const off = harness({ saved: { reports: false } });
    expect(await off.reporter.setUiLanguage("ro")).toBe(false);
    expect(off.prefs().report.uiLanguage).toBe("");
    const vetoed = harness({ env: { AGENTS_DECK_NO_REPORTS: "1" } });
    expect(await vetoed.reporter.setUiLanguage("ro")).toBe(false);
    const on = harness();
    await on.reporter.setUiLanguage("ro");
    await on.reporter.setReports(false);
    expect(on.prefs().report.uiLanguage).toBe("");
  });
});

describe("installFacts", () => {
  it("includes uiLanguage as a token and omits it when unknown", () => {
    expect(installFacts({ env: {}, uiLanguage: "pt-BR" }).uiLanguage).toBe("pt-BR");
    expect("uiLanguage" in installFacts({ env: {} })).toBe(false);
    expect("uiLanguage" in installFacts({ env: {}, uiLanguage: "" })).toBe(false);
    expect(installFacts({ env: {}, uiLanguage: "a".repeat(40) }).uiLanguage).toHaveLength(16);
  });
});

describe("what goes out", () => {
  it("rides on install, update and active, with locale, once a page has said it", async () => {
    const h = harness({ saved: { report: { installId: "id-1", lastVersion: "3.0.0" } } });
    await h.reporter.setUiLanguage("ro");
    await h.reporter.checkIn();
    const events = h.calls.filter(c => c.url.endsWith("/v1/app/events"));
    expect(events.map(e => e.body?.kind)).toEqual(expect.arrayContaining(["update", "active"]));
    for (const e of events) {
      expect(e.body?.uiLanguage, String(e.body?.kind)).toBe("ro");
      expect(e.body?.locale).toBe("en-US");
    }
  });

  it("is left out of an event while no page has said it", async () => {
    const h = harness({ saved: { report: { installId: "id-1", lastVersion: "3.0.0" } } });
    await h.reporter.checkIn();
    const events = h.calls.filter(c => c.url.endsWith("/v1/app/events"));
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect("uiLanguage" in (e.body ?? {})).toBe(false);
  });

  it("is not on an error report or the ping", async () => {
    const h = harness({ saved: { report: { installId: "id-1", lastVersion: "3.54.0", uiLanguage: "ro" } } });
    await h.reporter.reportError("server", new Error("boom"));
    await h.reporter.ping();
    expect(h.calls.length).toBeGreaterThan(0);
    for (const c of h.calls) expect("uiLanguage" in (c.body ?? {}), c.url).toBe(false);
  });

  it("is not sent once reports are off, even if a code was kept", async () => {
    const h = harness({ saved: { reports: false, report: { installId: "id-1", uiLanguage: "ro" } } });
    await h.reporter.checkIn();
    expect(h.calls.filter(c => c.body?.uiLanguage)).toEqual([]);
  });
});

describe("POST /api/ui-language", () => {
  async function post(body: unknown, report: unknown) {
    const req = Object.assign(new PassThrough(), { method: "POST", headers: { "content-type": "application/json" } });
    req.end(typeof body === "string" ? body : JSON.stringify(body));
    let status = 0, text = "";
    const res = {
      headersSent: false,
      writeHead: (s: number) => { status = s; return res; },
      end: (b?: string) => { text = b ?? ""; },
    };
    await handleUiLanguageWrite(req, res, { report });
    return { status, out: JSON.parse(text) };
  }

  it("hands a good code to the reporter", async () => {
    const setUiLanguage = vi.fn(async () => true);
    expect(await post({ code: "pt-BR" }, { setUiLanguage })).toEqual({ status: 200, out: { ok: true, kept: true } });
    expect(setUiLanguage).toHaveBeenCalledWith("pt-BR");
  });

  it("refuses a bad code or body with 400 and keeps nothing", async () => {
    const setUiLanguage = vi.fn(async () => true);
    for (const bad of [{ code: "nope!" }, { code: 5 }, {}, "not json"]) {
      expect((await post(bad, { setUiLanguage })).status).toBe(400);
    }
    expect(setUiLanguage).not.toHaveBeenCalled();
  });

  it("answers 200 with kept false when reports are off", async () => {
    const h = harness({ saved: { reports: false } });
    expect(await post({ code: "ro" }, h.reporter)).toEqual({ status: 200, out: { ok: true, kept: false } });
  });
});

describe("the page", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    vi.resetModules();
    fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  const codes = () => fetchMock.mock.calls.map(([url, init]) => [url, JSON.parse((init as { body: string }).body).code]);

  it("posts the language on load and again on every change", async () => {
    const { setLanguage, resetLanguageForTest } = await import("../i18n");
    const { startLanguageReport } = await import("../report-language");
    resetLanguageForTest();
    setLanguage("en");
    fetchMock.mockClear();
    const stop = startLanguageReport();
    expect(codes()).toEqual([["/api/ui-language", "en"]]);
    setLanguage("ro");
    expect(codes()[1]).toEqual(["/api/ui-language", "ro"]);
    stop();
    setLanguage("de");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never throws or blocks when the post fails", async () => {
    const { startLanguageReport } = await import("../report-language");
    fetchMock.mockImplementation(() => Promise.reject(new Error("offline")));
    expect(() => startLanguageReport()()).not.toThrow();
    vi.stubGlobal("fetch", () => { throw new Error("sync"); });
    expect(() => startLanguageReport()()).not.toThrow();
    await new Promise(r => setTimeout(r, 0));
  });
});
