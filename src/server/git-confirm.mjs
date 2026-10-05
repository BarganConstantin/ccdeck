// The repository's word on a commit an agent's shell output reported making —
// and the switch that turns commit recording on.
//
// agent-git-tap.mjs spots a commit in what an agent's `git commit` printed
// (`[main 1a2b3c4] subject`) and hands it to the recorder, which needs two
// answers it cannot get without running git: which repository the folder is
// in, and whether that repository really holds the commit. Both are answered
// here, through the deck's one git runner (git-run.mjs), so recording reads
// exactly what the git view's routes read and writes nothing to the repository.
//
// THE COMMIT CHECK. The short SHA git printed is resolved in that repository
// (`rev-parse --verify <short>^{commit}`), then its author time and subject are
// read. The answer is one of three, as agent-git-record.mjs expects:
//
//   { sha, authorTime }   the full SHA and the author time in ms — the subject
//                         matched what the agent's git printed;
//   false                 the repository definitely holds no such commit, so
//                         the line did not come from this folder;
//   null                  could not tell: git missing, a timeout, a folder that
//                         is not a repository, a short SHA that names several
//                         objects, or a commit whose subject is not the one
//                         printed. The recorder then keeps the line with the
//                         short SHA only when the folder was certain.
//
// THE SWITCH. Recording follows the git view's own setting: switched off, no
// repository is resolved, so nothing is recorded, exactly as no repository is
// read.
import { connectAgentGit } from "./agent-git-tap.mjs";
import { classifyFailure, git } from "./git-run.mjs";
import { repoTopOf } from "./git-state.mjs";
import { gitEnabled } from "./git-watch.mjs";

const SHORT = /^[0-9a-f]{7,64}$/;
const FULL = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * The commit a candidate names, as its repository knows it.
 *
 * @param {{ shortSha?: unknown, subject?: unknown, cwd?: unknown, repo?: { top?: unknown } | null }} candidate
 *   a commit candidate (agent-git-detect.mjs) with the folder and repository
 *   the recorder is trying it against
 * @param {{ run?: typeof git }} [deps] the runner, replaced by the tests
 * @returns {Promise<{ sha: string, authorTime: number } | null | false>}
 */
export async function confirmCommit(candidate, { run = git } = {}) {
  const c = candidate && typeof candidate === "object" ? candidate : {};
  const short = typeof c.shortSha === "string" ? c.shortSha : "";
  const cwd = typeof c.repo?.top === "string" && c.repo.top ? c.repo.top : typeof c.cwd === "string" ? c.cwd : "";
  if (!SHORT.test(short) || !cwd) return null;

  // Hex only, checked above, so the argument can only ever be a revision.
  const resolved = await run("rev-parse", ["--verify", `${short}^{commit}`], { cwd });
  if (!resolved.ok) {
    // git missing, the folder gone, not a repository, a timeout: could not tell.
    if (classifyFailure(resolved) !== "error") return null;
    // Several objects share the prefix: the repository may well hold the
    // commit, so this is not a "no".
    if (/ambiguous/i.test(resolved.stderr ?? "")) return null;
    if (/needed a single revision|unknown revision|bad revision/i.test(resolved.stderr ?? "")) return false;
    return null;
  }
  const sha = resolved.stdout.trim();
  if (!FULL.test(sha)) return null;

  const read = await run("log", ["-1", "--format=%H%x00%at%x00%s", sha, "--"], { cwd });
  if (!read.ok) return null;
  const [got, at, subject] = read.stdout.replace(/\r?\n$/, "").split("\0");
  const seconds = Number(at);
  if (got !== sha || !Number.isFinite(seconds) || subject === undefined) return null;
  const printed = typeof c.subject === "string" ? c.subject : "";
  if (subject.trimEnd() !== printed.trimEnd()) return null;
  return { sha, authorTime: seconds * 1000 };
}

/**
 * Turn commit recording on: hand the deck's tap the two git hooks it needs,
 * both gated on the git view's setting. Called once, at server start.
 *
 * @param {{ enabled?: () => boolean }} [opts] the setting, replaced by the tests
 */
export function connectCommitRecording({ enabled = gitEnabled } = {}) {
  connectAgentGit({
    resolveRepo: (cwd) => (enabled() ? repoTopOf(cwd) : null),
    confirm: (candidate) => (enabled() ? confirmCommit(candidate) : null),
  });
}
