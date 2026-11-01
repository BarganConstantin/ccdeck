// One Accounts panel with a Claude/Codex switch, on a deck with both CLIs.
//
// The switch changes the view and nothing else, stands where the title stood,
// and exists only where there are two sides to choose between.
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import AccountsHeader from "../components/AccountsHeader";
import AccountsSwitch, { sideForKey, type AccountSide } from "../components/AccountsSwitch";
import CodexAccountsPanel from "../components/CodexAccountsPanel";
import { panelId } from "../use-account-side";
import { items } from "./edge-keys-rails";

const NONE = { claude: false, codex: false };
const draw = (shown: AccountSide, notices: Record<AccountSide, boolean> = NONE) =>
  renderToStaticMarkup(createElement(AccountsSwitch, { shown, notices, onPick() {} }));

describe("the switch between Claude's accounts and Codex's", () => {
  it("is one radio group with one tab stop, on the side showing", () => {
    const html = draw("codex");
    expect(html).toContain('role="radiogroup"');
    expect(html.match(/role="radio"/g)).toHaveLength(2);
    expect(html).toMatch(/aria-checked="true"[^>]*tabindex="0"[^>]*>Codex/i);
    expect(html).toMatch(/aria-checked="false"[^>]*tabindex="-1"[^>]*>Claude/i);
  });

  it("walks the sides with the arrows, wrapping, and Home and End go to the ends", () => {
    expect(sideForKey("claude", "ArrowRight")).toBe("codex");
    expect(sideForKey("claude", "ArrowDown")).toBe("codex");
    expect(sideForKey("codex", "ArrowLeft")).toBe("claude");
    expect(sideForKey("codex", "ArrowUp")).toBe("claude");
    expect(sideForKey("codex", "ArrowRight")).toBe("claude");
    expect(sideForKey("claude", "ArrowLeft")).toBe("codex");
    expect(sideForKey("codex", "Home")).toBe("claude");
    expect(sideForKey("claude", "End")).toBe("codex");
  });

  it("leaves every other key to the deck", () => {
    for (const key of ["a", "Tab", "Enter", " ", "Escape", "toString"]) expect(sideForKey("claude", key)).toBeNull();
  });

  it("marks only the side out of sight, and says it in the button's name", () => {
    const flagged = draw("claude", { claude: false, codex: true });
    expect(flagged.match(/ap-side-dot/g)).toHaveLength(1);
    expect(flagged).toContain('aria-label="Codex, needs attention"');
    // The side showing carries its own notice; a dot there would say it twice.
    const showing = draw("codex", { claude: false, codex: true });
    expect(showing).not.toContain("ap-side-dot");
    expect(showing).not.toContain("needs attention");
  });
});

describe("the panel header with and without the switch", () => {
  const header = (switcher?: unknown) => renderToStaticMarkup(createElement(AccountsHeader, {
    canShare: true, onAdd() {}, onShareSet() {}, onReload() {},
    pressProps: () => ({}), reloading: false, closeButton: null, switcher,
  } as never));

  it("keeps the plain title on a deck with one CLI", () => {
    expect(header()).toContain("<h2>Claude accounts</h2>");
    expect(header()).not.toContain("radiogroup");
  });

  it("puts the switch where the title stood, and keeps the title for a reader", () => {
    const html = header(createElement(AccountsSwitch, { shown: "claude", notices: NONE, onPick() {} }));
    expect(html).toContain('<h2 class="vis-hidden">Claude accounts</h2>');
    expect(html).toContain('role="radiogroup"');
  });

  it("does the same on Codex's side, and takes the side out of the tree while it is hidden", () => {
    const panel = (side?: "shown" | "hidden") => renderToStaticMarkup(createElement(CodexAccountsPanel, {
      onClose() {}, side, switcher: side ? createElement(AccountsSwitch, { shown: "claude", notices: NONE, onPick() {} }) : undefined,
    }));
    expect(panel()).toContain("<h2>Codex accounts</h2>");
    expect(panel()).not.toContain("data-side");
    expect(panel("shown")).toContain('data-side="shown"');
    expect(panel("shown")).not.toMatch(/<aside[^>]* hidden/);
    expect(panel("hidden")).toMatch(/<aside[^>]* hidden/);
    expect(panel("hidden")).toContain('<h2 class="vis-hidden">Codex accounts</h2>');
  });

  it("draws the hidden side out of the layout, against the panel's own display", () => {
    const sheet = readFileSync(new URL("../styles/accounts-panel.css", import.meta.url), "utf8");
    expect(sheet).toContain(".accounts-panel[hidden] { display: none; }");
  });
});

describe("the rail with both CLIs", () => {
  const ids = (list: { id: string }[]) => list.map(item => item.id);

  it("has one Accounts button; Codex's own is only where Codex is all there is", () => {
    const both = items({ claude: true, codex: true });
    expect(ids(both.left)).toEqual(["accounts", "session-list"]);
    expect(ids(both.leftStripe.flat())).not.toContain("codex-accounts");
    expect(both.left[0]).toMatchObject({ label: "Accounts", short: "Accounts", ariaLabel: "Accounts" });
    expect(ids(items({ claude: false, codex: true }).leftStripe.flat())).toContain("codex-accounts");
  });

  it("keeps quick open's door to Codex's side", () => {
    expect(ids(items({ claude: true, codex: true }).codexDoor)).toEqual(["codex-accounts"]);
    expect(items({ claude: false, codex: true }).codexDoor).toEqual([]);
  });

  it("points at the side on screen", () => {
    expect(panelId("claude")).toBe("accounts-panel");
    expect(panelId("codex")).toBe("codex-accounts-panel");
  });
});
