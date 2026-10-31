// The HTTP questions the terminal panel asks the deck before, and instead of,
// opening a socket.
//
//   GET  /api/terminal/status     is tmux here, and new enough?
//   GET  /api/terminal/target     can this session be attached to, and how?
//   GET  /api/terminal/hosts      sessions still on an older session host
//   POST /api/terminal/open       attach — answered with a ticket, or with why not
//   POST /api/terminal/adopt      reopen a session started outside the deck, here
//   POST /api/terminal/launch     start a new agent in a deck-owned tmux session
//   POST /api/terminal/claim      is this new Codex the one a launch started?
//   POST /api/terminal/hosts/end  end the sessions the reader reviewed on one host
//
// THE TWO HOSTS ROUTES ARE WINDOWS'. A session host that the engine has moved
// on from (a newer engine, a security update) keeps its sessions running until
// they end or the reader ends them. GET /api/terminal/hosts answers
//
//   { ok: true, hosts: [{ generation, state, sessions: [{ id, name, agent,
//     cwd, conversation, started }] }], launchesRefused: null | sentence }
//
// with only the older hosts that still run sessions, and only those sessions;
// `state` is "stranded", "security" or "draining". POST
// /api/terminal/hosts/end `{ generation, sessions }` ends exactly those ids on
// that host: `{ ok: true, ended }`, or 409 `consent-outdated` when its
// sessions changed since the reader looked, or 409 `host-gone` when it no
// longer runs. An engine with no session host — Linux, macOS — refuses both
// `no-terminal`, which the panel reads as nothing to show.
//
// Same-origin fetches with relative paths, like every other call this page
// makes: the deck's request gates recognise its own page by Origin on a POST
// and by Sec-Fetch-Site on a GET, and a relative path is what keeps both
// truthful. Nothing here adds a header of its own beyond the JSON content type.
//
// EVERY ANSWER IS A VALUE, NEVER A THROW. The panel draws each of these
// outcomes as a state — tmux missing is a fact, a session started elsewhere is
// an offer, a refusal is a sentence — so a rejected promise would only be one
// more shape for it to catch and translate. A network failure, a gate's 403,
// the 404 every route gives while the flag is off and a body this page cannot
// read all come back as one `ApiFailure`, with the status when there was one.
//
// A REFUSAL KEEPS ITS CODE. When the Command Panel's engine cannot take a
// question, the deck answers one of the codes below beside its sentence
// (docs/contracts/pro-engine-host-v1.md, Refusals). The panel needs the code
// to tell a state of this machine — no engine, one that did not verify, a
// platform with no panel — from a moment the deck is waiting out, so the
// failure carries it. Any other code a route answers stays the route's own.
//
// "NOT ATTACHABLE" IS NOT A FAILURE. POST /api/terminal/open answers a session
// it cannot attach to with HTTP 200 and `{ ok: false, target }`: the deck did
// its job, and the target says what the panel should offer instead. That is
// passed through as its own shape, distinguishable by having a `target`.
//
// The fetch is injectable so the suite can answer these without a server; the
// panel never passes one.

export const TERMINAL_ROUTES = {
  status: "/api/terminal/status",
  target: "/api/terminal/target",
  open: "/api/terminal/open",
  adopt: "/api/terminal/adopt",
  launch: "/api/terminal/launch",
  claim: "/api/terminal/claim",
  hosts: "/api/terminal/hosts",
  endHosts: "/api/terminal/hosts/end",
} as const;

export type TerminalProvider = "claude" | "codex";

/** What the deck can say about tmux. No paths: the panel shows a fact and,
 *  when tmux is missing, the one line that installs it on this platform. */
export interface TmuxStatus {
  ok: boolean;
  version?: string | number[];
  /** "missing", "too-old" or "unsupported-platform" when `ok` is false, or
   *  "installing" while the deck fetches its own tmux — ask again. */
  reason?: string;
  install?: string;
  /** Why the deck's own tmux could not be fetched, when it tried and failed:
   *  download_failed, checksum_mismatch, too_large, extract_failed or
   *  does_not_run. */
  download?: string;
  /** While "installing": how far the download has got, once it has said. */
  progress?: TmuxProgress;
}

/** The deck's own tmux on its way: bytes so far (`total` null when the server
 *  did not say how many), then the check before it is used. */
export type TmuxProgress =
  | { stage: "downloading"; received: number; total: number | null }
  | { stage: "checking" };

