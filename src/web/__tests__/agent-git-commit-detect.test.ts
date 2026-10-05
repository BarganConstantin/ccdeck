// Spotting a commit an agent made, from the shell call that made it: the
// command must run `git … commit` (or cherry-pick / revert), and git's own
// summary line — `[<branch> <sha>] <subject>` — must be in what it printed.
//
// The summary lines here are real: every sample is produced by running git in
// a temp repo this file creates and owns — a root commit, a branch with
// slashes, an amend, a detached HEAD, a revert, two commits in one call — and
// the payloads are the shapes the deck receives: a Claude PostToolUse as the
// hook forwards it, and Codex rollout lines through the real translation.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
// @ts-expect-error — .mjs server module, no types
import { commitCandidates, gitCommitInvocations, parseCommitSummaries } from "../../server/agent-git-detect.mjs";
// @ts-expect-error — .mjs server module, no types
import { createCallJoiner } from "../../server/agent-git-calls.mjs";
// @ts-expect-error — .mjs server module, no types
import { codexObjToPayload } from "../../server/codex-translate.mjs";

type Payload = Record<string, unknown>;
type Summary = { branch: string | null; detached: boolean; rootCommit: boolean; shortSha: string; subject: string };

const T0 = 1_760_000_000_000;
const SID = "c1a0d000-0000-4000-8000-0000000000c0";
const CODEX_SID = "019ff475-79c7-7783-97e6-414efa7000c0";

// ── real git output ──────────────────────────────────────────────────────────

const ROOT = mkdtempSync(join(tmpdir(), "ccdeck-agent-git-commits-"));
afterAll(() => rmTempDir(ROOT));

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(ROOT, "no-global-config"),
  HOME: ROOT, LANG: "C", LC_ALL: "C",
};
const QUIET_CONFIG = ["-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${join(ROOT, "no-hooks")}`];

/** `git <args>` in `cwd`, stdout as text. */
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", [...QUIET_CONFIG, ...args], { cwd, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const out: Record<string, string> = {};
let repo = "";
let other = "";

beforeAll(() => {
  repo = join(ROOT, "repo");
  other = join(ROOT, "other");
  mkdirSync(repo);
  mkdirSync(other);
  git(repo, "init", "-q");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "a.txt");
  out.root = git(repo, "commit", "-m", "first commit");
  out.rootSha = git(repo, "rev-parse", "--short", "HEAD").trim();
  git(repo, "checkout", "-q", "-b", "feature/agents/VCRM-9090");
  writeFileSync(join(repo, "b.txt"), "b\n");
  git(repo, "add", "b.txt");
  out.slash = git(repo, "commit", "-m", "feat: add b [skip ci]");
  // Committed a second later than the original, so the amend reports its
  // author date line — the shape an amend prints when the dates differ.
  writeFileSync(join(repo, "b.txt"), "b2\n");
  git(repo, "add", "b.txt");
  out.amend = execFileSync("git", [...QUIET_CONFIG, "commit", "--amend", "-m", "feat: add b, amended"], {
    cwd: repo, encoding: "utf8", env: { ...GIT_ENV, GIT_COMMITTER_DATE: "2030-01-01T00:00:00Z" },
  });
  out.revert = git(repo, "revert", "--no-edit", "HEAD");
  writeFileSync(join(repo, "c.txt"), "c\n");
  git(repo, "add", "c.txt");
  out.quiet = git(repo, "commit", "-q", "-m", "quiet one");
  git(repo, "checkout", "-q", "--detach");
  writeFileSync(join(repo, "d.txt"), "d\n");
  git(repo, "add", "d.txt");
  out.detached = git(repo, "commit", "-m", "work on a detached head");
  git(repo, "checkout", "-q", "main");
  writeFileSync(join(repo, "e.txt"), "e\n");
  git(repo, "add", "e.txt");
  const one = git(repo, "commit", "-m", "one of two");
  writeFileSync(join(repo, "f.txt"), "f\n");
  git(repo, "add", "f.txt");
  out.two = one + git(repo, "commit", "-m", "two of two");
  git(other, "init", "-q");
  writeFileSync(join(other, "x.txt"), "x\n");
  git(other, "add", "x.txt");
  out.other = git(other, "commit", "-m", "in the other repo");
});

