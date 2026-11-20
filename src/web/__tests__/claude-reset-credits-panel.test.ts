// The Claude card's saved-limit-resets row (#1308): what it says, and when it
// says nothing.
//
// The sentence is run rather than read, from reset-credits.ts, which both cards
// print through. Where the row sits and what gates it are read from the
// component, because the panel fetches its own quota inside an effect and this
// suite renders no DOM — the same trade wire-contract-1046.test.ts makes for
// the pay-as-you-go fields beside it.
import { describe, it, expect, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RESET_KINDS, resetCreditGroups, resetCreditsLine, resetGroupText, resetGroupTitle } from "../reset-credits";
import { en } from "../i18n/en";
import { catalogFor } from "../i18n/catalogs";
import { LANGUAGES } from "../i18n/registry";
import { translate } from "../i18n/translate";
// @ts-expect-error — plain JS module, no types
import { RESET_KINDS as SERVER_KINDS } from "../../server/claude-reset-credits.mjs";
import { sourceOf } from "./client-source";
import { USAGE_FILES } from "./usage-surface";
import { sheetText } from "./sheet-source";

// The expiry is printed in the reader's own zone, so the file pins one: the
// strings below hold whatever zone a CI runner or a contributor's machine is in.
const previousZone = process.env.TZ;
process.env.TZ = "Europe/Berlin";
afterAll(() => {
  if (previousZone === undefined) delete process.env.TZ; else process.env.TZ = previousZone;
});

// Midday UTC: 2:00pm in Berlin (CEST), 8:00am in New York (EDT).
const OCT_4 = Date.parse("2026-10-04T12:00:00Z");

/** The sentence as it reads, with the expiry's no-break spaces as plain ones;
 *  where it may wrap is its own test below. */
const line = (noun: string, c: Parameters<typeof resetCreditsLine>[1]) => resetCreditsLine(noun, c).replace(/ /g, " ");

describe("the sentence", () => {
  it("counts, pluralises and gives the nearest expiry as a date and a time", () => {
    expect(line("limit reset", { availableCount: 2, nextExpiryAt: OCT_4 }))
      .toBe("2 limit resets available · expires Oct 4, 2:00pm");
    expect(line("limit reset", { availableCount: 1, nextExpiryAt: OCT_4 }))
      .toBe("1 limit reset available · expires Oct 4, 2:00pm");
    expect(line("limit reset", { availableCount: 1, nextExpiryAt: Date.parse("2026-10-04T21:05:00Z") }))
      .toBe("1 limit reset available · expires Oct 4, 11:05pm");
  });

  it("gives the time in the reader's own zone, not one written into the deck", () => {
    try {
      process.env.TZ = "America/New_York";
      expect(line("limit reset", { availableCount: 1, nextExpiryAt: OCT_4 }))
        .toBe("1 limit reset available · expires Oct 4, 8:00am");
      // Past midnight UTC is still the evening before here, and the date says so.
      expect(line("limit reset", { availableCount: 1, nextExpiryAt: Date.parse("2026-10-05T00:30:00Z") }))
        .toBe("1 limit reset available · expires Oct 4, 8:30pm");
    } finally { process.env.TZ = "Europe/Berlin"; }
  });

  it("wraps before the expiry, never between its date and its time", () => {
    const said = resetCreditsLine("rate-limit reset", { availableCount: 2, nextExpiryAt: OCT_4 });
    expect(said).toBe("2 rate-limit resets available · expires Oct 4, 2:00pm");
  });

  it("says nothing about expiry when no reset has an end", () => {
    expect(resetCreditsLine("limit reset", { availableCount: 3, nextExpiryAt: null }))
      .toBe("3 limit resets available");
  });

  it("is still the Codex card's sentence, word for word", () => {
    expect(line("rate-limit reset", { availableCount: 2, nextExpiryAt: OCT_4 }))
      .toBe("2 rate-limit resets available · expires Oct 4, 2:00pm");
  });
});

