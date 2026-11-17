// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RailRow, type RailRowProps } from "../components/RailParts";
import SessionList, { buildRows, type Row } from "../components/SessionList";
import StageHeader, { type StageHeaderProps } from "../components/terminal/StageHeader";
import { ToolRow } from "../components/chat/ChatTurn";
import { FileGlyph, SearchGlyph, ToolTerminalGlyph } from "../components/chat/chat-icons";
import type { ChatTurn } from "../components/chat/chat-model";
import { applyEvent, initialState, type GraphState } from "../reducer";
import type { HookPayload } from "../types";
import { resetSessionsSeen } from "../session-seen";
import { setLanguage } from "../i18n";
import type { PaneLink } from "../workspace-split";

const NOW = new Date(2026, 10, 17, 15, 0, 30).getTime();
const TASK = "Repair keyboard navigation in the workspace";
const noop = () => {};
const row = (over: Partial<Row> = {}): Row => ({
  sessionId: "session-a", label: "Workspace navigation", folder: "web-api",
  task: TASK, state: "active", toolCount: 2, cost: 0,
  startedAt: NOW - 60_000, lastActivity: NOW - 1_000,
  plan: null, planTitle: "", ...over,
});
const drawRow = (over: Partial<RailRowProps> = {}) => renderToStaticMarkup(createElement(RailRow, {
  row: row(), group: 2, now: NOW, compact: true,
  selected: false, removed: false, leaving: false, landNonce: null,
  onSelect: noop, ...over,
}));

// Exclude tooltips and screen-reader-only spans: finding a prompt somewhere in
// the HTML would pass even when the only distinguishing words are invisible.
const text = (html: string) => html.replace(/<[^>]+>/g, "");
const visibleText = (html: string) => text(html
  .replace(/<span class="vis-hidden">[\s\S]*?<\/span>/g, "")
  .replace(/<svg\b[\s\S]*?<\/svg>/g, ""));
const rowButton = (html: string, id: string): string => {
  const found = [...html.matchAll(/<button\b[^>]*data-session="([^"]+)"[^>]*>[\s\S]*?<\/button>/g)]
    .find(match => match[1] === id)?.[0];
  expect(found, `session ${id} has a rendered row`).toBeDefined();
  return found!;
};
const badge = (html: string): string => {
  const found = html.match(/<span class="pane-badge"[^>]*>[\s\S]*?<\/span><\/span>/g) ?? [];
  expect(found).toHaveLength(1);
  return found[0];
};
const drawHeader = (paneLink?: PaneLink) => renderToStaticMarkup(createElement(StageHeader, {
  identity: "session:session-a", name: "Workspace navigation", provider: "claude",
  status: { state: "working", phrase: "working" }, keysOwner: "board",
  chordLabel: "Ctrl+]", canType: true, expanded: false, takeover: false,
  onKeys: noop, onExpand: noop, onClose: noop, paneLink,
} satisfies StageHeaderProps));

beforeEach(() => {
  setLanguage("en");
  resetSessionsSeen();
});

