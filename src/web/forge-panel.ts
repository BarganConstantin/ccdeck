// What the GitHub and GitLab panels know besides the drawing (#2179).
//
// The panels copy screens the owner already works in: a project's Branches
// page, the Merge requests dashboard, a merge request's own page. This file is
// the part of that which is not layout — how a read is asked for and kept,
// what each state is called on screen, how a list splits into the groups those
// screens show — so the components stay drawing and the rules stay testable.
//
// ONE READ, KEPT. A panel asks the deck (/api/integrations/<kind>/<connId>/
// <read>), and the answer is kept for this page's life keyed by that address.
// Opening the panel again draws what was kept at once and asks again only when
// it is older than FRESH_MS; a refresh that fails keeps the last answer on
// screen and marks it stale, because a list that vanishes when the network
// blinks is worse than one that says it is a few minutes old.
//
// EVERY STATE GETS A MARK AND A WORD (DESIGN.md): a pipeline is never only a
// colour.
import type {
  CiState, ForgeBranch, ForgeChange, ForgeErrorInfo, ForgeErrorKind, ForgeKind, ChangeFilter, ChangeState,
} from "./forge-types";
import { forgeWords } from "./forge-types";

/** How long an answer is fresh enough to draw without asking again. */
export const FRESH_MS = 120_000;

/** The integrations host's fetch for one connection: it prefixes
 *  /api/integrations/<kind>/<connId>/ to the path it is given (#2178). */
export type ForgeApi = (path: string, init?: RequestInit) => Promise<Response>;

/** The host's per-connection preference store (#2178). */
export interface ForgePrefs {
  read<T>(key: string, check: (v: unknown) => v is T): T | undefined;
  write(key: string, value: unknown): void;
}

/** One read's path below the connection, with its query; empty values are
 *  left out so a default stays the server's. */
export function forgeReadPath(read: string, params: Record<string, string | number | null | undefined> = {}): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") q.set(k, String(v));
  const query = q.toString();
  return `${read}${query ? `?${query}` : ""}`;
}

/** A read that failed: the forge's own failure, or the deck's. */
export class ForgeReadError extends Error {
  constructor(readonly info: ForgeErrorInfo) {
    super(info.message);
    this.name = "ForgeReadError";
  }
}

/** Ask the deck for one read. Every integration fails in one envelope,
 *  { ok: false, error: { kind, message, … } }; an answer without it (a deck
 *  that is restarting, a proxy's page) is reported as the deck's. */
export async function fetchForge<T>(api: ForgeApi, path: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await api(path, { signal, headers: { accept: "application/json" } });
  } catch (err) {
    if ((err as Error)?.name === "AbortError") throw err;
    throw new ForgeReadError({ kind: "unreachable", message: "the deck did not answer" });
  }
  let body: { ok?: boolean; data?: T; error?: ForgeErrorInfo | string } | null = null;
  try { body = await res.json(); } catch { /* handled below */ }
  if (res.ok && body?.ok) return body.data as T;
  const error = body?.error;
  if (error && typeof error === "object" && typeof error.kind === "string") throw new ForgeReadError(error);
  throw new ForgeReadError({
    kind: "upstream",
    message: typeof error === "string" ? error : `the deck answered ${res.status}`,
    status: res.status,
  });
}

export interface Kept<T> {
  data: T | null;
  /** When the forge last ANSWERED this read (epoch ms), null if never. */
  loadedAt: number | null;
  error: ForgeErrorInfo | null;
}

const kept = new Map<string, Kept<unknown>>();
const KEEP_MAX = 200;

export function keptRead<T>(url: string): Kept<T> {
  return (kept.get(url) as Kept<T> | undefined) ?? { data: null, loadedAt: null, error: null };
}

export function keepRead<T>(url: string, entry: Kept<T>): void {
  kept.delete(url);
  kept.set(url, entry);
  while (kept.size > KEEP_MAX) kept.delete(kept.keys().next().value as string);
}

/** Whether a kept read should be asked again now. */
export function readDue(entry: Kept<unknown>, now: number, force = false): boolean {
  return force || entry.loadedAt == null || now - entry.loadedAt >= FRESH_MS;
}

/** A kept answer whose latest refresh failed: still drawn, marked stale. */
export function isStale(entry: Kept<unknown>): boolean {
  return entry.data != null && entry.error != null;
}

