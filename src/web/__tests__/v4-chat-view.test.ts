// Chat on props: the turns in order, the bubble's corner, the tool row's
// height, the record's spacing, the loading and error states, and the Chat |
// Term switch that is drawn only with a transcript to show. The stand-in
// transcript is screens-fixtures.ts's; nothing under src/ carries one.
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ChatView from "../components/chat/ChatView";
import { sinceText } from "../components/chat/ChatTurn";
import StageHeader, { type StageHeaderProps } from "../components/terminal/StageHeader";
import { PERMISSION, TRANSCRIPT, words } from "./screens-fixtures";

const css = readFileSync(fileURLToPath(new URL("../components/chat/chat.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const html = (source: Parameters<typeof ChatView>[0]["source"], decision?: Parameters<typeof ChatView>[0]["decision"]) =>
  renderToStaticMarkup(createElement(ChatView, { source, decision }));
const rule = (sel: string) => {
  const at = css.indexOf(`\n${sel} {`);
  expect(at, `${sel} has a rule`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at));
};

describe("the conversation", () => {
  const markup = html(TRANSCRIPT);

  it("draws the divider, then every turn in the order it was given", () => {
    const order = [
      "Since you looked · 4 tool calls · now asking",
      "Add rate limiting to the public API",
      "I'll put a token-bucket limiter in front of the public routes",
      "Read", "src/server/routes.ts", "182 lines",
      "Explore", "Find every public route", "18s · 4 calls",
      "Write", "middleware/rate-limit.ts", "+64",
      "Edit", "+4 −1",
      "Now the limiter's tests.",
      "You answered 1 · Yes, run it · 6m 42s after it asked",
      "Bash", "npm test -- rate-limit", "running",
    ];
    const spoken = words(markup);
    let at = 0;
    for (const text of order) {
      const found = spoken.indexOf(text, at);
      expect(found, `"${text}" comes after the one before it`).toBeGreaterThanOrEqual(0);
      at = found + text.length;
    }
  });

  it("keeps the record's spaces as the host wrote them", () => {
    expect(markup).toContain("You answered  1 · Yes, run it  ·  6m 42s after it asked");
    expect(rule(".chat-record")).toContain("white-space: pre-wrap;");
  });

  it("counts one tool call in the singular", () => {
    expect(sinceText({ toolCalls: 1, label: "now asking" })).toBe("Since you looked · 1 tool call · now asking");
  });

  it("marks the running call, and gives the divider a name that says all of it", () => {
    expect(markup.match(/data-running/g)).toHaveLength(1);
    expect(markup).toContain('role="separator" aria-label="Since you looked · 4 tool calls · now asking"');
  });

  it("sticks to the bottom unless the reader scrolled up (the view scrolls itself, with a slack)", () => {
    const src = readFileSync(fileURLToPath(new URL("../components/chat/ChatView.tsx", import.meta.url)), "utf8");
    expect(src).toMatch(/stuck\.current = el\.scrollHeight - el\.scrollTop - el\.clientHeight <= BOTTOM_SLACK;/);
    expect(src).toMatch(/if \(el && stuck\.current\) el\.scrollTop = el\.scrollHeight;/);
  });
});

describe("the sheet", () => {
  it("rounds your message 12 12 4 12 on --your-message, 8 and 12 in", () => {
    const you = rule(".chat-you-text");
    expect(you).toContain("border-radius: var(--r-overlay) var(--r-overlay) var(--r-tag) var(--r-overlay);");
    expect(you).toContain("background: var(--your-message);");
    expect(you).toContain("padding: 8px 12px;");
  });

  it("sets the assistant's text with no bubble, 640 across, and the column at 760 centred", () => {
    expect(rule(".chat-said")).toContain("max-width: 640px;");
    expect(rule(".chat-said")).not.toContain("background");
    const col = rule(".chat-col");
    expect(col).toContain("max-width: 760px;");
    expect(col).toContain("margin: 0 auto;");
  });

  it("makes a tool row --row-tool high at 0 8 with the mono 12/16", () => {
    const tool = rule(".chat-tool");
    expect(tool).toContain("height: var(--row-tool);");
    expect(tool).toContain("padding: 0 8px;");
    expect(tool).toContain("font: 400 12px/16px var(--font-mono);");
    expect(rule(".chat-tool-name")).toContain("font-weight: 500;");
  });

  it("moves nothing: no transition, no animation, no keyframes", () => {
    // The one rule that names them turns the hidden terminal's own off.
    const own = css.slice(0, css.indexOf(".ts-body > .chat"));
    expect(own).not.toMatch(/transition|animation|@keyframes/);
  });

  it("puts the chat in the pane and hides, never removes, the terminal's host", () => {
    expect(css).toContain(".ts-body > .chat { position: absolute; inset: 0; }");
    expect(css).toMatch(/\.ts-body\[data-view="chat"\] \.ts-host \{ visibility: hidden;/);
  });
});

describe("loading, an error", () => {
  it("loading is the skeleton with its label, and no 'no transcript' state exists", () => {
    const loading = html({ state: "loading" });
    expect(loading).toContain("ig-skeleton");
    expect(loading).toContain("Reading the conversation");
    const src = readFileSync(fileURLToPath(new URL("../components/chat/chat-model.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(/state: "none"/);
    expect(words(html({ state: "loading" }))).not.toMatch(/No transcript/);
  });

  it("an error is an alert with its message and a Retry only when one is given", () => {
    const retry = vi.fn();
    const withRetry = html({ state: "error", message: "The transcript could not be read", onRetry: retry });
    expect(withRetry).toContain('role="alert"');
    expect(words(withRetry)).toContain("The transcript could not be read");
    expect(withRetry).toContain("Retry");
    expect(html({ state: "error", message: "x" })).not.toContain("Retry");
  });
});

describe("the question docked under the chat", () => {
  it("is drawn under the turns when a model is given, and not otherwise", () => {
    const docked = html(TRANSCRIPT, { model: PERMISSION });
    expect(docked).toContain('class="dc-dock"');
    expect(docked.indexOf("chat-body")).toBeLessThan(docked.indexOf("dc-dock"));
    expect(docked).toContain("data-docked");
    expect(html(TRANSCRIPT)).not.toContain("dc-dock");
  });
});

describe("the Chat | Term switch", () => {
  const props = (over: Partial<StageHeaderProps> = {}): StageHeaderProps => ({
    identity: "session:a", name: "web-api", provider: "claude", status: { state: "waiting", phrase: "waiting", emphasis: "6m", tool: "Bash", arg: "npm test -- rate-limit" },
    keysOwner: "board", chordLabel: "Ctrl+]", canType: true, expanded: false, takeover: false,
    onKeys: vi.fn(), onExpand: vi.fn(), onClose: vi.fn(), ...over,
  });
  const header = (over?: Partial<StageHeaderProps>) => renderToStaticMarkup(createElement(StageHeader, props(over)));

  it("is not drawn without a view: the deck's header has no switch and none of Chat's words", () => {
    const out = header();
    expect(out).not.toContain("view-switch");
    expect(out).not.toContain("Chat");
    expect(out).not.toContain("view-opt");
  });

  it("is drawn with a view, Chat or Term pressed, in the deck's own switch", () => {
    const out = header({ view: { current: "chat", onChange: vi.fn() } });
    expect(out).toContain('class="view-switch" role="group" aria-label="View"');
    expect(out).toMatch(/aria-pressed="true">Chat</);
    expect(out).toMatch(/aria-pressed="false">Term</);
    expect(header({ view: { current: "term", onChange: vi.fn() } })).toMatch(/aria-pressed="true">Term</);
  });

  it("adds nothing else to the header: the same markup less the switch", () => {
    const strip = (s: string) => s.replace(/<div class="view-switch".*?<\/div>/, "");
    expect(strip(header({ view: { current: "chat", onChange: vi.fn() } }))).toBe(header());
  });
});
