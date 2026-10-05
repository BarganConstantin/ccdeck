// From a commit an agent's shell output reports to a line in the local store:
// the repository it belongs to, the repo's word on its full SHA and author
// time, and what the session had spent and how long it had worked.
//
// The repo hooks here are real git — `rev-parse` for the repository, `log -1`
// for the commit — over temp repos this file creates and owns, the way the
// integration will back them; the events are the shapes pushEvent admits.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
// @ts-expect-error — .mjs server module, no types
import { createAgentGitTap } from "../../server/agent-git-tap.mjs";
// @ts-expect-error — .mjs server module, no types
import { COMMIT_STORE_FILE, createCommitStore } from "../../server/agent-git-store.mjs";
// @ts-expect-error — .mjs server module, no types
import { codexObjToPayload } from "../../server/codex-translate.mjs";

type Payload = Record<string, unknown>;
type Rec = Record<string, unknown>;

const ROOT = mkdtempSync(join(tmpdir(), "ccdeck-agent-git-record-"));
afterAll(() => rmTempDir(ROOT));

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(ROOT, "no-global-config"),
  HOME: ROOT, LANG: "C", LC_ALL: "C",
};
const CFG = ["-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${join(ROOT, "no-hooks")}`];
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", [...CFG, ...args], { cwd, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** The repository a folder is in, as the integration's resolver will answer. */
function resolveRepo(cwd: string) {
  try {
    const [top, common] = git(cwd, "rev-parse", "--show-toplevel", "--git-common-dir").trim().split("\n");
    return { top, commonDir: isAbsolute(common) ? common : resolve(cwd, common) };
  } catch { return null; }
}

/** The commit as the repo knows it — false when the repo has no such commit. */
function confirm(c: { cwd: string; shortSha: string; subject: string }) {
  try {
    const [sha, at, subject] = git(c.cwd, "log", "-1", "--format=%H%x00%at%x00%s", `${c.shortSha}^{commit}`, "--").trim().split("\0");
    return subject === c.subject ? { sha, authorTime: Number(at) * 1000 } : false;
  } catch { return false; }
}

let repo = "";
let other = "";
const out: Record<string, string> = {};

const commitIn = (cwd: string, file: string, subject: string) => {
  writeFileSync(join(cwd, file), `${subject}\n`);
  git(cwd, "add", file);
  return git(cwd, "commit", "-m", subject);
};

beforeAll(() => {
  repo = join(ROOT, "repo");
  other = join(ROOT, "other");
  for (const d of [repo, other]) { mkdirSync(d); git(d, "init", "-q"); }
  out.first = commitIn(repo, "a.txt", "feat: first");
  git(repo, "checkout", "-q", "-b", "agent/work");
  out.second = commitIn(repo, "b.txt", "fix: second");
  out.third = commitIn(repo, "c.txt", "chore: third");
  out.otherFirst = commitIn(other, "x.txt", "feat: other");
});

const T0 = 1_760_000_000_000;
const SID = "c1a0d000-0000-4000-8000-0000000000d0";
const CODEX_SID = "019ff475-79c7-7783-97e6-414efa7000d0";
const USAGE = { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 4000, ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 4000 };
const BY_MODEL = { "claude-opus-5": { input_tokens: 1000, output_tokens: 300 }, "claude-haiku-4-5": { input_tokens: 200, output_tokens: 40 } };

let n = 0;
const freshTap = (hooks: Payload = { resolveRepo, confirm }) => {
  const dir = join(ROOT, `store-${++n}`);
  mkdirSync(dir);
  const store = createCommitStore({ path: join(dir, COMMIT_STORE_FILE) });
  return createAgentGitTap({ store, ...hooks });
};

const env = (payload: Payload, at: number, source = "hook") => ({ payload, receivedAt: at, source });
const LIVE = { persisting: true };

const bash = (command: string, stdout: string, extra: Payload = {}): Payload => ({
  session_id: SID, cwd: repo, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command },
  tool_use_id: `toolu_${Math.random().toString(36).slice(2)}`, tool_response: { stdout, stderr: "" }, model: "claude-opus-5", ...extra,
});

