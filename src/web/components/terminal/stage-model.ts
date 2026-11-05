// What the stage says, decided without React or a terminal.
//
// The stage has three voices: the header's state sentence (the node's face,
// at the size of a stage), the body's state card when there is no pane to
// show, and the keys bar's account of who has the keyboard. Each is a rule
// about words and states, and every rule here is a pure function so the suite
// can hold it in plain node — the components only draw what these return.
//
// ONE WORD PER STATE, EVERYWHERE. The header IS the
// face's sentence: "waiting 6m 42s" because the face, the topbar chip and the
// navigator say "waiting", never "blocked". What the board knows about a
// session (stageStatusFrom) is the header's default, and only what the stage
// itself knows better — it is attaching, it has no pane, tmux is missing —
// overrides it (headerStatus).
//
// THE KEYS ARE terminal-keys.ts's. Which chord gives the keyboard back to the
// board, what Shift+Enter sends and who acts on each were researched and
// decided there; the stage only prints the chord and
// says who owns the keys.
import type { SizeOwner } from "../../terminal-protocol";
import type { PanelUnavailable, TerminalProvider, TerminalTarget, TmuxProgress } from "../../terminal-api";
import { shortAgo } from "../../relative-time";
import { elapsed } from "../../duration";
import { clockShort } from "../../elapsed-short";
import { t } from "../../i18n";

// ---------------------------------------------------------------------------
// The stage's own phase — what the terminal under the header is doing.

/**
 * One state of the stage body. The hook (use-terminal-session.ts) moves
 * between these; the components draw them.
 *
 *  - attaching: a ticket is being asked for, or the socket has not sent its
 *    first frame. `reconnect` is the deck coming back after a restart, when
 *    the frozen frame of this same session stays up meanwhile.
 *  - starting: a new agent is being launched.
 *  - live: the pane is drawn and streaming.
 *  - not-attachable: case C (started outside the deck) or gone (ended), with
 *    the deck's one sentence. `stillRunning` is adopt's 409.
 *  - tmux-installing: no usable tmux, and the deck is fetching its own
 *    (src/server/tmux-download.mjs); the stage asks again until it lands.
 *    `progress` is how far it has got, once the deck has said.
 *  - tmux-missing: a fact, with the line that installs it. `download` is why
 *    the deck's own tmux could not be fetched, when it tried.
 *  - ended: the session finished; its last frame stays, frozen. `atOpen`
 *    when it had already finished before this stage first drew it — a dead
 *    deck pane opened for its last frame — so the stage never saw it end and
 *    must not say it ended "just now".
 *  - detached: someone else took the pane away; the session runs on.
 *  - error: anything else, said in a sentence, with a way to try again.
 */
export type StagePhase =
  | { kind: "empty" }
  | { kind: "attaching"; reconnect: boolean }
  | { kind: "starting"; agent: TerminalProvider; cwd: string }
  | { kind: "live"; sizeOwner: SizeOwner; readOnly: boolean }
  | { kind: "not-attachable"; target: TerminalTarget; stillRunning: boolean; busy: boolean }
  | { kind: "tmux-installing"; progress?: TmuxProgress }
  | { kind: "tmux-missing"; reason: string; install?: string; download?: string; busy: boolean }
  | { kind: "ended"; atOpen?: boolean }
  | { kind: "detached" }
  /** `code`: the engine's refusal, when it is a state of this machine
   *  (terminal-api's PANEL_UNAVAILABLE). Such a card checks again in place,
   *  `busy` while it does, as the tmux card does. */
  | { kind: "error"; message: string; code?: PanelUnavailable; busy?: boolean };

export type StagePhaseKind = StagePhase["kind"];

/** Whether the terminal's own frame is what the body shows. A first attach
 *  and a switch show a state card instead — the frame in the terminal then is
 *  another session's, and drawing it under this header would be a lie. */
export function showsFrame(phase: StagePhase): boolean {
  return phase.kind === "live" || phase.kind === "ended" || phase.kind === "detached"
    || (phase.kind === "attaching" && phase.reconnect);
}

