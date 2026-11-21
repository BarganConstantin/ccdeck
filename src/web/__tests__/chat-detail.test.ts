// Chat shows what happened: the task list (only the conversation's last one
// whole), a failed call and an edit's change behind the row's own button, a
// notice where you interrupted or the API failed, and a sub-agent's line.
// Drawn here as the page first shows them; opening a row is
// chat-detail-toggle.test.ts.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ChatView, { lastTodoAt, tailKey } from "../components/chat/ChatView";
import { AgentLine, DiffBlock, diffOp, NoticeLine, ToolGroup, ToolRow } from "../components/chat/ChatTurn";
import type { ChatSource, ChatTodo, ChatTurn } from "../components/chat/chat-model";
import { words } from "./screens-fixtures";

type Tool = Extract<ChatTurn, { kind: "tool" }>;

const html = (turns: ChatTurn[]) => renderToStaticMarkup(createElement(ChatView, { source: { state: "ready", turns } satisfies ChatSource }));
const todo = (...statuses: ChatTodo["status"][]): ChatTurn => ({
  kind: "todo",
  items: statuses.map((status, i) => ({ text: ["Read the routes", "Add the limiter", "Write the tests"][i] ?? `Task ${i}`, status })),
});
const checklists = (markup: string) => markup.match(/<section class="chat-todo"[^>]*>[\s\S]*?<\/section>/g) ?? [];
/** Each group of calls, out to its own closing tag: the rows inside are disclosures too. */
function groups(markup: string): string[] {
  const out: string[] = [];
  const tag = /<details\b|<\/details>/g;
  let start = markup.indexOf('<details class="chat-activity"');
  while (start >= 0) {
    tag.lastIndex = start;
    let depth = 0;
    let end = markup.length;
    for (let m = tag.exec(markup); m; m = tag.exec(markup)) {
      depth += m[0] === "</details>" ? -1 : 1;
      if (depth === 0) { end = tag.lastIndex; break; }
    }
    out.push(markup.slice(start, end));
    start = markup.indexOf('<details class="chat-activity"', end);
  }
  return out;
}
const EDIT: Tool = { kind: "tool", name: "Edit", arg: "src/limit.ts", note: "+2 −1", diff: { lines: [" keep", "-old", "+new", "+more"] } };
const FAILED: Tool = { kind: "tool", name: "Bash", arg: "npm test", error: "Error: 3 tests failed" };

describe("the task list", () => {
  const turns: ChatTurn[] = [
    { kind: "user", text: "Add rate limits" },
    { kind: "assistant", text: "On it." },
    todo("pending", "pending", "pending"),
    { kind: "tool", name: "Read", arg: "src/routes.ts" },
    EDIT,
    todo("done", "active", "pending"),
    { kind: "assistant", text: "Halfway." },
    todo("done", "done", "active"),
  ];

  it("is the conversation's last todo turn, decided here", () => {
    expect(lastTodoAt(turns)).toBe(7);
    expect(lastTodoAt(turns.slice(0, 7))).toBe(5);
    expect(lastTodoAt([{ kind: "user", text: "x" }])).toBe(-1);
    expect(lastTodoAt([])).toBe(-1);
  });

  it("draws only the last list as a checklist: done muted, active picked out, pending plain", () => {
    const markup = html(turns);
    const lists = checklists(markup);
    expect(lists).toHaveLength(1);
    const [list] = lists;
    expect(list).toContain('aria-label="Tasks · 2 of 3 done"');
    expect(words(list)).toContain("Tasks · 2 of 3 done");
    expect([...list.matchAll(/data-status="(\w+)"/g)].map(m => m[1])).toEqual(["done", "done", "active"]);
    // Each state is said in words for a screen reader, beside its mark.
    expect([...list.matchAll(/<span class="chat-sr">([^<]*)<\/span>/g)].map(m => m[1])).toEqual(["Done", "Done", "In progress"]);
    expect(words(list)).toContain("Write the tests");
  });

  it("folds each earlier list into the tool calls as one muted line", () => {
    const markup = html(turns);
    const [group] = groups(markup);
    expect(words(group)).toContain("4 tool calls");
    expect(words(group)).toContain("Tasks updated · 0 of 3 done");
    expect(words(group)).toContain("Tasks updated · 1 of 3 done");
    expect(group.match(/class="chat-tool chat-todo-line"/g)).toHaveLength(2);
    expect(group).not.toContain("chat-todo-item");
  });

  it("is the last one of the whole conversation, not of each response", () => {
    const markup = html([
      { kind: "user", text: "first" }, todo("active", "pending"), { kind: "assistant", text: "Started." },
      { kind: "user", text: "second" }, { kind: "assistant", text: "Going on." }, todo("done", "active"),
    ]);
    expect(checklists(markup)).toHaveLength(1);
    expect(words(checklists(markup)[0])).toContain("Tasks · 1 of 2 done");
    // The earlier one sat with no call beside it: a line of its own, not a disclosure of one.
    expect(groups(markup)).toHaveLength(0);
    expect(words(markup)).toContain("Tasks updated · 0 of 2 done");
  });

  it("an emptied list says so in one line", () => {
    const markup = html([todo("done"), { kind: "todo", items: [] }]);
    expect(checklists(markup)).toHaveLength(0);
    expect(words(markup)).toContain("Task list cleared");
    expect(words(markup)).toContain("Tasks updated · 1 of 1 done");
  });
});

