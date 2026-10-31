import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import CodexAccountsPanel from "../components/CodexAccountsPanel";
import { items } from "./edge-keys-rails";

const ids = (list: { id: string }[]) => list.map(item => item.id);

describe("Codex accounts, in their own column", () => {
  it("shows Codex profiles and close without Claude account actions", () => {
    const html = renderToStaticMarkup(createElement(CodexAccountsPanel, { onClose() {} }));
    expect(html).toContain('aria-label="Codex profiles"');
    expect(html).toContain('aria-label="Close Codex accounts"');
    expect(html).not.toContain('Add an account');
    expect(html).not.toContain('Claude accounts');
    expect(html).toContain('id="codex-accounts-panel"');
  });

  it("gives a Codex-only machine Codex's own button where Claude's would be", () => {
    expect(ids(items({ claude: false, codex: true }).left)).toEqual(["codex-accounts", "session-list"]);
    expect(ids(items({ claude: false, codex: false }).left)).toEqual(["session-list"]);
  });

  it("keeps the two providers' panels separate on a machine with both CLIs", () => {
    // The dock keeps its five slots: Claude's button leads it and Codex's waits in More.
    const both = items({ claude: true, codex: true });
    expect(ids(both.left)).toEqual(["accounts", "session-list"]);
    expect(ids(both.codexMore)).toEqual(["codex-accounts"]);
    expect(ids(both.leftStripe.flat())).toEqual(["accounts", "codex-accounts", "session-list"]);
    expect(ids(items({ claude: true, codex: false }).left)).toEqual(["accounts", "session-list"]);
  });
});
