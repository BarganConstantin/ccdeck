// The git view's data, as the server's read routes answer it
// (src/server/git-routes.mjs), and the few shapes the view's parts share.
// Types only: what the page does with them is use-git-view.ts's.

/** Why a session has no repository to show, or "repo" when it has one. */
export type GitReadState = "repo" | "not-a-repo" | "gone" | "no-git" | "bare" | "unsafe" | "timeout" | "error";

export interface GitHead {
  branch: string | null;
  detached: boolean;
  sha: string | null;
  short: string | null;
  unborn: boolean;
}

export interface GitUpstream {
  name: string;
  ahead: number;
  behind: number;
  gone: boolean;
}

export interface Repo {
  topLevel: string;
  gitDir: string;
  commonDir: string;
  linkedWorktree: boolean;
  name: string;
  mainName: string;
  folder: string;
  folderName: string;
  nameDiffers: boolean;
  head: GitHead;
  empty: boolean;
  upstream: GitUpstream | null;
  stale?: number;
}

/** Who made a commit, and how the deck knows: seen making it, matched to one
 *  it saw after an amend or rebase, or only named by the commit's trailer. */
export type CommitAgent =
  | { sessionId: string; agentId: string | null; label: string | null; agentType?: string | null; kind?: string | null; model?: string | null; durationMs?: number | null; confidence: "seen" | "matched" }
  | { agent: "claude" | "codex"; confidence: "trailer" };

export interface LogCommit {
  sha: string;
  parents: string[];
  author: { name: string; email: string };
  date: string;
  subject: string;
  trailers: Array<{ key: string; value: string }>;
  refs: { local: string[]; remote: string[]; tags: string[]; head: boolean };
  agent: CommitAgent | null;
  outsideWindow?: boolean;
}

export type StatusArea = "staged" | "unstaged" | "untracked" | "conflict";

export interface StatusEntry {
  path: string;
  area: StatusArea;
  change: string;
  from?: string;
  submodule?: boolean;
  directory?: boolean;
  /** The lines this side's diff adds and removes, and whether it is binary:
   *  absent when the deck does not know (a conflict, a submodule, a folder, a
   *  file past a size cap). */
  added?: number;
  removed?: number;
  binary?: boolean;
}

/** A subagent of the session that works in a folder of its own — another
 *  worktree, another repository, or no repository — as /api/git/repo lists
 *  it for a whole session. `changed` counts the files changed there (each
 *  path once), null when that is not known. */
export interface SubagentElsewhere {
  agentId: string;
  label: string | null;
  folder: string;
  folderName: string;
  state: GitReadState;
  topLevel: string | null;
  sameRepo: boolean;
  changed: number | null;
}

export interface StatusCounts {
  staged: number;
  unstaged: number;
  untracked: number;
  conflict: number;
}

export interface CommitFile {
  path: string;
  from?: string;
  change: string;
  added: number;
  removed: number;
  binary: boolean;
}

export interface Edit {
  /** Repository-relative. */
  path: string;
  agentId: string | null;
  label: string | null;
  at: number;
}

export type DiffResult =
  | { binary: false; patch: string; added: number; removed: number }
  | { binary: true }
  | { tooLarge: true; limit: number; oldSize: number; newSize: number }
  | { directory: true };

/** Whose work the view is about: a session's whole team, or one subagent. */
export interface GraphFocus {
  sessionId: string;
  /** null = the whole team; otherwise the subagent keys the view is narrowed to. */
  agentIds: string[] | null;
}

/** The selected history row: a commit's SHA, or the working tree. */
export type GitSelection = string;
export const UNCOMMITTED = "uncommitted";

/** A file in the files pane, as the diff pane is asked to show it. */
export interface GitFileRef {
  path: string;
  area: string;
  from?: string;
}