/**
 * What the terminal's host does in `phase`, given what it did before:
 *
 *  - "shown": the frame is the body (showsFrame).
 *  - "held": a switch is attaching the next session, and the last session's
 *    frame stays up, dimmed, until the next seed is drawn over it. Without
 *    it the stage blanks for the length of the attach — a blink between two
 *    terminals on every click of a tile, j/k or Next ask (v3's own critique).
 *    Dimmed, under the new name and its scan line, it reads as the stage
 *    moving on rather than as this session's screen.
 *  - "hidden": a card speaks instead.
 *
 * Only a frame that was on screen is held: a switch from a card has nothing
 * to hold, and a hold never outlives the attach it covers.
 */
export type FrameState = "shown" | "held" | "hidden";

export function frameState(previous: FrameState, phase: StagePhase): FrameState {
  if (showsFrame(phase)) return "shown";
  if (phase.kind === "attaching" && previous !== "hidden") return "held";
  return "hidden";
}

/** The host from one render to the next: its frameState, and whether the
 *  frame it shows rose out of a hold. That second fact lasts for the whole
 *  time the frame is shown — the host's first-reveal fade must not come back
 *  a render later and start over from nothing. */
export interface FrameRun { state: FrameState; afterHold: boolean }

export function frameRun(previous: FrameRun, phase: StagePhase): FrameRun {
  const state = frameState(previous.state, phase);
  const afterHold = state === "shown"
    && (previous.state === "held" || (previous.state === "shown" && previous.afterHold));
  return { state, afterHold };
}

/** Whether the stage is only on its way to a pane: a session being started,
 *  or attached with no frame on screen. Its card says what is happening and
 *  there is nothing to type into yet, so the keys bar is not drawn (V4's
 *  Attaching is the card alone). A switch that holds the last frame up is not
 *  on its way in that sense, so its bar does not blink between two sessions;
 *  nor is a reconnect, whose frame stays and whose bar says it reconnects. */
export function onItsWay(phase: StagePhase, frame: FrameState): boolean {
  return phase.kind === "starting" || (phase.kind === "attaching" && frame === "hidden");
}

/** Whether keys can go to the pane right now. */
export function canType(phase: StagePhase): boolean {
  return phase.kind === "live" && !phase.readOnly;
}

// ---------------------------------------------------------------------------
// The header's state sentence.

/** The mark and colour the header's second line takes. `waiting` is --warn
 *  with the deck's pulse; `elsewhere` a hollow --inflight ring; `ended` a
 *  square. */
export type StageState =
  | "working" | "waiting" | "idle" | "ready" | "ended" | "elsewhere"
  | "attaching" | "starting" | "detached" | "none";

export interface StageStatus {
  state: StageState;
  /** The words: "working", "waiting", "ended 14m ago". */
  phrase: string;
  /** Said right after the phrase, in the same weight: the "6m 42s" of
   *  "waiting 6m 42s", to the second as the rail row counts it. */
  emphasis?: string;
  /** The tool, at 600 in --text: "Bash". */
  tool?: string;
  /** The tool's argument, in mono --muted: "git push -u origin …". */
  arg?: string;
  /** How long the tool has run, in mono tabular figures: "7m 38s". */
  seconds?: string;
}

/** What the board knows about the session on stage, in the shape the header
 *  needs. The integrator maps AgentNodeData onto it; nothing here reads the
 *  graph. */
export interface BoardFacts {
  /** The session ended (SessionEnd, or the sweep). */
  closedAt?: number | null;
  /** An alarming wait — permission or a question, the two the topbar counts. */
  waiting?: { since: number; tool?: string; detail?: string } | null;
  /** The root agent is running a turn. */
  active: boolean;
  /** The open call the face would name, if any. */
  tool?: { name: string; subject?: string | null; startedAt?: number } | null;
  /** How many subagents are running, for a turn whose own call is a Task. */
  subagentsLive?: number;
  lastTurnEndAt?: number | null;
  /** A session the deck just started that has had no prompt yet. */
  fresh?: boolean;
  /** The session finished its turn and waits at its prompt — the card's
   *  "Your turn". It outranks `active`, which a session can still carry
   *  between its Stop and the next event, so the header never says working
   *  beside a card that says your turn. */
  yourTurn?: boolean;
}

