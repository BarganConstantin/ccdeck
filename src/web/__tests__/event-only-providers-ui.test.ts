// What an opencode or Copilot session looks like where the deck draws one:
// its mark, the Chat view's calm "no transcript" line, the Context tab, and
// the recap's figures. Rendered to markup, as the suite renders components.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ProviderAvatar from "../components/ProviderAvatar";
import ChatView from "../components/chat/ChatView";
import { ContextView } from "../components/ContextModal";
import SessionSummary from "../components/SessionSummary";
import { applyEvent, initialState } from "../reducer";
import type { AgentNodeData, HookEnvelope, HookPayload, Provider } from "../types";
import { en } from "../i18n/en";

const avatar = (provider: Provider) => renderToStaticMarkup(createElement(ProviderAvatar, { provider }));

describe("the provider mark", () => {
  it("draws a neutral monogram for opencode and Copilot, named for the CLI, with no logo", () => {
    const oc = avatar("opencode");
    expect(oc).toContain('data-provider="opencode"');
    expect(oc).toContain("provider-monogram");
    expect(oc).toContain('aria-label="OpenCode"');
    expect(oc).toContain(">O<");
    expect(oc).not.toContain("--provider-mark");
    const cp = avatar("copilot");
    expect(cp).toContain('aria-label="GitHub Copilot"');
    expect(cp).toContain(">C<");
    expect(cp).not.toContain("--provider-mark");
  });

  it("keeps Claude's and Codex's own marks", () => {
    for (const [provider, name] of [["claude", "Claude Code"], ["codex", "Codex"]] as const) {
      const html = avatar(provider);
      expect(html, provider).toContain("--provider-mark");
      expect(html, provider).toContain(`aria-label="${name}"`);
      expect(html, provider).not.toContain("provider-monogram");
    }
  });
});

describe("Chat for a session whose conversation the deck does not read", () => {
  it("says so in one calm line: no error, no composer, no turns", () => {
    const message = en["board.chat.noTranscript"].replace("{agent}", "OpenCode");
    const html = renderToStaticMarkup(createElement(ChatView, { source: { state: "absent", message }, provider: "opencode" }));
    expect(html).toContain('class="chat-empty"');
    expect(html).toContain("ccdeck doesn’t read OpenCode conversations");
    expect(html).not.toMatch(/chat-error|chat-response|textarea/);
  });

  it("would name the CLI, never Claude Code, on a response it did draw", () => {
    const html = renderToStaticMarkup(createElement(ChatView, {
      source: { state: "ready", turns: [{ kind: "user", text: "hi" }, { kind: "assistant", text: "hello" }] },
      provider: "copilot",
    }));
    expect(html).toContain("GitHub Copilot");
    expect(html).not.toContain("Claude Code");
  });
});

let seq = 0;
const envelope = (payload: Record<string, unknown>): HookEnvelope => ({
  seq: ++seq, epoch: 1, receivedAt: 1_700_000_000_000 + seq, source: "hook", payload: payload as unknown as HookPayload,
}) as HookEnvelope;

function sessionBoard(provider: string | undefined, sessionId: string) {
  const p = provider ? { provider } : {};
  let state = initialState();
  for (const e of [
    { hook_event_name: "SessionStart", session_id: sessionId, cwd: "/home/u/billing", ...p },
    { hook_event_name: "UserPromptSubmit", session_id: sessionId, cwd: "/home/u/billing", prompt: "Add a health check", ...p },
    { hook_event_name: "PreToolUse", session_id: sessionId, cwd: "/home/u/billing", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "npm test" }, ...p },
    { hook_event_name: "PostToolUse", session_id: sessionId, cwd: "/home/u/billing", tool_name: "Bash", tool_use_id: "t1", tool_response: {}, ...p },
    { hook_event_name: "Stop", session_id: sessionId, cwd: "/home/u/billing", ...p },
  ]) state = applyEvent(state, envelope(e));
  return state;
}

describe("the Context tab and modal", () => {
  it("say the deck has no context figures for opencode or Copilot, rather than Claude's window and CLAUDE.md", () => {
    for (const [provider, name] of [["opencode", "OpenCode"], ["copilot", "GitHub Copilot"]] as const) {
      const agent = sessionBoard(provider, `ctx-${provider}`).agents.get(`ctx-${provider}`) as AgentNodeData;
      for (const meta of [false, true]) {
        const html = renderToStaticMarkup(createElement(ContextView, { agent, meta }));
        expect(html, `${provider} meta=${meta}`).toContain(en["insights.context.eventsOnly"].replace("{agent}", name));
        expect(html).not.toMatch(/CLAUDE\.md|200k|progressbar|Estimated from the transcript/);
      }
    }
  });

  it("leave a Claude session's breakdown as it was", () => {
    const agent = sessionBoard(undefined, "ctx-claude").agents.get("ctx-claude") as AgentNodeData;
    const html = renderToStaticMarkup(createElement(ContextView, { agent, meta: true }));
    expect(html).toContain("CLAUDE.md");
    expect(html).toContain('role="progressbar"');
  });
});

describe("the recap", () => {
  const render = (provider: string | undefined, id: string) =>
    renderToStaticMarkup(createElement(SessionSummary, { state: sessionBoard(provider, id), sessionId: id, onClose: () => {} }));

  it("leaves out spend and tokens for opencode and Copilot, which report neither, and keeps the counts", () => {
    for (const provider of ["opencode", "copilot"]) {
      const html = render(provider, `ss-${provider}`);
      expect(html, provider).not.toContain(en["insights.summary.spend"]);
      expect(html, provider).not.toContain(`>${en["insights.usage.tokens"]}<`);
      expect(html, provider).toContain(en["insights.summary.toolCalls"]);
      expect(html, provider).toContain(en["insights.summary.prompts"]);
    }
  });

  it("keeps both for a Claude session", () => {
    const html = render(undefined, "ss-claude");
    expect(html).toContain(en["insights.summary.spend"]);
    expect(html).toContain(en["insights.usage.tokens"]);
  });
});