// ── words ────────────────────────────────────────────────────────────────

export interface Mark {
  mark: string;
  word: string;
  /** The tone class: ok, bad, busy, idle. */
  tone: "ok" | "bad" | "busy" | "idle";
}

const CI_MARKS: Record<CiState, Mark> = {
  success: { mark: "✓", word: "passed", tone: "ok" },
  failed: { mark: "✕", word: "failed", tone: "bad" },
  running: { mark: "●", word: "running", tone: "busy" },
  pending: { mark: "○", word: "pending", tone: "busy" },
  canceled: { mark: "⊘", word: "canceled", tone: "idle" },
  skipped: { mark: "»", word: "skipped", tone: "idle" },
  manual: { mark: "▷", word: "manual", tone: "idle" },
  none: { mark: "–", word: "no pipeline", tone: "idle" },
};

export function ciMark(state: CiState | null | undefined): Mark {
  return CI_MARKS[state ?? "none"] ?? CI_MARKS.none;
}

/** The badge a change carries on a branch row or in a list: Draft, Approved,
 *  Merged, Closed or Open, in that order of what matters. */
export function changeBadge(c: { state: ChangeState; draft: boolean; approved: boolean }): Mark {
  if (c.state === "merged") return { mark: "⇢", word: "Merged", tone: "ok" };
  if (c.state === "closed") return { mark: "⊘", word: "Closed", tone: "idle" };
  if (c.draft) return { mark: "◌", word: "Draft", tone: "idle" };
  if (c.approved) return { mark: "✓", word: "Approved", tone: "ok" };
  return { mark: "●", word: "Open", tone: "busy" };
}

export function reviewerMark(state: "approved" | "changes_requested" | "commented" | "pending"): Mark {
  switch (state) {
    case "approved": return { mark: "✓", word: "approved", tone: "ok" };
    case "changes_requested": return { mark: "✕", word: "changes requested", tone: "bad" };
    case "commented": return { mark: "…", word: "commented", tone: "idle" };
    default: return { mark: "◌", word: "review pending", tone: "idle" };
  }
}

/** Ahead/behind as GitLab's Branches page writes it: past 999 it is "999+". */
export function divergeCount(n: number | null): string {
  if (n == null) return "–";
  return n >= 1000 ? "999+" : String(n);
}

