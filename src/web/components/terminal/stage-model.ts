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
import type { FolderRefusal, PanelUnavailable, ProjectWorktree, StopElsewhereReason, TerminalProvider, TerminalTarget, TmuxProgress } from "../../terminal-api";
import { shortAgo } from "../../relative-time";
import { elapsed } from "../../duration";
import { clockShort } from "../../elapsed-short";
import { t } from "../../i18n";
import { providerLabel } from "../../provider-copy";
import type { Provider } from "../../types";

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
 *    the deck's one sentence. `stillRunning` is adopt's 409. `held`: this
 *    pane's own Reopen here led here — the deck said the conversation is
 *    still open, and it could not be shown where it is — named by its agent,
 *    whose card then says so and offers a new session in its place.
 *    `awaitingExit`: Resume here after exit is armed for a Claude session
 *    running outside the deck. The stage keeps looking at that exact session
 *    and reopens it here, by itself, once nothing holds it any more.
 *    `stopping`: that wait was armed by Stop there and resume here, and the
 *    deck is ending Claude where it runs; `slowStop` once it still runs a
 *    while after the stop was sent. `stopIssue`: why the last Stop there and
 *    resume here stopped nothing, while nothing is armed.
 *  - tmux-installing: no usable tmux, and the deck is fetching its own
 *    (src/server/tmux-download.mjs); the stage asks again until it lands.
 *    `progress` is how far it has got, once the deck has said.
 *  - tmux-missing: a fact, with the line that installs it. `download` is why
 *    the deck's own tmux could not be fetched, when it tried.
 *  - ended: the session finished; its last frame stays, frozen. `atOpen`
 *    when it had already finished before this stage first drew it — a dead
 *    deck pane opened for its last frame — so the stage never saw it end and
 *    must not say it ended "just now". `clean` when its agent ended itself
 *    with status 0 — /exit, Ctrl+D — while this stage watched it run
 *    (endedCleanly): the pane closes then (internal #104), and the session
 *    stays on the board to reopen. `updated` when that agent was a Codex
 *    that had just updated itself (Codex's own "Update now", which asks to
 *    be restarted): the stage starts it again in the same pane, once.
 *    `busy` while a Reopen here asked for it works: the frame stays, the
 *    button says Reopening… and a second press starts nothing. `unresumed`
 *    when the session a Reopen here started ended at once
 *    (CLEAN_END_MIN_LIVE_MS): its agent could not resume the conversation,
 *    and the pane offers to try again or, as an explicit choice, a new
 *    session in the same folder.
 *  - detached: someone else took the pane away; the session runs on.
 *  - folder-gone: the folder the press needs is not one to start in — gone
 *    (a removed worktree, a project moved or renamed), not this account's
 *    to open, or not reachable right now (a disconnected drive or network
 *    folder) — found before anything was started (the stage asked the deck
 *    first), said by the deck refusing the launch or the adopt, or said by
 *    the agent itself as it ended at once (agentFolderFailure). Named, with
 *    Choose folder… (a NEW session there, never this conversation in another
 *    folder) and Check again, which runs the press again only once the folder
 *    is back; never asked again by itself. `sessionId` for a conversation,
 *    which stays with its folder; none for a launch. `frame` when it came
 *    from an ended pane, whose last frame stays and whose end bar offers the
 *    choices, Cancel among them (back to that pane as it was); else a card.
 *    `busy` while Check again asks; `checked` once one found it still gone.
 *    `there` when the agent said it could not read its working folder but
 *    the deck finds the folder there: not what failed, and never called gone.
 *  - error: anything else, said in a sentence, with a way to try again.
 *    `reopen` when it is the deck refusing a Reopen here: Try again reopens
 *    again, and a new session in the same folder is offered beside it.
 */
export type StagePhase =
  | { kind: "empty" }
  | { kind: "attaching"; reconnect: boolean }
  | { kind: "starting"; agent: TerminalProvider; cwd: string }
  | { kind: "live"; sizeOwner: SizeOwner; readOnly: boolean }
  | {
    kind: "not-attachable"; target: TerminalTarget; stillRunning: boolean; busy: boolean; held?: TerminalProvider; awaitingExit?: boolean;
    stopping?: boolean; slowStop?: boolean; stopIssue?: StopElsewhereReason;
  }
  | { kind: "tmux-installing"; progress?: TmuxProgress }
  | { kind: "tmux-missing"; reason: string; install?: string; download?: string; busy: boolean }
  | { kind: "ended"; atOpen?: boolean; clean?: boolean; updated?: boolean; busy?: boolean; unresumed?: boolean }
  | { kind: "detached" }
  | FolderGonePhase
  /** `code`: the engine's refusal, when it is a state of this machine
   *  (terminal-api's PANEL_UNAVAILABLE). Such a card checks again in place,
   *  `busy` while it does, as the tmux card does. `missing`: a Claude or a
   *  Codex session refused `agent-missing`, which the card offers to install
   *  (ClaudeInstall.tsx). `reopen`: a refused Reopen here, whose Try again
   *  reopens again (`busy` meanwhile). */
  | { kind: "error"; message: string; code?: PanelUnavailable; busy?: boolean; missing?: TerminalProvider; reopen?: boolean };

export type StagePhaseKind = StagePhase["kind"];

/** The stage's phase when the folder a press needs is not one to start in. */
export interface FolderGonePhase {
  kind: "folder-gone";
  /** The folder, as the session or the launch names it. */
  cwd: string;
  code: FolderRefusal;
  /** The agent a new session in another folder would start. */
  agent: TerminalProvider;
  /** The conversation that stays with the folder; none for a launch. */
  sessionId?: string;
  frame?: boolean;
  busy?: boolean;
  checked?: boolean;
  /** The agent could not read the folder it was started in, and the deck
   *  finds the folder there: the folder is not what failed. */
  there?: boolean;
}

/** Whether the pane shows no frame and no end bar, only a card: the cards
 *  that say why there is nothing to type into, and a folder-gone that did
 *  not come from an ended pane. */
export function paneless(phase: StagePhase): boolean {
  switch (phase.kind) {
    case "empty": case "not-attachable": case "error": case "tmux-missing": case "tmux-installing": return true;
    case "folder-gone": return phase.frame !== true;
    default: return false;
  }
}

/** How long a pane must have been live before an ending counts as the agent
 *  ending itself (internal #104). Below it, the ending is the start failing,
 *  or the deck's once-a-second word that a pane opened for its last frame
 *  was already dead, and the frame stays for the reader. */
export const CLEAN_END_MIN_LIVE_MS = 3000;

/**
 * Whether an ending the stage watched is the agent ending itself cleanly:
 * its program exited with status 0, no signal, after the pane had been live
 * for CLEAN_END_MIN_LIVE_MS. A crash, a kill, a failed start, an ending tmux
 * gave no status for, a lost socket or a restarting deck is never one: those
 * keep the pane, its last frame and Reopen.
 */
export function endedCleanly(exit: { exitStatus?: number; exitSignal?: number }, liveForMs: number): boolean {
  return exit.exitStatus === 0 && exit.exitSignal === undefined && liveForMs >= CLEAN_END_MIN_LIVE_MS;
}

/** Whether the terminal's own frame is what the body shows. A first attach
 *  and a switch show a state card instead — the frame in the terminal then is
 *  another session's, and drawing it under this header would be a lie. */
export function showsFrame(phase: StagePhase): boolean {
  return phase.kind === "live" || phase.kind === "ended" || phase.kind === "detached"
    || (phase.kind === "attaching" && phase.reconnect)
    || (phase.kind === "folder-gone" && phase.frame === true);
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

/** The header's word for a session a Reopen here could not resume, and the
 *  end bar's sentence for it ({name}: the agent). */
export const NOT_RESUMED_PHRASE_MSG = "board.stage.phrase.notResumed";
export const NOT_RESUMED_MSG = "board.stage.notResumed";
/** Reopen here's words while it works. */
export const REOPENING_MSG = "board.stage.reopening";
/** The explicit way on from a session that could not be reopened: a new
 *  session of the same agent in the same folder. Its tooltip names the agent. */
export const START_NEW_MSG = "board.stage.startNewHere";
export const START_NEW_TIP_MSG = "board.stage.startNewTip";
/** The card's first line when the deck refused a Reopen here. */
export const REOPEN_FAILED_MSG = "board.stage.reopenFailed";
/** What leads the command that resumes a Claude conversation by hand, shown
 *  with its Copy under a refused Reopen here. */
export const RESUME_BY_HAND_MSG = "board.stage.resumeByHand";

/** Resume here after exit, for a Claude session running outside the deck:
 *  the button; the card's status line while it waits for that exact session
 *  to end; and the one line that says what to do meanwhile. */
export const AFTER_EXIT_MSG = "board.stage.afterExit.arm";
export const AFTER_EXIT_WAITING_MSG = "board.stage.afterExit.waiting";
export const AFTER_EXIT_HOW_MSG = "board.stage.afterExit.how";

/** Stop there and resume here, beside Resume here after exit: the button; the
 *  card's line while it is on offer; the confirmation's title ({name}: the
 *  name the pane header shows), what happens, its warnings and its button;
 *  the line while the deck stops Claude there, and the one once Claude has
 *  not stopped after a while. */
export const STOP_ELSEWHERE_MSG = "board.stage.stopElsewhere.stop";
export const STOP_OFFER_MSG = "board.stage.stopElsewhere.offer";
export const STOP_CONFIRM_TITLE_MSG = "board.stage.stopElsewhere.title";
export const STOP_CONFIRM_WHAT_MSG = "board.stage.stopElsewhere.what";
export const STOP_WARN_TURN_MSG = "board.stage.stopElsewhere.warnTurn";
export const STOP_WARN_QUESTION_MSG = "board.stage.stopElsewhere.warnQuestion";
export const STOP_WARN_UNSENT_MSG = "board.stage.stopElsewhere.warnUnsent";
export const STOP_CONFIRM_MSG = "board.stage.stopElsewhere.confirm";
export const STOP_STOPPING_MSG = "board.stage.stopElsewhere.stopping";
export const STOP_SLOW_MSG = "board.stage.stopElsewhere.slow";

/** The one line for a Stop there and resume here that stopped nothing, by
 *  why. Every reason the deck or the page can give has one; any other is the
 *  plain one. */
export const STOP_ISSUE_MSG: Readonly<Record<StopElsewhereReason, string>> = {
  unverifiable: "board.stage.stopElsewhere.unverifiable",
  "not-found": "board.stage.stopElsewhere.unverifiable",
  ambiguous: "board.stage.stopElsewhere.unverifiable",
  background: "board.stage.stopElsewhere.background",
  "shared-parent": "board.stage.stopElsewhere.sharedParent",
  changed: "board.stage.stopElsewhere.changed",
  unsupported: "board.stage.stopElsewhere.failed",
  "not-elsewhere": "board.stage.stopElsewhere.failed",
  "signal-failed": "board.stage.stopElsewhere.failed",
  network: "board.stage.stopElsewhere.failed",
};

/** The reasons pressing Stop there and resume here again cannot change: the
 *  deck cannot tell the process, it is a background session, or the deck runs
 *  inside it. The button goes, and Resume here after exit leads. */
export const STOP_FINAL: ReadonlySet<StopElsewhereReason> = new Set(["unverifiable", "not-found", "ambiguous", "background", "shared-parent", "unsupported"]);

/** What the confirmation warns of before Claude is stopped there, by what
 *  the board says it is doing: a turn in progress stops where it is, a
 *  question or a permission prompt waiting there goes, and whatever was typed
 *  there and not sent is lost, always. */
export function stopWarnings(state: StageState | null | undefined): string[] {
  return [
    ...(state === "working" ? [STOP_WARN_TURN_MSG] : []),
    ...(state === "waiting" ? [STOP_WARN_QUESTION_MSG] : []),
    STOP_WARN_UNSENT_MSG,
  ];
}

/**
 * The command that continues a Claude conversation in a terminal of the
 * reader's own: its folder, then `claude --resume` with its id. The folder is
 * quoted for a POSIX shell (and fish) unless it is plain; the id is a UUID the
 * deck checked before it ever named the session.
 */
export function resumeCommand(cwd: string, sessionId: string): string {
  const folder = /^[\w@%+=:,./-]+$/.test(cwd) ? cwd : `'${cwd.replace(/'/g, "'\\''")}'`;
  return `cd ${folder} && claude --resume ${sessionId}`;
}

/** The folder-gone card and end bar (StagePhase `folder-gone`): its title, by
 *  why; what it says for a conversation and for a launch ({name}: the agent);
 *  Choose folder…; what a Check again that found it still gone adds; the
 *  header's word ({folder}: the folder's own name); the end bar's sentence
 *  ({what}: the title, {folder}: the path). */
export const FOLDER_GONE_MSG = "board.stage.folderGone.title";
export const FOLDER_DENIED_MSG = "board.stage.folderGone.denied";
export const FOLDER_GONE_BODY_MSG = "board.stage.folderGone.body";
export const FOLDER_GONE_LAUNCH_MSG = "board.stage.folderGone.bodyLaunch";
export const CHOOSE_FOLDER_MSG = "board.stage.folderGone.choose";
export const STILL_MISSING_MSG = "board.stage.folderGone.stillMissing";
export const STILL_DENIED_MSG = "board.stage.folderGone.stillDenied";
export const FOLDER_GONE_PHRASE_MSG = "board.stage.folderGone.phrase";
export const FOLDER_DENIED_PHRASE_MSG = "board.stage.folderGone.phraseDenied";
export const FOLDER_GONE_LEAD_MSG = "board.stage.folderGone.lead";
export const FOLDER_DENIED_LEAD_MSG = "board.stage.folderGone.leadDenied";
export const FOLDER_GONE_NEXT_MSG = "board.stage.folderGone.next";
export const FOLDER_GONE_NEXT_LAUNCH_MSG = "board.stage.folderGone.nextLaunch";
/** The same words for a folder that is not reachable right now: there, on a
 *  drive or a network folder that is disconnected, and back once it is. */
export const FOLDER_UNREACHABLE_MSG = "board.stage.folderGone.unreachable";
export const FOLDER_UNREACHABLE_BODY_MSG = "board.stage.folderGone.bodyUnreachable";
export const FOLDER_UNREACHABLE_LAUNCH_MSG = "board.stage.folderGone.bodyLaunchUnreachable";
export const STILL_UNREACHABLE_MSG = "board.stage.folderGone.stillUnreachable";
export const FOLDER_UNREACHABLE_PHRASE_MSG = "board.stage.folderGone.phraseUnreachable";
export const FOLDER_UNREACHABLE_LEAD_MSG = "board.stage.folderGone.leadUnreachable";
/** The same for an agent that could not read the folder it was started in,
 *  where the deck finds the folder there ({name}: the agent). */
export const FOLDER_THERE_LEAD_MSG = "board.stage.folderGone.leadThere";
export const FOLDER_THERE_BODY_MSG = "board.stage.folderGone.bodyThere";
export const STILL_THERE_MSG = "board.stage.folderGone.stillThere";
export const FOLDER_THERE_PHRASE_MSG = "board.stage.folderGone.phraseThere";

/** The folder-gone phase's words, by why the folder is not one to start in. */
const FOLDER_WORDS: Record<FolderGonePhase["code"], { title: string; still: string; phrase: string; lead: string }> = {
  "folder-missing": { title: FOLDER_GONE_MSG, still: STILL_MISSING_MSG, phrase: FOLDER_GONE_PHRASE_MSG, lead: FOLDER_GONE_LEAD_MSG },
  "folder-denied": { title: FOLDER_DENIED_MSG, still: STILL_DENIED_MSG, phrase: FOLDER_DENIED_PHRASE_MSG, lead: FOLDER_DENIED_LEAD_MSG },
  "folder-unreachable": { title: FOLDER_UNREACHABLE_MSG, still: STILL_UNREACHABLE_MSG, phrase: FOLDER_UNREACHABLE_PHRASE_MSG, lead: FOLDER_UNREACHABLE_LEAD_MSG },
};

/** The folder-gone title: gone, not this account's to open, or not reachable right now. */
export function folderGoneTitle(phase: FolderGonePhase): string {
  return t(FOLDER_WORDS[phase.code].title);
}

/** What the folder-gone card explains. A conversation stays with the folder
 *  it started in — the agent keeps it there — so another folder is a new
 *  session, and the old conversation waits for its folder; a launch had no
 *  conversation yet. A folder that is only unreachable says how it comes
 *  back: its drive or network folder reconnected, then Check again. */
export function folderGoneBody(phase: FolderGonePhase): string {
  const away = phase.code === "folder-unreachable" && !phase.there;
  if (phase.sessionId) return t(phase.there ? FOLDER_THERE_BODY_MSG : away ? FOLDER_UNREACHABLE_BODY_MSG : FOLDER_GONE_BODY_MSG);
  return t(away ? FOLDER_UNREACHABLE_LAUNCH_MSG : FOLDER_GONE_LAUNCH_MSG, { name: agentName(phase.agent) });
}

/** What a Check again that found the folder still gone adds, or null. */
export function folderStillGone(phase: FolderGonePhase): string | null {
  if (!phase.checked || phase.busy) return null;
  if (phase.there) return t(STILL_THERE_MSG, { name: agentName(phase.agent) });
  return t(FOLDER_WORDS[phase.code].still);
}

/** The first half of the folder-gone line: what is wrong, by the folder's
 *  name — or, for a folder that is there, by the agent's (`there`). */
function folderLead(phase: FolderGonePhase, folder: string): string {
  if (phase.there) return t(FOLDER_THERE_LEAD_MSG, { name: agentName(phase.agent), folder });
  return t(FOLDER_WORDS[phase.code].lead, { folder });
}

/**
 * The one line a folder-gone pane shows over its kept frame, and its end bar
 * says: what is gone, by the folder's name (the full path is the line's
 * tooltip), then what Choose folder… does — a new session elsewhere, the
 * conversation staying with its folder, or for a launch, the agent started in
 * another folder. A Check again that found it still gone says that instead of
 * the first half, so the line changes where the reader is looking.
 */
export function folderGoneLine(phase: FolderGonePhase): { lead: string; next: string } {
  const folder = folderName(phase.cwd);
  const lead = folderStillGone(phase) ?? folderLead(phase, folder);
  const next = phase.sessionId ? t(FOLDER_GONE_NEXT_MSG) : t(FOLDER_GONE_NEXT_LAUNCH_MSG, { name: agentName(phase.agent) });
  return { lead, next };
}

/** The folder, cut to a line: its end, which tells two projects apart. The
 *  full path goes in the tooltip. */
export function folderShown(cwd: string, max = 48): string {
  return elidePath(cwd, max);
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
      // What it does there is the board's too (#97): a reply that is done
      // reads "waiting elsewhere", not as a session that cannot be reached.
      if (phase.target.kind === "C" && board && board.state !== "ended") {
        const { tool, arg } = board;
        return { state: "elsewhere", phrase: t(elsewherePhrase(board.state)), ...(tool ? { tool } : {}), ...(arg ? { arg } : {}) };
      }
      return board ?? { state: "ended", phrase: t("board.stage.phrase.ended") };
    case "ended":
      // A Reopen here whose agent ended at once: the stage knows why, which
      // the board's "ended 2m ago" does not say.
      if (phase.unresumed) return { state: "ended", phrase: t(NOT_RESUMED_PHRASE_MSG) };
      // The socket said so before the board's sweep did. "Just now" only when
      // the stage watched it happen; a pane that was already dead when it was
      // opened ended some time ago, and the stage cannot say when.
      if (board?.state === "ended") return board;
      return { state: "ended", phrase: phase.atOpen ? t("board.stage.phrase.ended") : t("board.stage.phrase.endedJustNow") };
    case "folder-gone":
      // The stage knows what the board cannot: the folder is not there. Its
      // own name in the word, the whole path in the tooltip.
      return {
        state: "ended",
        phrase: t(phase.there ? FOLDER_THERE_PHRASE_MSG : FOLDER_WORDS[phase.code].phrase, { folder: folderName(phase.cwd) }),
        arg: phase.cwd,
      };
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

/** The card's paragraph for a session still running in a terminal outside the
 *  deck, by what the board says it is doing there (#97). Done with its reply,
 *  it is waiting, not ended; each says how to bring it here — quit it there,
 *  and the stage, which keeps looking, offers Reopen here. A card this pane's
 *  own Reopen here led to (`held`) says instead that the conversation is
 *  still open somewhere — for Codex often its background service, which
 *  keeps it after the TUI in the pane ends — not "quit it in
 *  that terminal", which may name no terminal at all. */
export function elsewhereLine(state: StageState | null | undefined, held?: TerminalProvider): string {
  if (held) return held === "codex" ? "board.stage.held.codex" : "board.stage.held.claude";
  switch (state) {
    case "idle": case "ready": return "board.stage.elsewhere.idle";
    case "waiting": return "board.stage.elsewhere.waiting";
    case "working": return "board.stage.elsewhere.working";
    default: return "board.stage.elsewhere.running";
  }
}

/** The header's words for the same session. */
export function elsewherePhrase(state: StageState): string {
  if (state === "working") return "board.stage.phrase.workingElsewhere";
  if (state === "idle" || state === "ready" || state === "waiting") return "board.stage.phrase.waitingElsewhere";
  return "board.stage.phrase.elsewhere";
}

/** The sentence for arriving at `phase`, or null when there is nothing new to
 *  say. The integrator hands it to the deck's announcement reducer. */
export function stageAnnouncement(name: string, phase: StagePhase): string | null {
  switch (phase.kind) {
    case "live": return t("board.stage.announceLive", { name });
    case "ended": return t(phase.unresumed ? "board.stage.announceNotResumed" : "board.stage.announceEnded", { name });
    case "detached": return t("board.stage.announceDetached", { name });
    case "not-attachable": return phase.stillRunning ? t("board.stage.announceStillRunning", { name }) : t("board.stage.announceNoPane", { name });
    case "tmux-installing": return t("board.stage.announceTmuxSetup");
    case "tmux-missing": return t("board.stage.announceTmuxMissing");
    case "folder-gone": return folderStillGone(phase) ?? (phase.there ? folderLead(phase, phase.cwd) : t("board.stage.announceFolderGone", { name, folder: phase.cwd }));
    case "error": return phase.missing ? t(MISSING_MSGS[phase.missing]) : errorWords(phase.message);
    default: return null;
  }
}

/** What the card says for a Claude session refused because Claude Code is not
 *  installed: the deck's own sentence in the language on show, whatever the
 *  engine said (its Windows sentence is longer and names installers). */
export const CLAUDE_MISSING_MSG = "board.stage.claudeMissing";
/** And for a Codex session refused because Codex is not installed, the same way. */
export const CODEX_MISSING_MSG = "board.stage.codexMissing";
/** Each by the CLI that is missing. */
export const MISSING_MSGS: Readonly<Record<TerminalProvider, string>> = { claude: CLAUDE_MISSING_MSG, codex: CODEX_MISSING_MSG };

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
  worktree?: ProjectWorktree;
  /** When it was last used: a session heard from there, or the reader chose
   *  it (project-picker.ts). Orders the board's folders among the picker's. */
  at?: number;
}

/** Paths the picker can offer: POSIX absolute paths, Windows drives and UNC shares. */
export function isAbsolutePath(p: string): boolean {
  return /^\//.test(p) || /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(p);
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
  return ordered.map(s => ({ cwd: s.cwd, name: s.name || folderName(s.cwd), hue: s.hue, at: s.at }));
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

/** The product name the stage uses for an agent: provider-copy.ts's, so an
 *  opencode or Copilot session on stage is never called Claude Code. */
export function agentName(agent: Provider): string {
  return providerLabel(agent);
}

/** The agent's short name, for a line that already says what it runs in: the
 *  Hosts dialog's "Claude · web-api · started 2h ago". */
export function agentShortName(agent: TerminalProvider): string {
  return agent === "codex" ? "Codex" : "Claude";
}
