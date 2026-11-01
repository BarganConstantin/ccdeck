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
import { resetCreditsLine } from "../reset-credits";
import { en } from "../i18n/en";
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
    expect(sourceOf("use-quota.ts")).toMatch(/interface QuotaData \{[^}]*resetCredits\?: ResetCredits \| null;/);
  });

  it("draws the row only when there is a reset to spend", () => {
    // Zero, unknown and absent all draw nothing — an eligible account with no
    // grants is not news, and an inventory the server could not establish is
    // not a zero.
    expect(panel).toMatch(/\{quota\.resetCredits && quota\.resetCredits\.availableCount > 0 && \(/);
    expect(panel).toContain('resetCreditsText("limit", quota.resetCredits, t)');
  });

  it("says where a reset is redeemed, and that the deck only reports them", () => {
    const row = panel.slice(panel.indexOf('resetCreditsText("limit"') - 400, panel.indexOf('resetCreditsText("limit"'));
    expect(row).toContain('title={t("usage.credits.claudeTitle", { product: PRODUCT })}');
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