/** "40s", "6m 42s", "1h 12m": how long a session has waited, the clock its
 *  row in the rail prints (elapsed-short.ts), so the header, the empty pane,
 *  the keys bar's next ask and the row say one wait the same way. A wait
 *  under a second is "0s": "waiting <1s" would read as no wait at all. */
export function waitedFor(ms: number): string {
  return clockShort(Math.max(0, Math.floor(ms / 1000)));
}

/**
 * The header's sentence from the board's facts, in the order a reader wants
 * to be interrupted by them: ended, then waiting on you, then working, then
 * a fresh session's invitation, then idle.
 */
export function stageStatusFrom(facts: BoardFacts, now: number): StageStatus {
  if (facts.closedAt != null) {
    const ago = shortAgo(now - facts.closedAt);
    return { state: "ended", phrase: ago === t("common.ago.now") ? t("board.stage.phrase.endedJustNow") : t("board.stage.phrase.endedAgo", { ago }) };
  }
  if (facts.waiting) {
    return {
      state: "waiting",
      phrase: t("board.queue.waiting"),
      emphasis: waitedFor(now - facts.waiting.since),
      ...(facts.waiting.tool ? { tool: facts.waiting.tool } : {}),
      ...(facts.waiting.detail ? { arg: facts.waiting.detail } : {}),
    };
  }
  if (facts.yourTurn && !facts.tool) {
    if (facts.fresh) return { state: "ready", phrase: t("board.stage.phrase.ready"), arg: t("board.stage.phrase.firstPrompt") };
    const ago = facts.lastTurnEndAt != null ? shortAgo(now - facts.lastTurnEndAt) : null;
    return { state: "idle", phrase: t("board.list.yourTurn"), ...(ago ? { arg: lastTurnWords(ago) } : {}) };
  }
  // A session that has been asked nothing waits for its first prompt, even
  // while it still reads active from its start: it is not working.
  if (facts.fresh && !facts.tool && !facts.subagentsLive) return { state: "ready", phrase: t("board.stage.phrase.ready"), arg: t("board.stage.phrase.firstPrompt") };
  if (facts.active) {
    const out: StageStatus = { state: "working", phrase: t("board.stage.phrase.working") };
    if (facts.tool) {
      out.tool = facts.tool.name;
      if (facts.tool.subject) out.arg = facts.tool.subject;
      if (facts.tool.startedAt != null) out.seconds = elapsed(facts.tool.startedAt, undefined, now);
    } else if (facts.subagentsLive) {
      out.arg = t("board.stage.subagentsRunning", { count: facts.subagentsLive });
    }
    return out;
  }
  if (facts.fresh) return { state: "ready", phrase: t("board.stage.phrase.ready"), arg: t("board.stage.phrase.firstPrompt") };
  if (facts.lastTurnEndAt != null) {
    return { state: "idle", phrase: t("board.stage.phrase.idle"), arg: lastTurnWords(shortAgo(now - facts.lastTurnEndAt)) };
  }
  return { state: "idle", phrase: t("board.stage.phrase.idle") };
}

/** "last turn 4m", or "last turn just now". */
function lastTurnWords(ago: string): string {
  return ago === t("common.ago.now") ? t("board.stage.phrase.lastTurnNow") : t("board.stage.phrase.lastTurn", { ago });
}

/** What a reconnecting pane adds to the header's "reconnecting…", and the
 *  keys bar's second half (V4's Figma). */
export const RECONNECT_NOTE_MSG = "board.stage.reconnectNote";

/**
 * What the header says once the stage's own phase is taken into account. The
 * board's sentence stands whenever the pane is up or the stage has nothing
 * better to say; the stage's knowledge wins where it is the newer fact.
 */
