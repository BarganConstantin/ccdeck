// #1311: when Anthropic or OpenAI had an incident, the deck showed only its
// local symptoms — a failed quota read, an agent retrying — and nothing that
// said the cause was upstream. provider-status.mjs now reads both providers'
// status pages and reduces each to one line.
//
// What these pin: the mapping from a Statuspage summary to that line, scoped to
// the components a deck's sessions use; the worst-of rule; the page-wide
// fallback; that a failed or unreadable read is never an outage and never
// fresher than it is; that nothing is asked more often than the cache allows;
// and that the opt-outs ask nobody anything.
import { describe, expect, it } from "vitest";
import {
  cappedText, createProviderStatus, EXPIRE_MS, FRESH_MS, providerStatusReport, readSummary, RETRY_MS, statusChecksOff,
  // @ts-expect-error — plain JS module, no types
} from "../../server/provider-status.mjs";

type Component = { id: string; name: string; status: string; group?: boolean };

/** Anthropic's page as it answered on 2026-09-29, cut to what is read. */
function claudePage(over: Partial<Record<string, string>> = {}, extra: Record<string, unknown> = {}) {
  const components: Component[] = [
    { id: "rwppv331jlwc", name: "claude.ai", status: over["claude.ai"] ?? "operational" },
    { id: "0qbwn08sd68x", name: "Claude Console (platform.claude.com)", status: "operational" },
    { id: "k8w3r06qmzrp", name: "Claude API (api.anthropic.com)", status: over.api ?? "operational" },
    { id: "yyzkbfz2thpt", name: "Claude Code", status: over.code ?? "operational" },
    { id: "bpp5gb3hpjcl", name: "Claude Cowork", status: "operational" },
  ];
  return {
    page: { id: "tymt9n04zgry", name: "Claude", url: "https://status.claude.com", updated_at: "2026-09-29T05:25:23.693Z" },
    components,
    incidents: [],
    scheduled_maintenances: [],
    status: { indicator: "none", description: "All Systems Operational" },
    ...extra,
  };
}

/** OpenAI's page (incident.io's Statuspage-shaped summary): no incidents key,
 *  two components both called "Login". */
function openaiPage(over: Partial<Record<string, string>> = {}, indicator = "none") {
  const c = (id: string, name: string) => ({ id, name, status: over[name] ?? "operational" });
  return {
    page: { id: "01JMDK9XYNY6RXSED6SDWW50WY", name: "OpenAI", url: "https://status.openai.com/", updated_at: "2026-09-24T23:39:27Z" },
    status: { description: indicator === "none" ? "All Systems Operational" : "Partial System Outage", indicator },
    components: [
      c("a", "Conversations"), c("b", "Image Generation"), c("c", "Login"), c("d", "Codex Web"),
      c("e", "CLI"), c("f", "VS Code extension"), c("g", "Codex API"), c("h", "Login"),
    ],
  };
}

