// Every key the deck answers, and what each one reaches.
//
// Lifted out of App.tsx's `Inner` unchanged: the one window keydown listener,
// Escape's single owner, the gates that leave a focused control and an open
// modal their own keys, and the single-key shortcuts behind them. The handler
// body is byte for byte what it was; what is new is the parameter list, which
// is the first place the deck says, in one list, everything a keystroke can
// read and everything it can do. key-help.ts documents the same keys for the
// reader, and a test holds the sheet against this handler.
//
// The terminal stage added two rules and nothing else (terminal-keys.ts says
// why each is shaped the way it is). A key pressed inside the pane is the
// session's, Escape included, so the handler returns before it reads anything
// — except the release chord, which it answers by giving the keys back to the
// board. And while the stage is open, j/k walk the sessions the navigator
// shows, Enter and i put the keys in the pane, and n and w take the next ask.
// With the stage closed, or the flag off, `stageRef` is absent or not open,
// no element carries the pane's attribute, and every key does exactly what it
// did before; stage-board-keys.test.ts holds the two decks side by side.
import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react";

import { blockedSessions, nextWaiting } from "./ambient-counts";
import { isCanvasNodeElement } from "./canvas-node-element";
import { canvasKeyIntent, shouldReleaseFocusOnEscape } from "./canvas-keys";
import type { ClearSource } from "./clear-confirm";
import { escapeOutcome, modalStack } from "./modal-dismiss";
import type { GraphState } from "./reducer";
import { isSettingsChord, type SettingsSection } from "./settings";
import { canvasModalOpen, closesKeySheet, isBrowserChord, isTypingTarget, ownsKeystroke, type FocusTarget, shortcutBlocked } from "./shortcuts";
import { inTerminalPanel, isReleaseChord, STAGE_FLIP_REST_MS, stageKeyIntent, stepSession, type StageKeyIntent } from "./terminal-keys";
import type { Theme } from "./theme";

type Read<T> = { readonly current: T };
type Toggle = Dispatch<SetStateAction<boolean>>;

/** What the keys can read of the terminal stage and ask of it. Callbacks, not
 *  the stage itself: this file is in the first-load chunk and the stage is not,
 *  so it knows the stage only by this shape. */
export interface StageShortcuts {
  /** Whether the stage is open. Closed, it claims no key at all. */
  open: boolean;
  /** The session on the stage now. */
  current: string | null;
  /** The sessions the navigator shows, in its reading order — down the first
   *  column, then the next — which is the order j walks. */
  order: readonly string[];
  /** The session whose navigator tile holds the element a key was pressed on,
   *  if any — so j steps on from the tile the arrows walked to, not from the
   *  stage. Left out, j steps from the stage (or from the flip in progress). */
  sessionAt?: (target: EventTarget | null) => string | null;
  /** Put the board's focus on a session's navigator tile. The stage stays
   *  where it is; it follows once the key has rested. */
  focusTile: (sessionId: string) => void;
  /** Put a session on the stage, and the keys in its pane when asked. */
  switchTo: (sessionId: string, opts: { focusPane: boolean }) => void;
  /** Hand the keys to the pane of the session already on the stage. */
  focusPane: () => void;
  /** The next ask — use-asks.ts decides which. */
  nextAsk: () => void;
  /** Give the keys back to the board: the release chord's answer. */
  release: () => void;
}

