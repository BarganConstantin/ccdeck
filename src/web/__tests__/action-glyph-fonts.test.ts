import { readdirSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { RefreshGlyph, ExternalLinkGlyph } from "../components/action-glyphs";

describe("action icons do not depend on a platform's symbol-font fallback", () => {
  it("keeps refresh and external-link artwork sized and hidden from accessible names", () => {
    for (const Icon of [RefreshGlyph, ExternalLinkGlyph]) {
      const html = renderToStaticMarkup(createElement(Icon));
      expect(html).toContain('width="13" height="13"');
      expect(html).toContain('aria-hidden="true"');
      expect(html).toContain('stroke="currentColor"');
      expect(html).not.toMatch(/[↻↗]/);
    }
  });

  it("finds no remaining text reload icons or decorative external-link arrows", () => {
    const dir = new URL("../components/", import.meta.url);
    const offenders: string[] = [];
    for (const file of readdirSync(dir).filter(name => name.endsWith(".tsx"))) {
      const source = ts.createSourceFile(file, readFileSync(new URL(file, dir), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const visit = (node: ts.Node) => {
        if ((ts.isJsxText(node) || ts.isStringLiteral(node)) && /^[↻↺⟳⟲]$/.test(node.text.trim())) {
          offenders.push(`${file}: ${node.text.trim()}`);
        }
        if (ts.isJsxText(node) && node.text.trim() === "↗" && ts.isJsxElement(node.parent)
            && node.parent.openingElement.tagName.getText(source) === "span") {
          offenders.push(`${file}: external-link text icon`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(offenders).toEqual([]);
  });
});