/** A progress the deck sent, or nothing for anything that is not one. */
function progressOf(value: unknown): TmuxProgress | null {
  if (!isObject(value)) return null;
  if (value.stage === "checking") return { stage: "checking" };
  const count = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0;
  if (value.stage !== "downloading" || !count(value.received)) return null;
  return { stage: "downloading", received: value.received as number, total: count(value.total) && (value.total as number) > 0 ? value.total as number : null };
}

export interface TerminalStatus {
  ok: true;
  platform: string;
  tmux: TmuxStatus;
}

/** Which way a session can be reached — see terminal-target.mjs on the server
 *  for what each letter means. The panel needs only `label`, the one sentence
 *  it shows, and whether a "Reopen here" is on offer. */
export type TerminalTargetKind = "A" | "B" | "C" | "D" | "gone" | "unsupported";

/** Who started a case C session, as the deck recorded it (the server's
 *  panel-provenance.mjs): its Command Panel, something outside the deck, or
 *  the deck cannot tell. */
export type TerminalProvenance = "panel" | "external" | "unknown";

export interface TerminalTarget {
  kind: TerminalTargetKind;
  label: string;
  adoptable?: boolean;
  reason?: string;
  provenance?: TerminalProvenance;
}

/** A session on the board, as the routes that act on one want it named. */
export interface SessionRef {
  sessionId: string;
  provider: TerminalProvider;
  /** The session's working directory, absolute. */
  cwd: string;
}

export interface TargetAnswer {
  ok: true;
  target: TerminalTarget;
}

/** Whether a session runs in the pane a launch started, and where it is. */
export interface ClaimAnswer {
  ok: true;
  claimed: boolean;
  target: TerminalTarget;
}

/** A ticket for /api/terminal/attach, single-use and short-lived, and the
 *  target it was minted for. */
export interface Ticketed {
  ok: true;
  ticket: string;
  target: TerminalTarget;
}

/** The deck answered, and the answer is that this session has no pane to
 *  attach to. A state to draw, not an error. */
export interface NotAttachable {
  ok: false;
  target: TerminalTarget;
}

export interface Launched {
  ok: true;
  /** The new session's id, or "" for Codex, which names its session only once
   *  it has started writing a rollout. */
  sessionId: string;
  /** The deck-owned tmux session it runs in. */
  name: string;
  ticket: string;
}

/** Anything short of an answer the panel can act on. `status` is null when the
 *  deck did not answer at all. `error` is the deck's own short reason when it
 *  gave one (`still-running`, a sentence), else one written here. */
export interface ApiFailure {
  ok: false;
  status: number | null;
  error: string;
  /** The deck's refusal code, when the Command Panel's engine refused. */
  code?: PanelRefusal;
}

/** Refusals that are a state of this machine (HTTP 409): the panel says so
 *  and stops there, until the reader asks it to check again. */
export const PANEL_UNAVAILABLE = ["unsupported", "not-installed", "not-verified", "no-terminal", "failed"] as const;
/** Refusals of a moment (HTTP 503): an engine restarting, busy, or slow to
 *  answer, which the panel waits out where waiting is safe. */
export const PANEL_RECOVERING = ["restarting", "busy", "no-answer"] as const;
/** The engine's own refusals of a session it was asked to start (HTTP 409),
 *  none of them tmux's: the agent not installed, a pane already attached,
 *  as many sessions as it can run, the engine stopping, sessions still on
 *  older session hosts. Said as the engine says it, with Try again; so the
 *  launch it refused is not asked about tmux, and it is not a state the card
 *  checks again by itself. A 409 with any other code may be tmux missing. */
export const PANEL_SAID_REFUSALS = ["agent-missing", "exists", "full", "stopping", "host-generations"] as const;
/** The engine's refusals of an end of an older host's sessions: the sessions
 *  on it changed since the reader looked, or it has gone (HTTP 409), or the
 *  end itself failed (HTTP 500), which the reader may press again. */
export const HOSTS_REFUSALS = ["consent-outdated", "host-gone", "end-failed"] as const;
export type PanelUnavailable = typeof PANEL_UNAVAILABLE[number];
export type PanelRefusal = PanelUnavailable | typeof PANEL_RECOVERING[number] | typeof PANEL_SAID_REFUSALS[number] | typeof HOSTS_REFUSALS[number];