export interface DeckShortcuts {
  // ── what the keys read ──
  /** The element a pointer focused, so a pressed button does not keep the keys (#851). */
  pointerFocusRef: Read<EventTarget | null>;
  /** The nodes React Flow is drawing, to tell a card's wrapper from a drag handle's. */
  nodesRef: Read<ReadonlyArray<{ id: string }>>;
  stateRef: Read<GraphState>;
  primarySelectedIdRef: Read<string | null>;
  providersRef: Read<{ claude: boolean }>;
  /** Null until the stored sound flag has been read back. */
  soundOnRef: Read<boolean | null>;
  keyHelpOpenRef: Read<boolean>;
  /** Whether a modal this component knows about is open. */
  modalOpenRef: Read<boolean>;
  /** The blocked session W went to last (#825). Written here, read by the waiting button too. */
  waitingCursorRef: MutableRefObject<string | null>;
  removeSelectedRef: Read<() => void>;
  activateSoundRef: Read<(withShift: boolean) => void>;
  // ── what the keys do ──
  clearSelection: () => void;
  selectAgent: (id: string, additive: boolean, inspect?: boolean) => void;
  focusAgent: (id: string) => void;
  stepAgent: (direction: 1 | -1) => void;
  focusSession: (sessionId: string) => void;
  requestClear: (source: ClearSource) => void;
  handleRelayout: () => void;
  handleFit: () => void;
  togglePause: () => void;
  toggleSessionList: () => void;
  toggleAccountsPanel: () => void;
  setDetailOpen: Toggle;
  setUsageHistoryOpen: Toggle;
  setUsagePanelOpen: Toggle;
  setMachinePanelOpen: Toggle;
  setBrowserWatchOpen: Toggle;
  setKeyHelpOpen: Toggle;
  setTheme: Dispatch<SetStateAction<Theme>>;
  /** The door into Settings that the gear uses too: Cmd/Ctrl+, opens it where
   *  it was left, V at Sounds. */
  openSettings: (section?: SettingsSection) => void;
  /** The terminal stage, where the terminal flag put one. Left out, or not
   *  open, and the keys are the deck's as they always were. */
  stageRef?: Read<StageShortcuts | null>;
}