describe("reading a status summary", () => {
  it("is operational, with nothing to say, when the named components are", () => {
    const r = readSummary("claude", claudePage());
    expect(r).toMatchObject({ state: "operational", summary: null, components: [], scope: "components" });
    expect(r.updatedAt).toBe(Date.parse("2026-09-29T05:25:23.693Z"));
  });

  it("maps every component status to the deck's five words", () => {
    const cases: [string, string][] = [
      ["operational", "operational"],
      ["degraded_performance", "degraded"],
      ["partial_outage", "partial_outage"],
      ["major_outage", "major_outage"],
      ["under_maintenance", "maintenance"],
    ];
    for (const [page, deck] of cases) {
      expect(readSummary("claude", claudePage({ code: page })).state, page).toBe(deck);
    }
  });

  it("takes the worst of the components it watches", () => {
    const r = readSummary("claude", claudePage({ code: "degraded_performance", api: "major_outage" }));
    expect(r.state).toBe("major_outage");
    expect(r.components).toEqual(["Claude API (api.anthropic.com)", "Claude Code"]);
    // Planned work does not outrank an unplanned slowdown.
    expect(readSummary("claude", claudePage({ code: "under_maintenance", api: "degraded_performance" })).state).toBe("degraded");
  });

  it("ignores a component no session uses", () => {
    // A claude.ai-only outage: the web app is down, Claude Code is not.
    expect(readSummary("claude", claudePage({ "claude.ai": "major_outage" })).state).toBe("operational");
    // A ChatGPT outage that lights OpenAI's page-wide indicator.
    const r = readSummary("codex", openaiPage({ Conversations: "major_outage", Login: "major_outage" }, "major"));
    expect(r).toMatchObject({ state: "operational", scope: "components" });
  });

  it("reads the Codex components, including the two without the word", () => {
    for (const name of ["Codex Web", "Codex API", "CLI", "VS Code extension"]) {
      const r = readSummary("codex", openaiPage({ [name]: "partial_outage" }, "major"));
      expect(r.state, name).toBe("partial_outage");
      expect(r.components, name).toEqual([name]);
    }
  });

  it("names the incident that lists an affected component", () => {
    const body = claudePage({ code: "partial_outage" }, {
      incidents: [
        { name: "Login issues on claude.ai", status: "investigating", components: [{ id: "rwppv331jlwc" }] },
        { name: "Elevated errors for multiple models", status: "identified", components: [{ id: "yyzkbfz2thpt" }] },
      ],
    });
    expect(readSummary("claude", body).summary).toBe("Elevated errors for multiple models");
  });

  it("borrows no title from an incident about something else, or one that is over", () => {
    const body = claudePage({ code: "partial_outage" }, {
      incidents: [
        { name: "Login issues on claude.ai", status: "investigating", components: [{ id: "rwppv331jlwc" }] },
        { name: "Yesterday's errors", status: "resolved", components: [{ id: "yyzkbfz2thpt" }] },
      ],
    });
    const r = readSummary("claude", body);
    expect(r.summary).toBeNull();
    expect(r.components).toEqual(["Claude Code"]);
  });

  it("names a maintenance window that is in progress", () => {
    const body = claudePage({ api: "under_maintenance" }, {
      scheduled_maintenances: [
        { name: "Database upgrade", status: "in_progress", components: [{ id: "k8w3r06qmzrp" }] },
      ],
    });
    expect(readSummary("claude", body)).toMatchObject({ state: "maintenance", summary: "Database upgrade" });
  });

  it("says each affected component once", () => {
    const body = openaiPage({ "Codex API": "major_outage" });
    body.components.push({ id: "z", name: "Codex API ", status: "major_outage" });
    expect(readSummary("codex", body).components).toEqual(["Codex API"]);
  });

  it("falls back to Anthropic's page-wide indicator only when no named component is listed", () => {
    const body = { page: {}, status: { indicator: "minor", description: "Minor Service Outage" }, components: [{ id: "x", name: "Something renamed", status: "partial_outage" }] };
    expect(readSummary("claude", body)).toMatchObject({ state: "degraded", summary: "Minor Service Outage", components: [], scope: "page" });
    for (const [indicator, state] of [["none", "operational"], ["major", "partial_outage"], ["critical", "major_outage"], ["maintenance", "maintenance"]]) {
      expect(readSummary("claude", { status: { indicator } }).state, indicator).toBe(state);
    }
  });

  it("never reads OpenAI's page-wide indicator as Codex's state", () => {
    // Codex's components renamed away, and a ChatGPT outage lighting the page:
    // the deck cannot say anything about Codex, and says so.
    const body = openaiPage({}, "major");
    body.components = body.components.filter(c => !/codex|^cli$|vs code/i.test(c.name));
    expect(readSummary("codex", body)).toMatchObject({ state: "unknown", summary: null, components: [], scope: "page" });
  });

  it("does not count a component group, or a status it does not know, against the ones it does", () => {
    const body = claudePage({ code: "degraded_performance" });
    body.components.push({ id: "grp", name: "Claude Code", status: "major_outage", group: true });
    body.components.push({ id: "odd", name: "Claude API (beta)", status: "on_fire" });
    expect(readSummary("claude", body)).toMatchObject({ state: "degraded", components: ["Claude Code"] });
  });

  it("borrows no title from a maintenance that is only scheduled, or from a component at a lesser state", () => {
    const body = claudePage({ code: "major_outage", api: "under_maintenance" }, {
      scheduled_maintenances: [
        { name: "Next week's upgrade", status: "scheduled", components: [{ id: "yyzkbfz2thpt" }] },
        { name: "Database upgrade", status: "in_progress", components: [{ id: "k8w3r06qmzrp" }] },
      ],
    });
    const r = readSummary("claude", body);
    expect(r.state).toBe("major_outage");
    // The API's maintenance is real, and still not the name of Claude Code's outage.
    expect(r.summary).toBeNull();
    expect(r.components).toEqual(["Claude API (api.anthropic.com)", "Claude Code"]);
  });

  it("reads nothing out of a body that is not a summary", () => {
    for (const body of [null, "", 42, [], {}, { status: { indicator: "bogus" } }, { components: [{ name: "Claude Code", status: "on fire" }] }, { status: { indicator: "constructor" } }]) {
      expect(readSummary("claude", body), JSON.stringify(body)).toBeNull();
    }
  });

  it("cuts page-supplied words to a length a chip can hold", () => {
    const body = claudePage({ code: "major_outage" }, {
      incidents: [{ name: "x".repeat(5000), status: "investigating", components: [{ id: "yyzkbfz2thpt" }] }],
    });
    expect(readSummary("claude", body).summary.length).toBeLessThanOrEqual(160);
  });
});

