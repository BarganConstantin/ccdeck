// The pane's ⋯ on a phone: named like the dock's More, opened from either end
// with the arrows, a row hands focus back to it before the menu closes, and the
// menu shows the part of a label before " — ". Close keeps its whole label.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CLOSE_LABEL_MSG, FULL_LABEL_MSG, menuLabel } from "../components/terminal/StageHeader";
import { en } from "../i18n/en";

// CHANGED ON PURPOSE (the UI in every language): both labels are read through
// their keys now, and the English catalog holds the words.
const CLOSE_LABEL = en[CLOSE_LABEL_MSG];
const FULL_LABEL = en[FULL_LABEL_MSG];

const header = readFileSync(fileURLToPath(new URL("../components/terminal/StageHeader.tsx", import.meta.url)), "utf8");

describe("the labels in the ⋯ menu", () => {
  it("full screen shows the words before the shortcut hint, which stays on the desktop button's tooltip", () => {
    expect(FULL_LABEL).toContain(" — ");
    expect(menuLabel({ id: "expand", label: FULL_LABEL })).toBe("Full screen");
    // CHANGED ON PURPOSE (the UI in every language): the short label has a key of its own,
    // so a language may word it apart from the long one.
    expect(en["board.stage.fullScreenShort"]).toBe("Full screen");
    expect(header).toContain("title={expandLabel}");
  });

  it("close keeps its whole label: it says the session is not stopped", () => {
    expect(menuLabel({ id: "close", label: CLOSE_LABEL })).toBe(CLOSE_LABEL);
    expect(CLOSE_LABEL).toContain("the session keeps running");
  });

  it("a label with no dash is shown as it is", () => {
    expect(menuLabel({ id: "keys", label: "Type into the session" })).toBe("Type into the session");
    expect(menuLabel({ id: "expand", label: "Give the Command Panel the width" })).toBe("Give the Command Panel the width");
  });
});

describe("the ⋯ button", () => {
  it("is named by the existing key, as the dock's More is, for both the name and the tooltip", () => {
    expect(en["board.rail.more"]).toBe("More");
    expect(header).toContain('const more = t("board.rail.more");');
    expect(header).toContain("aria-label={more}");
    expect(header).toContain("title={more}");
    expect(header).not.toContain('aria-label="More"');
  });

  it("opens at the last row on ArrowUp and the first on ArrowDown", () => {
    expect(header).toContain('setMenu(e.key === "ArrowUp" ? "last" : "first")');
    expect(header).toContain("start={menu}");
  });

  it("hands focus to the ⋯ before the menu closes, so what the row does gives it back there", () => {
    const pick = header.slice(header.indexOf('role="menuitem"'));
    expect(pick.indexOf("document.getElementById(PANE_MORE_ID)?.focus();")).toBeGreaterThan(-1);
    expect(pick.indexOf("document.getElementById(PANE_MORE_ID)?.focus();")).toBeLessThan(pick.indexOf("setMenu(null);"));
  });
});