const REFUSALS: ReadonlySet<string> = new Set([...PANEL_UNAVAILABLE, ...PANEL_RECOVERING, ...PANEL_SAID_REFUSALS, ...HOSTS_REFUSALS]);

/** Whether `code` is a state of this machine rather than of a moment. */
export const panelUnavailable = (code?: string | null): code is PanelUnavailable =>
  (PANEL_UNAVAILABLE as readonly string[]).includes(code ?? "");

/** Why an older session host is still listed: the engine has moved on from
 *  it, a security update replaces it, or it closes once its sessions end. */
export type HostState = "stranded" | "security" | "draining";

/** A session still running on an older session host. `conversation` is the
 *  agent's own id for it, or "" before it has one; `started` is when, in ms. */
export interface HostSession {
  id: string;
  name: string;
  agent: TerminalProvider;
  /** Its project folder, absolute. */
  cwd: string;
  conversation: string;
  started: number;
}

export interface OlderHost {
  generation: number;
  state: HostState;
  sessions: HostSession[];
}

export interface HostsAnswer {
  ok: true;
  hosts: OlderHost[];
  /** The engine's sentence while it refuses new sessions, else null. */
  launchesRefused: string | null;
}

export interface HostsEnded {
  ok: true;
  ended: number;
}

/** What New session may ask of a new Claude: Claude Code's own flags, from
 *  the lists the deck's launcher accepts (terminal-sessions.mjs). Absent is
 *  the reader's own settings. */
export interface LaunchOptions {
  model?: "opus" | "sonnet" | "haiku";
  permissionMode?: "auto" | "acceptEdits" | "plan";
  worktree?: boolean;
}

/** The size the panel will show a session at, so it starts there. */
export interface PaneSize {
  cols: number;
  rows: number;
}

/** The panel's theme colours, `#rrggbb`, so a session starts answering a
 *  program that asks its terminal's colours with the deck's. */
export interface PaneColours {
  fg: string;
  bg: string;
}

/** Adopt's refusal when the session's original process is still alive: it
 *  must stop there before it can continue here, or two agents write one log. */
export const STILL_RUNNING = "still-running";

export interface ApiOptions {
  signal?: AbortSignal;
  fetchFn?: (input: string, init?: RequestInit) => Promise<Response>;
}

const UNREACHABLE = "The deck did not answer.";
const CANCELLED = "The request was cancelled.";
const SWITCHED_OFF = "The Command Panel is not switched on for this deck.";
const REFUSED = "The deck refused the request from this page.";
const UNREADABLE = "The deck answered in a form this page cannot read.";

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A target as the deck describes one, or null when the body is not one. */
function targetOf(v: unknown): TerminalTarget | null {
  if (!isObject(v) || typeof v.kind !== "string" || typeof v.label !== "string") return null;
  const out: TerminalTarget = { kind: v.kind as TerminalTargetKind, label: v.label };
  if (typeof v.adoptable === "boolean") out.adoptable = v.adoptable;
  if (typeof v.reason === "string") out.reason = v.reason;
  if (v.provenance === "panel" || v.provenance === "external" || v.provenance === "unknown") out.provenance = v.provenance;
  return out;
}

const ticketOf = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** What the deck answers for any /api path it has no route for — which is
 *  exactly what every terminal route answers while the flag is off. */
const UNMATCHED_API = "not found";

/** The failure for an answer that was not one the route's reader accepted. */
function failureFrom(status: number, body: unknown): ApiFailure {
  const said = isObject(body) && typeof body.error === "string" ? body.error : "";
  // Both checked before the deck's own words, because these answers HAVE
  // words — the router's generic "not found", the request gate's
  // "unauthenticated" and "cross-site request blocked" — and they are
  // diagnostics for a log, not sentences for the panel. The terminal routes
  // themselves never answer 401 or 403; only the gate in front of them does.
  if (status === 404 && (!said || said === UNMATCHED_API)) return { ok: false, status, error: SWITCHED_OFF };
  if (status === 401 || status === 403) return { ok: false, status, error: REFUSED };
  // A launch the deck's tmux refused may say what to do about it.
  const hint = isObject(body) && typeof body.hint === "string" ? body.hint : "";
  const code = isObject(body) && typeof body.code === "string" && REFUSALS.has(body.code) ? body.code as PanelRefusal : null;
  if (said) return { ok: false, status, error: hint ? `${said} ${hint}` : said, ...(code ? { code } : {}) };
  return { ok: false, status, error: UNREADABLE };
}

