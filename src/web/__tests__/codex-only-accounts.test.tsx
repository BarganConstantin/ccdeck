import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AccountsPanel from "../components/AccountsPanel";
import { items } from "./edge-keys-rails";

describe("Codex-only accounts", () => {
  it("shows Codex profiles and close without Claude account actions", () => {
    const html = renderToStaticMarkup(createElement(AccountsPanel, { claudeEnabled: false, codexEnabled: true, onClose() {} }));
    expect(html).toContain('aria-label="Codex profiles"');
    expect(html).toContain('aria-label="Close accounts"');
    expect(html).not.toContain('Add an account');
    expect(html).not.toContain('Claude accounts');
  });
  it("exposes Accounts in the rail on a Codex-only machine", () => {
    expect(items({ claude: false, codex: true }).left.map(item => item.id)).toEqual(["accounts", "session-list"]);
    expect(items({ claude: false, codex: false }).left.map(item => item.id)).toEqual(["session-list"]);
  });
});
