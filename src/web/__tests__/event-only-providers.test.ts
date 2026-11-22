// opencode and GitHub Copilot CLI on the board. Both post Claude-shaped hook
// payloads through the installed forwarder (`hook.js --provider opencode` or
// `--provider copilot`), and the deck hears them through those events alone:
// no transcript, no token count, no terminal it can reach, no account.
//
// Before this, `provider` had two values and every branch read "not codex" as
// Claude: an opencode session wore Claude's mark, was named "Claude Code" in
// Chat, offered Claude's resume, and its stop fed Claude's account watch. These
// cases pin the reverse: each surface names the CLI it heard from, says what it
// cannot know rather than printing Claude's numbers, and a payload with no
// provider, or one the deck has never heard of, is still Claude's, as it always
// was.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmTempDir } from "./rm-temp-dir";
// @ts-expect-error — plain JS module, no types
import { createUsageDay } from "../../server/usage-day.mjs";
// @ts-expect-error — plain JS module, no types
import { createToolAudit } from "../../server/tool-audit.mjs";
// @ts-expect-error — plain JS module, no types
import { agentWord } from "../../server/cli-lines.mjs";
// @ts-expect-error — plain JS module, no types
import { blockNotice } from "../../server/block-notify.mjs";
import { EVENT_ONLY_PROVIDERS, PROVIDERS, isEventOnly, payloadProvider, providerOf } from "../../server/provider-ids.mjs";
import { applyEvent, initialState, type GraphState } from "../reducer";
import type { AgentNodeData, HookEnvelope, HookPayload } from "../types";
import { providerLabel } from "../provider-copy";
import { agentName } from "../components/terminal/stage-model";
import { subRowTitle } from "../agent-copy";
import { noteSource, sessionNoteShown } from "../session-note";
import { renameFacts } from "../session-rename";
import { inspectorNextStep } from "../components/Detail";
import { claudeEffort } from "../payload-effort";
import { en } from "../i18n/en";

let seq = 0;
const T0 = Date.parse("2026-11-22T10:00:00.000Z");
const envelope = (payload: Partial<HookPayload> & Record<string, unknown>): HookEnvelope => ({
  seq: ++seq, epoch: 1, receivedAt: T0 + seq, source: "hook", payload: payload as HookPayload,
}) as HookEnvelope;

function board(...payloads: Array<Partial<HookPayload> & Record<string, unknown>>): GraphState {
  let state = initialState();
  for (const p of payloads) state = applyEvent(state, envelope(p));
  return state;
}

/** A session's root after a start and one prompt, as the forwarder sends them. */
function rootOf(provider: string | undefined, sessionId = `s-${provider ?? "none"}`): AgentNodeData {
  const p = provider === undefined ? {} : { provider };
  const state = board(
    { hook_event_name: "SessionStart", session_id: sessionId, cwd: "/home/u/billing", ...p },
    { hook_event_name: "UserPromptSubmit", session_id: sessionId, cwd: "/home/u/billing", prompt: "Add a health check endpoint", ...p },
  );
  const root = state.agents.get(sessionId);
  if (!root) throw new Error("no root");
  return root;
}

describe("the provider a payload names", () => {
  it("knows four CLIs, two of them heard through events alone", () => {
    expect([...PROVIDERS]).toEqual(["claude", "codex", "opencode", "copilot"]);
    expect([...EVENT_ONLY_PROVIDERS]).toEqual(["opencode", "copilot"]);
    for (const p of ["opencode", "copilot"]) expect(isEventOnly(p), p).toBe(true);
    for (const p of ["claude", "codex", undefined, null, "", "gemini", 7]) expect(isEventOnly(p), String(p)).toBe(false);
  });

  it("reads a missing or unknown name as Claude, which is what the field has always meant", () => {
    expect(providerOf(undefined)).toBe("claude");
    expect(providerOf("gemini")).toBe("claude");
    expect(providerOf("OpenCode")).toBe("claude");   // the forwarder sends the id, lower case
    expect(providerOf(42)).toBe("claude");
    for (const p of PROVIDERS) expect(providerOf(p)).toBe(p);
    expect(payloadProvider(null)).toBe("claude");
    expect(payloadProvider("opencode")).toBe("claude");   // a string is not a payload
    expect(payloadProvider({ provider: "copilot" })).toBe("copilot");
  });
});

