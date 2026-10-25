// The Claude card says which plan it is reading, as the Codex card always has.
//
// Reported from a Mac: CODEX QUOTA carried "Plus" beside its title and CLAUDE
// QUOTA carried nothing. The plan was not missing from the machine — Claude
// Code keeps it on `oauthAccount` in its own config, which every platform has —
// it was missing from /api/quota. The token's file, which also says it, is in
// the Keychain on macOS, so that is not where this reads it from.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SANDBOX = mkdtempSync(join(tmpdir(), "ccdeck-claude-plan-"));
const CONFIG = join(SANDBOX, ".claude.json");

const { swap } = vi.hoisted(() => ({ swap: { entry: null as unknown } }));

vi.mock("../../server/claude-accounts.mjs", () => ({
  activeAccountUsage: async () => swap.entry,
  requestCollection: async () => false,
}));

vi.mock("../../server/claude-dir.mjs", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, claudeConfigDir: () => SANDBOX, claudeCliCandidates: () => ["claude"] };
});

// The global config sits in the config dir once CLAUDE_CONFIG_DIR is set, so
// this one file is the only `.claude.json` the module can find.
const previousDir = process.env.CLAUDE_CONFIG_DIR;
process.env.CLAUDE_CONFIG_DIR = SANDBOX;

