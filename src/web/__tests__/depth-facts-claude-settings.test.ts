// The plan category the deck reports reads Claude Code's configuration the way
// the quota reader does.
//
// Bedrock and Vertex are switched on in Claude Code's own settings as often as
// in a shell — the `env` block of settings.json, user or managed — and Claude
// Code reads "true", "yes" and "on" there as well as "1". The quota reader
// learnt both (hasSubscriptionCredential), so its panel says "no quota to
// show" on such a machine; the deck's own "active" still checked only its own
// environment for the literal "1", and reported the subscription token it found
// in the credentials file — a Max plan for an install billed per token. An API
// key from an `apiKeyHelper`, with no OAuth block beside it, reported nothing.
//
// Every file read here is under a temp CLAUDE_CONFIG_DIR.
import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

const ROOT = mkdtempSync(join(tmpdir(), "ccdeck-depth-settings-"));
afterAll(() => rmTempDir(ROOT));
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

/** A Claude config dir holding `settings` and, when given, an OAuth login. */
function claudeDir(settings: object | null, oauth = true): string {
  const dir = mkdtempSync(join(ROOT, "claude-"));
  mkdirSync(dir, { recursive: true });
  if (settings) writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
  if (oauth) {
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify({
      claudeAiOauth: { accessToken: "sk-secret", subscriptionType: "max", rateLimitTier: "default_claude_max_5x" },
    }));
  } else rmSync(join(dir, ".credentials.json"), { force: true });
  return dir;
}

async function planWith(dir: string, env: Record<string, string> = {}) {
  vi.stubEnv("CLAUDE_CONFIG_DIR", dir);
  vi.resetModules();
  const { deckDepth } = await import("../../server/depth-facts.mjs");
  return (await deckDepth({ setup: { claudeHooks: "ok" }, prefs: null, env })).claudePlan;
}

describe("the Claude plan category", () => {
  it("is api when Claude Code's settings switch Bedrock on, whatever the credentials file holds", async () => {
    expect(await planWith(claudeDir({ env: { CLAUDE_CODE_USE_BEDROCK: "1" } }))).toBe("api");
  });

  it("reads a switch the way Claude Code does — true, yes and on as well as 1", async () => {
    expect(await planWith(claudeDir({ env: { CLAUDE_CODE_USE_VERTEX: "true" } }))).toBe("api");
    expect(await planWith(claudeDir(null), { CLAUDE_CODE_USE_BEDROCK: "yes" })).toBe("api");
  });

  it("is api for a key from an apiKeyHelper with no subscription login beside it", async () => {
    expect(await planWith(claudeDir({ apiKeyHelper: "~/bin/claude-key" }, false))).toBe("api");
  });

  it("is still the subscription's own plan when nothing says otherwise", async () => {
    expect(await planWith(claudeDir({ env: { CLAUDE_CODE_USE_BEDROCK: "0" } }))).toBe("max-5x");
  });
});
