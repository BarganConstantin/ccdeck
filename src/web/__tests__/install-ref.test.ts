// `--ref <name>`: which ccdeck.dev page an install's command was copied from.
// The site puts one in every command it offers to copy, and the first "install"
// report carries it — once, a page name and nothing else (install-ref.mjs,
// reports.mjs). What these pin: only a slug survives, only the install report
// carries it, a ref the install could not send yet waits in the prefs and goes
// with the next try, and a ref that arrives after the install reported is
// ignored.
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { normalise } from "../../server/deck-prefs.mjs";
// @ts-expect-error — plain JS module, no types
import { createReporter } from "../../server/reports.mjs";
// @ts-expect-error — plain JS module, no types
import { REF_MAX, refSlug } from "../../server/install-ref.mjs";
// @ts-expect-error — plain JS module, no types
import { parseArgs } from "../../server/args.mjs";
// @ts-expect-error — plain JS module, no types
import { createUsageDay } from "../../server/usage-day.mjs";

type Call = { method: string; url: string; body: Record<string, unknown> | undefined };

/** A reporter against an API that records, with the prefs in memory and the ref this run's command said. */
function harness({ env = {} as Record<string, string>, version = "3.37.0" } = {}) {
  let prefs = normalise({});
  const store = {
    current: () => prefs,
    update: async (mutate: (prev: typeof prefs) => Partial<typeof prefs> | undefined) => {
      prefs = normalise({ ...prefs, ...(mutate(prefs) ?? {}) });
      return prefs;
    },
  };
  const calls: Call[] = [];
  let online = true;
  const clock = new Date("2026-10-04T10:00:00Z");
  const fetchImpl = async (url: string, init: { method: string; body?: string }) => {
    calls.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined });
    if (!online) throw new Error("offline");
    return { ok: true, status: 202 };
  };
  const reporter = (reference: unknown, over: { version?: string } = {}) => createReporter({
    fetchImpl, now: () => clock, prefs: store, env, home: "/home/alice",
    facts: { version: over.version ?? version, os: "linux", arch: "x64", channel: "npm", runtime: "node-22.18.0" },
    usage: createUsageDay({ now: () => clock }),
    reference: () => reference,
  });
  return {
    reporter, calls, prefs: () => prefs,
    events: (kind: string) => calls.filter(c => c.body?.kind === kind).map(c => c.body!),
    goOffline: () => { online = false; },
    goOnline: () => { online = true; },
  };
}

describe("a ref is a page name and nothing else", () => {
  it.each(["home", "guides", "guides-first-run", "codex-cli-dashboard", "a1", "x".repeat(REF_MAX)])("keeps %s", ref => {
    expect(refSlug(ref)).toBe(ref);
  });

  it.each(["", "Home", "home page", "guides/first-run", "../x", "x".repeat(REF_MAX + 1), "ünï", undefined, 7, null])(
    "drops %j",
    ref => {
      expect(refSlug(ref)).toBeUndefined();
    },
  );

  it("drops one that is not a slug from the saved prefs too", () => {
    expect(normalise({ report: { ref: "guides-codex" } }).report.ref).toBe("guides-codex");
    expect(normalise({ report: { ref: "/home/alice" } }).report.ref).toBe("");
  });
});

describe("the command line", () => {
  it("takes --ref=name and --ref name, and names a --ref with nothing after it", () => {
    expect(parseArgs(["--ref=guides-first-run"])).toMatchObject({ ref: "guides-first-run", unknown: [] });
    expect(parseArgs(["--ref", "home", "--no-open"])).toMatchObject({ ref: "home", noOpen: true, unknown: [] });
    expect(parseArgs(["--ref", "--no-open"])).toMatchObject({ noOpen: true, incomplete: [{ flag: "--ref", expects: "a page name" }] });
    expect(parseArgs(["--ref", "--no-open"]).ref).toBeUndefined();
  });

  it("is handed to the reports by the boot, and listed in --help", () => {
    const deck = readFileSync(new URL("../../../bin/deck.js", import.meta.url), "utf8");
    expect(deck).toContain("noteRef(flags.ref);");
    expect(readFileSync(new URL("../../../bin/cli/help.js", import.meta.url), "utf8"))
      .toMatch(/--ref <name>\s+The site page this command was copied from/);
  });
});

describe("the install report carries it, once", () => {
  it("rides on the first install and on nothing else", async () => {
    const h = harness();
    await h.reporter("guides-first-run").checkIn();

    expect(h.events("install")).toHaveLength(1);
    expect(h.events("install")[0].ref).toBe("guides-first-run");
    expect(h.events("active")[0]).not.toHaveProperty("ref");
    expect(h.prefs().report.ref).toBe("");
  });

  it("is left out when the command named none, or named something that is not a ref", async () => {
    for (const reference of [undefined, "Not A Ref"]) {
      const h = harness();
      await h.reporter(reference).checkIn();
      expect(h.events("install")[0]).not.toHaveProperty("ref");
    }
  });

  it("waits in the prefs when the install cannot get out, and goes with the next start's try", async () => {
    const h = harness();
    h.goOffline();
    await h.reporter("codex-cli-dashboard").checkIn();
    expect(h.prefs().report.ref).toBe("codex-cli-dashboard");
    expect(h.prefs().report.lastVersion).toBe("");

    // The next start came from the login item: no --ref on its command line.
    h.goOnline();
    await h.reporter(undefined).checkIn();
    const installs = h.events("install");
    expect(installs.at(-1)!.ref).toBe("codex-cli-dashboard");
    expect(h.prefs().report.ref).toBe("");
  });

  it("is ignored once the install has reported: an update or a later run with a ref sends none", async () => {
    const h = harness({ version: "3.37.0" });
    await h.reporter(undefined).checkIn();
    await h.reporter("home", { version: "3.37.1" }).checkIn();

    expect(h.events("install")).toHaveLength(1);
    expect(h.events("update")).toHaveLength(1);
    expect(h.events("update")[0]).not.toHaveProperty("ref");
    expect(h.prefs().report.ref).toBe("");
  });

  it("is never kept, let alone sent, on a machine that vetoes the reports", async () => {
    const h = harness({ env: { AGENTS_DECK_NO_REPORTS: "1" } });
    await h.reporter("home").checkIn();
    expect(h.calls).toEqual([]);
    expect(h.prefs().report.ref).toBe("");
  });
});