afterAll(() => {
  if (previousDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previousDir;
  rmTempDir(SANDBOX);
});

const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** claude-swap's row for `who`, collected a minute ago: the answer itself. */
const row = (who: string) => ({
  num: 1,
  email: `${who}@b.c`,
  organizationUuid: `org-${who}`,
  fetchedAt: Date.now() - MIN,
  lastGood: {
    five_hour: { pct: 12, resets_at: iso(Date.now() + 100 * MIN) },
    seven_day: { pct: 34, resets_at: iso(Date.now() + 3 * 24 * 60 * MIN) },
  },
});

/** Claude Code signed in as `who`, on the plan its config names. */
const signedIn = (who: string, oauth: Record<string, unknown> = {}) => writeFileSync(CONFIG, JSON.stringify({
  numStartups: 3,
  oauthAccount: { emailAddress: `${who}@b.c`, organizationUuid: `org-${who}`, ...oauth },
}));

const MAX_20X = { organizationType: "claude_max", organizationRateLimitTier: "default_claude_max_20x" };

type Quota = { ok: boolean; plan?: string | null; planLabel?: string | null; session5hPct?: number };
type Login = { email: string; orgUuid: string; plan?: string } | null;
type Account = { email: string; organizationUuid: string } | null;
type QuotaModule = {
  fetchClaudeQuota: (o?: { force?: boolean }) => Promise<Quota>;
  withClaudePlan: (r: Quota, o?: { login?: Login; account?: Account }) => Promise<Quota>;
};
type LoginModule = { planOfAccount: (o: unknown) => string | null };
type ShapeModule = { claudePlanLabel: (p: unknown) => string | null };
let quota: QuotaModule;
let login: LoginModule;
let shape: ShapeModule;

beforeEach(async () => {
  swap.entry = null;
  rmSync(CONFIG, { force: true });
  vi.resetModules();
  quota = await import("../../server/quota.mjs") as unknown as QuotaModule;
  login = await import("../../server/claude-login.mjs") as unknown as LoginModule;
  shape = await import("../../server/quota-shape.mjs") as unknown as ShapeModule;
});

describe("the plan, from oauthAccount", () => {
  it("names Max with its tier, and the others as they are", () => {
    expect(login.planOfAccount(MAX_20X)).toBe("max-20x");
    expect(login.planOfAccount({ organizationType: "claude_max", organizationRateLimitTier: "default_claude_max_5x" })).toBe("max-5x");
    expect(login.planOfAccount({ organizationType: "claude_max" })).toBe("max");
    expect(login.planOfAccount({ organizationType: "claude_pro", organizationRateLimitTier: "default_claude_ai" })).toBe("pro");
    expect(login.planOfAccount({ organizationType: "claude_team" })).toBe("team");
    expect(login.planOfAccount({ organizationType: "claude_enterprise" })).toBe("enterprise");
  });

  it("says nothing for a type it does not know, or none", () => {
    expect(login.planOfAccount({ organizationType: "claude_something_new" })).toBeNull();
    expect(login.planOfAccount({ organizationType: null, organizationRateLimitTier: "default_claude_max_20x" })).toBeNull();
    expect(login.planOfAccount({})).toBeNull();
    expect(login.planOfAccount(null)).toBeNull();
  });

  it("prints the plan the way Anthropic names it", () => {
    expect(shape.claudePlanLabel("max-20x")).toBe("Max 20x");
    expect(shape.claudePlanLabel("max-5x")).toBe("Max 5x");
    expect(shape.claudePlanLabel("max")).toBe("Max");
    expect(shape.claudePlanLabel("pro")).toBe("Pro");
    expect(shape.claudePlanLabel("enterprise")).toBe("Enterprise");
    expect(shape.claudePlanLabel("api")).toBeNull();
    expect(shape.claudePlanLabel("toString")).toBeNull();
    expect(shape.claudePlanLabel(undefined)).toBeNull();
  });
});

describe("/api/quota's answer", () => {
  it("carries the signed-in account's plan beside the numbers", async () => {
    swap.entry = row("a");
    signedIn("a", MAX_20X);
    const read = await quota.fetchClaudeQuota();
    expect(read.ok).toBe(true);
    const sent = await quota.withClaudePlan(read);
    expect(sent).toMatchObject({ ok: true, session5hPct: 12, plan: "max-20x", planLabel: "Max 20x" });
  });

  it("is sent from a copy, so the reading account-watch looks up is left as it was", async () => {
    swap.entry = row("a");
    signedIn("a", MAX_20X);
    const read = await quota.fetchClaudeQuota();
    const sent = await quota.withClaudePlan(read);
    expect(sent).not.toBe(read);
    expect(read).not.toHaveProperty("planLabel");
  });

  it("carries no plan when the reading is somebody else's", async () => {
    // claude-swap's row is still for a, and Claude Code has just been signed in
    // as b: b's plan beside a's numbers would be the one wrong thing on the card.
    swap.entry = row("a");
    signedIn("b", MAX_20X);
    const read = await quota.fetchClaudeQuota();
    expect(read.ok).toBe(true);
    expect(await quota.withClaudePlan(read)).not.toHaveProperty("planLabel");
  });

  it("matches the account the way claude-swap does: the address without case", async () => {
    const read = { ok: true, session5hPct: 1 };
    const sent = await quota.withClaudePlan(read, {
      login: { email: "A@b.c", orgUuid: "org-a", plan: "pro" },
      account: { email: "a@b.c", organizationUuid: "org-a" },
    });
    expect(sent.planLabel).toBe("Pro");
    expect(await quota.withClaudePlan(read, {
      login: { email: "a@b.c", orgUuid: "org-b", plan: "pro" },
      account: { email: "a@b.c", organizationUuid: "org-a" },
    })).toBe(read);
  });

  it("labels a reading nobody tagged with the signed-in account's plan", async () => {
    const read = { ok: true, session5hPct: 1 };
    expect((await quota.withClaudePlan(read, { login: { email: "a@b.c", orgUuid: "", plan: "max" }, account: null })).planLabel)
      .toBe("Max");
  });

  it("leaves a reading with no numbers, or no plan to say, alone", async () => {
    const failed = { ok: false };
    expect(await quota.withClaudePlan(failed, { login: { email: "a@b.c", orgUuid: "org-a", plan: "pro" }, account: null }))
      .toBe(failed);
    const read = { ok: true, session5hPct: 1 };
    expect(await quota.withClaudePlan(read, { login: { email: "a@b.c", orgUuid: "org-a" }, account: null })).toBe(read);
    expect(await quota.withClaudePlan(read, { login: null, account: null })).toBe(read);
  });

  it("is what the route sends", () => {
    const routes = readFileSync(fileURLToPath(new URL("../../server/usage-routes.mjs", import.meta.url)), "utf8");
    expect(routes).toContain("send(res, 200, await withClaudePlan(quota));");
  });
});

describe("the Claude card", () => {
  const sections = readFileSync(fileURLToPath(new URL("../components/QuotaSections.tsx", import.meta.url)), "utf8");
  const claude = sections.slice(sections.indexOf("export function ClaudeQuotaSection"), sections.indexOf("export function CodexQuotaSection"));

  it("prints the plan in its title, in the Codex card's badge, only beside numbers", () => {
    const title = claude.slice(claude.indexOf('<h3 className="up-section-title">'), claude.indexOf("</h3>"));
    expect(title).toContain('{quota?.ok && quota.planLabel && (\n          <span className="up-plan-badge">{quota.planLabel}</span>');
  });
});
