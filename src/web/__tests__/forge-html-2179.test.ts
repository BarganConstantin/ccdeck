// #2179: the GitHub and GitLab panels draw the forge's own rendered HTML for a
// description, through forge-html.ts's allow-list and ForgeHtml.tsx.
//
// What these pin: only listed elements and attributes survive; anything that
// runs or embeds goes with its content; unknown wrappers are unwrapped, their
// words kept; links keep only web and mail schemes, become absolute against the
// instance and open outside the deck; in-page anchors are dropped; images go
// through the deck's proxy (GitLab's lazy data-src included) or fall back to a
// link; task-list checkboxes are drawn disabled; a title keeps only inline
// marks; and a huge description is cut rather than drawn whole. The suite has
// no DOM, so the parsed document is built here as plain objects — the same
// shape a DOM node offers.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { forgeTree, type ForgeHtmlOptions, type ForgeNode, type NodeLike } from "../forge-html";
import ForgeHtml from "../components/ForgeHtml";

function el(name: string, attrs: Record<string, string> = {}, ...kids: (NodeLike | string)[]): NodeLike {
  return {
    nodeType: 1,
    nodeName: name.toUpperCase(),
    nodeValue: null,
    childNodes: kids.map(k => (typeof k === "string" ? txt(k) : k)),
    getAttribute: (n: string) => (Object.hasOwn(attrs, n) ? attrs[n] : null),
  };
}
function txt(s: string): NodeLike {
  return { nodeType: 3, nodeName: "#text", nodeValue: s, childNodes: [] };
}
const body = (...kids: (NodeLike | string)[]) => el("body", {}, ...kids);

const opts: ForgeHtmlOptions = {
  baseUrl: "https://gitlab.example.com",
  asset: (url: string) => (url.startsWith("https://gitlab.example.com/") ? `/proxy?url=${encodeURIComponent(url)}` : null),
};
const html = (nodes: ForgeNode[]) => renderToStaticMarkup(createElement(ForgeHtml, { nodes }));
const draw = (root: NodeLike, o: Partial<ForgeHtmlOptions> = {}) => html(forgeTree(root, { ...opts, ...o }));

describe("what survives", () => {
  it("keeps structure and emphasis, without classes, ids or styles", () => {
    const out = draw(body(
      el("h2", { id: "new", class: "x" }, "✨ New"),
      el("ul", {}, el("li", { style: "color:red" }, "On ", el("strong", {}, "tablets"), ", two columns")),
      el("pre", {}, el("code", { class: "language-js" }, "let a = 1 < 2;")),
    ));
    expect(out).toBe(
      '<div class="forge-html"><h2>✨ New</h2><ul><li>On <strong>tablets</strong>, two columns</li></ul>'
      + "<pre><code>let a = 1 &lt; 2;</code></pre></div>",
    );
  });

  it("drops what runs or embeds, with its content", () => {
    const out = draw(body(
      el("p", { onclick: "steal()" }, "hi"),
      el("script", {}, "alert(1)"),
      el("style", {}, "body{display:none}"),
      el("iframe", { src: "https://evil.example" }, "x"),
      el("svg", {}, el("a", { href: "https://x" }, "svg link")),
      el("form", {}, el("input", { type: "text", value: "x" })),
    ));
    expect(out).toBe('<div class="forge-html"><p>hi</p></div>');
  });

  it("unwraps an element it does not know, keeping its words", () => {
    const out = draw(body(el("p", {}, el("gl-emoji", { "data-name": "bug" }, "🐛"), " ", el("custom-thing", {}, "Fixed"))));
    expect(out).toBe('<div class="forge-html"><p>🐛 Fixed</p></div>');
  });

  it("keeps only the table attributes that are numbers or an alignment", () => {
    const out = draw(body(el("table", {}, el("tr", {}, el("td", { colspan: "2", align: "right", rowspan: "x" }, "a")))));
    expect(out).toContain('<td style="text-align:right" colSpan="2">a</td>');
    expect(out.toLowerCase()).not.toContain("rowspan");
  });
});

