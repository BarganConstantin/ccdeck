import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { JsonInspector, type Json } from "../components/JsonInspector";

function rawText(markup: string) {
  const pre = markup.match(/<pre[^>]*>([\s\S]*?)<\/pre>/)?.[1];
  expect(pre).toBeDefined();
  const entities: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'" };
  return pre!.replace(/<[^>]*>/g, "").replace(/&(?:amp|lt|gt|quot|#x27);/g, entity => entities[entity]);
}

describe("JsonInspector", () => {
  it.each([
    [null, "null", "null"],
    [true, "boolean", "true"],
    [false, "boolean", "false"],
    [0, "number", "0"],
    [-12.5, "number", "-12.5"],
    ["hello", "string", "&quot;hello&quot;"],
    ["", "string", "&quot;&quot;"],
  ] as const)("renders the primitive %j with its syntax class", (value, kind, text) => {
    const markup = renderToStaticMarkup(<JsonInspector value={value} />);
    expect(markup).toContain(`<span class="tr-json-${kind}">${text}</span>`);
    expect(markup).not.toContain("<details");
  });

  it("escapes malicious keys and values in both views and preserves raw data", () => {
    const value = { '<img src=x onerror="alert(1)">': '<script>alert("&lt;")</script>\n"quoted" \\ path', literal: "true null 123" };
    for (const initialMode of ["tree", "raw"] as const) {
      const markup = renderToStaticMarkup(<JsonInspector value={value} initialMode={initialMode} />);
      expect(markup).not.toMatch(/<(?:script|img)\b/);
      expect(markup).toContain("&lt;script&gt;");
      expect(markup).toContain("&lt;img");
      expect(markup).toContain('class="tr-json-key"');
      if (initialMode === "raw") expect(JSON.parse(rawText(markup))).toEqual(value);
    }
  });

  it("expands the root but does not read descendants of closed branches", () => {
    let reads = 0;
    const child: { [key: string]: Json } = {};
    Object.defineProperty(child, "hidden", { enumerable: true, get: () => { reads++; return "nested secret"; } });
    const markup = renderToStaticMarkup(<JsonInspector value={{ child }} />);
    expect(markup.match(/<details[^>]* open=""/g)).toHaveLength(1);
    expect(markup.match(/<details/g)).toHaveLength(2);
    expect(markup).not.toContain("nested secret");
    expect(reads).toBe(0);
  });

  it("reads and renders only the first 50 array entries", () => {
    let reads = 0;
    const value: Json[] = Array.from({ length: 10_000 }, (_, index) => `entry-${index}`);
    for (let index = 0; index < value.length; index++) {
      Object.defineProperty(value, index, { get: () => { reads++; return `entry-${index}`; } });
    }
    const markup = renderToStaticMarkup(<JsonInspector value={value} />);
    expect(reads).toBe(50);
    expect(markup.match(/class="tr-json-string"/g)).toHaveLength(50);
    expect(markup).toContain("entry-49");
    expect(markup).not.toContain("entry-50");
    expect(markup).toContain("Show 50 more (9950 remaining)");
  });

  it("bounds large object rendering and preserves every field in raw mode", () => {
    const value = Object.fromEntries(Array.from({ length: 123 }, (_, index) => [`field-${index}`, index]));
    const tree = renderToStaticMarkup(<JsonInspector value={value} />);
    expect(tree.match(/class="tr-json-number"/g)).toHaveLength(50);
    expect(tree).toContain("field-49");
    expect(tree).not.toContain("field-50");
    expect(tree).toContain("Show 50 more (73 remaining)");
    const raw = renderToStaticMarkup(<JsonInspector value={value} initialMode="raw" />);
    expect(rawText(raw)).toBe(JSON.stringify(value, null, 2));
  });

  it.each([[], {}] as Json[])("renders an empty collection %j without a pagination control", value => {
    const markup = renderToStaticMarkup(<JsonInspector value={value} />);
    expect(markup).toContain(Array.isArray(value) ? "[]" : "{}");
    expect(markup).not.toContain("Show ");
  });

  it("highlights raw JSON keys and every scalar kind without matching inside strings", () => {
    const value = { 'key"\\': ["true null 1e3", -1.25e-7, false, null], unicode: "Здравствуйте 🌍" };
    const markup = renderToStaticMarkup(<JsonInspector value={value} initialMode="raw" />);
    for (const kind of ["key", "string", "number", "boolean", "null"]) expect(markup).toContain(`class="tr-json-${kind}"`);
    expect(markup.match(/class="tr-json-number"/g)).toHaveLength(1);
    expect(rawText(markup)).toBe(JSON.stringify(value, null, 2));
  });

  it("highlights at the 200,000-character boundary, then uses a complete plain pre", () => {
    const atLimit = "x".repeat(199_998);
    const highlighted = renderToStaticMarkup(<JsonInspector value={atLimit} initialMode="raw" />);
    expect(highlighted).toContain('class="tr-json-string"');
    expect(rawText(highlighted)).toBe(JSON.stringify(atLimit));
    const overLimit = `${atLimit}<script>tail</script>`;
    const plain = renderToStaticMarkup(<JsonInspector value={overLimit} initialMode="raw" />);
    expect(plain).not.toContain('class="tr-json-string"');
    expect(plain).not.toContain("<script>");
    expect(rawText(plain)).toBe(JSON.stringify(overLimit));
  });

  it.each(["tree", "raw"] as const)("exposes the selected %s mode through accessible pressed buttons", initialMode => {
    const markup = renderToStaticMarkup(<JsonInspector value={null} initialMode={initialMode} />);
    expect(markup).toContain('role="group" aria-label="JSON view"');
    expect(markup).toContain(`aria-pressed="${initialMode === "tree"}">Tree</button>`);
    expect(markup).toContain(`aria-pressed="${initialMode === "raw"}">Raw JSON</button>`);
  });
});
