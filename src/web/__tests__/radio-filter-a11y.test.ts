import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RadioFilterOptions } from "../components/RadioFilter";

describe("radio filter result semantics", () => {
  it("announces empty matches without an invalid optionless listbox", () => {
    const html = renderToStaticMarkup(createElement(RadioFilterOptions, {
      label: "Country", value: "", options: [], onSelect: () => {},
    }));
    expect(html).toContain('role="status">No matches');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="listbox"');
    expect(html).not.toContain('aria-controls=');
    expect(html).not.toContain('aria-activedescendant=');
  });

  it("connects a nonempty combobox to its listbox and active option", () => {
    const html = renderToStaticMarkup(createElement(RadioFilterOptions, {
      label: "Country", value: "FR", options: [{ value: "FR", label: "France" }], onSelect: () => {},
    }));
    const listId = html.match(/id="([^"]+)" class="radio-filter-options" role="listbox"/)?.[1];
    const optionId = html.match(/role="option" tabindex="-1" id="([^"]+)"/)?.[1];
    expect(listId).toBeTruthy();
    expect(optionId).toBeTruthy();
    expect(html).toContain(`aria-controls="${listId}"`);
    expect(html).toContain(`aria-activedescendant="${optionId}"`);
    expect(html).toContain('aria-expanded="true"');
  });
});