export function useDeckShortcuts({
  pointerFocusRef, nodesRef, stateRef, primarySelectedIdRef, providersRef, soundOnRef,
  keyHelpOpenRef, modalOpenRef, waitingCursorRef, removeSelectedRef, activateSoundRef,
  clearSelection, selectAgent, focusAgent, stepAgent, focusSession, requestClear,
  handleRelayout, handleFit, togglePause, toggleSessionList, toggleAccountsPanel,
  setDetailOpen, setUsageHistoryOpen, setUsagePanelOpen, setMachinePanelOpen,
  setBrowserWatchOpen, setKeyHelpOpen, setTheme, openSettings, stageRef,
}: DeckShortcuts): void {
  // keyboard shortcuts
  useEffect(() => {
    // A flip in progress: the session j/k has put the board's focus on, the
    // session the stage showed when the flipping began, and the timer that
    // moves the stage once the key rests. The stage follows the focus the way
    // a channel changes — a held j passes a session every few dozen
    // milliseconds, and attaching to each one would open a socket and replay
    // a seed for every session it passed.
    let flip: { to: string; from: string | null; timer: ReturnType<typeof setTimeout> } | null = null;
    const dropFlip = () => {
      if (flip) clearTimeout(flip.timer);
      flip = null;
    };
    const stageKey = (intent: StageKeyIntent, stage: StageShortcuts, at: EventTarget | null) => {
      if (intent.kind === "step") {
        const from = flip ? flip.from : stage.current;
        // On from wherever the board's focus is: the tile the arrows walked
        // to, else the one the flip reached, else the session on the stage.
        const here = stage.sessionAt?.(at) ?? (flip ? flip.to : stage.current);
        const to = stepSession(stage.order, here, intent.direction);
        dropFlip();
        if (to == null) return;
        stage.focusTile(to);
        const timer = setTimeout(() => {
          flip = null;
          // Never under the user's hands: if anything else moved the stage
          // while the key rested — a click on a tile, Next ask — or closed it,
          // the flip that began from the old session is stale, and the hand
          // that moved it last wins.
          const now = stageRef?.current;
          if (!now?.open || now.current !== from || now.current === to) return;
          now.switchTo(to, { focusPane: false });
        }, STAGE_FLIP_REST_MS);
        flip = { to, from, timer };
        return;
      }
      if (intent.kind === "focus-pane") {
        // Enter in the middle of a flip means the session flipped to, now,
        // with the keys in it — not the one the stage has yet to leave.
        const pending = flip;
        dropFlip();
        if (pending && pending.to !== stage.current && pending.from === stage.current) {
          stage.switchTo(pending.to, { focusPane: true });
        } else {
          stage.focusPane();
        }
        return;
      }
      dropFlip();
      stage.nextAsk();
    };
    const onKey = (e: KeyboardEvent) => {
      // The listener is on window in the bubble phase, so it sees every
      // keystroke aimed at every focused control on the page. Read the four
      // things the rules need off the target — getAttribute rather than the
      // reflected .role property, which older browsers do not expose.
      const el = e.target as (HTMLElement & { type?: string }) | null;
      const target: FocusTarget = {
        tagName: el?.tagName,
        isContentEditable: el?.isContentEditable,
        role: el?.getAttribute?.("role"),
        type: el?.type,
        pointerFocused: el != null && el === pointerFocusRef.current,
      };
      // Inside the terminal pane every key is the session's, and asked before
      // anything else here reads the keystroke. Escape most of all: the branch
      // below blurs a typing target, xterm's input is a <textarea>, and Escape
      // is how Claude Code is interrupted mid-turn — the deck answering it
      // would take the keys away at the moment the agent most needs a brake.
      // The one key that is not the session's is the release chord, whose
      // keydown xterm lets through to here untouched (terminal-keys.ts).
      if (inTerminalPanel(el)) {
        if (isReleaseChord(e)) {
          e.preventDefault();
          if (!e.repeat) stageRef?.current?.release();
        }
        return;
      }
      if (e.key === "Escape") {
        // One press, one owner. This branch used to clear the canvas selection
        // while whichever modal was on screen closed itself on the same event
        // — every modal listened on window too, so the tool modal shut and the
        // selection behind it vanished with it. The modals queue in
        // modal-dismiss.ts now and only the topmost answers.
        const outcome = escapeOutcome({ overlayOpen: modalStack.depth() > 0, typing: isTypingTarget(target) });
        if (outcome === "dismiss") modalStack.dismissTop();
        else if (outcome === "blur") el?.blur();
        else {
          // And the branch that gave the keyboard its way back. Every control
          // on this deck is a <button> or a role="button", so the gate below
          // — which is right to leave a focused control its own keys — killed
          // all thirteen single-key shortcuts the moment the first Tab landed,
          // for the rest of the session: tabbing off the end of the document
          // wraps to the first control rather than to <body>, and Escape only
          // released focus when the user was typing, which a button never is.
          // Releasing it here is what makes the next j, /, space or l work.
          // The selection still clears on the same press, so nothing about the
          // mouse's Escape changes.
          if (shouldReleaseFocusOnEscape(target)) el?.blur();
          clearSelection();
        }
        return;
      }
      // The one chord the deck claims: Cmd+, on a Mac and Ctrl+, elsewhere,
      // which is where every desktop app keeps its settings. Asked ahead of
      // the rule below that gives the browser every other chord, and held to
      // the two gates every key here answers to: a field somebody is typing
      // in keeps its keystrokes, and nothing opens behind a dialog that covers
      // the canvas — Settings over a clear prompt would be two things waiting
      // on one Escape.
      if (e.key === "," && isSettingsChord(e)) {
        if (isTypingTarget(target)) return;
        if (canvasModalOpen({ appModal: modalOpenRef.current, dialogDepth: modalStack.dialogDepth() })) return;
        e.preventDefault();
        if (!e.repeat) openSettings();
        return;
      }
      // Ctrl/Cmd/Alt chords are the browser's, not ours — Ctrl+C is copy and
      // Ctrl+R is reload, and both arrive here as the bare letter. Asked before
      // the canvas branch below rather than after the gate it used to sit
      // behind, so that Cmd+Enter on a focused card stays the browser's too.
      if (isBrowserChord(e)) return;
      // An agent card is the one focusable thing here that is not really a
      // control: React Flow makes every node a tabbable role="button" and then
      // answers Enter itself through a store write that a controlled `nodes`
      // prop skips, so the card announced itself as a button and did nothing at
      // all. This is where the keyboard gets the click's behaviour — including
      // Shift for additive, the way Shift+click already works in onNodeClick.
      // Checked against the array React Flow is rendering rather than trusted
      // from the DOM: the invisible per-session drag handles are wrappers with
      // a data-id too, and they are not agents. They are focusable={false} so
      // no keystroke should ever arrive from one, but selecting an id that is
      // not on the canvas would leave a selection nothing can show or clear.
      const focusedId = isCanvasNodeElement(el) ? el?.getAttribute?.("data-id") : null;
      const focusedNodeId = focusedId && nodesRef.current.some(n => n.id === focusedId) ? focusedId : null;
      const intent = canvasKeyIntent(e, focusedNodeId);
      if (intent.kind === "activate") {
        e.preventDefault();
        selectAgent(intent.nodeId, intent.additive);
        return;
      }
      // Arrows belong to the card, whatever React Flow does or does not do with
      // them. Delete does not: it is the deck's Remove from board (#1668).
      if (intent.kind === "node") return;
      // `?` closes the sheet it opened, whatever in the sheet has focus — see
      // closesKeySheet. Asked before the gate below, which kept the key for the
      // sheet's ×, and not on a held key's repeat, which would shut the sheet
      // the same press had just opened.
      if (closesKeySheet({ key: e.key, sheetOpen: keyHelpOpenRef.current, target })) {
        if (!e.repeat) setKeyHelpOpen(false);
        return;
      }
      // The board's keys while the stage is open: j/k walk the navigator's
      // sessions and the stage follows, Enter and i put the keys in the pane,
      // n and w take the next ask. Asked ahead of the focused-control gate
      // below because handing the keys back to the board leaves focus on a
      // button, which that gate would let keep its letters — stageKeyIntent
      // applies the same two gates itself, with a button's letters freed.
      // Whatever it declines falls through to the deck's rules unchanged.
      const stage = stageRef?.current;
      if (stage?.open) {
        const stageIntent = stageKeyIntent({
          key: e.key,
          repeat: e.repeat,
          target,
          modalOpen: canvasModalOpen({ appModal: modalOpenRef.current, dialogDepth: modalStack.dialogDepth() }),
        });
        if (stageIntent) {
          e.preventDefault();
          stageKey(stageIntent, stage, e.target);
          return;
        }
      }
      // A focused control owns its own keys: Space presses a button, letters
      // run a <select>'s type-ahead. Answering them stole the button's
      // activation key and let a bare "c" from a dropdown wipe the event log.
      //
      // A card is exempt. It wears role="button" because React Flow put it
      // there, not because it is a control the user typed into, and the two
      // keys it genuinely owns were answered above — so j still traverses and
      // / still reaches the search box while a card holds focus, which is the
      // whole point of being able to tab onto one.
      if (intent.nodeId == null && ownsKeystroke(target, e.key)) return;
      // A modal is on screen, and focus is not necessarily inside it.
      //
      // The gate above asks the FOCUSED ELEMENT whether it owns the keystroke,
      // which is the right question for a text field and the wrong one here:
      // use-modal-dismiss.ts states outright that "clicking a paragraph of modal
      // text drops focus on <body>", and BODY is in neither KEY_OWNING_TAGS nor
      // KEY_OWNING_ROLES. So reading a tool call's JSON payload, then pressing a
      // letter, ran that letter against the canvas behind the scrim.
      //
      // R is the one that hurt: handleRelayout clears every pin, every stored
      // position and both localStorage keys, so an arrangement the user built by
      // hand was gone with no undo — and they did not see it happen until they
      // closed the modal. H stacked a second modal over the first, Space paused
      // the stream, A/U/L opened panels underneath.
      //
      // This is not a new rule, it is the rule `c` already had: the comment on
      // modalOpenRef above describes this exact focus path, and the fix was
      // applied to the clear path alone. modalOpenRef was already computed and
      // already correct; it just had one caller.
      //
      // `?` is the exception, and only for the sheet itself. It is advertised as
      // a toggle, so it has to be able to close what it opened; over any OTHER
      // modal it would stack a second one, which is what this gate is for.
      // Escape is unaffected — it is answered further up, through modalStack.
      //
      // And the gate asks the stack as well as modalOpenRef (#1175): the nine
      // dialogs a panel opens — processes, history, add, share, the LAN four,
      // a pairing request, the clear prompt — have no flag in this component,
      // so the ref alone let R wipe the layout behind every one of them.
      if (shortcutBlocked({
        key: e.key,
        modalOpen: canvasModalOpen({ appModal: modalOpenRef.current, dialogDepth: modalStack.dialogDepth() }),
        sheetOpen: keyHelpOpenRef.current,
      })) return;
      // A held key is one press. Every auto-repeat used to run its shortcut
      // again, so a held Space flipped pause about thirty times a second and
      // left the stream in whichever state the key came up on, and T, L, D and
      // U flickered the same way. J and K keep repeating: holding them to step
      // through the board is what a held key is for. Space goes on to its own
      // line, which pauses on the first press only and still cancels every
      // repeat, or the page behind the canvas scrolls.
      if (e.repeat && !/^[ jkJK]$/.test(e.key)) return;
      if (e.key === " ") { e.preventDefault(); if (!e.repeat) togglePause(); }
      if (e.key === "c" || e.key === "C") requestClear("shortcut");
      if (e.key === "r" || e.key === "R") handleRelayout();
      if (e.key === "f" || e.key === "F") handleFit();
      // F is the whole board; Z is the one card the selection is on, framed
      // with its session at a readable size — the ribbon's click, on a key.
      if (e.key === "z" || e.key === "Z") {
        if (primarySelectedIdRef.current) focusAgent(primarySelectedIdRef.current);
      }
      // The detail panel's "Remove from board", one key from a selection — a
      // plain click on a card shuts that panel, so the button alone would sit
      // two gestures away. Delete and not Backspace: Backspace is the key a
      // stray press in the wrong place sends, and only the session list brings a card back.
      if (e.key === "Delete") removeSelectedRef.current();
      // The only way in, now that the topbar's ☰ is gone — and a genuine
      // toggle, so the same key that opened the sidebar closes it again. The
      // panel's own ‹ is the second way out and calls the same setter; Escape
      // is not and never was one, because the session list is an <aside> beside
      // the canvas rather than a modal, so it registers no dismisser with
      // modalStack (see modal-dismiss.ts). The shortcuts sheet below still
      // lists L, which is where the feature is discoverable from now.
      //
      // What removing the button cost the accessibility tree: aria-expanded on
      // that ☰ was the only place the panel's open/closed state was reported,
      // and nothing replaces it. It was never read on THIS path — a key pressed
      // while focus is elsewhere changes a button's state silently — so what is
      // actually lost is the ability to tab to a control and ask. The panel
      // itself is still announced when it is open: it is a named complementary
      // landmark ("Sessions") that the rotor lists, and its close button is the
      // first control in it.
      if (e.key === "l" || e.key === "L") toggleSessionList();
      // The detail panel's keyboard toggle, and no longer its only route. The
      // reopen tab that sat on the canvas edge stays gone, by the owner's
      // decision; what changed (#814, the owner's call on 2026-09-14) is that a
      // plain selection opens the panel — see selectAgent — so a panel closed
      // with its × comes back on the next card clicked instead of waiting for
      // somebody to find this key.
      //
      // With nothing selected (#845) the toggle used to flip a flag that showed
      // nothing — the panel only renders beside a selection — and the next
      // click then opened it by surprise. So D first picks something for the
      // panel to be about: the session that has waited longest, which is what
      // somebody reaching for it with nothing selected most likely wants, or
      // else the card j would land on. Selecting opens the panel by itself.
      if (e.key === "d" || e.key === "D") {
        if (primarySelectedIdRef.current) setDetailOpen(o => !o);
        else {
          const waiting = blockedSessions(stateRef.current.agents.values());
          if (waiting.length > 0) focusSession(waiting[0].id); else stepAgent(1);
        }
      }
      if (e.key === "h" || e.key === "H") setUsageHistoryOpen(o => !o);
      if (e.key === "u" || e.key === "U") setUsagePanelOpen(o => !o);
      // Nothing to disclose on a deck with no Claude Code: the button is not
      // rendered and the panel is not mounted, so an unguarded `A` would only
      // toggle a persisted flag nobody can see the effect of.
      if (e.key === "a" || e.key === "A") { if (providersRef.current.claude) toggleAccountsPanel(); }
      if (e.key === "j" || e.key === "J") stepAgent(1);
      if (e.key === "k" || e.key === "K") stepAgent(-1);
      // #825: the most urgent move in the deck, on a key. J and K walk every
      // agent in position order; W goes to the session blocked on the reader —
      // the one the "N waiting" button goes to, oldest first — and each press
      // after it to the next, wrapping. Nothing waiting, nothing happens.
      if (e.key === "w" || e.key === "W") {
        const next = nextWaiting(blockedSessions(stateRef.current.agents.values()), waitingCursorRef.current);
        if (next) {
          waitingCursorRef.current = next.id;
          focusSession(next.id);
        }
      }
      if (e.key === "t" || e.key === "T") setTheme(t => (t === "dark" ? "light" : "dark"));
      // The last topbar control to get a key, and the only one that reads
      // Shift. Every other letter here treats "C" and "c" alike — a Caps-locked
      // keyboard sends the upper case for the same press — and this one does
      // too for the toggle; what Shift adds is the keyboard's version of the
      // shift-click that puts the user's own parked hooks back, which was a
      // recovery with no key, no control and no home outside a tooltip. Same
      // control, same modifier, same outcome: activateSound is the one door
      // both devices come through, so the two can never drift apart.
      // Guarded by the state the switch waits for: before the stored flag has
      // been read back there is nothing to invert. Not by Claude Code any
      // more: the switch is in Settings › Sounds on every machine, and a Codex
      // turn plays the finish tone too, so a Codex-only deck has a sound to
      // silence and now a key to silence it with.
      if (e.key === "m" || e.key === "M") {
        if (soundOnRef.current !== null) activateSoundRef.current(e.shiftKey);
      }
      // #826: the three topbar panels that were pointer-only. S for this
      // machine (the system's readings), B for Browser Watch, and V, which
      // opened the speaker's quick popover until the speaker left the topbar
      // (2026-10-07). V opens Settings at Sounds now — the switch, each
      // tone's volume and sound, the custom sounds — through the gear's own
      // door, and held to every gate above: not while typing, not behind a
      // dialog, once per press. Not to Claude Code any more, for M's reason:
      // the section is in Settings on every machine, and a Codex turn plays
      // the finish tone too.
      if (e.key === "s" || e.key === "S") setMachinePanelOpen(o => !o);
      if (e.key === "b" || e.key === "B") setBrowserWatchOpen(o => !o);
      if (e.key === "v" || e.key === "V") openSettings("sounds");
      // The way in that does not depend on already knowing the way in. `?` is
      // the convention, it was unbound, and it is the one key on this list that
      // a user who knows nothing about the deck might still try. Everything it
      // opens is written down in key-help.ts, held against this handler by a
      // test, so the sheet cannot fall behind the keys again.
      if (e.key === "?") setKeyHelpOpen(o => !o);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      dropFlip();
    };
  }, [requestClear, handleRelayout, handleFit, clearSelection, selectAgent, stepAgent, focusSession, focusAgent, togglePause]);
}
