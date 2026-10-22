// Settings › Integrations' connect form (#2178): each field is named by its
// label alone — the hint used to sit inside the label and became part of the
// field's name, so "Jira URL" was read with the whole hint after it — and a
// refusal that names a field is said under that field and takes focus there,
// rather than at the foot of the form, out of sight on a phone.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import IntegrationConnectionForm from "../components/IntegrationConnectionForm";
import { IntegrationFailure } from "../integrations/client";
import { integrationDef } from "../integrations/registry";

const web = fileURLToPath(new URL("../", import.meta.url));
const source = readFileSync(`${web}components/IntegrationConnectionForm.tsx`, "utf8").replace(/^\s*\/\/.*$/gm, "");
const jira = integrationDef("jira")!;
const form = (error: IntegrationFailure | null) => renderToStaticMarkup(createElement(IntegrationConnectionForm, {
  def: jira, busy: false, error, onSubmit: () => {}, onCancel: () => {},
}));
/** The <label for=…> of an input, and the input itself. */
const field = (html: string, label: string) => {
  const lab = new RegExp(`<label class="fb-field-label" for="([^"]+)">${label} ?(?:<span[^>]*>[^<]*</span>)?</label>`).exec(html);
  expect(lab, `a label reading only "${label}"`).not.toBeNull();
  const id = lab![1];
  const input = new RegExp(`<input id="${id}"[^>]*>`).exec(html)?.[0] ?? "";
  return { id, input, block: new RegExp(`<div class="fb-field">((?:(?!<div class="fb-field">)[\\s\\S])*?for="${id}"[\\s\\S]*?)</div>`).exec(html)?.[1] ?? "" };
};
const describedBy = (html: string, input: string) => (/aria-describedby="([^"]+)"/.exec(input)?.[1] ?? "").split(" ")
  .map(id => new RegExp(`id="${id}"[^>]*>([^<]*)`).exec(html)?.[1] ?? `missing ${id}`);

describe("the connect form's fields", () => {
  it("names each field by its label alone, and gives its hint as the description", () => {
    const html = form(null);
    expect(html).not.toMatch(/<label class="fb-field">/);
    const url = field(html, "Jira URL");
    expect(url.input).toMatch(/type="url"/);
    expect(describedBy(html, url.input)).toEqual([expect.stringMatching(/^The address you open Jira at/)]);
    const token = field(html, "Personal access token");
    expect(token.input).toMatch(/type="password"/);
    expect(token.input).toMatch(/value=""/);
    field(html, "Name");
  });

  it("says a refusal that names a field under that field, invalid and described by it", () => {
    const html = form(new IntegrationFailure("invalid", "Enter your Jira URL.", { field: "baseUrl" }));
    const url = field(html, "Jira URL");
    expect(url.input).toMatch(/aria-invalid="true"/);
    expect(describedBy(html, url.input)[1]).toBe("Enter your Jira URL.");
    expect(url.block).toMatch(/<span class="ig-form-error" id="[^"]+" role="alert">Enter your Jira URL\.<\/span>/);
    // Said once: not again above the actions.
    expect(html.match(/ig-form-error/g)).toHaveLength(1);
  });

  it("says one that names no field above Cancel and Connect, with what the provider said", () => {
    const html = form(new IntegrationFailure("unreachable", "The deck could not reach Jira.", { detail: "connect ECONNREFUSED" }));
    expect(html).toMatch(/<p class="ig-form-error" id="[^"]+" role="alert">The deck could not reach Jira\.<span class="ig-form-detail"> Jira said: connect ECONNREFUSED<\/span><\/p><div class="ig-form-actions">/);
    expect(html).not.toMatch(/aria-invalid/);
  });

  it("moves focus to the field a refusal names, each time one comes back", () => {
    expect(source).toMatch(/useEffect\(\(\) => \{\s*if \(errorField\) inputs\.current\.get\(errorField\)\?\.focus\(\);\s*\}, \[error, errorField\]\);/);
  });
});