// ── payload shapes ───────────────────────────────────────────────────────────

const claudeBash = (command: string, stdout: string, extra: Payload = {}): Payload => ({
  session_id: SID, cwd: repo, hook_event_name: "PostToolUse", tool_name: "Bash",
  tool_input: { command, description: "Commit" }, tool_use_id: "toolu_commit",
  tool_response: { stdout, stderr: "", interrupted: false, isImage: false }, ...extra,
});

const join1 = (payload: Payload, at = T0) => createCallJoiner().join({ payload, receivedAt: at, source: "hook" });

describe("parseCommitSummaries, on git's own output", () => {
  it("reads a root commit", () => {
    expect(parseCommitSummaries(out.root)).toEqual([
      { branch: "main", detached: false, rootCommit: true, shortSha: out.rootSha, subject: "first commit" },
    ]);
  });

  it("reads a branch with slashes, and a subject with brackets in it", () => {
    const [s] = parseCommitSummaries(out.slash) as Summary[];
    expect(s).toMatchObject({ branch: "feature/agents/VCRM-9090", detached: false, rootCommit: false, subject: "feat: add b [skip ci]" });
    expect(s.shortSha).toMatch(/^[0-9a-f]{7,}$/);
  });

  it("reads an amend, whose output carries a Date line", () => {
    expect(out.amend).toMatch(/\n Date: /);
    const [s] = parseCommitSummaries(out.amend) as Summary[];
    expect(s).toMatchObject({ branch: "feature/agents/VCRM-9090", subject: "feat: add b, amended" });
  });

  it("reads a revert", () => {
    const [s] = parseCommitSummaries(out.revert) as Summary[];
    expect(s.subject).toBe('Revert "feat: add b, amended"');
  });

  it("reads a commit on a detached HEAD as no branch", () => {
    const [s] = parseCommitSummaries(out.detached) as Summary[];
    expect(s).toMatchObject({ branch: null, detached: true, rootCommit: false, subject: "work on a detached head" });
  });

  it("reads every commit when one output holds several, in order", () => {
    expect((parseCommitSummaries(out.two) as Summary[]).map(s => s.subject)).toEqual(["one of two", "two of two"]);
  });

  it("finds nothing in a quiet commit", () => {
    expect(out.quiet).toBe("");
    expect(parseCommitSummaries(out.quiet)).toEqual([]);
  });

  it("reads a localized git's detached HEAD and root marker, and CRLF output", () => {
    expect(parseCommitSummaries("[losgelöster HEAD 1a2b3c4d] Nachricht\r\n 1 file changed\r\n")).toEqual([
      { branch: null, detached: true, rootCommit: false, shortSha: "1a2b3c4d", subject: "Nachricht" },
    ]);
    expect(parseCommitSummaries("[main (Basis-Commit) 1a2b3c4] erste")).toEqual([
      { branch: "main", detached: false, rootCommit: true, shortSha: "1a2b3c4", subject: "erste" },
    ]);
  });

  it("does not read lines that only look similar", () => {
    for (const text of [
      "1a2b3c4 first commit", "  [main 1a2b3c4] indented", "[main 1A2B3C4] upper-case is not a sha",
      "[main 1a2b3] too short", "[main] no sha", "x [main 1a2b3c4] mid-line", "", null, 42,
    ]) expect(parseCommitSummaries(text), String(text)).toEqual([]);
    // An empty subject is still a commit.
    expect(parseCommitSummaries("[main 1a2b3c4]")).toEqual([
      { branch: "main", detached: false, rootCommit: false, shortSha: "1a2b3c4", subject: "" },
    ]);
  });
});

