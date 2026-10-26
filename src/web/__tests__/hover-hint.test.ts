import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import HoverHint, { hintDescription } from "../components/HoverHint";
import AccountHint from "../components/AccountHint";

describe("hover hint descriptions", () => {
  it("keeps instructions and other descriptions while exposing a visible hint", () => {
    expect(hintDescription("row-instructions row-context", "row-hint", true))
      .toBe("row-instructions row-context row-hint");
    expect(hintDescription("row-instructions row-hint", "row-hint", true))
      .toBe("row-instructions row-hint");
  });

  it("does not reference an absent hint or erase the child's descriptions", () => {
    expect(hintDescription("row-instructions", "row-hint", false)).toBe("row-instructions");
    expect(hintDescription(undefined, "row-hint", false)).toBeUndefined();
    expect(hintDescription(undefined, "row-hint", true)).toBe("row-hint");
  });

  it("gives unnamed siblings distinct anchor IDs without adding tab stops to a roving row", () => {
    const markup = renderToStaticMarkup(createElement("div", null,
      ...["First", "Second"].map(label => createElement(HoverHint, {
        key: label, detail: label, className: "row-preview",
        children: createElement("button", { tabIndex: -1, "aria-describedby": "instructions" }, label),
      })),
    ));
    const ids = [...markup.matchAll(/ id="([^"]+)"/g)].map(match => match[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(markup.match(/aria-describedby="instructions"/g)).toHaveLength(2);
    expect(markup.match(/tabindex="-1"/g)).toHaveLength(2);
    expect(markup).not.toContain('role="tooltip"');
  });

  it("preserves an account control's existing identity and description", () => {
    const markup = renderToStaticMarkup(createElement(AccountHint, {
      detail: "Account explanation",
      children: createElement("button", { id: "account-control", "aria-describedby": "account-context" }, "Account"),
    }));
    expect(markup).toContain('id="account-control"');
    expect(markup).toContain('aria-describedby="account-context"');
    expect(markup).not.toContain("undefined-hint");
  });
});