/** A fetch that answers from a script and counts what it was asked. */
function fakeFetch(answer: () => unknown) {
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    const a = answer();
    if (a instanceof Error) throw a;
    if (typeof a === "number") return { ok: false, status: a, headers: new Map(), text: async () => "" };
    if (a && typeof a === "object" && "raw" in (a as object)) return (a as { raw: unknown }).raw;
    return { ok: true, status: 200, headers: new Map(), text: async () => (typeof a === "string" ? a : JSON.stringify(a)) };
  };
  return { calls, fetchImpl };
}

describe("the cache in front of the pages", () => {
  it("asks once per FRESH_MS, whoever asks", async () => {
    let t = 1_000_000;
    const { calls, fetchImpl } = fakeFetch(() => claudePage({ code: "partial_outage" }));
    const status = createProviderStatus({ fetchImpl, now: () => t });
    const first = await status.read("claude");
    expect(first).toMatchObject({ provider: "claude", state: "partial_outage", stale: false, checkedAt: t, statusPageUrl: "https://status.claude.com" });
    t += FRESH_MS - 1;
    await status.read("claude");
    expect(calls).toHaveLength(1);
    t += 1;
    await status.read("claude");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe("https://status.claude.com/api/v2/summary.json");
  });

  it("sends one request for two askers in the same moment", async () => {
    const { calls, fetchImpl } = fakeFetch(() => openaiPage());
    const status = createProviderStatus({ fetchImpl, now: () => 5_000_000 });
    const [a, b] = await Promise.all([status.read("codex"), status.read("codex")]);
    expect(calls).toEqual(["https://status.openai.com/api/v2/summary.json"]);
    expect(a).toEqual(b);
  });

  it("says unknown, not an outage, when the page never answered", async () => {
    for (const failure of [new Error("ENOTFOUND"), 503, "<!DOCTYPE html>", { hello: "world" }]) {
      const { fetchImpl } = fakeFetch(() => failure);
      const status = createProviderStatus({ fetchImpl, now: () => 7_000_000 });
      const r = await status.read("claude");
      expect(r, String(failure)).toMatchObject({ state: "unknown", checkedAt: null, stale: false, components: [] });
    }
  });

  it("keeps the last answer through a failure, marked stale and dated when it was true", async () => {
    let t = 10_000_000;
    let answer: unknown = claudePage({ code: "major_outage" });
    const { calls, fetchImpl } = fakeFetch(() => answer);
    const status = createProviderStatus({ fetchImpl, now: () => t });
    await status.read("claude");
    const answeredAt = t;

    answer = new Error("offline");
    t += FRESH_MS;
    const held = await status.read("claude");
    expect(held).toMatchObject({ state: "major_outage", stale: true, checkedAt: answeredAt });

    // No retry inside RETRY_MS, however often the page polls.
    t += RETRY_MS - 1;
    await status.read("claude");
    expect(calls).toHaveLength(2);
    t += 1;
    await status.read("claude");
    expect(calls).toHaveLength(3);
  });

  it("drops a stale answer past EXPIRE_MS rather than showing it as current", async () => {
    let t = 20_000_000;
    let answer: unknown = claudePage({ code: "major_outage" });
    const { fetchImpl } = fakeFetch(() => answer);
    const status = createProviderStatus({ fetchImpl, now: () => t });
    await status.read("claude");
    answer = new Error("offline");
    t += EXPIRE_MS + 1;
    expect(await status.read("claude")).toMatchObject({ state: "unknown", checkedAt: null, summary: null });
  });

  it("clears stale on the next good answer", async () => {
    let t = 30_000_000;
    let answer: unknown = claudePage({ code: "degraded_performance" });
    const { fetchImpl } = fakeFetch(() => answer);
    const status = createProviderStatus({ fetchImpl, now: () => t });
    await status.read("claude");
    answer = 502;
    t += FRESH_MS;
    expect((await status.read("claude")).stale).toBe(true);
    answer = claudePage();
    t += RETRY_MS;
    expect(await status.read("claude")).toMatchObject({ state: "operational", stale: false, checkedAt: t });
  });

  it("refuses a body past a megabyte, by its header or while it arrives", async () => {
    const big = { raw: { ok: true, status: 200, headers: new Map([["content-length", String(5 << 20)]]), text: async () => "{}" } };
    const streamed = {
      raw: {
        ok: true, status: 200, headers: new Map(),
        body: new ReadableStream({
          pull(c) { c.enqueue(new Uint8Array(256 * 1024).fill(32)); },
        }),
      },
    };
    for (const answer of [big, streamed]) {
      const { fetchImpl } = fakeFetch(() => answer);
      const status = createProviderStatus({ fetchImpl, now: () => 50_000_000 });
      expect(await status.read("claude")).toMatchObject({ state: "unknown", checkedAt: null });
    }
  });

  it("reads a body that fits, streamed or whole, and counts bytes rather than characters", async () => {
    const json = JSON.stringify(claudePage());
    const res = { body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(json)); c.close(); } }) };
    expect(await cappedText(res, 1 << 20)).toBe(json);
    // 400 characters, 1200 bytes.
    const wide = "€".repeat(400);
    await expect(cappedText({ text: async () => wide }, 1000)).rejects.toThrow("body too large");
    await expect(cappedText({ text: async () => wide }, 1200)).resolves.toBe(wide);
  });

  it("never rejects, whatever the fetch does", async () => {
    const status = createProviderStatus({
      fetchImpl: () => { throw new TypeError("fetch is not a function"); },
      now: () => 40_000_000,
    });
    await expect(status.read("codex")).resolves.toMatchObject({ state: "unknown" });
  });
});