describe("gitCommitInvocations", () => {
  const at = (command: string, cwd = "/repo") =>
    (gitCommitInvocations(command, cwd) as { cwd: string | null; subcommand: string; amend: boolean; quiet: boolean; noCommit: boolean }[]);

  it("finds a plain commit, and nothing in commands that make none", () => {
    expect(at("git commit -m 'x'")).toEqual([{ cwd: "/repo", subcommand: "commit", amend: false, quiet: false, noCommit: false }]);
    for (const c of ["git status", "git log --grep commit", "echo git commit", "git commit-tree HEAD^{tree}", "npm run commit", "gitk commit", "git help commit"]) {
      expect(at(c), c).toEqual([]);
    }
  });

  it("follows -C, -c and the other global options to the folder and the subcommand", () => {
    expect(at("git -C sub commit -m x")[0].cwd).toBe("/repo/sub");
    expect(at("git -C /abs -C rel -c user.name=x --no-pager commit -m x")[0].cwd).toBe("/abs/rel");
    expect(at('git -c "core.hooksPath=/dev/null" --work-tree=../wt --git-dir ../wt/.git commit -am x')[0].cwd).toBe("/wt");
    expect(at("/usr/bin/git commit -m x")).toHaveLength(1);
    expect(at('"C:\\Program Files\\Git\\cmd\\git.exe" commit -m x', "C:\\repo")[0].cwd).toBe("C:\\repo");
  });

  it("follows cd through a chain, and back out of a subshell", () => {
    expect(at("cd packages/app && git add -A && git commit -m x")[0].cwd).toBe("/repo/packages/app");
    expect(at("(cd a && git commit -m x) && git commit -m y").map(i => i.cwd)).toEqual(["/repo/a", "/repo"]);
    expect(at("cd $SOMEWHERE && git commit -m x")[0].cwd).toBeNull();
    expect(at("cd ~/proj && git commit -m x", "/repo")[0].cwd).toMatch(/[\\/]proj$/);
  });

  it("reads the flags that matter, in clusters too", () => {
    expect(at("git commit --amend --no-edit")[0]).toMatchObject({ amend: true, quiet: false });
    expect(at("git commit -qam 'x'")[0]).toMatchObject({ quiet: true });
    expect(at("git commit -mq")[0], "-m takes `q` as the message").toMatchObject({ quiet: false });
    expect(at("git commit --quiet -m x")[0]).toMatchObject({ quiet: true });
    expect(at("git commit --dry-run")[0]).toMatchObject({ noCommit: true });
    expect(at("git cherry-pick -n abc1234")[0]).toMatchObject({ subcommand: "cherry-pick", noCommit: true });
    expect(at("git revert --no-edit HEAD")[0]).toMatchObject({ subcommand: "revert", noCommit: false });
  });

  it("survives the heredoc message Claude writes, apostrophes and all", () => {
    const cmd = "git add -A && git commit -m \"$(cat <<'EOF'\nfix: don't drop the (last) line\n\nBody with \"quotes\" && ; | chars.\nEOF\n)\" && git log --oneline -1";
    expect(at(cmd)).toEqual([{ cwd: "/repo", subcommand: "commit", amend: false, quiet: false, noCommit: false }]);
  });

  it("looks inside sh -c and an env prefix", () => {
    expect(at("bash -lc 'cd sub && git commit -m x'")[0].cwd).toBe("/repo/sub");
    expect(at("GIT_AUTHOR_DATE=now env -u FOO git commit -m x")).toHaveLength(1);
  });

  it("is empty for junk", () => {
    for (const c of ["", "   ", null, 7, "'unterminated", "git"]) expect(at(c as string)).toEqual([]);
  });
});

