// pushEvent for opencode and Copilot: what the deck does with an event it
// hears from a CLI it cannot read.
//
// Everything after the ring in pushEvent was written for two providers, and
// the Claude half was the complement of Codex: a payload that was not Codex's
// went to the four Claude transcript scanners, to the output watch, to the
// account watch's rate-limit stop, to stop-continue's "type continue" and to
// the deck-name announcer that looks a session up among Claude's files. An
// opencode or Copilot event is none of those, and a `transcript_path` one of
// them may carry names a file in that CLI's own format. These cases feed the
// pipeline the forwarder's payloads and read which of those calls it made.
//
// The readers are replaced with spies (vi.mock below), so nothing here reads a
// file, and the deck's directories point into a sandbox before any server
// module loads, as every server suite does.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

const spies = vi.hoisted(() => ({
  model: vi.fn(), usage: vi.fn(), context: vi.fn(), name: vi.fn(), announce: vi.fn(),
  codex: vi.fn(), hookStop: vi.fn(), stopContinue: vi.fn(),
}));

vi.mock("../../server/session-enrichment.mjs", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  maybeResolveModel: spies.model,
  maybeResolveUsage: spies.usage,
  maybeResolveContext: spies.context,
  maybeResolveSessionName: spies.name,
  maybeAnnounceDeckName: spies.announce,
}));
vi.mock("../../server/codex-enrichment.mjs", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  maybeResolveCodex: spies.codex,
}));
vi.mock("../../server/account-watch.mjs", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  noteHookStop: spies.hookStop,
}));
vi.mock("../../server/stop-continue.mjs", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  noteStopContinue: spies.stopContinue,
}));

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-event-only-pipeline-"));
const prevEnv = { ...process.env };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.XDG_CONFIG_HOME = join(DIR, "config");
for (const p of [process.env.HOME, process.env.USERPROFILE, process.env.CLAUDE_CONFIG_DIR, process.env.CODEX_HOME]) {
  if (!resolve(p!).startsWith(resolve(DIR))) throw new Error(`sandbox escaped: ${p}`);
}

