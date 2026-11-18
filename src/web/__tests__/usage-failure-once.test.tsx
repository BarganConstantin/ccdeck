// The usage panel says a failure once, with one action (owner, 2026-11-11).
//
// It used to say it three times: "Quota unavailable." with "Run /usage in a
// claude session, then click ↻" under it, "Couldn't read today from the
// transcripts on this machine." with "Press Refresh to try again.", and the
// Refresh button at the foot. Now the bold line stays, why is a hover hint on
// a small info mark beside it, the period's failure is one sentence, and the
// foot's Refresh is the one retry for both.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { ClaudeQuotaSection, CodexQuotaSection } from "../components/QuotaSections";
import { LANGUAGES } from "../i18n/registry";
import { sheetText } from "./sheet-source";
import { withoutComments } from "./tsx-scan";

const claude = (reason: string) => renderToStaticMarkup(
  <ClaudeQuotaSection quota={{ ok: false, reason }} quotaLoading={false} nowSec={0} />);
const codex = (reason: string) => renderToStaticMarkup(
  <CodexQuotaSection codexQuota={{ ok: false, reason }} codexLoading={false} nowSec={0} />);

describe("a quota that is down", () => {
  it.each([
    ["Claude", claude("cli_failed"), "Quota unavailable.", "Run /usage in a Claude session."],
    ["Claude, waiting", claude("waiting"), "Quota unavailable.", "Next read allowed within a few minutes."],
    ["Codex", codex("http_500"), "Quota unavailable.", "ChatGPT API unreachable."],
  ])("%s: keeps the bold line and puts why on an info mark beside it", (_name, html, headline, why) => {
    const down = /<span class="up-quota-down">([^]*?)<\/span><span class="up-quota-hint"/.exec(html)?.[1] ?? "";
    expect(down.startsWith(headline)).toBe(true);
    const mark = /<span class="up-quota-why"[^>]*>/.exec(down)?.[0] ?? "";
    expect(mark).toContain('role="img"');
    expect(mark).toContain('aria-label="Why"');
    expect(mark).toContain('tabindex="0"');
    // The reason is in the page under the id the mark points at, for a screen
    // reader, and for a screen with no hover to print.
    const describedBy = /aria-describedby="([^"]+)"/.exec(mark)?.[1];
    expect(html).toContain(`<span class="up-quota-hint" id="${describedBy}">${why}</span>`);
  });

  it("asks for no press anywhere: the foot's Refresh is the one retry", () => {
    for (const html of [claude("cli_failed"), claude("waiting"), codex("http_500"), codex("refresh_failed")]) {
      expect(html).not.toContain("↻");
      expect(html).not.toMatch(/click|press|\bRefresh\b/);
    }
    for (const language of LANGUAGES) {
      const usage = Object.entries(language.catalog as Record<string, string>).filter(([key]) => key.startsWith("usage."));
      expect(usage.filter(([, text]) => text.includes("↻")), language.code).toEqual([]);
      expect(usage.map(([key]) => key), language.code).not.toContain("usage.period.unreadRetry");
    }
  });

  it("shows the hint with the accounts panel's hover hint, not a title of its own", () => {
    const src = withoutComments(readFileSync(fileURLToPath(new URL("../components/QuotaSections.tsx", import.meta.url)), "utf8"));
    expect(src).toContain('<HoverHint className="ap-peek ap-account-hint" detail={why}>');
    expect(src).not.toMatch(/up-quota-why"[^>]*title=/);
  });

  it("draws the mark as a 24px target for a mouse, and leaves the reason in place without one", () => {
    const css = sheetText();
    expect(css).toMatch(/\.up-quota-why \{ display: none; \}/);
    const mouse = /@media \(hover: hover\) and \(pointer: fine\) \{\s*\.up-quota-why \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(mouse).toMatch(/width: 24px;/);
    expect(mouse).toMatch(/height: 24px;/);
  });
});

describe("a period that could not be read", () => {
  const panel = withoutComments(readFileSync(fileURLToPath(new URL("../components/UsagePanel.tsx", import.meta.url)), "utf8"));

  it("is one sentence, with no line pointing at the button below it", () => {
    expect(panel).toContain('<div className="up-empty">{t("usage.period.unread", { period: periodWord })}</div>');
    expect(panel).not.toContain("unreadRetry");
  });

  it("is read again by the same Refresh that reads both quotas", () => {
    expect(panel).toContain("const refreshAll = () => { refreshQuota(); refreshCodex(); setRangeRefresh(n => n + 1); };");
    expect(panel).toContain("onClick={refreshAll}");
    // One retry on the panel: no other control re-reads a quota.
    expect(panel.match(/refreshQuota\(\)/g)).toHaveLength(1);
    expect(panel.match(/refreshCodex\(\)/g)).toHaveLength(1);
  });
});
