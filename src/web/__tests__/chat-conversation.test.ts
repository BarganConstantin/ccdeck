import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ChatView from "../components/chat/ChatView";
import { conversationBlocks, type ChatTurn } from "../components/chat/chat-model";

const turns: ChatTurn[] = [
  { kind: "user", text: "Check the layout\nand keep the shortcuts." },
  { kind: "assistant", text: "## Changes\n\nKeep **keyboard focus** visible." },
  { kind: "tool", name: "Read", arg: "src/layout.tsx" },
  { kind: "tool", name: "Bash", arg: "npm test -- layout", running: true },
  { kind: "assistant", text: "The checks are running." },
  { kind: "record", text: "Earlier turns are not shown." },
  { kind: "user", text: "Check the narrow split too." },
  { kind: "assistant", text: "Checking the narrow split." },
];
const render = (items = turns) => renderToStaticMarkup(createElement(ChatView, { source: { state: "ready", turns: items } }));

describe("conversation reading", () => {
  it("groups assistant prose and calls without crossing a user message or a transcript record", () => {
    const blocks = conversationBlocks(turns);
    expect(blocks.map(b => b.kind)).toEqual(["user", "assistant", "record", "user", "assistant"]);
    const reconstructed = blocks.flatMap(b => b.kind === "assistant" ? b.turns : [{ kind: b.kind, text: b.text }]);
    expect(reconstructed).toEqual(turns);
    expect(turns).toHaveLength(8);
  });

  it("identifies the author once per response and renders prose as structured text", () => {
    const html = render();
    expect(html.match(/class="chat-response"/g)).toHaveLength(2);
    expect(html.match(/class="chat-response-author"/g)).toHaveLength(2);
    expect(html.match(/class="chat-you"/g)).toHaveLength(2);
    expect(html).toContain("<h2>Changes</h2>");
    expect(html).toContain("<strong>keyboard focus</strong>");
    expect(html).toContain("Check the layout\nand keep the shortcuts.");
  });

  it("puts actual calls behind native disclosures and retains their arguments", () => {
    const html = render();
    expect(html).toContain('<details class="chat-activity" open="">');
    expect(html).toContain("2 tool calls");
    expect(html.match(/<details class="chat-tool-call">/g)).toHaveLength(2);
    expect(html).toContain('<pre class="chat-tool-input"><code>npm test -- layout</code></pre>');
    expect(html).toContain("Running");
    expect(html).not.toContain("Tests passed");
  });

  it("collapses completed activity without presenting it as a successful result", () => {
    const html = render([{ kind: "tool", name: "Read", arg: "src/layout.tsx" }]);
    expect(html).toContain('<details class="chat-activity">');
    expect(html).toContain("1 tool call");
    expect(html).not.toContain("Running");
    expect(html).not.toContain("Passed");
  });

  it("gives an empty readable transcript an honest empty state", () => {
    expect(render([])).toContain("No messages yet.");
    expect(render([])).not.toContain("chat-response-author");
  });
});