describe("links", () => {
  it("makes GitLab's paths absolute and opens them outside", () => {
    const out = draw(body(el("a", { href: "/group/project/-/merge_requests/5", class: "gfm" }, "!5")));
    expect(out).toContain('<a href="https://gitlab.example.com/group/project/-/merge_requests/5" target="_blank" rel="noreferrer noopener">!5</a>');
  });

  it("keeps a Jira link the forge put on a key", () => {
    const out = draw(body(el("a", { href: "https://jira.example.com/browse/ABC-12", title: "ABC-12" }, "ABC-12")));
    expect(out).toContain('href="https://jira.example.com/browse/ABC-12"');
  });

  it("refuses scripts and data, and drops in-page anchors but keeps their words", () => {
    for (const href of ["javascript:alert(1)", " JaVaScRiPt:alert(1)", "data:text/html,<b>x</b>", "vbscript:x"]) {
      expect(draw(body(el("a", { href }, "click"))), href).toBe('<div class="forge-html">click</div>');
    }
    expect(draw(body(el("h2", {}, el("a", { href: "#heading", class: "anchor" }), "Title"))))
      .toBe('<div class="forge-html"><h2>Title</h2></div>');
  });
});

describe("images", () => {
  it("load through the deck's proxy, inside a link to the original", () => {
    const out = draw(body(el("img", { src: "/uploads/abc/shot.png", alt: "shot", width: "640" })));
    expect(out).toContain('href="https://gitlab.example.com/uploads/abc/shot.png"');
    expect(out).toContain(`src="/proxy?url=${encodeURIComponent("https://gitlab.example.com/uploads/abc/shot.png").replace(/&/g, "&amp;")}"`);
    expect(out).toContain('width="640"');
    expect(out).toContain('referrerPolicy="no-referrer"');
  });

  it("take GitLab's lazy data-src over its placeholder", () => {
    const tree = forgeTree(body(el("img", { src: "data:image/gif;base64,R0lGOD", "data-src": "/uploads/x/a.png", alt: "" })), opts);
    expect(tree).toEqual([{ t: "img", src: expect.stringContaining("/proxy?url="), href: "https://gitlab.example.com/uploads/x/a.png", alt: "", width: null, height: null }]);
  });

  it("become a link when the proxy will not take them", () => {
    const out = draw(body(el("img", { src: "https://elsewhere.example.org/a.png", alt: "diagram" })));
    expect(out).toBe('<div class="forge-html"><a class="fh-image-link" href="https://elsewhere.example.org/a.png" target="_blank" rel="noreferrer noopener">diagram ↗</a></div>');
  });

  it("are dropped when their address is not a web one", () => {
    expect(draw(body(el("img", { src: "javascript:alert(1)" })))).toBe('<div class="forge-html"></div>');
  });
});

describe("task lists, titles and size", () => {
  it("draws a task's checkbox, disabled", () => {
    const out = draw(body(el("ul", {}, el("li", {}, el("input", { type: "checkbox", checked: "", disabled: "" }), " done"))));
    expect(out).toContain('<input type="checkbox" class="fh-check" disabled="" readonly="" checked=""/> done');
  });

  it("keeps only inline marks and links in a title", () => {
    const title = el("body", {}, el("p", {}, "Draft: ", el("a", { href: "https://jira.example.com/browse/ABC-1" }, "ABC-1"), " : cards ", el("img", { src: "/e.png", alt: ":x:" })));
    const tree = forgeTree(title, { ...opts, inline: true });
    expect(html(tree)).toBe('<div class="forge-html">Draft: <a href="https://jira.example.com/browse/ABC-1" target="_blank" rel="noreferrer noopener">ABC-1</a> : cards :x:</div>');
  });

  it("cuts a description past its node budget", () => {
    const many = body(...Array.from({ length: 50 }, (_, i) => el("p", {}, `para ${i}`)));
    const tree = forgeTree(many, { ...opts, maxNodes: 10 });
    expect(tree[tree.length - 1]).toEqual({ t: "text", text: " …" });
    expect(tree.length).toBeLessThan(12);
  });
});