describe("the reducer's stamp", () => {
  it("keeps opencode and Copilot as their own sessions", () => {
    expect(rootOf("opencode").provider).toBe("opencode");
    expect(rootOf("copilot").provider).toBe("copilot");
    expect(rootOf("codex").provider).toBe("codex");
  });

  it("stamps Claude for a missing provider and for one it does not know", () => {
    expect(rootOf(undefined).provider).toBe("claude");
    expect(rootOf("gemini").provider).toBe("claude");
  });

  it("takes an opencode session id that is not a UUID", () => {
    const root = rootOf("opencode", "ses_4b2f9c1a7e3dXk2mQp8R");
    expect(root.sessionId).toBe("ses_4b2f9c1a7e3dXk2mQp8R");
    expect(root.kind).toBe("root");
  });
});

describe("what the deck calls each CLI", () => {
  it("names each one, and Claude for none", () => {
    expect(providerLabel("claude")).toBe("Claude Code");
    expect(providerLabel("codex")).toBe("Codex");
    expect(providerLabel("opencode")).toBe("OpenCode");
    expect(providerLabel("copilot")).toBe("GitHub Copilot");
    expect(providerLabel(undefined)).toBe("Claude Code");
  });

  it("says the same in the terminal stage", () => {
    expect(agentName("opencode")).toBe("OpenCode");
    expect(agentName("copilot")).toBe("GitHub Copilot");
    expect(agentName("claude")).toBe("Claude Code");
  });

  it("puts the CLI on a card's row while no model is known, as a Codex card does", () => {
    expect(subRowTitle(rootOf("opencode"))).toContain("OpenCode");
    expect(subRowTitle(rootOf("copilot"))).toContain("GitHub Copilot");
    expect(subRowTitle(rootOf(undefined))).not.toMatch(/Claude|OpenCode|Copilot/);
  });

  it("names the agent in the terminal's session lines and the TUI", () => {
    expect(agentWord("opencode")).toBe("OpenCode");
    expect(agentWord("copilot")).toBe("Copilot");
    expect(agentWord("codex")).toBe("Codex");
    expect(agentWord(undefined)).toBe("Claude");
    expect(agentWord("gemini")).toBe("Claude");
    expect(agentWord("constructor")).toBe("Claude");   // own keys only
  });
});

describe("the features that stay Claude's and Codex's", () => {
  it("offers no Rename: a save renames the CLI's own conversation, which only those two can", () => {
    expect(renameFacts(rootOf("opencode"))).toBeNull();
    expect(renameFacts(rootOf("copilot"))).toBeNull();
    expect(renameFacts(rootOf(undefined))).toMatchObject({ provider: "claude" });
    expect(renameFacts(rootOf("codex"))).toMatchObject({ provider: "codex" });
  });

  it("offers Open, not Answer, for a session waiting on a person: the deck cannot type into it", () => {
    const waiting = { kind: "permission", message: "opencode needs your permission", since: T0 } as AgentNodeData["waiting"];
    const deck = { canOpen: true, stageSession: null };
    for (const provider of ["opencode", "copilot"] as const) {
      expect(inspectorNextStep({ kind: "root", sessionId: "s", waiting, provider }, deck), provider).toBe("open");
    }
    expect(inspectorNextStep({ kind: "root", sessionId: "s", waiting, provider: "claude" }, deck)).toBe("answer");
    expect(inspectorNextStep({ kind: "root", sessionId: "s", waiting }, deck)).toBe("answer");
  });

  // The forwarders send a question as agent_needs_input (opencode-plugin-body
  // waiting, hook.js fromCopilot), Claude Code's own kind for it.
  it("holds a question as a question, not a permission, with the CLI's sentence on the desktop", () => {
    const deck = { canOpen: true, stageSession: null };
    for (const [provider, message] of [["opencode", "opencode has a question"], ["copilot", "Copilot has a question for you"]] as const) {
      const sid = `q-${provider}`;
      const asked = { hook_event_name: "Notification", session_id: sid, cwd: "/home/u/billing", provider, notification_type: "agent_needs_input", message };
      const state = board(
        { hook_event_name: "SessionStart", session_id: sid, cwd: "/home/u/billing", provider },
        { hook_event_name: "UserPromptSubmit", session_id: sid, cwd: "/home/u/billing", prompt: "Add a health check endpoint", provider },
        asked,
      );
      const root = state.agents.get(sid)!;
      expect(root.waiting, provider).toMatchObject({ kind: "asked", message });
      expect(inspectorNextStep({ kind: "root", sessionId: sid, waiting: root.waiting, provider }, deck), provider).toBe("open");
      expect(blockNotice(asked, "ccdeck"), provider).toEqual({ title: "billing — ccdeck", body: message });
    }
  });

  it("reads no effort level off a payload that is not Claude's", () => {
    // payload-effort.ts reads Claude Code's own field; another CLI's would be
    // shown as a Claude setting it never was.
    const field = { effort: { level: "high" } };
    expect(claudeEffort("PreToolUse", { provider: "opencode", ...field } as never)).toBeUndefined();
    expect(claudeEffort("PreToolUse", { provider: "copilot", ...field } as never)).toBeUndefined();
    expect(claudeEffort("PreToolUse", { ...field } as never)).toBe("high");
  });
});

