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

  it("gives a machine with both CLIs one Accounts button, with no Codex button beside it", () => {
    // The dock keeps its five slots: one Accounts button leads it, and a switch
    // in the panel's header picks the side. Only quick open keeps a Codex door.
    const both = items({ claude: true, codex: true });
    expect(ids(both.left)).toEqual(["accounts", "session-list"]);
    expect(ids(both.codexDoor)).toEqual(["codex-accounts"]);
    expect(ids(both.leftStripe.flat())).toEqual(["accounts", "session-list"]);
    expect(ids(items({ claude: true, codex: false }).left)).toEqual(["accounts", "session-list"]);
  });
});
