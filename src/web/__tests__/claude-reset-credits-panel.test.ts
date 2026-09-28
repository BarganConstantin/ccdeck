// The Claude card's saved-limit-resets row (#1308): what it says, and when it
// says nothing.
//
// The sentence is run rather than read, from reset-credits.ts, which both cards
// print through. Where the row sits and what gates it are read from the
// component, because the panel fetches its own quota inside an effect and this
// suite renders no DOM — the same trade wire-contract-1046.test.ts makes for
// the pay-as-you-go fields beside it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resetCreditsLine } from "../reset-credits";
import { sourceOf } from "./client-source";
import { USAGE_FILES } from "./usage-surface";

// Midday UTC, so the printed date is the same in every timezone a CI runner or
// a contributor's machine might be in.
const OCT_4 = Date.parse("2026-10-04T12:00:00Z");

describe("the sentence", () => {
  it("counts, pluralises and gives the nearest expiry as a date", () => {
    expect(resetCreditsLine("limit reset", { availableCount: 2, nextExpiryAt: OCT_4 }))
      .toBe("2 limit resets available · expires Oct 4");
    expect(resetCreditsLine("limit reset", { availableCount: 1, nextExpiryAt: OCT_4 }))
      .toBe("1 limit reset available · expires Oct 4");
  });

  it("says nothing about expiry when no reset has an end", () => {
    expect(resetCreditsLine("limit reset", { availableCount: 3, nextExpiryAt: null }))
      .toBe("3 limit resets available");
  });

  it("is still the Codex card's sentence, word for word", () => {
    expect(resetCreditsLine("rate-limit reset", { availableCount: 2, nextExpiryAt: OCT_4 }))
      .toBe("2 rate-limit resets available · expires Oct 4");
  });
});

describe("the Claude card", () => {
  const panel = sourceOf("components/UsagePanel.tsx");
  const quota = readFileSync(fileURLToPath(new URL("../../server/quota.mjs", import.meta.url)), "utf8");

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
    expect(panel).toContain('resetCreditsLine("limit reset", quota.resetCredits)');
  });

  it("says where a reset is redeemed, and that the deck only reports them", () => {
    const row = panel.slice(panel.indexOf('resetCreditsLine("limit reset"') - 400, panel.indexOf('resetCreditsLine("limit reset"'));
    expect(row).toMatch(/title=\{`[^`]*Redeem one in Claude on the web or desktop — \$\{PRODUCT\} only reports them`\}/);
  });

  it("wears the Codex row's class, so both inventories read as the same kind of fact", () => {
    // Counted over the panel and every file lifted out of it.
    expect(USAGE_FILES.map(sourceOf).join("\n").match(/className="up-quota-sub up-reset-credits"/g)).toHaveLength(2);
  });
});

describe("the row's type", () => {
  const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");

  it("takes its colour from a token and sets its numbers in tabular figures", () => {
    const rule = css.match(/\.up-reset-credits \{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toMatch(/color: var\(--ok\)/);
    expect(rule).toMatch(/font-variant-numeric: tabular-nums/);
    // --warn is the colour of an agent blocked on the user, and nothing else.
    expect(rule).not.toMatch(/--warn/);
  });
});
