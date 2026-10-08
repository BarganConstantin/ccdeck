// Every key the deck answers, and what each one reaches.
//
// Lifted out of App.tsx's `Inner` unchanged: the one window keydown listener,
// Escape's single owner, the gates that leave a focused control and an open
// modal their own keys, and the single-key shortcuts behind them. The handler
// body is byte for byte what it was; what is new is the parameter list, which
// is the first place the deck says, in one list, everything a keystroke can
// read and everything it can do. key-help.ts documents the same keys for the
// reader, and a test holds the sheet against this handler.
import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react";

import { blockedSessions, nextWaiting } from "./ambient-counts";
import { isCanvasNodeElement } from "./canvas-node-element";
import { canvasKeyIntent, shouldReleaseFocusOnEscape } from "./canvas-keys";
import type { ClearSource } from "./clear-confirm";
import { inKeyScope } from "./git-view-keys";
import { gitViewNewest } from "./git-view-request";
import { escapeOutcome, modalStack } from "./modal-dismiss";
import type { GraphState } from "./reducer";
import { isSettingsChord, type SettingsSection } from "./settings";
import { characterKeyMuted, singleKeyShortcutsOn } from "./single-key-shortcuts";
import { canvasModalOpen, closesKeySheet, isBrowserChord, isTypingTarget, ownsKeystroke, type FocusTarget, shortcutBlocked } from "./shortcuts";
import type { Theme } from "./theme";

type Read<T> = { readonly current: T };
type Toggle = Dispatch<SetStateAction<boolean>>;

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
  // ── the git view ──
  /** Whether the git view is open (components/GitView.tsx). */
  gitViewOpenRef: Read<boolean>;
  /** `g`: opens the git view on the selection, or closes it. */
  toggleGitView: () => void;
  closeGitView: (how: "key") => void;
}

export function useDeckShortcuts({
  pointerFocusRef, nodesRef, stateRef, primarySelectedIdRef, providersRef, soundOnRef,
  keyHelpOpenRef, modalOpenRef, waitingCursorRef, removeSelectedRef, activateSoundRef,
  clearSelection, selectAgent, focusAgent, stepAgent, focusSession, requestClear,
  handleRelayout, handleFit, togglePause, toggleSessionList, toggleAccountsPanel,
  setDetailOpen, setUsageHistoryOpen, setUsagePanelOpen, setMachinePanelOpen,
  setBrowserWatchOpen, setKeyHelpOpen, setTheme, openSettings,
  gitViewOpenRef, toggleGitView, closeGitView,
}: DeckShortcuts): void {
  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The listener is on window in the bubble phase, so it sees every
      // keystroke aimed at every focused control on the page. Read the four
      // things the rules need off the target — getAttribute rather than the
      // reflected .role property, which older browsers do not expose.
      const el = e.target as (HTMLElement & { type?: string }) | null;
      // A region that owns its keys keeps every one of them. The git view
      // answers its own and stops the rest before they get here; this is the
      // second wall, so that no letter typed inside it — R above all, which
      // drops every pin with no undo — can ever reach the canvas. The one
      // chord the deck claims goes through: the view lets the browser's chords
      // travel, and Settings, where the view's own switch and look are, is no
      // canvas action. It still answers to the chord's own gates below.
      if (inKeyScope(el) && !isSettingsChord(e)) return;
      const target: FocusTarget = {
        tagName: el?.tagName,
        isContentEditable: el?.isContentEditable,
        role: el?.getAttribute?.("role"),
        type: el?.type,
        pointerFocused: el != null && el === pointerFocusRef.current,
      };
      if (e.key === "Escape") {
        // One press, one owner. This branch used to clear the canvas selection
        // while whichever modal was on screen closed itself on the same event
        // — every modal listened on window too, so the tool modal shut and the
        // selection behind it vanished with it. The modals queue in
        // modal-dismiss.ts now and only the topmost answers.
        const outcome = escapeOutcome({ overlayOpen: modalStack.depth() > 0, typing: isTypingTarget(target) });
        if (outcome === "dismiss") modalStack.dismissTop();
        else if (outcome === "blur") el?.blur();
        // The git view is the layer in front of the selection: Esc closes it
        // and keeps the agent selected, one layer at a time.
        else if (gitViewOpenRef.current) closeGitView("key");
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
      // WCAG 2.1.4: with Settings › General's switch off, no key that types a
      // character does anything from here down — every letter, `?` and Space
      // — so dictation that lands on the page cannot drive the deck. Asked
      // after the chords, Escape and a focused card's own Enter and Space,
      // which are not this list's; Delete is a named key and stays too.
      if (characterKeyMuted(e.key, singleKeyShortcutsOn())) return;
      // `?` closes the sheet it opened, whatever in the sheet has focus — see
      // closesKeySheet. Asked before the gate below, which kept the key for the
      // sheet's ×, and not on a held key's repeat, which would shut the sheet
      // the same press had just opened.
      if (closesKeySheet({ key: e.key, sheetOpen: keyHelpOpenRef.current, target })) {
        if (!e.repeat) setKeyHelpOpen(false);
        return;
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
      // The git view for the selected agent, and the same key closes it. It
      // asks for a selection and the view switched on; the dialog gate above
      // has already said no dialog is in front.
      if (e.key === "g" || e.key === "G") toggleGitView();
      // The newest diff of the file the open git view shows, from anywhere —
      // the view takes the same key itself while it has focus.
      if (e.key === "n" || e.key === "N") { if (gitViewOpenRef.current) gitViewNewest(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClear, handleRelayout, handleFit, clearSelection, selectAgent, stepAgent, focusSession, focusAgent, togglePause, toggleGitView, closeGitView]);
}