export function headerStatus(board: StageStatus | null, phase: StagePhase): StageStatus {
  switch (phase.kind) {
    case "empty":
      return { state: "none", phrase: "" };
    case "attaching":
      // A reconnect says what the frozen frame cannot: keys typed now go nowhere.
      return phase.reconnect
        ? { state: "attaching", phrase: t("board.stage.phrase.reconnecting"), arg: t(RECONNECT_NOTE_MSG) }
        : { state: "attaching", phrase: t("board.stage.attaching") };
    case "starting":
      return { state: "starting", phrase: t("board.stage.phrase.starting"), arg: phase.cwd };
    case "tmux-installing":
      return { state: "starting", phrase: t("board.stage.settingUpTmux") };
    case "tmux-missing":
      return { state: "detached", phrase: t("board.stage.phrase.notAttached") };
    case "error":
      // The engine is not here to attach anything: the board's "working" is
      // true of the session, but not of this panel.
      return phase.code ? { state: "detached", phrase: t("board.stage.phrase.notAttached") } : board ?? { state: "none", phrase: "" };
    case "not-attachable":
      // Started outside the deck and still running there: the board's own
      // tool and argument are still true, only the place is different.
      if (phase.target.kind === "C" && board && board.state !== "ended") {
        const { tool, arg } = board;
        return { state: "elsewhere", phrase: t("board.stage.phrase.elsewhere"), ...(tool ? { tool } : {}), ...(arg ? { arg } : {}) };
      }
      return board ?? { state: "ended", phrase: t("board.stage.phrase.ended") };
    case "ended":
      // The socket said so before the board's sweep did. "Just now" only when
      // the stage watched it happen; a pane that was already dead when it was
      // opened ended some time ago, and the stage cannot say when.
      if (board?.state === "ended") return board;
      return { state: "ended", phrase: phase.atOpen ? t("board.stage.phrase.ended") : t("board.stage.phrase.endedJustNow") };
    default:
      return board ?? { state: "none", phrase: "" };
  }
}

/** Whether the spine carries its travelling light: output is streaming and
 *  the session is not waiting on anyone. Still while it waits, and gone with
 *  the pane. */
export function spineLive(status: StageStatus, phase: StagePhase, streaming: boolean): boolean {
  return phase.kind === "live" && streaming && status.state !== "waiting";
}

// ---------------------------------------------------------------------------
// What the live region says. The stage never streams output into one (#372);
// it says when the stage changed what it shows, once.

/** Case C on Windows for a session this deck launched — the stage holds its
 *  launch, or the deck's record says so — where the deck's "started outside
 *  the deck" would be untrue. It says why the deck may not reach it, and that
 *  it was not ended. */
export const LAUNCHED_UNREACHABLE_MSG = "board.stage.launchedUnreachable";

/** Case C on Windows for a session the deck cannot say who started (the
 *  target's provenance is "unknown"): neither sentence above would be known
 *  to be true. */
export const PROVENANCE_UNKNOWN_MSG = "board.stage.provenanceUnknown";

/** Whether a card with no pane is LAUNCHED_UNREACHABLE's: case C, on Windows,
 *  for a session this deck launched — this tab's launch, or the deck's record
 *  (`provenance: "panel"`), which outlives a reload, another tab and a deck
 *  restart. Such a card offers no Reopen here — there is nothing this deck can
 *  do across sign-ins. Without either, C keeps the deck's own sentence. */
export function launchedUnreachable(target: TerminalTarget, place: { windows?: boolean; launched?: boolean }): boolean {
  return target.kind === "C" && place.windows === true && (place.launched === true || target.provenance === "panel");
}

/** Whether a card with no pane is PROVENANCE_UNKNOWN's: case C, on Windows,
 *  not known to be this deck's launch, and the deck cannot tell whose it is.
 *  It fails closed: no Reopen, as for a launch of this deck's. A target with
 *  no provenance at all (an engine route that did not carry it) keeps the
 *  deck's own sentence. */
export function provenanceUnknown(target: TerminalTarget, place: { windows?: boolean; launched?: boolean }): boolean {
  return target.kind === "C" && place.windows === true && !launchedUnreachable(target, place) && target.provenance === "unknown";
}

/** The sentence for arriving at `phase`, or null when there is nothing new to
 *  say. The integrator hands it to the deck's announcement reducer. */
export function stageAnnouncement(name: string, phase: StagePhase): string | null {
  switch (phase.kind) {
    case "live": return t("board.stage.announceLive", { name });
    case "ended": return t("board.stage.announceEnded", { name });
    case "detached": return t("board.stage.announceDetached", { name });
    case "not-attachable": return phase.stillRunning ? t("board.stage.announceStillRunning", { name }) : t("board.stage.announceNoPane", { name });
    case "tmux-installing": return t("board.stage.announceTmuxSetup");
    case "tmux-missing": return t("board.stage.announceTmuxMissing");
    case "error": return errorWords(phase.message);
    default: return null;
  }
}

