// What the stage says, decided without React or a terminal.
//
// The stage has three voices: the header's state sentence (the node's face,
// at the size of a stage), the body's state card when there is no pane to
// show, and the keys bar's account of who has the keyboard. Each is a rule
// about words and states, and every rule here is a pure function so the suite
// can hold it in plain node — the components only draw what these return.
//
// ONE WORD PER STATE, EVERYWHERE (DESIGN-UI decision 3). The header IS the
// face's sentence: "waiting 6m" because the face, the topbar chip and the
// navigator say "waiting", never "blocked". What the board knows about a
// session (stageStatusFrom) is the header's default, and only what the stage
// itself knows better — it is attaching, it has no pane, tmux is missing —
// overrides it (headerStatus).
//
// THE KEYS ARE terminal-keys.ts's. Which chord gives the keyboard back to the
// board, what Shift+Enter sends and who acts on each were researched and
// decided there (DESIGN-UI decision 4); the stage only prints the chord and
// says who owns the keys.
import type { SizeOwner } from "../../terminal-protocol";
import type { TerminalProvider, TerminalTarget } from "../../terminal-api";
import { shortAgo } from "../../relative-time";
import { elapsed } from "../../duration";

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
  | { kind: "tmux-installing" }
  | { kind: "tmux-missing"; reason: string; install?: string; download?: string; busy: boolean }
  | { kind: "ended"; atOpen?: boolean }
  | { kind: "detached" }
  | { kind: "error"; message: string };

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
  /** Drawn bold after the phrase: the "6m" of "waiting 6m". */
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

/** "40s", "6m", "1h 12m": how long a session has waited, in the face's units.
 *  Seconds in the first minute, as the face counts them: a fresh ask said as
 *  "waiting 0m" reads as no wait at all, when it is the newest thing on the
 *  board. */
export function waitedFor(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * The header's sentence from the board's facts, in the order a reader wants
 * to be interrupted by them: ended, then waiting on you, then working, then
 * a fresh session's invitation, then idle.
 */
export function stageStatusFrom(facts: BoardFacts, now: number): StageStatus {
  if (facts.closedAt != null) {
    const ago = shortAgo(now - facts.closedAt);
    return { state: "ended", phrase: ago === "just now" ? "ended just now" : `ended ${ago}` };
  }
  if (facts.waiting) {
    return {
      state: "waiting",
      phrase: "waiting",
      emphasis: waitedFor(now - facts.waiting.since),
      ...(facts.waiting.tool ? { tool: facts.waiting.tool } : {}),
      ...(facts.waiting.detail ? { arg: facts.waiting.detail } : {}),
    };
  }
  if (facts.yourTurn && !facts.tool) {
    if (facts.fresh) return { state: "ready", phrase: "ready", arg: "for a first prompt" };
    const ago = facts.lastTurnEndAt != null ? shortAgo(now - facts.lastTurnEndAt) : null;
    return { state: "idle", phrase: "your turn", ...(ago ? { arg: ago === "just now" ? "last turn just now" : `last turn ${ago}` } : {}) };
  }
  if (facts.active) {
    const out: StageStatus = { state: "working", phrase: "working" };
    if (facts.tool) {
      out.tool = facts.tool.name;
      if (facts.tool.subject) out.arg = facts.tool.subject;
      if (facts.tool.startedAt != null) out.seconds = elapsed(facts.tool.startedAt, undefined, now);
    } else if (facts.subagentsLive) {
      out.arg = `${facts.subagentsLive} ${facts.subagentsLive === 1 ? "subagent" : "subagents"} running`;
    }
    return out;
  }
  if (facts.fresh) return { state: "ready", phrase: "ready", arg: "for a first prompt" };
  if (facts.lastTurnEndAt != null) {
    const ago = shortAgo(now - facts.lastTurnEndAt);
    return { state: "idle", phrase: "idle", arg: ago === "just now" ? "last turn just now" : `last turn ${ago}` };
  }
  return { state: "idle", phrase: "idle" };
}

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
      return { state: "attaching", phrase: phase.reconnect ? "reconnecting…" : "attaching…" };
    case "starting":
      return { state: "starting", phrase: "starting…", arg: phase.cwd };
    case "tmux-installing":
      return { state: "starting", phrase: "setting up tmux…" };
    case "tmux-missing":
      return { state: "detached", phrase: "not attached" };
    case "not-attachable":
      // Started outside the deck and still running there: the board's own
      // tool and argument are still true, only the place is different.
      if (phase.target.kind === "C" && board && board.state !== "ended") {
        const { tool, arg } = board;
        return { state: "elsewhere", phrase: "running elsewhere", ...(tool ? { tool } : {}), ...(arg ? { arg } : {}) };
      }
      return board ?? { state: "ended", phrase: "ended" };
    case "ended":
      // The socket said so before the board's sweep did. "Just now" only when
      // the stage watched it happen; a pane that was already dead when it was
      // opened ended some time ago, and the stage cannot say when.
      if (board?.state === "ended") return board;
      return { state: "ended", phrase: phase.atOpen ? "ended" : "ended just now" };
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

/** The sentence for arriving at `phase`, or null when there is nothing new to
 *  say. The integrator hands it to the deck's announcement reducer. */
export function stageAnnouncement(name: string, phase: StagePhase): string | null {
  switch (phase.kind) {
    case "live": return `${name} is on the stage.`;
    case "ended": return `${name} ended. The stage shows its last frame.`;
    case "detached": return `${name} was detached from the stage. It keeps running.`;
    case "not-attachable": return phase.stillRunning ? `${name} is still running in another terminal.` : `${name} has no pane to attach to.`;
    case "tmux-installing": return "Setting up tmux for the stage.";
    case "tmux-missing": return "tmux is not installed, so the stage cannot attach.";
    case "error": return phase.message;
    default: return null;
  }
}

/** What is said when the stage closes. Never "stopped": it did not stop. */
export function closedAnnouncement(name: string | null): string {
  return name ? `Stage closed. ${name} keeps running.` : "Stage closed.";
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
