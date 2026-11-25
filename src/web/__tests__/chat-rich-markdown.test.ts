// What Chat draws from the assistant's Markdown beyond paragraphs and lists:
// links (http, https and mailto only, in a new tab with no opener), italics,
// strikethrough, GitHub tables scrolled sideways, and code blocks with a band
// that names the language and copies the code, coloured by the highlighter.
// Everything here is drawn the way the page first shows it.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ChatMarkdown, { tableCells } from "../components/chat/ChatMarkdown";
import ChatCode, { COPIED_MS } from "../components/chat/ChatCode";
import { chatPlain, parseChatInline, safeHref } from "../components/chat/chat-inline";
import { MAX_HIGHLIGHT_LINES } from "../components/chat/chat-highlight";

const html = (text: string) => renderToStaticMarkup(createElement(ChatMarkdown, { text }));
/** One paragraph's inner markup. */
const para = (text: string) => html(text).replace(/^<div class="chat-markdown"><p>|<\/p><\/div>$/g, "");
const LINK = (href: string, words: string) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${words}</a>`;

describe("a link", () => {
  it("is a link only for http, https and mailto, opened in a new tab with no opener", () => {
    expect(para("[docs](https://example.test/a?b=1&c=2#d)")).toBe(LINK("https://example.test/a?b=1&amp;c=2#d", "docs"));
    expect(para("[site](http://example.test)")).toBe(LINK("http://example.test/", "site"));
    expect(para("[mail](mailto:team@example.test)")).toBe(LINK("mailto:team@example.test", "mail"));
  });

  it.each([
    "javascript:alert(1)", "JavaScript:alert(1)", " javascript:alert(1)", "java\tscript:alert(1)", "data:text/html,<b>x</b>",
    "vbscript:msgbox(1)", "file:///etc/passwd", "/relative/path", "#anchor", "//example.test/x", "ftp://example.test",
  ])("stays the text it was written as for %j", (href) => {
    const markup = html(`[click](${href})`);
    expect(markup).not.toMatch(/<a\b/);
    expect(markup).not.toContain("href=");
    expect(markup).not.toMatch(/<(?:b|script)\b/);
  });

  it("keeps hostile words and addresses as text: no markup, no attribute breaks out", () => {
    const markup = html('[<img src=x onerror=alert(1)>](https://example.test/"onmouseover="alert(1)) and <script>x</script>');
    expect(markup).toContain("&lt;img src=x onerror=alert(1)&gt;</a>");
    expect(markup).toContain('href="https://example.test/%22onmouseover=%22alert(1)"');
    expect(markup).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(markup).not.toMatch(/<(?:img|script)\b/);
  });

  it("links a bare address and one in angle brackets, leaving the sentence's punctuation out", () => {
    expect(para("See https://example.test/docs.")).toBe(`See ${LINK("https://example.test/docs", "https://example.test/docs")}.`);
    expect(para("(at https://example.test/a_(b))")).toBe(`(at ${LINK("https://example.test/a_(b)", "https://example.test/a_(b)")})`);
    expect(para("<https://example.test/x>")).toBe(LINK("https://example.test/x", "https://example.test/x"));
    expect(para("`https://example.test` stays code")).toBe("<code>https://example.test</code> stays code");
  });

  it("is read safely by safeHref alone", () => {
    expect(safeHref("https://example.test")).toBe("https://example.test/");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("not a url")).toBeNull();
  });
});

describe("emphasis", () => {
  it("reads italics, bold, strikethrough and their nesting", () => {
    expect(para("*one* _two_ **three** ~~four~~ ***five***"))
      .toBe("<em>one</em> <em>two</em> <strong>three</strong> <del>four</del> <em><strong>five</strong></em>");
    expect(para("**bold with *italic* inside**")).toBe("<strong>bold with <em>italic</em> inside</strong>");
    expect(para("[**bold** link](https://example.test)")).toBe(LINK("https://example.test/", "<strong>bold</strong> link"));
  });

  it("leaves words with underscores, lone marks and spaced marks alone", () => {
    expect(para("snake_case_name and __init__ files")).toBe("snake_case_name and <strong>init</strong> files");
    expect(para("2 * 3 * 4 and a_b")).toBe("2 * 3 * 4 and a_b");
    expect(para("a * not b ~~ nor this ~~")).toBe("a * not b ~~ nor this ~~");
    expect(para("\\*escaped\\* and \\[not\\](a link)")).toBe("*escaped* and [not](a link)");
  });

  it("stays fast on a line of lone marks, brackets and half links", () => {
    for (const hostile of ["*".repeat(20000), "_a".repeat(10000), "[".repeat(20000), "[a](".repeat(5000), "~~x".repeat(7000), "`".repeat(9999), "<http".repeat(4000)]) {
      const start = performance.now();
      const nodes = parseChatInline(hostile);
      expect(performance.now() - start, hostile.slice(0, 8)).toBeLessThan(250);
      expect(chatPlain(nodes).length).toBeGreaterThan(0);
    }
  });
});