/** What the Error card says when the stage cannot say more. */
export const PANEL_STOPPED_MSG = "board.stage.panelStopped";

/** The engine's own refusals of a malformed question (terminal-target.mjs
 *  checkTargetQuery): the session has no id the deck can use, or no provider.
 *  They are the server's words for its route, not for a person, and no state
 *  of the pane fits them better than the Error card's. */
const SERVER_REFUSALS: ReadonlySet<string> = new Set([
  "That is not a session id.",
  "The provider must be claude or codex.",
]);

/** The words an error is shown with: the deck's own sentence as it is, a raw
 *  server refusal as the Error card's. */
export function errorWords(message: string): string {
  return SERVER_REFUSALS.has(message.trim()) ? t(PANEL_STOPPED_MSG) : message;
}

/** What is said when the stage closes. Never "stopped": it did not stop. */
export function closedAnnouncement(name: string | null): string {
  return name ? t("board.stage.closedNamed", { name }) : t("board.stage.closed");
}

// ---------------------------------------------------------------------------
// Keys.

/** Who the keyboard belongs to. One of the two, always, and always shown. */
export type KeysOwner = "board" | "pane";

// ---------------------------------------------------------------------------
// The New session popover's project list.

export interface ProjectSeen {
  cwd: string;
  /** The board's name for it, when it has a better one than the folder. */
  name?: string;
  hue: number;
  /** When the board last heard from a session there. */
  at: number;
}

export interface ProjectChoice {
  cwd: string;
  name: string;
  hue: number;
}

/** Whether `p` is a path the deck will start an agent in: absolute, POSIX or
 *  a Windows drive. "~" is not — the deck has no shell to expand it. */
export function isAbsolutePath(p: string): boolean {
  return /^\//.test(p) || /^[A-Za-z]:[\\/]/.test(p);
}

/** The last folder in a path, either separator, trailing ones ignored. */
export function folderName(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

/**
 * The projects to offer: every distinct folder a session on the board ran in,
 * most recently heard from first — except that the folder of the session on
 * stage leads, since "another one here" is the commonest reason to ask.
 */
export function projectChoices(seen: Iterable<ProjectSeen>, currentCwd?: string | null): ProjectChoice[] {
  const latest = new Map<string, ProjectSeen>();
  for (const s of seen) {
    if (!s.cwd || !isAbsolutePath(s.cwd)) continue;
    const had = latest.get(s.cwd);
    if (!had || s.at > had.at) latest.set(s.cwd, s);
  }
  const ordered = [...latest.values()].sort((a, b) => b.at - a.at);
  const current = currentCwd ? ordered.findIndex(s => s.cwd === currentCwd) : -1;
  if (current > 0) ordered.unshift(...ordered.splice(current, 1));
  return ordered.map(s => ({ cwd: s.cwd, name: s.name || folderName(s.cwd), hue: s.hue }));
}

/**
 * A path cut to fit `max` characters from the end, which is the part that
 * tells two projects apart: "…/personal/ccdeck". The last folder is kept
 * whole when it fits, else cut itself.
 */
export function elidePath(p: string, max = 24): string {
  if (p.length <= max) return p;
  const parts = p.split(/[\\/]+/).filter(Boolean);
  const two = parts.slice(-2).join("/");
  if (two.length + 2 <= max) return `…/${two}`;
  const last = parts[parts.length - 1] ?? p;
  if (last.length + 2 <= max) return `…/${last}`;
  return `…/${last.slice(0, Math.max(1, max - 3))}…`;
}

/** The product name the stage uses for an agent. */
export function agentName(agent: TerminalProvider): string {
  return agent === "codex" ? "Codex" : "Claude Code";
}

/** The agent's short name, for a line that already says what it runs in: the
 *  Hosts dialog's "Claude · web-api · started 2h ago". */
export function agentShortName(agent: TerminalProvider): string {
  return agent === "codex" ? "Codex" : "Claude";
}