describe("compact session rows", () => {
  it("keeps a simple named session on one line, with its project and accessible task", () => {
    const out = drawRow();
    expect(out).toContain('data-compact="true"');
    expect(out).toContain('data-one-line="true"');
    expect(out).not.toContain("sl-line2");
    expect(visibleText(out)).toContain("Workspace navigation");
    expect(visibleText(out)).toContain("web-api");
    expect(visibleText(out)).not.toContain(TASK);
    expect(out).toContain(`<span class="vis-hidden">web-api · ${TASK}</span>`);
    expect(out).toContain('<span class="sl-project" aria-hidden="true">web-api</span>');
    expect(out).toMatch(/title="[^"]*Repair keyboard navigation in the workspace/);
    expect(text(out).split(TASK)).toHaveLength(2);
    expect(text(out).split("web-api")).toHaveLength(3);
    const accessible = out.replace(/<span class="sl-project" aria-hidden="true">[\s\S]*?<\/span>/g, "");
    expect(text(accessible).split("web-api")).toHaveLength(2);
  });

  it.each([false, true])("retains explicitly requested context when compact=%s", compact => {
    const out = drawRow({ compact, showContext: true });
    expect(out).toContain('class="sl-line2"');
    expect(out).not.toContain('data-one-line="true"');
    expect(visibleText(out)).toContain(`web-api · ${TASK}`);
    expect(text(out).split(TASK)).toHaveLength(2);
    expect(text(out).split("web-api")).toHaveLength(2);
    expect(out).not.toContain(`<span class="vis-hidden">web-api · ${TASK}</span>`);
  });

  it("preserves the Board's task detail when compact is omitted", () => {
    const out = drawRow({ compact: undefined });
    expect(out).not.toContain('data-compact="true"');
    expect(out).toContain('class="sl-line2"');
    expect(visibleText(out)).toContain(`web-api · ${TASK}`);
  });

  it("keeps a waiting tool and its argument visible", () => {
    const out = drawRow({ group: 0, row: row({ waiting: {
      kind: "permission", message: "Allow the test command?", since: NOW - 5_000,
      tool: { name: "Bash", preview: "npm test -- workspace" },
    } }) });
    expect(out).toContain("sl-line2");
    expect(visibleText(out)).toContain("Bash · npm test -- workspace");
    expect(out).not.toContain('data-one-line="true"');
  });

  it.each([false, true])("gives a waiting twin's command the second line in pane 3 when active=%s", active => {
    const startedAt = NOW - 30 * 60_000;
    const clock = new Date(startedAt).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" });
    const out = drawRow({ group: 0, pane: { number: 3, active }, row: row({
      provider: "codex", twin: "second", startedAt,
      waiting: {
        kind: "permission", message: "Allow the test command?", since: NOW - 27 * 60_000,
        tool: { name: "Bash", preview: "npm test -- workspace" },
      },
    }) });
    const line2 = out.slice(out.indexOf('<span class="sl-line2'));
    expect(visibleText(line2)).toContain("Bash · npm test -- workspace");
    expect(out).not.toContain("sl-start");
    expect(out).not.toContain("pane-badge");
    expect(visibleText(out)).not.toContain(clock);
    expect(visibleText(out)).toContain("27m");
    const tooltip = out.match(/\btitle="([^"]*)"/)?.[1];
    expect(tooltip).toContain("Started ");
    expect(tooltip).toContain(clock);
    expect(tooltip).toContain(active ? "Active pane 3" : "Pane 3");
    expect(out).toContain(`<span class="vis-hidden">${active ? "Active pane 3" : "Pane 3"}</span>`);
    expect(out).not.toContain('data-one-line="true"');
  });

  it("keeps a waiting question visible", () => {
    const out = drawRow({ group: 0, row: row({ waiting: {
      kind: "asked", message: "Which pane should receive the session?", since: NOW - 5_000,
    } }) });
    expect(out).toContain("sl-line2");
    expect(visibleText(out)).toContain("Which pane should receive the session?");
  });

  it("keeps partial failure counts and task context visible", () => {
    const out = drawRow({ group: 3, row: row({ state: "done", toolErrorCount: 2 }) });
    expect(out).toContain('data-glyph="partial"');
    expect(visibleText(out)).toContain("Done · 2 failed");
    expect(visibleText(out)).toContain(`web-api · ${TASK}`);
    expect(text(out).split(TASK)).toHaveLength(2);
  });

  it("keeps an errored session's task visible even without failed tool calls", () => {
    const out = drawRow({ group: 3, row: row({ state: "err", toolErrorCount: 0 }) });
    expect(out).toContain('data-glyph="error"');
    expect(out).toContain('class="sl-line2"');
    expect(visibleText(out)).toContain(`web-api · ${TASK}`);
    expect(out).not.toContain('data-one-line="true"');
  });

  it("keeps twins' task context and distinguishing start time visible", () => {
    const out = drawRow({ row: row({ twin: "second" }) });
    expect(out).toContain('class="sl-line2 sl-twin"');
    expect(visibleText(out)).toContain(`web-api · ${TASK}`);
    expect(out).toMatch(/class="sl-start">· [^<]+<\/span>/);
  });

  it("keeps a removed session's status and task visible", () => {
    const out = drawRow({ removed: true });
    expect(visibleText(out)).toContain("off the board");
    expect(visibleText(out)).toContain(`web-api · ${TASK}`);
    expect(out).not.toContain('data-one-line="true"');
  });

  it("keeps the prompt visible when the session has only its folder as a title", () => {
    const out = drawRow({ row: row({ label: "web-api", folder: undefined }) });
    expect(out).toContain('class="sl-line2"');
    expect(visibleText(out)).toContain(TASK);
    expect(text(out).split(TASK)).toHaveLength(2);
    expect(out).not.toContain(`<span class="vis-hidden">${TASK}</span>`);
  });
});

