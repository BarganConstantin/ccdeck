// The five HTTP questions the terminal panel asks the deck before, and instead
// of, opening a socket.
//
//   GET  /api/terminal/status   is tmux here, and new enough?
//   GET  /api/terminal/target   can this session be attached to, and how?
//   POST /api/terminal/open     attach — answered with a ticket, or with why not
//   POST /api/terminal/adopt    reopen a session started outside the deck, here
//   POST /api/terminal/launch   start a new agent in a deck-owned tmux session
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

export interface TerminalTarget {
  kind: TerminalTargetKind;
  label: string;
  adoptable?: boolean;
  reason?: string;
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
const SWITCHED_OFF = "The terminal is not switched on for this deck.";
const REFUSED = "The deck refused the request from this page.";
const UNREADABLE = "The deck answered in a form this page cannot read.";

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A target as the deck describes one, or null when the body is not one. */
function targetOf(v: unknown): TerminalTarget | null {
  if (!isObject(v) || typeof v.kind !== "string" || typeof v.label !== "string") return null;
  const out: TerminalTarget = { kind: v.kind as TerminalTargetKind, label: v.label };
  if (typeof v.adoptable === "boolean") out.adoptable = v.adoptable;
  if (typeof v.reason === "string") out.reason = v.reason;
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
  if (said) return { ok: false, status, error: hint ? `${said} ${hint}` : said };
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
