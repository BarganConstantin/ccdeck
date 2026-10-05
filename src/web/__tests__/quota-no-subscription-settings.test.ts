// An API-key, Bedrock or Vertex install configured the way Claude Code
// documents it, rather than through the deck's own environment.
//
// hasSubscriptionCredential decides whether the CLI's silence means "a window
// that has just reset" (two zero bars) or "no window to report" (#765). It read
// only process.env, and only the literal "1". But the documented place for
// org-wide configuration is the `env` block of Claude Code's settings — user or
// managed — an API key can come from `apiKeyHelper` there, Claude Code takes
// `true` as readily as `1`, and a deck started by the desktop app or a login
// item never sees the shell's exports at all. Each of those machines was read
// as a subscription, and the panel drew two empty bars for a measurement
// nobody took.
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-quota-sub-settings-"));
const PREV = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
mkdirSync(join(DIR, "claude"), { recursive: true });
afterAll(() => {
  for (const [k, v] of Object.entries(PREV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmTempDir(DIR);
});

// @ts-expect-error — .mjs server module, no types
const { hasSubscriptionCredential } = await import("../../server/quota-oauth.mjs");

const USER = join(DIR, "claude", "settings.json");
const MANAGED = join(DIR, "managed-settings.json");
const FILES = [USER, MANAGED];

/** Write Claude Code's user settings and managed settings (null: absent). */
function settings(user: unknown, managed: unknown = null) {
  rmSync(USER, { force: true });
  rmSync(MANAGED, { force: true });
  if (user != null) writeFileSync(USER, JSON.stringify(user));
  if (managed != null) writeFileSync(MANAGED, JSON.stringify(managed));
}

describe("an install that bills per token, configured in Claude Code's settings", () => {
  it("is Bedrock when the user settings' env says so", async () => {
    settings({ env: { CLAUDE_CODE_USE_BEDROCK: "1" } });
    expect(await hasSubscriptionCredential({}, FILES)).toBe(false);
  });

  it("is Vertex when the managed settings' env says so", async () => {
    settings(null, { env: { CLAUDE_CODE_USE_VERTEX: "1" } });
    expect(await hasSubscriptionCredential({}, FILES)).toBe(false);
  });

  it("takes the values Claude Code takes as on, not only 1", async () => {
    settings(null);
    for (const on of ["true", "TRUE", "yes", "on"]) {
      expect(await hasSubscriptionCredential({ CLAUDE_CODE_USE_BEDROCK: on }, FILES)).toBe(false);
    }
    settings({ env: { CLAUDE_CODE_USE_VERTEX: "true" } });
    expect(await hasSubscriptionCredential({}, FILES)).toBe(false);
  });

  it("is an API-key install when its key comes from the settings' env", async () => {
    settings({ env: { ANTHROPIC_API_KEY: "sk-ant-test" } });
    expect(await hasSubscriptionCredential({}, FILES)).toBe(false);
  });

  it("is an API-key install when its key comes from an apiKeyHelper", async () => {
    settings({ apiKeyHelper: "/usr/local/bin/print-key" });
    expect(await hasSubscriptionCredential({}, FILES)).toBe(false);
  });

  it("is still a machine not signed in yet when the settings say none of it", async () => {
    settings({ env: { CLAUDE_CODE_USE_BEDROCK: "0", SOMETHING_ELSE: "1" }, model: "opus" });
    expect(await hasSubscriptionCredential({}, FILES)).toBe(true);
  });

  it("reads a settings file it cannot parse as saying nothing", async () => {
    settings(null);
    writeFileSync(USER, "{ not json");
    expect(await hasSubscriptionCredential({}, FILES)).toBe(true);
  });
});