describe("a table", () => {
  const TABLE = [
    "| File | Lines | Note |", "| :--- | ---: | :---: |", "| `a.ts` | 12 | **new** |", "| b\\|c.ts | 3 |", "", "After.",
  ].join("\n");

  it("is a table inside a focusable, named region that scrolls sideways", () => {
    const markup = html(TABLE);
    expect(markup).toContain('<div class="chat-table-wrap" role="region" aria-label="Table" tabindex="0"><table class="chat-table">');
    expect(markup).toContain('<thead><tr><th data-align="left">File</th><th data-align="right">Lines</th><th data-align="center">Note</th></tr></thead>');
    expect(markup).toContain('<tr><td data-align="left"><code>a.ts</code></td><td data-align="right">12</td><td data-align="center"><strong>new</strong></td></tr>');
    // An escaped pipe stays in its cell; a short row is filled out with an empty cell.
    expect(markup).toContain('<tr><td data-align="left">b|c.ts</td><td data-align="right">3</td><td data-align="center"></td></tr>');
    expect(markup).toContain("</table></div><p>After.</p>");
  });

  it("splits cells outside code spans and escapes only", () => {
    expect(tableCells("| a | `x | y` | b \\| c |")).toEqual(["a", "`x | y`", "b \\| c"]);
    expect(tableCells("a | b")).toEqual(["a", "b"]);
  });

  it("needs its rule line: a pipe in prose is prose", () => {
    expect(html("a | b\nc | d")).toBe('<div class="chat-markdown"><p>a | b<br/>c | d</p></div>');
    expect(html("| a | b |\n| --- |")).not.toContain("<table");
  });

  it("draws a rule line on its own as a rule", () => {
    expect(html("Above\n\n---\n\nBelow")).toBe('<div class="chat-markdown"><p>Above</p><hr/><p>Below</p></div>');
  });
});

describe("a code block", () => {
  const block = (code: string, language?: string) => renderToStaticMarkup(createElement(ChatCode, { code, language }));

  it("wears a band with its language and a Copy button a screen reader hears", () => {
    const markup = block("const a = 1;\n", "ts");
    expect(markup).toMatch(/^<div class="chat-code" data-language="js"><div class="chat-code-head"><span class="chat-code-lang">ts<\/span>/);
    expect(markup).toContain('<button type="button" class="chat-code-copy" aria-label="Copy code" title="Copy code">');
    expect(markup).toContain('<span class="chat-copy-word" aria-hidden="true">Copy</span>');
    expect(markup).toContain('<span class="chat-sr" role="status" aria-live="polite"></span>');
    expect(markup).not.toContain("data-copied");
    expect(COPIED_MS).toBe(1500);
  });

  it("colours the code by kind, keeping every character", () => {
    const markup = block('const a = "x"; // note\n', "ts");
    expect(markup).toContain('<code data-language="ts"><span class="hl-kw">const</span> a = <span class="hl-str">&quot;x&quot;</span>; <span class="hl-com">// note</span>\n</code>');
    expect(block("x = 1", "unknown-lang")).toContain('<code data-language="unknown-lang">x = 1</code>');
    expect(block("x = 1")).toContain("<code>x = 1</code>");
  });

  it("is drawn plain past the highlighter's cap, and has no Copy when empty", () => {
    const long = "let a = 1;\n".repeat(MAX_HIGHLIGHT_LINES + 1);
    expect(block(long, "js")).not.toContain("hl-");
    expect(block("", "js")).not.toContain("<button");
    expect(block("  \n", "js")).not.toContain("<button");
  });

  it("is what a fence in a message becomes", () => {
    const markup = html("Run:\n\n```sh\nnpm test # all\n```");
    expect(markup).toContain('<div class="chat-code" data-language="sh">');
    expect(markup).toContain('<span class="hl-com"># all</span>');
  });
});
