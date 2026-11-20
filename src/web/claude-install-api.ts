// Claude Code's install from the deck, as the page asks about it (the server
// half is claude-install.mjs):
//
//   GET  /api/claude-install   where the install stands, and the command to run by hand
//   POST /api/claude-install   start one
//
// The session pane's card for a Claude that is not installed and the Accounts
// sign-in that could not run `claude` both use it, through ClaudeInstall.tsx.
// Every answer is a value: a refusal, a network failure and a deck without the
// route all come back as null or `{ ok: false, code }`.

export const CLAUDE_INSTALL_ROUTE = "/api/claude-install";

export type ClaudeInstallState = "idle" | "running" | "done" | "failed";

/** Why an install failed, as the deck names it. */
export type ClaudeInstallReason =
  | "download-failed" | "start-failed" | "exit-failed" | "timed-out" | "installed-but-not-found" | "failed";

export interface ClaudeInstallStatus {
  state: ClaudeInstallState;
  /** The job the state is about; absent while none has run. */
  id: string | null;
  reason: ClaudeInstallReason | null;
  /** The installer's last lines, for a failure: its own words, the home
   *  folder written as ~. */
  detail: string | null;
  /** The command that does the same by hand, for the deck's platform. */
  command: string;
  /** Where that command is typed. */
  shell: "terminal" | "powershell";
  /** The deck may not download it (AGENTS_DECK_NO_INSTALL, AGENTS_DECK_NO_DOWNLOAD). */
  blocked: boolean;
}

export type ClaudeInstallAnswer = { ok: true; id: string } | { ok: false; code: string };

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
const defaultFetch: FetchFn = (input, init) => fetch(input, init);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const STATES: readonly string[] = ["idle", "running", "done", "failed"];
const REASONS: readonly string[] = ["download-failed", "start-failed", "exit-failed", "timed-out", "installed-but-not-found", "failed"];

/** A status the deck sent, or null for anything else. */
export function claudeInstallStatusOf(v: unknown): ClaudeInstallStatus | null {
  if (!isObject(v) || v.ok !== true || typeof v.state !== "string" || !STATES.includes(v.state) || typeof v.command !== "string") return null;
  return {
    state: v.state as ClaudeInstallState,
    id: typeof v.id === "string" ? v.id : null,
    reason: typeof v.reason === "string" ? (REASONS.includes(v.reason) ? v.reason as ClaudeInstallReason : "failed") : null,
    detail: typeof v.detail === "string" && v.detail.trim() ? v.detail : null,
    command: v.command,
    shell: v.shell === "powershell" ? "powershell" : "terminal",
    blocked: typeof v.blocked === "string" && v.blocked !== "",
  };
}

/** Where the install stands, or null when the deck cannot say. */
export async function claudeInstallStatus(fetchFn: FetchFn = defaultFetch): Promise<ClaudeInstallStatus | null> {
  try {
    const res = await fetchFn(CLAUDE_INSTALL_ROUTE, { method: "GET" });
    if (!res.ok) return null;
    return claudeInstallStatusOf(await res.json().catch(() => null));
  } catch {
    return null;
  }
}

/** Starts the install. */
export async function startClaudeInstall(fetchFn: FetchFn = defaultFetch): Promise<ClaudeInstallAnswer> {
  try {
    const res = await fetchFn(CLAUDE_INSTALL_ROUTE, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const body: unknown = await res.json().catch(() => null);
    if (isObject(body) && body.ok === true && typeof body.id === "string") return { ok: true, id: body.id };
    return { ok: false, code: isObject(body) && typeof body.code === "string" ? body.code : "failed" };
  } catch {
    return { ok: false, code: "unreachable" };
  }
}

/** The sentence for a failure, by its reason. */
export const REASON_KEYS: Readonly<Record<ClaudeInstallReason, string>> = {
  "download-failed": "accounts.claudeInstall.fail.download",
  "start-failed": "accounts.claudeInstall.fail.start",
  "exit-failed": "accounts.claudeInstall.fail.exit",
  "timed-out": "accounts.claudeInstall.fail.timeout",
  "installed-but-not-found": "accounts.claudeInstall.fail.notFound",
  failed: "accounts.claudeInstall.fail.other",
};