describe("a failed call", () => {
  it("says Failed on its row, quietly, with a button that opens the error", () => {
    const markup = renderToStaticMarkup(createElement(ToolRow, { turn: FAILED }));
    expect(markup).toMatch(/^<div class="chat-tool-call"><button type="button" class="chat-tool chat-tool-toggle" aria-expanded="false">/);
    expect(markup).toContain('<span class="chat-tool-failed">Failed</span>');
    // Closed: the error is not drawn, and the button controls nothing yet.
    expect(markup).not.toContain("chat-tool-error");
    expect(markup).not.toContain("aria-controls");
    expect(words(markup)).not.toContain("3 tests failed");
  });

  it("with nothing said, keeps the plain row and its Failed note", () => {
    const markup = renderToStaticMarkup(createElement(ToolRow, { turn: { ...FAILED, error: "" } }));
    expect(markup).toMatch(/^<details class="chat-tool-call">/);
    expect(markup).not.toContain("<button");
    expect(markup).toContain('<span class="chat-tool-failed">Failed</span>');
  });

  it("declined, says so quietly on a plain row, with no error to open and no failure counted", () => {
    const declined: Tool = { kind: "tool", name: "Bash", arg: "rm -rf build", declined: true };
    const markup = renderToStaticMarkup(createElement(ToolRow, { turn: declined }));
    expect(markup).toMatch(/^<details class="chat-tool-call">/);
    expect(markup).not.toContain("<button");
    expect(markup).toContain('<span class="chat-tool-declined">Declined</span>');
    expect(markup).not.toContain("chat-tool-failed");
    const group = renderToStaticMarkup(createElement(ToolGroup, { turns: [declined, EDIT] }));
    expect(group).not.toContain("chat-activity-failed");
  });

  it("is counted on the head of its group, so it shows while the group is closed", () => {
    const one = renderToStaticMarkup(createElement(ToolGroup, { turns: [{ kind: "tool", name: "Read", arg: "a.ts" }, FAILED, EDIT] }));
    expect(one).toMatch(/^<details class="chat-activity">/);
    expect(words(one)).toContain("3 tool calls 1 failed");
    expect(one).toContain('<span class="chat-activity-failed">1 failed</span>');
    const none = renderToStaticMarkup(createElement(ToolGroup, { turns: [EDIT] }));
    expect(none).not.toContain("chat-activity-failed");
  });
});

describe("an edit's change", () => {
  it("counts its lines in the row's note and stays closed", () => {
    const markup = renderToStaticMarkup(createElement(ToolRow, { turn: EDIT }));
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('<span class="chat-tool-note">+2 −1</span>');
    expect(markup).toContain('<span class="chat-tool-arg" title="src/limit.ts">src/limit.ts</span>');
    expect(markup).not.toContain("chat-diff");
    expect(markup).not.toContain("chat-tool-failed");
  });

  it("draws one line per diff line, each marked added, removed, kept or the gap between hunks", () => {
    const markup = renderToStaticMarkup(createElement(DiffBlock, { diff: { lines: [" keep", "-old", "+new", "…", " far"] } }));
    expect(markup).toMatch(/^<pre class="chat-diff"><code>/);
    expect([...markup.matchAll(/data-op="(\w+)">([^<]*)</g)].map(m => [m[1], m[2]])).toEqual([
      ["ctx", " keep"], ["del", "-old"], ["add", "+new"], ["gap", "…"], ["ctx", " far"],
    ]);
    expect(markup).not.toContain("chat-diff-cut");
  });

  it("says when the change was longer than the transcript keeps", () => {
    const markup = renderToStaticMarkup(createElement(DiffBlock, { diff: { lines: ["+a"], cut: true } }));
    expect(words(markup)).toContain("The change is longer than shown here.");
  });

  it("reads a line's way from its first character", () => {
    expect(["+x", "-x", " x", "x", "…", "", "+"].map(diffOp)).toEqual(["add", "del", "ctx", "ctx", "gap", "ctx", "add"]);
  });
});