/** A run's length as a person says it: "45s", "3m 12s", "1h 04m". */
export function durationWords(sec: number | null): string | null {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return null;
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

export interface ErrorWords {
  title: string;
  detail: string;
  /** What the panel offers: send the user to the connection, or try again. */
  action: "connection" | "retry";
}

/** The sentence and the recovery for each failure, in the forge's own name. */
export function forgeErrorWords(kind: ForgeKind, err: ForgeErrorInfo, now = Date.now()): ErrorWords {
  const name = forgeWords[kind].name;
  const words: Record<ForgeErrorKind, ErrorWords> = {
    auth: { title: `${name} refused the token`, detail: "It may have been revoked. Update it in Settings › Integrations.", action: "connection" },
    expired: { title: `The ${name} token has expired`, detail: "Create a new one and paste it in Settings › Integrations.", action: "connection" },
    permission: { title: `The token cannot read this`, detail: `${err.message}. Check the token's scopes in Settings › Integrations.`, action: "connection" },
    unreachable: { title: `${name} did not answer`, detail: "Check the network or VPN, and whether the instance is up.", action: "retry" },
    tls: { title: `${name}'s certificate is not trusted`, detail: "This machine does not trust the instance's certificate. Add its CA to the system, or set NODE_EXTRA_CA_CERTS.", action: "retry" },
    "rate-limit": {
      title: `${name} asked to slow down`,
      detail: err.retryAfter != null ? `Try again ${retryWords(err.retryAfter, now)}.` : "Try again in a minute.",
      action: "retry",
    },
    incompatible: { title: `This is not a ${name} API`, detail: `${err.message}. Check the address in Settings › Integrations.`, action: "connection" },
    "not-found": { title: "Not found", detail: "It was deleted, moved, or this token cannot see it.", action: "retry" },
    upstream: { title: `${name} answered with an error`, detail: err.message, action: "retry" },
    invalid: { title: "The deck could not ask for that", detail: err.message, action: "retry" },
  };
  return words[err.kind] ?? words.upstream;
}

function retryWords(seconds: number, now: number): string {
  if (seconds < 60) return `in ${Math.max(1, seconds)}s`;
  const at = new Date(now + seconds * 1000);
  return `after ${at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

// ── groups ───────────────────────────────────────────────────────────────

/** The Branches page's two groups, each in the order the forge gave. */
export function splitBranches(items: ForgeBranch[]): { active: ForgeBranch[]; stale: ForgeBranch[] } {
  const active: ForgeBranch[] = [];
  const stale: ForgeBranch[] = [];
  for (const b of items) (b.stale && !b.isDefault ? stale : active).push(b);
  return { active, stale };
}

/** Review requests split the way the owner reads them: still waiting on me,
 *  and already approved by me (folded). */
export function splitReviews(items: ForgeChange[]): { waiting: ForgeChange[]; approved: ForgeChange[] } {
  const waiting: ForgeChange[] = [];
  const approved: ForgeChange[] = [];
  for (const c of items) (c.approvedByMe ? approved : waiting).push(c);
  return { waiting, approved };
}

/** Keeps the rows whose key or title holds the query, case-insensitively —
 *  the panel's search over what is loaded. */
export function matchesQuery(row: { key?: string; title?: string; name?: string; number?: number }, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [row.key, row.title, row.name, row.number != null ? String(row.number) : null]
    .filter((s): s is string => typeof s === "string")
    .join("\n")
    .toLowerCase();
  return q.replace(/^[#!]/, "").split(/\s+/).every(w => hay.includes(w));
}

/** Whether a query is a URL or a full key worth asking the forge to resolve. */
export function looksLikeRef(query: string): boolean {
  const q = query.trim();
  return /^https?:\/\/\S+\/(?:-\/)?(?:merge_requests|issues|pull)\/\d+/.test(q) || /^[\w.-]+(?:\/[\w.-]+)+[#!]\d+$/.test(q);
}

// ── what a panel remembers ───────────────────────────────────────────────

export type ForgeTab = "branches" | "changes" | "pipelines" | "issues";

export interface ForgeView {
  /** The project or repository; null is "All projects" where a tab allows it. */
  repo: string | null;
  tab: ForgeTab;
  filter: ChangeFilter;
  state: ChangeState;
  sort: "created" | "updated";
  issueState: "open" | "closed";
  /** Groups the user unfolded (stale branches, approved reviews…). */
  open: string[];
}

export const DEFAULT_VIEW: ForgeView = {
  repo: null, tab: "branches", filter: "all", state: "open", sort: "created", issueState: "open", open: [],
};

const TABS: ForgeTab[] = ["branches", "changes", "pipelines", "issues"];
const VIEW_KEY = "view";

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A panel's remembered view for one connection (the host scopes the store to
 *  it); anything unreadable falls back to the default, field by field. */
export function loadForgeView(prefs: ForgePrefs): ForgeView {
  return normaliseView(prefs.read(VIEW_KEY, isObject) ?? {});
}

export function saveForgeView(prefs: ForgePrefs, view: ForgeView): void {
  prefs.write(VIEW_KEY, view);
}

export function normaliseView(raw: Record<string, unknown>): ForgeView {
  const pick = <T,>(v: unknown, ok: readonly T[], d: T): T => (ok.includes(v as T) ? (v as T) : d);
  return {
    repo: typeof raw.repo === "string" && raw.repo.length <= 255 ? raw.repo : null,
    tab: pick(raw.tab, TABS, DEFAULT_VIEW.tab),
    filter: pick(raw.filter, ["all", "mine", "review"] as const, DEFAULT_VIEW.filter),
    state: pick(raw.state, ["open", "merged", "closed"] as const, DEFAULT_VIEW.state),
    sort: pick(raw.sort, ["created", "updated"] as const, DEFAULT_VIEW.sort),
    issueState: pick(raw.issueState, ["open", "closed"] as const, DEFAULT_VIEW.issueState),
    open: Array.isArray(raw.open) ? raw.open.filter((s): s is string => typeof s === "string").slice(0, 20) : [],
  };
}

/** Tabs that read across projects when none is picked; the others need one. */
export function tabAllowsAllProjects(kind: ForgeKind, tab: ForgeTab): boolean {
  if (tab === "branches") return false;
  // GitHub's issues tab is a repository's issue list; GitLab's is "assigned to
  // me", which is across projects by nature.
  if (tab === "issues") return kind === "gitlab";
  return true;
}