/** A session the deck watched from its start, named and with spend so far. */
function startSession(tap: ReturnType<typeof freshTap>) {
  tap.observe(env({ session_id: SID, cwd: repo, hook_event_name: "SessionStart" }, T0), LIVE);
  tap.observe(env({ session_id: SID, hook_event_name: "SessionNamed", sessionName: "agent-commits", sessionTitle: "Commit tracking" }, T0 + 10, "internal"), LIVE);
  tap.observe(env({ session_id: SID, hook_event_name: "SubagentStart", cwd: repo, agent_id: "agent-7", agent_type: "general-purpose" }, T0 + 20), LIVE);
  tap.observe(env({ session_id: SID, hook_event_name: "UsageObserved", usage: USAGE, usageByModel: BY_MODEL }, T0 + 55_000, "internal"), LIVE);
}

describe("recording an agent's commit", () => {
  it("writes the documented line, confirmed against the repo, with the spend and time so far", async () => {
    const tap = freshTap();
    startSession(tap);
    tap.observe(env(bash("git add b.txt && git commit -m 'fix: second'", out.second), T0 + 60_000), LIVE);
    await tap.settled();
    const [r] = await tap.store.all() as Rec[];
    expect(Object.keys(r)).toEqual([
      "v", "repo", "top", "sha", "shaFull", "subject", "authorTime", "branch", "detached", "sessionId", "agentId",
      "label", "agentType", "model", "kind", "at", "cwd", "cost", "durationMs", "durationFrom", "confidence", "amend", "subcommand",
    ]);
    const full = git(repo, "rev-parse", "HEAD~1").trim();
    expect(r).toEqual({
      v: 1,
      repo: realpathSync.native(join(repo, ".git")),
      top: resolveRepo(repo)!.top,
      sha: full,
      shaFull: true,
      subject: "fix: second",
      authorTime: Number(git(repo, "log", "-1", "--format=%at", full).trim()) * 1000,
      branch: "agent/work",
      detached: false,
      sessionId: SID,
      agentId: null,
      label: "agent-commits",
      agentType: null,
      model: "claude-opus-5",
      kind: "claude",
      at: T0 + 60_000,
      cwd: repo,
      cost: { usage: USAGE, usageByModel: BY_MODEL, model: null, at: T0 + 55_000 },
      durationMs: 60_000,
      durationFrom: "session-start",
      confidence: "seen",
      amend: false,
      subcommand: "commit",
    });
  });

  it("names a subagent's commit by its type, and times it from the session's previous commit", async () => {
    const tap = freshTap();
    startSession(tap);
    tap.observe(env(bash("git commit -m 'fix: second'", out.second), T0 + 60_000), LIVE);
    tap.observe(env(bash("git commit -m 'chore: third'", out.third, { agent_id: "agent-7", model: "claude-haiku-4-5" }), T0 + 90_000), LIVE);
    await tap.settled();
    const [, r] = await tap.store.all() as Rec[];
    expect(r).toMatchObject({
      subject: "chore: third", agentId: "agent-7", label: "general-purpose", agentType: "general-purpose",
      model: "claude-haiku-4-5", durationMs: 30_000, durationFrom: "commit",
    });
  });

  it("says when the deck joined a session late rather than inventing its start", async () => {
    const tap = freshTap();
    tap.observe(env({ session_id: SID, cwd: repo, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} }, T0 + 5_000), LIVE);
    tap.observe(env(bash("git commit -m 'fix: second'", out.second), T0 + 8_000), LIVE);
    await tap.settled();
    expect((await tap.store.all())[0]).toMatchObject({ durationMs: 3_000, durationFrom: "first-seen", cost: null, label: null });
  });

  it("records nothing from a replay, from another deck's session, or before the hooks are connected", async () => {
    const replayed = freshTap();
    replayed.observe(env(bash("git commit -m 'fix: second'", out.second), T0), { replay: true, persisting: false });
    const foreign = freshTap();
    foreign.observe(env(bash("git commit -m 'fix: second'", out.second), T0), { persisting: false });
    const unhooked = freshTap({});
    unhooked.observe(env(bash("git commit -m 'fix: second'", out.second), T0), LIVE);
    for (const tap of [replayed, foreign, unhooked]) {
      await tap.settled();
      expect(await tap.store.all()).toEqual([]);
    }
    // Connecting later is what the integration does.
    unhooked.connect({ resolveRepo, confirm });
    unhooked.observe(env(bash("git commit -m 'fix: second'", out.second), T0 + 1), LIVE);
    await unhooked.settled();
    expect(await unhooked.store.all()).toHaveLength(1);
  });

  it("keeps the short SHA when the repo cannot say, and drops a commit the repo denies", async () => {
    const unsure = freshTap({ resolveRepo, confirm: () => null });
    unsure.observe(env(bash("git commit -m 'fix: second'", out.second), T0), LIVE);
    await unsure.settled();
    const [r] = await unsure.store.all() as Rec[];
    expect(r).toMatchObject({ shaFull: false, authorTime: null });
    expect(r.sha).toBe(out.second.match(/ ([0-9a-f]{7,}?)\]/)![1]);

    const denied = freshTap();
    denied.observe(env(bash("git commit -m 'fix: second'", "[agent/work deadbee] fix: second\n"), T0), LIVE);
    await denied.settled();
    expect(await denied.store.all()).toEqual([]);

    const throws = freshTap({ resolveRepo: () => { throw new Error("git missing"); }, confirm });
    throws.observe(env(bash("git commit -m 'fix: second'", out.second), T0), LIVE);
    await throws.settled();
    expect(await throws.store.all()).toEqual([]);
  });

  it("places a commit that could have come from two folders only by the repo's word", async () => {
    const tap = freshTap();
    const cmd = `git -C ${JSON.stringify(repo)} commit -m nothing-here; git -C ${JSON.stringify(other)} commit -m 'feat: other'`;
    tap.observe(env(bash(cmd, out.otherFirst), T0), LIVE);
    await tap.settled();
    const [r] = await tap.store.all() as Rec[];
    expect(r).toMatchObject({ repo: realpathSync.native(join(other, ".git")), cwd: other, subject: "feat: other", shaFull: true });

    const blind = freshTap({ resolveRepo, confirm: () => null });
    blind.observe(env(bash(cmd, out.otherFirst), T0), LIVE);
    await blind.settled();
    expect(await blind.store.all(), "no folder was certain and none was confirmed").toEqual([]);
  });

  it("records one commit once, however often its event arrives", async () => {
    const tap = freshTap();
    const p = bash("git commit -m 'feat: first'", out.first, { tool_use_id: "toolu_same" });
    tap.observe(env(p, T0), LIVE);
    tap.observe(env(p, T0 + 1), LIVE);
    await tap.settled();
    expect(await tap.store.all()).toHaveLength(1);
  });

  it("records a Codex commit with the session's Codex spend", async () => {
    const tap = freshTap();
    const codexUsage = { input_tokens: 50_000, cached_input_tokens: 40_000, output_tokens: 900, reasoning_output_tokens: 200, total_tokens: 50_900 };
    tap.observe(env(codexObjToPayload({ type: "turn_context", payload: { model: "gpt-5.6" } }, CODEX_SID, repo) ?? { session_id: CODEX_SID, provider: "codex", hook_event_name: "SessionStart", cwd: repo }, T0, "codex"), LIVE);
    tap.observe(env(codexObjToPayload({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: codexUsage, last_token_usage: { total_tokens: 900 }, model_context_window: 258_400 } } }, CODEX_SID, repo), T0 + 1_000, "codex"), LIVE);
    const script = `const r = await tools.exec_command({cmd:"git commit -m \\"chore: third\\"",workdir:${JSON.stringify(repo)}}); text(r.output);`;
    tap.observe(env(codexObjToPayload({ type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: script, call_id: "call_rc" } }, CODEX_SID, repo), T0 + 2_000, "codex"), LIVE);
    tap.observe(env(codexObjToPayload({ type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call_rc", output: [{ type: "input_text", text: `Script completed\nOutput:\n${out.third}` }] } }, CODEX_SID, repo), T0 + 3_000, "codex"), LIVE);
    await tap.settled();
    const [r] = await tap.store.all() as Rec[];
    expect(r).toMatchObject({
      kind: "codex", sessionId: CODEX_SID, agentId: null, subject: "chore: third", model: "gpt-5.6", shaFull: true,
      cost: { usage: codexUsage, usageByModel: null, model: "gpt-5.6", at: T0 + 1_000 },
    });
  });
});
