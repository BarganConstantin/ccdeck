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
  /** The branch the remote calls its default (`origin/HEAD`'s), without the
   *  remote's name; null or absent when no remote names one. */
  defaultBranch?: string | null;
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
  /** `upstream`: each local branch here that has one configured, by name,
   *  with the remote-tracking branch it follows (`origin/develop`). */
  refs: { local: string[]; remote: string[]; tags: string[]; head: boolean; upstream?: Record<string, string> };
  agent: CommitAgent | null;
  /** The message has more than its subject line. */
  hasBody?: boolean;
  /** HEAD has it and HEAD's upstream does not: not pushed yet. Only ever
   *  `true`, and only when HEAD's branch has an upstream to measure by. */
  unpushed?: boolean;
  outsideWindow?: boolean;
  /** One of the session's older commits past the window that HEAD has:
   *  git's answer, since the commits that join it to the window are not
   *  listed. Only ever `true`. */
  onHead?: boolean;
  /** On HEAD's line past the window, or an older commit HEAD has: whether
   *  the branch HEAD is measured against already has the commit — git's
   *  answer, for the same reason. */
  base?: boolean;
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

/** Who committed a commit, and when (strict ISO): the author's twin, which
 *  differs when someone else applied the commit (a rebase, a cherry-pick, a
 *  patch). */
export interface CommitIdentity {
  name: string;
  email: string;
  date: string;
}

/** What /api/git/commit adds to a commit's record: who committed it and
 *  when, and the message after its subject (trailers kept, at most 64 KB,
 *  `clipped` when it was cut). */
export interface CommitMessage {
  committer?: CommitIdentity;
  body?: string;
  clipped?: boolean;
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

/** How the git view draws itself: the deck's own look, or Fork's window. */
export type GitLook = "deck" | "fork";

/** The Fork look's inspector tabs. */
export type GitInspectorTab = "commit" | "changes" | "tree";

/** `/api/git/commit` for a commit without a path: the commit and its files. */
export interface CommitDetail {
  commit: LogCommit;
  files: CommitFile[];
  /** A partial clone without this commit's contents: no line counts, no diffs. */
  notDownloaded?: boolean;
  /** Its file list ran past the deck's cap: `files` is empty, the commit is whole. */
  filesTooLarge?: boolean;
}

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

// ── the sidebar's lists (GET /api/git/refs) ──────────────────────────────

/** A local branch: `current` is the one checked out in the session's own
 *  worktree, `upstream` the branch it tracks (null for none), `ahead` and
 *  `behind` how far it is from it as of the last fetch anybody made, `gone` an
 *  upstream the remote no longer has, `worktree` the folder holding it checked
 *  out (null when none does). `sha` is null only for a branch with no commit. */
export interface RefBranch {
  name: string;
  sha: string | null;
  current: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  gone: boolean;
  worktree: string | null;
}

/** A remote and its remote-tracking branches, named without the remote. */
export interface RefRemote {
  name: string;
  branches: Array<{ name: string; sha: string }>;
}

/** A tag, with the commit it names (an annotated tag's, peeled). */
export interface RefTag {
  name: string;
  sha: string;
  annotated: boolean;
  /** What it names when that is not a commit: "tree", "blob" or "tag". */
  target?: string;
}

/** One entry of the stash, newest first: `stash@{index}`. */
export interface RefStash {
  index: number;
  sha: string;
  subject: string;
  date: string;
}

/** A worktree of the repository; `current` is the session's own. */
export interface RefWorktree {
  path: string;
  name: string;
  branch: string | null;
  sha: string | null;
  current: boolean;
  locked: boolean;
  prunable: boolean;
  missing: boolean;
}

/** A submodule, at the commit the index pins it to. */
export interface RefSubmodule {
  path: string;
  name: string;
  sha: string;
}

/** The lists a list name in `clipped` or `unread` can be. */
export type RefsList = "refs" | "stashes" | "worktrees" | "submodules";

export interface GitRefs {
  branches: RefBranch[];
  remotes: RefRemote[];
  tags: RefTag[];
  stashes: RefStash[];
  worktrees: RefWorktree[];
  submodules: RefSubmodule[];
  /** Lists cut at their cap: "refs" is branches, remote branches and tags together. */
  clipped: RefsList[];
  /** Lists git could not be asked for. */
  unread: RefsList[];
}