function addSession(state: GraphState, id: string, title: string, prompt: string, provider?: HookPayload["provider"]): void {
  const send = (payload: HookPayload) => applyEvent(state, {
    seq: state.lastSeq + 1, receivedAt: NOW - 1_000 + state.lastSeq,
    source: "hook", payload: { session_id: id, ...payload },
  });
  send({ hook_event_name: "SessionStart", cwd: "/repo/web-api", provider });
  send({ hook_event_name: "UserPromptSubmit", prompt });
  send({ hook_event_name: "SessionNamed", sessionName: null, sessionTitle: title });
}

describe("compact session provider identity", () => {
  it.each([
    { provider: "claude" as const, name: "Claude Code", asset: "claude-code.svg", title: "Review Codex support" },
    { provider: "codex" as const, name: "Codex", asset: "codex.svg", title: "Review Claude support" },
  ])("carries the actual $provider provider through buildRows to the avatar", ({ provider, name, asset, title }) => {
    const state = initialState();
    addSession(state, "provider-session", title, TASK, provider);
    expect(buildRows(state, NOW).find(r => r.sessionId === "provider-session")?.provider).toBe(provider);
    const out = renderToStaticMarkup(createElement(SessionList, {
      state, now: NOW, selectedIds: new Set<string>(), onSelect: noop,
      onClose: noop, onOpenKeys: noop,
    }));
    const button = rowButton(out, "provider-session");
    const avatar = button.match(/<span\b[^>]*class="provider-avatar"[^>]*>/g) ?? [];
    expect(avatar).toHaveLength(1);
    expect(avatar[0]).toContain(`data-provider="${provider}"`);
    expect(avatar[0]).toContain('role="img"');
    expect(avatar[0]).toContain(`aria-label="${name}"`);
    expect(avatar[0]).toContain(`title="${name}"`);
    const style = avatar[0].match(/\bstyle="([^"]+)"/)?.[1];
    expect(style).toContain("--provider-mark:url(");
    expect(style).toContain(`/assets/providers/${asset}`);
    expect(style).not.toMatch(/https?:\/\//);
    expect(button).not.toMatch(/<img\b/);
    expect(button.indexOf(avatar[0])).toBeLessThan(button.indexOf('class="sl-text"'));
    expect(button.match(/data-glyph=/g)).toHaveLength(1);
    expect(button.indexOf('data-glyph="working"')).toBeGreaterThan(button.indexOf('class="sl-row-status"'));
    expect(visibleText(button)).toContain(title);
  });

  it("uses Claude Code for legacy rows without a provider", () => {
    const out = drawRow();
    const avatar = out.match(/<span\b[^>]*class="provider-avatar"[^>]*>/g) ?? [];
    expect(avatar).toHaveLength(1);
    expect(avatar[0]).toContain('data-provider="claude"');
    expect(avatar[0]).toContain('role="img"');
    expect(avatar[0]).toContain('aria-label="Claude Code"');
    expect(avatar[0]).toContain('title="Claude Code"');
    expect(avatar[0]).toMatch(/style="[^"]*--provider-mark:url\([^\n]*\/assets\/providers\/claude-code\.svg/);
    expect(out).not.toMatch(/<img\b/);
  });

  it("keeps the Board row's leading status mark", () => {
    const out = drawRow({ compact: false, row: row({ provider: "codex" }) });
    expect(out).not.toContain("provider-avatar");
    expect(out.match(/data-glyph=/g)).toHaveLength(1);
    expect(out.indexOf('data-glyph="working"')).toBeLessThan(out.indexOf('class="sl-text"'));
  });
});

