import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ChatMarkdown from "../components/chat/ChatMarkdown";

const html = (text: string) => renderToStaticMarkup(createElement(ChatMarkdown, { text }));

describe("Chat Markdown", () => {
  it("renders a transcript as paragraphs, headings, lists, a quote and literal code", () => {
    const text = [
      "# Rate limiter", "", "Added **per-client limits** to `GET /api`.",
      "Existing routes still work.", "", "## Changes", "- Validate the client",
      "- Return `429` when full", "", "### Verification", "1. Run tests",
      "2. Check headers", "", "> **Ready** for review.", "", "#### Example",
      "```ts", "function limit() {", "  return `**unchanged**`;", "}", "```",
      "", "All done.",
    ].join("\n");
    expect(html(text)).toBe('<div class="chat-markdown"><h2>Rate limiter</h2>'
      + '<p>Added <strong>per-client limits</strong> to <code>GET /api</code>.<br/>Existing routes still work.</p>'
      + '<h2>Changes</h2><ul><li>Validate the client</li><li>Return <code>429</code> when full</li></ul>'
      + '<h3>Verification</h3><ol><li>Run tests</li><li>Check headers</li></ol>'
      + '<blockquote><p><strong>Ready</strong> for review.</p></blockquote><h4>Example</h4>'
      + '<pre><code data-language="ts">function limit() {\n  return `**unchanged**`;\n}\n</code></pre>'
      + '<p>All done.</p></div>');
  });

  it("preserves code indentation, blank lines, tabs, trailing spaces and newlines", () => {
    expect(html("Before\r\n\r\n```\r\n  first  \r\n\r\n\tlast\r\n```\r\nAfter"))
      .toBe('<div class="chat-markdown"><p>Before</p><pre><code>  first  \n\n\tlast\n</code></pre><p>After</p></div>');
  });

  it.each(["", "\n"])("keeps an unclosed streaming fence with final newline %j", (ending) => {
    expect(html("Intro\n\n```js\n  const partial = `<tag>`;\n\n# still code" + ending))
      .toBe('<div class="chat-markdown"><p>Intro</p><pre><code data-language="js">  const partial = `&lt;tag&gt;`;\n\n# still code'
        + ending + '</code></pre></div>');
  });

  it("requires the matching fence character and at least the opening length", () => {
    expect(html("````text\n```\n~~~\n`````\nAfter"))
      .toBe('<div class="chat-markdown"><pre><code data-language="text">```\n~~~\n</code></pre><p>After</p></div>');
    expect(html("~~~\n  plain\n~~~"))
      .toBe('<div class="chat-markdown"><pre><code>  plain\n</code></pre></div>');
    expect(html("```")).toBe('<div class="chat-markdown"><pre><code></code></pre></div>');
  });

  it("normalizes headings to h2–h4 and preserves ordered starts and wrapped list text", () => {
    expect(html("# One\n## Two\n### Three\n#### Four\n##### Five\n###### Six\n\n3. Third\n   more text\n4. Fourth"))
      .toBe('<div class="chat-markdown"><h2>One</h2><h2>Two</h2><h3>Three</h3><h4>Four</h4><h4>Five</h4><h4>Six</h4>'
        + '<ol start="3"><li>Third<br/>more text</li><li>Fourth</li></ol></div>');
  });

  it("preserves blockquote paragraphs and prose with unfinished inline delimiters", () => {
    expect(html("> First\n> next\n>\n> **Second**\n\nWaiting **for `more"))
      .toBe('<div class="chat-markdown"><blockquote><p>First<br/>next</p><p><strong>Second</strong></p></blockquote>'
        + '<p>Waiting **for `more</p></div>');
  });

  it("keeps a heading's literal hash while removing optional closing markers", () => {
    expect(html("## C#\n## **Results** ##"))
      .toBe('<div class="chat-markdown"><h2>C#</h2><h2><strong>Results</strong></h2></div>');
  });

  it("escapes hostile tags and fence metadata; links stay literal for every protocol", () => {
    const rendered = html('<img src=x onerror=alert(1)>\n\n**<script>alert(1)</script>**\n\n'
      + '[bad](javascript:alert(1)) [data](data:text/html,test) [good](https://example.test)\n\n'
      + '```"><svg/onload=alert(1)>\n</code><script>alert(1)</script>\n```');
    expect(rendered).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(rendered).toContain('<strong>&lt;script&gt;alert(1)&lt;/script&gt;</strong>');
    expect(rendered).toContain('[bad](javascript:alert(1)) [data](data:text/html,test) [good](https://example.test)');
    expect(rendered).toContain('data-language="&quot;&gt;&lt;svg/onload=alert(1)&gt;"');
    expect(rendered).toContain('&lt;/code&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(rendered).not.toMatch(/<(?:script|img|svg|a)\b/i);
  });

  it("renders an empty transcript without an invented paragraph", () => {
    expect(html("\n \t\n")).toBe('<div class="chat-markdown"></div>');
  });
});