/**
 * One request, read into the route's own answer or into an ApiFailure.
 *
 * `accept` sees the parsed body only for a 2xx, and returns null for a body it
 * does not recognise — which is then a failure carrying the real status, so a
 * 200 with a mangled body is never mistaken for the deck saying no.
 */
async function ask<T>(
  path: string,
  init: RequestInit,
  options: ApiOptions,
  accept: (body: unknown) => T | null,
): Promise<T | ApiFailure> {
  const fetchFn = options.fetchFn ?? ((input: string, req?: RequestInit) => fetch(input, req));
  let res: Response;
  try {
    res = await fetchFn(path, options.signal ? { ...init, signal: options.signal } : init);
  } catch {
    return { ok: false, status: null, error: options.signal?.aborted ? CANCELLED : UNREACHABLE };
  }
  const body: unknown = await res.json().catch(() => null);
  if (res.ok) {
    const answer = accept(body);
    if (answer) return answer;
  }
  return failureFrom(res.status, body);
}

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const HOST_STATES: ReadonlySet<string> = new Set(["stranded", "security", "draining"]);
const SESSION_ID = /^[0-9a-f]{32}$/;

/** A session as the deck lists one, or null for anything that is not one. */
function hostSessionOf(v: unknown): HostSession | null {
  if (!isObject(v) || typeof v.id !== "string" || !SESSION_ID.test(v.id) || typeof v.name !== "string" || !v.name) return null;
  if ((v.agent !== "claude" && v.agent !== "codex") || typeof v.cwd !== "string" || typeof v.conversation !== "string") return null;
  if (typeof v.started !== "number" || !Number.isFinite(v.started)) return null;
  return { id: v.id, name: v.name, agent: v.agent, cwd: v.cwd, conversation: v.conversation, started: v.started };
}

/** A host as the deck lists one, or null — and a host with one session that
 *  is not one is not read at all: what the reader reviews is all of it. */
function olderHostOf(v: unknown): OlderHost | null {
  if (!isObject(v) || !Number.isInteger(v.generation) || typeof v.state !== "string" || !HOST_STATES.has(v.state)) return null;
  if (!Array.isArray(v.sessions)) return null;
  const sessions = v.sessions.map(hostSessionOf);
  if (sessions.some(x => x === null)) return null;
  return { generation: v.generation as number, state: v.state as HostState, sessions: sessions as HostSession[] };
}

/** Whether tmux is usable here. Asked once, when the panel first opens. */
export function terminalStatus(options: ApiOptions = {}): Promise<TerminalStatus | ApiFailure> {
  return ask<TerminalStatus>(TERMINAL_ROUTES.status, { method: "GET" }, options, body => {
    if (!isObject(body) || body.ok !== true || !isObject(body.tmux) || typeof body.tmux.ok !== "boolean") return null;
    const { progress, ...rest } = body.tmux;
    const sent = progressOf(progress);
    const tmux = { ...rest, ...(sent ? { progress: sent } : {}) } as unknown as TmuxStatus;
    return { ok: true, platform: typeof body.platform === "string" ? body.platform : "", tmux };
  });
}

/** How a session could be reached, without attaching to it. */
export function terminalTarget(ref: SessionRef, options: ApiOptions = {}): Promise<TargetAnswer | ApiFailure> {
  const query = new URLSearchParams({ session: ref.sessionId, provider: ref.provider, cwd: ref.cwd });
  return ask<TargetAnswer>(`${TERMINAL_ROUTES.target}?${query}`, { method: "GET" }, options, body => {
    const target = isObject(body) && body.ok === true ? targetOf(body.target) : null;
    return target ? { ok: true, target } : null;
  });
}

/** Whether `ref` is the session the launch named `key` started: how a Codex,
 *  which picks its own id, is recognised as the launch it came from. A yes
 *  also labels the pane with the session's id (terminal-routes, claim). */
export function claimLaunch(ref: SessionRef, key: string, options: ApiOptions = {}): Promise<ClaimAnswer | ApiFailure> {
  const { sessionId, provider, cwd } = ref;
  return ask<ClaimAnswer>(TERMINAL_ROUTES.claim, post({ key, sessionId, provider, cwd }), options, body => {
    if (!isObject(body) || body.ok !== true || typeof body.claimed !== "boolean") return null;
    const target = targetOf(body.target);
    return target ? { ok: true, claimed: body.claimed, target } : null;
  });
}