describe("the route's answer", () => {
  const counting = () => {
    const asked: string[] = [];
    return { asked, instance: { read: async (p: string) => { asked.push(p); return { provider: p, state: "operational" }; } } };
  };

  it("asks about the CLIs this deck watches, and only those", async () => {
    const both = counting();
    await providerStatusReport({ providers: { claude: true, codex: true }, env: {}, instance: both.instance });
    expect(both.asked).toEqual(["claude", "codex"]);
    const claudeOnly = counting();
    const r = await providerStatusReport({ providers: { claude: true, codex: false }, env: {}, instance: claudeOnly.instance });
    expect(claudeOnly.asked).toEqual(["claude"]);
    expect(r).toEqual({ ok: true, disabled: false, providers: [{ provider: "claude", state: "operational" }] });
  });

  it("asks nobody anything under either opt-out", async () => {
    for (const env of [{ AGENTS_DECK_NO_STATUS: "1" }, { AGENTS_DECK_NO_INSTALL: "1" }]) {
      const c = counting();
      expect(statusChecksOff(env)).toBe(true);
      expect(await providerStatusReport({ providers: { claude: true, codex: true }, env, instance: c.instance }))
        .toEqual({ ok: true, disabled: true, providers: [] });
      expect(c.asked).toEqual([]);
    }
    expect(statusChecksOff({})).toBe(false);
    expect(statusChecksOff({ AGENTS_DECK_NO_STATUS: "0" })).toBe(false);
  });
});