describe("compact SessionList title collisions", () => {
  const title = "Review the shared workspace navigation and keyboard behavior";
  it.each([title, `  ${title.toUpperCase()}  `])("shows both tasks for matching full titles: %s", otherTitle => {
    const state = initialState();
    addSession(state, "first", title, "Repair keyboard focus");
    addSession(state, "second", otherTitle, "Fix pane resizing");
    const out = renderToStaticMarkup(createElement(SessionList, {
      state, now: NOW, selectedIds: new Set<string>(), onSelect: noop,
      onClose: noop, onOpenKeys: noop,
    }));
    for (const [id, prompt] of [["first", "Repair keyboard focus"], ["second", "Fix pane resizing"]]) {
      const button = rowButton(out, id);
      expect(button).toContain('data-compact="true"');
      expect(button).toContain('class="sl-line2"');
      expect(visibleText(button)).toContain(`web-api · ${prompt}`);
      expect(button).not.toContain("sl-start"); // Different tasks are not twins.
      expect(text(button).split(prompt)).toHaveLength(2);
    }
  });

  it("does not expand distinct full titles just because their beginning matches", () => {
    const state = initialState();
    addSession(state, "first", `${title} in the list`, "Repair keyboard focus");
    addSession(state, "second", `${title} in the terminal`, "Fix pane resizing");
    const out = renderToStaticMarkup(createElement(SessionList, {
      state, now: NOW, selectedIds: new Set<string>(), onSelect: noop,
      onClose: noop, onOpenKeys: noop,
    }));
    for (const id of ["first", "second"]) {
      const button = rowButton(out, id);
      expect(button).toContain('data-one-line="true"');
      expect(button).not.toContain("sl-line2");
    }
  });
});

describe("pane references in rows and headers", () => {
  it.each([true, false])("keeps the row's pane accessible and the header's badge visible when active=%s", active => {
    const pane: PaneLink = { number: 3, active };
    const inRow = drawRow({ pane });
    const inHeader = badge(drawHeader(pane));
    const label = active ? "Active pane 3" : "Pane 3";
    expect(inRow).not.toContain("pane-badge");
    expect(inRow).toContain(`<span class="vis-hidden">${label}</span>`);
    expect(inRow).toMatch(new RegExp(`title="[^"]*${label}"`));
    expect(visibleText(inRow)).not.toContain(label);
    expect(inRow.includes('data-pane-active="true"')).toBe(active);
    expect(inHeader).toContain(`title="${label}"`);
    expect(inHeader).toContain(`<span class="vis-hidden">${label}</span>`);
    expect(inHeader).toContain('<span aria-hidden="true">3</span>');
    expect(inHeader.includes('data-active="true"')).toBe(active);
    expect(inHeader).not.toMatch(/<button|role="button"|aria-pressed|aria-expanded/);
  });

  it("draws no badge in either surface without a pane link", () => {
    expect(drawRow()).not.toContain("pane-badge");
    expect(drawHeader()).not.toContain("pane-badge");
  });
});

describe("Chat tool information", () => {
  it.each([
    { name: "Read", arg: "src/web/workspace.ts", note: "182 lines", Mark: FileGlyph },
    { name: "Explore", arg: "Find keyboard handlers", note: "4 calls", Mark: SearchGlyph },
    { name: "Bash", arg: "npm test -- workspace", note: "running", running: true, Mark: ToolTerminalGlyph },
    { name: "Custom command", arg: "inspect panes", mark: "terminal" as const, Mark: ToolTerminalGlyph },
  ])("retains $name's information and mark without promising expansion", ({ Mark, ...tool }) => {
    const turn: Extract<ChatTurn, { kind: "tool" }> = { kind: "tool", ...tool };
    const out = renderToStaticMarkup(createElement(ToolRow, { turn }));
    expect(visibleText(out)).toContain(tool.name);
    expect(visibleText(out)).toContain(tool.arg);
    if (turn.note) expect(visibleText(out)).toContain(turn.note);
    expect(out).toContain(`<span class="chat-tool-mark">${renderToStaticMarkup(createElement(Mark))}</span>`);
    expect(out.match(/<svg\b/g)).toHaveLength(1);
    expect(out.includes('data-running="true"')).toBe(!!turn.running);
    expect(out).not.toMatch(/chev|<button|<details|<summary|role="button"|aria-expanded|aria-controls|tabindex=/i);
  });
});