describe("the note beside the card", () => {
  it("keeps the prompt for the whole turn and says which CLI's replies it does not read", () => {
    for (const provider of ["opencode", "copilot"] as const) {
      const note = sessionNoteShown(rootOf(provider));
      expect(note, provider).toMatchObject({ kind: "now", source: "prompt", text: "Add a health check endpoint", eventsOnly: provider });
      expect(note!.codex).toBeUndefined();
      expect(noteSource(note!)).toBe(en["insights.note.src.promptEventsOnly"].replace("{agent}", providerLabel(provider)));
    }
  });

  it("leaves a Claude session's prompt note as it was", () => {
    const note = sessionNoteShown(rootOf(undefined));
    expect(note).toMatchObject({ kind: "now", source: "prompt" });
    expect(note!.eventsOnly).toBeUndefined();
    expect(noteSource(note!)).toBe(en["insights.note.src.prompt"]);
  });
});

describe("the day's usage tally", () => {
  it("counts an opencode or Copilot session as use, under its own CLI feature, with its cwd as the project", () => {
    let clock = new Date("2026-09-30T10:00:00Z");
    const t = createUsageDay({ now: () => clock });
    const firsts: unknown[] = [];
    t.onFirstUse((f: unknown) => firsts.push(f));
    t.noteUse({ session_id: "o1", provider: "opencode" });
    t.noteFolder("/home/u/billing");
    t.noteUse({ session_id: "p1", provider: "copilot" });
    t.noteFolder("/home/u/docs");
    // The report's activation names the first CLI heard; opencode is kept as
    // itself (reports.mjs sends it on only when it is claude or codex).
    expect(firsts).toEqual([{ at: "2026-09-30T10:00:00.000Z", provider: "opencode" }]);
    clock = new Date("2026-10-01T10:00:00Z");
    // Each CLI names itself in the day's features since the release after 4.3.0;
    // before it, these sessions counted under no CLI feature at all.
    expect(t.finished("2026-10-01")).toEqual({
      day: "2026-09-30", sessions: 2, subagents: 0, projects: 2,
      features: ["opencode-sessions", "copilot-sessions"], events: 2, peakMb: 0,
    });
  });

  it("still counts an unknown provider as a Claude session", () => {
    let clock = new Date("2026-09-30T10:00:00Z");
    const t = createUsageDay({ now: () => clock });
    t.noteUse({ session_id: "g1", provider: "gemini" });
    clock = new Date("2026-10-01T10:00:00Z");
    expect(t.finished("2026-10-01")).toMatchObject({ features: ["claude-sessions"] });
  });
});

describe("the device-wide tool audit", () => {
  const dirs: string[] = [];
  const audits: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    for (const a of audits.splice(0)) await a.close();
    for (const d of dirs.splice(0)) await rmTempDir(d);
  });

  it("records no opencode or Copilot call: its rows are Claude's and Codex's", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ccdeck-event-only-audit-")); dirs.push(dir);
    let clock = Date.parse("2026-10-13T10:00:00Z");
    const audit = createToolAudit({ dir, now: () => clock }); audits.push(audit); await audit.start();
    const call = (name: string, id: string, provider?: string) => ({
      session_id: "s1", tool_use_id: id, hook_event_name: name, tool_name: "Bash", tool_input: { command: "npm test" },
      ...(provider ? { provider } : {}),
    });
    for (const [id, provider] of [["o", "opencode"], ["p", "copilot"], ["c", undefined]] as const) {
      audit.observe(call("PreToolUse", id, provider), "hook", { receivedAt: clock });
      clock += 2000;
      audit.observe(call("PostToolUse", id, provider), "hook", { receivedAt: clock });
    }
    const r = await audit.report({ provider: "all", days: 90 });
    expect(r.total).toBe(1);
    expect(r.rows[0].operation).toBe("npm test");
  });
});