describe("the Claude card", () => {
  // The Claude section, lifted out of UsagePanel.tsx with the Codex one.
  const panel = sourceOf("components/QuotaSections.tsx");
  // The OAuth body is mapped in quota-shape.mjs, lifted out of quota.mjs.
  const quota = readFileSync(fileURLToPath(new URL("../../server/quota-shape.mjs", import.meta.url)), "utf8");

  it("declares the field the server sends", () => {
    expect(quota).toContain("result.resetCredits = credits");
    // The shape the route answers in moved to use-quota.ts with the hook that reads it.
    // One group per kind now, and still the single total a deck from before
    // the kinds sends.
    expect(sourceOf("use-quota.ts")).toMatch(/interface QuotaData \{[^}]*resetCredits\?: ResetCreditGroup\[\] \| ResetCredits \| null;/);
  });

  it("draws a line for each kind there is a reset to spend of, and nothing else", () => {
    // Zero, unknown and absent all draw nothing — an eligible account with no
    // grants is not news, and an inventory the server could not establish is
    // not a zero.
    expect(panel).toContain("{resetCreditGroups(quota.resetCredits).map(g => (");
    expect(panel).toContain("{resetGroupText(g, t)}");
    for (const nothing of [undefined, null, [], { availableCount: 0, nextExpiryAt: null }, [{ kind: "full", availableCount: 0, nextExpiryAt: null }], "3", 3])
      expect(resetCreditGroups(nothing), JSON.stringify(nothing)).toEqual([]);
  });

  it("says where a reset is redeemed, and that the deck only reports them", () => {
    const row = panel.slice(panel.indexOf("resetCreditGroups(quota.resetCredits)"), panel.indexOf("{resetGroupText(g, t)}"));
    expect(row).toContain('title={resetGroupTitle(g.kind, t("usage.credits.claudeTitle", { product: PRODUCT }), t)}');
    expect(en["usage.credits.claudeTitle"]).toMatch(/Redeem one in Claude on the web or desktop — \{product\} only reports them/);
  });

  it("wears the Codex row's class, so both inventories read as the same kind of fact", () => {
    // Counted over the panel and every file lifted out of it.
    expect(USAGE_FILES.map(sourceOf).join("\n").match(/className="up-quota-sub up-reset-credits"/g)).toHaveLength(2);
  });
});

