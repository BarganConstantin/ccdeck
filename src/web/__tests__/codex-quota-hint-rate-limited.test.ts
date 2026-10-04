// What the Codex section says while the deck waits out a rate limit.
//
// A refused read comes back as `rate_limited` (a 429 being waited out) or
// `waiting` (the first reading has not landed). codexHint had a sentence for
// neither, so both fell through to its default — "ChatGPT API unreachable —
// click ↻ to retry" — which is wrong twice over: the API answered, and ↻ is
// what the cooldown refuses. The Claude section says the same two states in
// its own words.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CodexQuotaSection } from "../components/QuotaSections";

const hint = (reason: string) => renderToStaticMarkup(createElement(CodexQuotaSection, {
  codexQuota: { ok: false, reason }, codexLoading: false, codexUsage: null, nowSec: 1_790_000_000,
})).replace(/<[^>]+>/g, " ");

describe("the Codex hint while the deck waits", () => {
  it("says a rate limit is being waited out, not that the API is unreachable", () => {
    const h = hint("rate_limited");
    expect(h).toContain("OpenAI asked the deck to wait");
    expect(h).not.toContain("unreachable");
    expect(h).not.toContain("click ↻ to retry");
  });

  it("says a first reading is still on its way", () => {
    expect(hint("waiting")).not.toContain("unreachable");
  });

  it("still sends a real failure to ↻", () => {
    expect(hint("http_500")).toContain("ChatGPT API unreachable — click ↻ to retry.");
  });
});