describe("commitCandidates", () => {
  it("turns a Claude Bash commit into a candidate for that session and agent", () => {
    const call = join1(claudeBash('git add b.txt && git commit -m "feat: add b [skip ci]"', out.slash, { agent_id: "a1b2c3", model: "claude-opus-5" }), T0 + 5);
    const [c] = commitCandidates(call);
    expect(c).toMatchObject({
      sessionId: SID, agentId: "a1b2c3", kind: "claude", cwd: repo, cwds: [repo], branch: "feature/agents/VCRM-9090",
      detached: false, subject: "feat: add b [skip ci]", at: T0 + 5, amend: false, subcommand: "commit", model: "claude-opus-5",
    });
    expect(c.shortSha).toMatch(/^[0-9a-f]{7,}$/);
  });

  it("finds a commit inside a call that failed afterwards", () => {
    // `git commit && npm test` with failing tests is a failed call that still
    // made a commit. The summary line is the proof; confirming it is later.
    const p = { ...claudeBash("git commit -m 'one of two' && npm test", out.two.split("\n")[0] + "\n> tests failed"), hook_event_name: "PostToolUseFailure" };
    expect(commitCandidates(join1(p)).map((c: { subject: string }) => c.subject)).toEqual(["one of two"]);
  });

  it("pairs several commits with the folders they were made in", () => {
    const cmd = `git -C ${JSON.stringify(repo)} commit -m 'two of two' && git -C ${JSON.stringify(other)} commit -m 'in the other repo'`;
    const stdout = out.two.split("\n").filter(l => l.includes("two of two")).join("\n") + "\n" + out.other;
    const cs = commitCandidates(join1(claudeBash(cmd, stdout)));
    expect(cs.map((c: { cwd: string; subject: string }) => [c.cwd, c.subject])).toEqual([[repo, "two of two"], [other, "in the other repo"]]);
  });

  it("names every possible folder, and no single one, when the count does not line up", () => {
    const cmd = `git -C ${JSON.stringify(repo)} commit -m a; git -C ${JSON.stringify(other)} commit -m 'in the other repo'`;
    const [c] = commitCandidates(join1(claudeBash(cmd, out.other)));
    expect(c).toMatchObject({ cwd: null, cwds: [repo, other], subject: "in the other repo" });
  });

  it("finds nothing for a quiet or redirected commit — a known blind spot", () => {
    expect(commitCandidates(join1(claudeBash("git commit -q -m 'quiet one'", out.quiet)))).toEqual([]);
    expect(commitCandidates(join1(claudeBash("git commit -m x > /dev/null 2>&1", "")))).toEqual([]);
  });

  it("ignores summary-shaped text from commands that are not a commit", () => {
    for (const cmd of ["cat notes.txt", "git log -1", "git rebase --continue", "echo '[main 1a2b3c4] x'"]) {
      expect(commitCandidates(join1(claudeBash(cmd, out.slash))), cmd).toEqual([]);
    }
  });

  it("reads a Codex exec script's commit, through the real translation", () => {
    const script = `const r = await tools.exec_command({cmd:"git commit -m \\"work on a detached head\\"",workdir:${JSON.stringify(repo)}}); text(r.output);\n`;
    const pre = codexObjToPayload({ type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: script, call_id: "call_c1", status: "completed" } }, CODEX_SID, "/elsewhere");
    const post = codexObjToPayload({
      type: "response_item",
      payload: {
        type: "custom_tool_call_output", call_id: "call_c1",
        output: [{ type: "input_text", text: `Script completed\nWall time 0.3 seconds\nOutput:\n${out.detached}` }, { type: "input_text", text: out.detached }],
      },
    }, CODEX_SID, "/elsewhere");
    const joiner = createCallJoiner();
    expect(joiner.join({ payload: pre, receivedAt: T0, source: "codex" })).toBeNull();
    const cs = commitCandidates(joiner.join({ payload: post, receivedAt: T0 + 9, source: "codex" }));
    // Printed twice (the wrapper part and the stdout part), reported once.
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ sessionId: CODEX_SID, agentId: null, kind: "codex", cwd: repo, branch: null, detached: true, at: T0 + 9 });
  });

  it("reads Codex 0.144's exec_command function call and its bare-string output", () => {
    const pre = codexObjToPayload({ type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "call_f1", arguments: JSON.stringify({ cmd: "git commit -m 'first commit'", workdir: repo }) } }, CODEX_SID, repo);
    const post = codexObjToPayload({ type: "response_item", payload: { type: "function_call_output", call_id: "call_f1", output: `Process exited with code 0\nOutput:\n${out.root}` } }, CODEX_SID, repo);
    const joiner = createCallJoiner();
    joiner.join({ payload: pre, receivedAt: T0, source: "codex" });
    expect(commitCandidates(joiner.join({ payload: post, receivedAt: T0 + 1, source: "codex" }))[0]).toMatchObject({ kind: "codex", rootCommit: true, subject: "first commit", branch: "main" });
  });

  it("answers [] for anything that is not a finished call with output", () => {
    for (const junk of [null, undefined, {}, { commands: [], output: "x" }, { commands: [{ command: "git commit", cwd: "/r" }], output: "" }]) {
      expect(commitCandidates(junk)).toEqual([]);
    }
  });
});
