// An API-key install has no quota window, and the panel used to invent one.
//
// Every source in quota.mjs needs a Claude.ai OAuth credential: the claude-swap
// store, `claudeAiOauth` in the credentials file, and `claude --print /usage`,
// which prints windows only for a session signed in with one. An API-key,
// Bedrock or Vertex install has none — those are billed per token and have no
// five-hour window at all.
//
// What happened on such a machine: the CLI RAN, printed no quota lines, and the
// server read that as "genuine <1%", publishing ok:true with two zeroes. The
// panel drew two empty bars for a measurement nobody took. The other branch was
// no better: `QuotaData` had no `reason` field, so the server's own reason was
// dropped and every failure printed one sentence — "Run /usage in a claude
// session" — which on that machine is advice that cannot work.
//
// Codex has answered this properly all along, with `api_key_mode` as its own
// reason and its own sentence. This is the Claude half catching up.
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-quota-sub-"));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
mkdirSync(join(DIR, "claude"), { recursive: true });
afterAll(() => rmTempDir(DIR));

// @ts-expect-error — .mjs server module, no types
const { hasSubscriptionCredential, credentialsPath } = await import("../../server/quota.mjs");

const panel = readFileSync(fileURLToPath(new URL("../components/UsagePanel.tsx", import.meta.url)), "utf8");
const server = readFileSync(fileURLToPath(new URL("../../server/quota.mjs", import.meta.url)), "utf8");

describe("whether this machine has a subscription to report on", () => {
  it("says no for Bedrock and for Vertex, whatever else is on disk", async () => {
    writeFileSync(credentialsPath(), JSON.stringify({ claudeAiOauth: { accessToken: "sk-live" } }));
    expect(await hasSubscriptionCredential({ CLAUDE_CODE_USE_BEDROCK: "1" })).toBe(false);
    expect(await hasSubscriptionCredential({ CLAUDE_CODE_USE_VERTEX: "1" })).toBe(false);
  });

  it("says yes when the OAuth block is there, even if the token has expired", async () => {
    // An expired subscription is still a subscription: the CLI will refresh it,
    // and "no quota to show" would be the wrong sentence for a machine that has
    // one. `readOAuthToken` deliberately answers the other question.
    writeFileSync(credentialsPath(), JSON.stringify({ claudeAiOauth: { accessToken: "sk-old", expiresAt: 1 } }));
    expect(await hasSubscriptionCredential({})).toBe(true);
    expect(await hasSubscriptionCredential({ ANTHROPIC_API_KEY: "sk-ant-key" })).toBe(true);
  });

  it("says no for an API key with no OAuth block beside it", async () => {
    writeFileSync(credentialsPath(), JSON.stringify({ somethingElse: true }));
    expect(await hasSubscriptionCredential({ ANTHROPIC_API_KEY: "sk-ant-key" })).toBe(false);
    expect(await hasSubscriptionCredential({ ANTHROPIC_AUTH_TOKEN: "tok" })).toBe(false);
  });

  it("says yes on a machine that is simply not signed in yet", async () => {
    // No credentials, no key: this deck has not been signed in, and "sign in"
    // is the right thing to say — which is the waiting branch, not this one.
    writeFileSync(credentialsPath(), "{}");
    expect(await hasSubscriptionCredential({})).toBe(true);
  });
});

describe("what the server publishes when the CLI prints no windows", () => {
  it("only calls it <1% on a machine that has a subscription", () => {
    expect(server).toContain("const subscribed = cliOk ? await hasSubscriptionCredential() : false;");
    expect(server).toContain("const result = cliOk && subscribed");
    expect(server).toContain('reason: cliOk ? "no_subscription" : "cli_failed"');
  });
});

describe("what the panel says about it", () => {
  it("carries the reason it used to drop on the floor", () => {
    expect(panel).toMatch(/reason\?: string;/);
    expect(panel).toContain('<span className="up-quota-hint">{claudeQuotaHint(quota.reason)}</span>');
  });

  it("does not tell an API-key install to run /usage", () => {
    // The sentence is still there for the case it fits — a subscription install
    // whose CLI has not printed the lines yet — and no longer for the one it
    // does not.
    expect(panel).toContain("Run /usage in a claude session, then click ↻");
    const hint = panel.slice(panel.indexOf("function claudeQuotaHint"), panel.indexOf("function codexHint"));
    expect(hint).toContain('case "no_subscription":');
    expect(hint).toMatch(/billed per token and has no session window/);
    expect(hint).toContain('case "rate_limited":');
    expect(hint).toContain('case "waiting":');
  });

  it("changes the headline too, because 'unavailable' implies a retry", () => {
    expect(panel).toContain('{quota.reason === "no_subscription" ? "No quota to show." : "Quota unavailable."}');
  });
});
