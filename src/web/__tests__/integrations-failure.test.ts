// One failure note for every integration panel (#2178, #2179). Jira and the
// forges each had a table of failures and a design for them, and they
// disagreed on the way out: a refused token offered Reconnect in one and "Open
// connection settings" in the other, a missing page offered Try again in one
// and nothing in the other, and a rate limit printed its wait beside a Try
// again that could be pressed at once. This pins the shared table, the held
// Try again, the stale variant and that the buttons are not inside the alert.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import IntegrationFailureNote from "../components/IntegrationFailureNote";
import { actionLabel, failureAction, failureSaid, failureWords, retryWait, retryWhen, type FailureInfo } from "../integrations/failure";
import type { IntegrationErrorKind } from "../integrations/types";
import { sheetText } from "./sheet-source";

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const KINDS: IntegrationErrorKind[] = ["auth", "expired", "permission", "unreachable", "tls", "rate-limit", "incompatible", "not-found", "upstream", "invalid", "network", "unavailable"];
const render = (error: FailureInfo, props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(IntegrationFailureNote, { error, provider: "GitHub", host: "github.example", now: NOW, onRetry: () => {}, onReconnect: () => {}, ...props }));
const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");

describe("what a failure offers", () => {
  it("is one way out per kind", () => {
    expect(Object.fromEntries(KINDS.map(k => [k, failureAction(k)]))).toEqual({
      auth: "reconnect", expired: "reconnect",
      permission: "settings", incompatible: "settings",
      "not-found": "none",
      unreachable: "retry", tls: "retry", "rate-limit": "retry", upstream: "retry", invalid: "retry", network: "retry", unavailable: "retry",
    });
    expect(actionLabel("reconnect")).toBe("Reconnect");
    expect(actionLabel("settings")).toBe("Open connection settings");
    expect(actionLabel("retry")).toBe("Try again");
  });

  it("says every kind in the provider's name, with a heading and a sentence", () => {
    for (const kind of KINDS) {
      const words = failureWords({ kind, message: "The deck said why." }, "GitLab", "gitlab.example", NOW);
      expect(words.title, kind).toBeTruthy();
      expect(words.body, kind).toBeTruthy();
      expect(words.title, kind).not.toMatch(/undefined|null/);
    }
    expect(failureWords({ kind: "auth" }, "Jira").title).toBe("Jira did not accept the saved token");
    expect(failureWords({ kind: "unreachable" }, "Jira", "jira.example").title).toBe("jira.example did not answer");
  });

  it("puts a rate limit's wait on Try again, not twice", () => {
    expect(retryWhen(42, NOW)).toBe("in 42s");
    expect(retryWhen(0.2, NOW)).toBe("in 1s");
    expect(retryWhen(600, NOW)).toMatch(/^after \d{1,2}[:.]\d{2}/);
    expect(failureWords({ kind: "rate-limit", retryAfter: 42 }, "GitHub").body).not.toMatch(/42/);
    expect(retryWait({ kind: "rate-limit", retryAfter: 42 }, NOW, NOW + 10_000)).toBe(32);
    expect(retryWait({ kind: "rate-limit", retryAfter: 42 }, NOW, NOW + 50_000)).toBe(0);
    expect(retryWait({ kind: "rate-limit" }, NOW, NOW)).toBe(0);
    expect(retryWait({ kind: "upstream", retryAfter: 42 }, NOW, NOW)).toBe(0);
  });

  it("shows the provider's own words only when they add something, and never for a token", () => {
    expect(failureSaid({ kind: "upstream", detail: "Server is busy" }, "GitHub answered with an error")).toBe("Server is busy");
    expect(failureSaid({ kind: "upstream", detail: "Server is busy" }, "Server is busy")).toBeNull();
    expect(failureSaid({ kind: "auth", detail: "Bad credentials" }, "x")).toBeNull();
    expect(failureSaid({ kind: "expired", detail: "Token expired" }, "x")).toBeNull();
  });
});

describe("the failure note on screen", () => {
  it("draws Reconnect as the primary way out for a token", () => {
    const html = render({ kind: "expired" });
    expect(html).toMatch(/<button type="button" class="btn primary">Reconnect<\/button>/);
    expect(html).not.toMatch(/Try again/);
  });

  it("draws nothing to press for a page that is gone", () => {
    expect(render({ kind: "not-found" })).not.toMatch(/<button/);
  });

  it("draws no button whose handler the panel did not pass", () => {
    expect(render({ kind: "upstream" }, { onRetry: undefined })).not.toMatch(/<button/);
    expect(render({ kind: "permission" }, { onReconnect: undefined })).not.toMatch(/<button/);
  });

  it("holds Try again through a rate limit, counting down on the button, and keeps it focusable", () => {
    const html = render({ kind: "rate-limit", retryAfter: 42 });
    expect(html).toMatch(/<button type="button" class="btn" aria-disabled="true">Try again in 42s<\/button>/);
    expect(html).not.toMatch(/ disabled=""/);
    expect(render({ kind: "rate-limit" })).toMatch(/<button type="button" class="btn">Try again<\/button>/);
  });

  it("keeps the buttons outside the alert, so a countdown is not read out every second", () => {
    const html = render({ kind: "rate-limit", retryAfter: 42 });
    const alert = /<div class="ig-failure-text" role="alert">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";
    expect(alert).toContain("GitHub asked the deck to slow down");
    expect(alert).not.toMatch(/<button/);
  });

  it("is a quieter status with the warning mark over rows that are the last answer", () => {
    const html = render({ kind: "upstream", message: "GitHub answered 500.", detail: "Server is busy" }, { stale: true });
    expect(html).toMatch(/<div class="ig-failure" data-kind="upstream" data-stale="true"><div class="ig-failure-text" role="status">/);
    expect(html).toMatch(/<path d="M7 1.9 12.9 12H1.1Z">/);
    expect(html).not.toContain("Server is busy");
  });

  it("lets a panel say it in its own words", () => {
    const html = render({ kind: "not-found" }, { title: "This board is gone", body: "Choose another board." });
    expect(html).toContain("This board is gone");
    expect(html).toContain("Choose another board.");
  });

  it("carries its tone on the edge and the mark, and no wash behind the words", () => {
    const rule = /\.ig-failure\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/border:\s*1px solid color-mix\(in srgb, var\(--err\)/);
    expect(rule).toMatch(/background:\s*var\(--panel\)/);
    expect(css).toMatch(/\.ig-failure\[data-stale\]\s*\{[^}]*border-color:\s*color-mix\(in srgb, var\(--warn\)/);
  });
});