describe("the row's type", () => {
  const css = sheetText();

  it("takes its colour from a token and sets its numbers in tabular figures", () => {
    const rule = css.match(/\.up-reset-credits \{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toMatch(/color: var\(--ok\)/);
    expect(rule).toMatch(/font-variant-numeric: tabular-nums/);
    // --warn is the colour of an agent blocked on the user, and nothing else.
    expect(rule).not.toMatch(/--warn/);
  });
});

// Claude's resets come in kinds (user feedback: a Fable reset and one that
// clears every limit read the same, "1 limit reset available"). The server
// sends one group per kind; the card prints a line for each.
describe("a line per kind of reset", () => {
  // 9:59am in Berlin on March 9 (CET, UTC+1).
  const MAR_9 = Date.parse("2027-03-09T08:59:00Z");
  const said = (g: Parameters<typeof resetGroupText>[0]) => resetGroupText(g).replace(/\u00a0/g, " ");

  it("names the kind, the way Claude's own Settings name it", () => {
    expect(said({ kind: "fable", availableCount: 1, nextExpiryAt: MAR_9 })).toBe("1 Fable reset · expires Mar 9, 9:59am");
    expect(said({ kind: "full", availableCount: 2, nextExpiryAt: MAR_9 })).toBe("2 Global resets · expires Mar 9, 9:59am");
    expect(said({ kind: "weekly", availableCount: 1, nextExpiryAt: null })).toBe("1 weekly reset");
    expect(said({ kind: "session", availableCount: 1, nextExpiryAt: null })).toBe("1 5-hour reset");
    expect(said({ kind: "session", availableCount: 3, nextExpiryAt: MAR_9 })).toBe("3 5-hour resets · expires Mar 9, 9:59am");
  });

  it("keeps today's neutral line for a reset whose grant did not say what it clears", () => {
    expect(said({ kind: "unknown", availableCount: 1, nextExpiryAt: MAR_9 })).toBe("1 limit reset available · expires Mar 9, 9:59am");
    expect(said({ kind: "unknown", availableCount: 2, nextExpiryAt: null })).toBe("2 limit resets available");
  });

  it("says what a Fable and a Global reset do in their title, over where any reset is redeemed", () => {
    const where = "Saved in Claude";
    expect(resetGroupTitle("fable", where)).toBe("Gives back what Fable used to your weekly limit\nSaved in Claude");
    expect(resetGroupTitle("full", where)).toBe("Clears every limit\nSaved in Claude");
    for (const kind of ["weekly", "session", "unknown"] as const) expect(resetGroupTitle(kind, where)).toBe(where);
  });

  it("lists the kinds in the server's order, Fable first", () => {
    expect([...RESET_KINDS]).toEqual(SERVER_KINDS);
    expect(resetCreditGroups([
      { kind: "unknown", availableCount: 1, nextExpiryAt: null },
      { kind: "session", availableCount: 1, nextExpiryAt: null },
      { kind: "fable", availableCount: 1, nextExpiryAt: MAR_9 },
      { kind: "full", availableCount: 2, nextExpiryAt: null },
    ]).map(g => g.kind)).toEqual(["fable", "full", "session", "unknown"]);
  });

  it("reads the single total a deck from before the kinds sends as the neutral line", () => {
    // A paired deck one release behind, or a page left open across an upgrade,
    // still holds { availableCount, nextExpiryAt }.
    const old = resetCreditGroups({ availableCount: 2, nextExpiryAt: MAR_9 });
    expect(old).toEqual([{ kind: "unknown", availableCount: 2, nextExpiryAt: MAR_9 }]);
    expect(said(old[0])).toBe("2 limit resets available · expires Mar 9, 9:59am");
  });

  it("reads a kind this page does not know as the neutral line, and drops a group that is not one", () => {
    expect(resetCreditGroups([
      { kind: "turbo", availableCount: 1, nextExpiryAt: MAR_9 },
      { kind: "unknown", availableCount: 1, nextExpiryAt: MAR_9 + 1000 },
      { kind: "fable", availableCount: 1.5, nextExpiryAt: null },
      { kind: "full", availableCount: 1, nextExpiryAt: "Mar 9" },
      null,
    ])).toEqual([{ kind: "unknown", availableCount: 2, nextExpiryAt: MAR_9 }]);
  });

  it("is translated, with its plurals, in every language the deck ships", () => {
    for (const { code } of LANGUAGES) {
      const catalog = catalogFor(code);
      for (const kind of ["fable", "full", "weekly", "session"]) {
        for (const form of ["one", "other"]) expect(catalog[`usage.credits.${kind}.${form}`], `${code} ${kind}.${form}`).toBeTruthy();
        for (const count of [1, 2, 5, 21]) {
          const line = translate(code, catalog, `usage.credits.${kind}` as never, { count, expiry: "" });
          expect(line, `${code} ${kind} ${count}`).toContain(String(count));
          expect(line, `${code} ${kind} ${count}`).not.toMatch(/\{|\}/);
        }
      }
      for (const key of ["usage.credits.fableTitle", "usage.credits.fullTitle"]) expect(catalog[key], `${code} ${key}`).toBeTruthy();
      if (code !== "en") {
        // Translated, not English copied over.
        expect(catalog["usage.credits.full.other"], code).not.toBe(en["usage.credits.full.other"]);
        expect(catalog["usage.credits.fableTitle"], code).not.toBe(en["usage.credits.fableTitle"]);
      }
    }
  });
});