// @ts-expect-error — plain .mjs server module, no types
const { pushEvent } = await import("../../server/event-pipeline.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { outputWatch } = await import("../../server/session-tracking.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { usageDay } = await import("../../server/usage-day.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { replayScope } = await import("../../server/log-replay.mjs");

afterAll(() => {
  for (const k of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME"]) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  rmTempDir(DIR);
});

const watchNote = vi.spyOn(outputWatch, "note");
const noteFolder = vi.spyOn(usageDay, "noteFolder");
const noteProject = vi.spyOn(usageDay, "noteProject");
const noteUse = vi.spyOn(usageDay, "noteUse");

beforeEach(() => {
  for (const s of Object.values(spies)) s.mockClear();
  for (const s of [watchNote, noteFolder, noteProject, noteUse]) s.mockClear();
});

// A Claude transcript the gate accepts, so the Claude control case reaches the
// scanners: under the sandbox's CLAUDE_CONFIG_DIR/projects.
const CLAUDE_TRANSCRIPT = join(DIR, "claude", "projects", "-home-u-shop", "7f3c2a10-1111-4222-8333-444455556666.jsonl");
mkdirSync(join(DIR, "claude", "projects", "-home-u-shop"), { recursive: true });
writeFileSync(CLAUDE_TRANSCRIPT, "");

const payload = (provider: string | undefined, event: string, extra: Record<string, unknown> = {}) => ({
  hook_event_name: event,
  session_id: provider === "opencode" ? "ses_4b2f9c1a7e3dXk2mQp8R" : "9a8b7c6d-1111-4222-8333-444455556666",
  cwd: join(DIR, "work", provider ?? "claude"),
  ...(provider ? { provider } : {}),
  ...extra,
});

describe("a live opencode or Copilot hook", () => {
  for (const provider of ["opencode", "copilot"]) {
    it(`${provider}: reads no transcript, follows no path, and counts its cwd as the project`, () => {
      // Copilot's hooks may carry a transcript_path; it must not be followed
      // even when it sits where Claude's transcripts do.
      pushEvent(payload(provider, "PreToolUse", { tool_name: "bash", tool_use_id: "t1", transcript_path: CLAUDE_TRANSCRIPT }), "hook");
      for (const s of [spies.model, spies.usage, spies.context, spies.name, spies.codex]) expect(s).not.toHaveBeenCalled();
      expect(watchNote).not.toHaveBeenCalled();
      expect(noteProject).not.toHaveBeenCalled();
      expect(noteUse).toHaveBeenCalledTimes(1);
      expect(noteFolder).toHaveBeenCalledWith(join(DIR, "work", provider));
    });

    it(`${provider}: is never announced a deck name, and its stop reaches neither the account watch nor stop-continue`, () => {
      pushEvent(payload(provider, "UserPromptSubmit", { prompt: "hi" }), "hook");
      pushEvent(payload(provider, "Stop"), "hook");
      pushEvent(payload(provider, "StopFailure", { error: "rate_limit" }), "hook");
      expect(spies.announce).not.toHaveBeenCalled();
      expect(spies.hookStop).not.toHaveBeenCalled();
      expect(spies.stopContinue).not.toHaveBeenCalled();
    });
  }
});

describe("the two CLIs the deck reads, unchanged", () => {
  it("Claude: the scanners, the output watch, the project, the name and the stop", () => {
    pushEvent(payload(undefined, "Stop", { transcript_path: CLAUDE_TRANSCRIPT }), "hook");
    for (const s of [spies.model, spies.usage, spies.context, spies.name]) expect(s).toHaveBeenCalledTimes(1);
    expect(watchNote).toHaveBeenCalledWith("9a8b7c6d-1111-4222-8333-444455556666", CLAUDE_TRANSCRIPT);
    expect(noteProject).toHaveBeenCalledWith(CLAUDE_TRANSCRIPT);
    expect(noteFolder).not.toHaveBeenCalled();
    expect(spies.announce).toHaveBeenCalledWith(expect.objectContaining({ hook_event_name: "Stop" }), "claude");
    expect(spies.hookStop).toHaveBeenCalledTimes(1);
    expect(spies.stopContinue).toHaveBeenCalledTimes(1);
  });

  it("an unknown provider is still read as Claude", () => {
    pushEvent(payload("gemini", "Stop", { transcript_path: CLAUDE_TRANSCRIPT }), "hook");
    expect(spies.model).toHaveBeenCalledTimes(1);
    expect(spies.hookStop).toHaveBeenCalledTimes(1);
  });

  it("Codex: its own enrichment and nothing of Claude's", () => {
    pushEvent(payload("codex", "PreToolUse", { tool_name: "shell", tool_use_id: "t2" }), "hook");
    expect(spies.codex).toHaveBeenCalledTimes(1);
    expect(spies.model).not.toHaveBeenCalled();
    expect(spies.announce).toHaveBeenCalledWith(expect.objectContaining({ provider: "codex" }), "codex");
  });
});

describe("the boot replay", () => {
  type Admits = (payload: unknown) => boolean;
  const oc = { hook_event_name: "PreToolUse", session_id: "ses_x", cwd: "/srv/p", provider: "opencode" };
  const cp = { hook_event_name: "PreToolUse", session_id: "c1", cwd: "/srv/p", provider: "copilot" };
  const claude = { hook_event_name: "PreToolUse", session_id: "a1", cwd: "/srv/p" };

  it("replays opencode and Copilot on a --no-claude deck, as their live events pass there too", () => {
    // event-routes.mjs refuses only Claude's events on a --no-claude deck, and
    // hook.js likewise; the replay must not be narrower than the live rule.
    const noClaude = replayScope("", undefined, { claude: false, codex: true }) as Admits;
    expect(noClaude(oc)).toBe(true);
    expect(noClaude(cp)).toBe(true);
    expect(noClaude(claude)).toBe(false);
  });

  it("replays them on a --no-codex deck and a deck watching neither CLI's own files", () => {
    const noCodex = replayScope("", undefined, { claude: true, codex: false }) as Admits;
    expect(noCodex(oc)).toBe(true);
    expect(noCodex(cp)).toBe(true);
    const neither = replayScope("", undefined, { claude: false, codex: false }) as Admits;
    expect(neither(oc)).toBe(true);
    expect(neither(cp)).toBe(true);
    expect(neither(claude)).toBe(false);
  });
});