describe("a notice", () => {
  it("an interruption is one muted line", () => {
    const markup = html([{ kind: "user", text: "fix it" }, { kind: "assistant", text: "Looking." }, { kind: "notice", what: "interrupted" }]);
    expect(markup).toContain('<p class="chat-notice" data-what="interrupted">Interrupted</p>');
    // It closes the response it cut short.
    expect(markup.match(/class="chat-response"/g)).toHaveLength(1);
  });

  it("an API error is its own line, in the warning colour's slot", () => {
    expect(renderToStaticMarkup(createElement(NoticeLine, { turn: { kind: "notice", what: "error", text: "API Error: 529 Overloaded" } })))
      .toBe('<p class="chat-notice" data-what="error">API Error: 529 Overloaded</p>');
    expect(renderToStaticMarkup(createElement(NoticeLine, { turn: { kind: "notice", what: "error" } })))
      .toBe('<p class="chat-notice" data-what="error">The request to the API failed.</p>');
  });
});

describe("a sub-agent", () => {
  const agent = (extra: Partial<Extract<ChatTurn, { kind: "agent" }>> = {}) =>
    renderToStaticMarkup(createElement(AgentLine, { turn: { kind: "agent", type: "Explore", description: "Find the auth code", ...extra } }));

  it("is one line with its type, what it was asked, and its state", () => {
    const running = agent({ running: true });
    expect(running).toMatch(/^<div class="chat-tool chat-agent" data-state="running">/);
    expect(words(running)).toContain("Sub-agent · Explore — Find the auth code Running");
    expect(words(agent())).toContain("Sub-agent · Explore — Find the auth code Done");
    expect(agent()).toContain('data-state="done"');
    expect(words(agent({ failed: true }))).toContain("Failed");
    expect(agent({ failed: true })).toContain('data-state="failed"');
  });

  it("declined is Declined, and one started in the background says so instead of Done", () => {
    expect(words(agent({ declined: true }))).toContain("— Find the auth code Declined");
    expect(agent({ declined: true })).toContain('data-state="declined"');
    expect(words(agent({ background: true }))).toContain("— Find the auth code In background");
    expect(agent({ background: true })).toContain('data-state="background"');
    expect(words(agent({ background: true }))).not.toContain("Done");
  });

  it("with no type or description, says Sub-agent alone", () => {
    const markup = agent({ type: "", description: "" });
    expect(words(markup).trim()).toBe("Sub-agent Done");
    expect(markup).not.toContain("chat-agent-desc");
  });

  it("is drawn in the conversation, outside any group of calls", () => {
    const markup = html([{ kind: "tool", name: "Read", arg: "a.ts" }, { kind: "agent", type: "Explore", description: "Find it", running: true }]);
    const [group] = groups(markup);
    expect(group).not.toContain("chat-agent");
    expect(markup).toContain('class="chat-tool chat-agent"');
  });
});

describe("the view follows the new lines as they change", () => {
  it("a task list, a sub-agent, a notice and a failed call each change the tail key", () => {
    expect(tailKey(todo("active", "pending"))).not.toBe(tailKey(todo("done", "active")));
    const agent: ChatTurn = { kind: "agent", type: "Explore", description: "d", running: true };
    expect(tailKey(agent)).not.toBe(tailKey({ ...agent, running: undefined }));
    expect(tailKey({ ...agent, running: undefined })).not.toBe(tailKey({ ...agent, running: undefined, failed: true }));
    expect(tailKey({ kind: "notice", what: "interrupted" })).not.toBe(tailKey({ kind: "notice", what: "error", text: "API Error" }));
    expect(tailKey({ kind: "tool", name: "Bash", arg: "x" })).not.toBe(tailKey({ kind: "tool", name: "Bash", arg: "x", error: "" }));
    expect(tailKey({ kind: "tool", name: "Bash", arg: "x" })).not.toBe(tailKey({ kind: "tool", name: "Bash", arg: "x", declined: true }));
    expect(tailKey({ ...agent, running: undefined })).not.toBe(tailKey({ ...agent, running: undefined, declined: true }));
    expect(tailKey({ ...agent, running: undefined })).not.toBe(tailKey({ ...agent, running: undefined, background: true }));
  });
});