/** Attach to a session: a ticket for the socket, or the reason there is no pane. */
export function openTerminal(ref: SessionRef, options: ApiOptions = {}): Promise<Ticketed | NotAttachable | ApiFailure> {
  const { sessionId, provider, cwd } = ref;
  return ask<Ticketed | NotAttachable>(TERMINAL_ROUTES.open, post({ sessionId, provider, cwd }), options, body => {
    if (!isObject(body)) return null;
    const target = targetOf(body.target);
    if (!target) return null;
    if (body.ok === false) return { ok: false, target };
    const ticket = ticketOf(body.ticket);
    return body.ok === true && ticket ? { ok: true, ticket, target } : null;
  });
}

/** The older session hosts that still run sessions, and whether new sessions
 *  are refused while they do. A deck with no session host refuses it
 *  (`no-terminal`), as it does while the panel is off (404). */
export function terminalHosts(options: ApiOptions = {}): Promise<HostsAnswer | ApiFailure> {
  return ask<HostsAnswer>(TERMINAL_ROUTES.hosts, { method: "GET" }, options, body => {
    if (!isObject(body) || body.ok !== true || !Array.isArray(body.hosts)) return null;
    const hosts = body.hosts.map(olderHostOf);
    if (hosts.some(h => h === null)) return null;
    const said = body.launchesRefused;
    const refused = said === null ? null : typeof said === "string" && said ? said : undefined;
    if (refused === undefined) return null;
    return { ok: true, hosts: hosts as OlderHost[], launchesRefused: refused };
  });
}

/** End exactly `sessions` on the host of `generation`: the ids the reader
 *  was shown, never more. Asked once per press; a refusal is said, not
 *  asked again. */
export function endHostSessions(
  { generation, sessions }: { generation: number; sessions: readonly string[] },
  options: ApiOptions = {},
): Promise<HostsEnded | ApiFailure> {
  return ask<HostsEnded>(TERMINAL_ROUTES.endHosts, post({ generation, sessions: [...sessions] }), options, body =>
    isObject(body) && body.ok === true && Number.isInteger(body.ended) ? { ok: true, ended: body.ended as number } : null);
}

/** Reopen a session started outside the deck, in a deck-owned tmux session.
 *  Refused with STILL_RUNNING (HTTP 409) while its original process lives. */
export function adoptTerminal(ref: SessionRef, options: ApiOptions = {}, size?: PaneSize, colours?: PaneColours): Promise<Ticketed | ApiFailure> {
  const { sessionId, provider, cwd } = ref;
  const extra = { ...(size ? { cols: size.cols, rows: size.rows } : {}), ...(colours ? { colours } : {}) };
  return ask<Ticketed>(TERMINAL_ROUTES.adopt, post({ sessionId, provider, cwd, ...extra }), options, body => {
    if (!isObject(body) || body.ok !== true) return null;
    const ticket = ticketOf(body.ticket);
    const target = targetOf(body.target);
    return ticket && target ? { ok: true, ticket, target } : null;
  });
}

/** Start a new agent in `cwd`, inside a deck-owned tmux session, and get a
 *  ticket to attach to it. `key` names the launch, so asking again after an
 *  answer that never came reaches the agent it started instead of a second. */
export function launchTerminal(
  { agent, cwd, size, launch, colours, key }: { agent: TerminalProvider; cwd: string; size?: PaneSize; launch?: LaunchOptions; colours?: PaneColours; key?: string },
  options: ApiOptions = {},
): Promise<Launched | ApiFailure> {
  const extra = {
    ...(key ? { key } : {}),
    ...(size ? { cols: size.cols, rows: size.rows } : {}),
    ...(launch && Object.keys(launch).length ? { options: launch } : {}),
    ...(colours ? { colours } : {}),
  };
  return ask<Launched>(TERMINAL_ROUTES.launch, post({ agent, cwd, ...extra }), options, body => {
    if (!isObject(body) || body.ok !== true) return null;
    const ticket = ticketOf(body.ticket);
    if (!ticket || typeof body.name !== "string" || !body.name) return null;
    return { ok: true, sessionId: typeof body.sessionId === "string" ? body.sessionId : "", name: body.name, ticket };
  });
}
