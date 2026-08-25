// Escape had no owner. Three of the deck's five modals registered a window
// keydown listener of their own, ContextModal and SessionSummary registered
// none, and App.tsx's global handler mapped the same key to clearSelection() —
// so one press did two unrelated things for three of them (close the tool
// modal, and wipe the canvas selection behind it) and nothing at all for the
// other two, where the only way out was to Tab to the ×.
//
// Stacking was the sharper edge. No listener stopped propagation, so every
// modal on screen answered the same Escape: the clear prompt raised over a
// session summary took the summary down with it. clearActionFor() refuses to
// open the prompt over a modal for exactly that reason, but a summary arrives
// on its own from a Stop hook and can still land while the prompt is up, where
// it would have answered an Escape that was aimed at the prompt.
//
// So the overlays queue here instead. Each registers a dismisser for as long as
// it is mounted, the one window listener in App.tsx asks who answers, and only
// the top of the queue does. Layer beats arrival order because the clear prompt
// is rendered last on purpose — it paints above a summary that arrives after
// it, and the thing on top is the thing Escape means.
//
// Kept out of React so the ordering rule can be tested in a plain node
// environment, the way clear-confirm.ts and shortcuts.ts are.

/** What an overlay runs when Escape reaches it — its own onClose/onCancel. */
export type Dismisser = () => void;

/** The layer of an overlay that is rendered last so it paints over every other
 *  modal, whichever of them mounted more recently. Only the clear prompt is
 *  drawn that way. */
export const CONFIRM_LAYER = 1;

/** The layer of a docked panel that answers Escape without being a dialog — the
 *  machine detail, which the topbar meter discloses into the right rail.
 *
 *  Below the modals, and not by arrival order: a panel whose open state is
 *  restored from localStorage is on the stack before any dialog exists, but a
 *  panel the user opened a moment ago would otherwise outrank a tool modal
 *  raised over it, and Escape would take the instruments down while the dialog
 *  the user is reading stayed up. Layer settles that once, the way CONFIRM_LAYER
 *  settles the clear prompt over a session summary. */
export const PANEL_LAYER = -1;

interface Entry {
  dismiss: Dismisser;
  layer: number;
  /** Mount order, so two overlays on the same layer resolve to the newer. */
  seq: number;
}

export interface DismissStack {
  /** Registers an overlay and hands back the unregister its unmount must call. */
  push(dismiss: Dismisser, layer?: number): () => void;
  /** Dismisses the overlay on top. False when there was none, which is the
   *  signal to App.tsx that Escape belongs to the canvas. */
  dismissTop(): boolean;
  /** Whether `dismiss` — the very function that was handed to push — belongs to
   *  the overlay on top. The focus trap asks this before it claims a Tab: Tab
   *  belongs to the dialog Escape would close, so one ordering settles both
   *  keys and two stacked overlays can never both answer the same press. */
  isTop(dismiss: Dismisser): boolean;
  /** How many overlays are on screen. */
  depth(): number;
  /** Whether the overlay Escape would close is a docked panel rather than a
   *  dialog — PANEL_LAYER, and nothing above it. escapeOutcome needs the
   *  distinction because a panel does not cover the page: a text field
   *  somewhere else is still the thing the user is working in, and Escape
   *  belongs to it first. False when the stack is empty. */
  topIsPanel(): boolean;
}

export function createDismissStack(): DismissStack {
  const entries: Entry[] = [];
  let seq = 0;
  // Layer first, then arrival — the order dismissTop() has always resolved in,
  // pulled out into one function so isTop() cannot drift away from it.
  function top(): Entry | undefined {
    let best: Entry | undefined;
    for (const e of entries) {
      if (!best || e.layer > best.layer || (e.layer === best.layer && e.seq > best.seq)) best = e;
    }
    return best;
  }
  return {
    push(dismiss, layer = 0) {
      const entry: Entry = { dismiss, layer, seq: seq++ };
      entries.push(entry);
      // Removal by identity, not by position: overlays do not close in the
      // order they opened, and splicing the last one would unregister whichever
      // modal happened to arrive most recently instead.
      return () => {
        const i = entries.indexOf(entry);
        if (i !== -1) entries.splice(i, 1);
      };
    },
    dismissTop() {
      const t = top();
      if (!t) return false;
      t.dismiss();
      return true;
    },
    isTop(dismiss) {
      const t = top();
      return t != null && t.dismiss === dismiss;
    },
    depth() {
      return entries.length;
    },
    topIsPanel() {
      const t = top();
      return t != null && t.layer === PANEL_LAYER;
    },
  };
}

/** The one stack the app runs on. A module-level singleton because the modals
 *  are siblings scattered across the tree with no common provider, and Escape
 *  arrives on window rather than through any of them. */
export const modalStack = createDismissStack();

export interface EscapeContext {
  /** An overlay is mounted, so the key is spoken for. */
  overlayOpen: boolean;
  /** Focus is in text the user is writing. */
  typing: boolean;
  /** The overlay on top is a docked panel rather than a dialog — see
   *  PANEL_LAYER and DismissStack.topIsPanel. Optional, and absent means "a
   *  dialog", because that is what every overlay on this stack was until the
   *  machine panel joined it. */
  panelOnTop?: boolean;
}

/** The three things Escape can mean, exactly one of which happens. */
export type EscapeOutcome = "dismiss" | "blur" | "clear-selection";

/**
 * Precedence, not a list of things that all fire. The old handler blurred the
 * field and cleared the canvas selection while the modal on screen was closing
 * itself on the very same press.
 *
 * Every surface on the deck that answers Escape, strongest claim first:
 *
 *   1. a DIALOG — tool, context, usage history, session summary, sign-in, the
 *      shortcuts sheet, the clear prompt. It covers the page behind a scrim, so
 *      a press means the dialog even from inside the dialog's own text field:
 *      that is what the sign-in dialog already did, and a keyboard user
 *      pressing Escape in a dialog means the dialog. Two dialogs at once are
 *      ranked against each other by layer then arrival, in the stack itself.
 *   2. TEXT the user is writing — the accounts panel's alias field is the one
 *      that is reachable with no dialog up. Escape there means "leave the
 *      field", and it outranks a panel because a panel covers nothing: it is
 *      docked beside the canvas, and the field is where the user's hands are.
 *   3. a DOCKED PANEL that registered a dismisser — today only the machine
 *      detail, whose × has always promised "Close (Esc)" (#545). Before this it
 *      promised a key that fell through to case 4 and threw away the canvas
 *      selection instead, which is the whole of the bug.
 *   4. the CANVAS — release focus, clear the selection. The default, and the
 *      only case that touches the selection at all.
 *
 * The session list and the usage and accounts panels are deliberately NOT case
 * 3: they advertise a letter (L, U, A) that toggles them, register nothing
 * here, and their close buttons name that letter rather than Esc. The machine
 * meter has no letter, which is why its × named Esc in the first place.
 */
export function escapeOutcome(ctx: EscapeContext): EscapeOutcome {
  if (ctx.overlayOpen && !ctx.panelOnTop) return "dismiss";
  if (ctx.typing) return "blur";
  if (ctx.overlayOpen) return "dismiss";
  return "clear-selection";
}

/** The handful of node properties the focus-restore rule reads. Structural, and
 *  deliberately not an Element, so the rule can be tested where there is no DOM
 *  — the same shape trick FocusTarget uses in shortcuts.ts. */
export interface FocusNode {
  tagName?: string | null;
  isConnected?: boolean | null;
}

function isBody(n: FocusNode): boolean {
  return String(n.tagName ?? "").toUpperCase() === "BODY";
}

/** Whether closing an overlay should hand focus back to whatever opened it.
 *
 *  Only when focus fell to the floor: React has already removed the dialog by
 *  the time the cleanup runs, so focus that was inside it has landed on <body>,
 *  and that is the case worth repairing — dismissing the context modal left a
 *  keyboard user at the top of the document instead of on the .ctx-donut they
 *  came from. If focus has since moved somewhere real, moving it again would be
 *  the deck stealing it. The opener itself may also be gone (a node re-rendered
 *  away while the modal was up), and focusing <body> is not a restoration. */
export function shouldRestoreFocus(opener: FocusNode | null | undefined, active: FocusNode | null | undefined): boolean {
  if (!opener || !opener.isConnected || isBody(opener)) return false;
  return active == null || isBody(active);
}

// ── holding Tab inside the dialog ───────────────────────────────────────────
//
// Four of the six overlays announced `aria-modal="true"`, which tells a screen
// reader that the rest of the document is inert while the dialog is up. Nothing
// in the app made that true. Three of them did not even move focus into
// themselves on open — the tool modal left it on the bubble that was clicked —
// and none of the six contained it, so a Tab from the last control in a dialog
// walked straight out into the canvas, the toolbar and the panels behind the
// scrim, where every stop is painted over by the backdrop and none of it can be
// seen. A keyboard user had no way to know they had left, and no way back
// except Escape, which closes the dialog they were still reading.
//
// The wrap is a decision about a list and an index, so it is written as one
// here rather than as DOM handling in the hook: the hook collects the dialog's
// controls, finds the focused one among them, and does what this says. Which
// keeps the whole rule readable in a plain-node test, the way escapeOutcome and
// shouldRestoreFocus already are.

/** Which controls a dialog offers the keyboard. Everything the deck actually
 *  builds a dialog out of, plus `[tabindex]` so anything hand-rolled later is
 *  caught by the same sweep. Whether a match is really tabbable — disabled,
 *  removed from the order, not drawn — is isTabbable's question, not the
 *  selector's, so there is one rule and not two half-rules. */
export const TABBABLE_SELECTOR = "a[href], button, input, select, textarea, [tabindex]";

/** The properties of a candidate control the tabbability rule reads. Structural
 *  rather than an Element, for the same reason FocusTarget and FocusNode are. */
export interface TabbableNode {
  /** A disabled control is skipped by the browser's own Tab, so the trap has to
   *  skip it too — the usage modal's ↻ is disabled for as long as ccusage runs,
   *  and wrapping onto it would put focus somewhere Tab could never reach. */
  disabled?: boolean | null;
  /** Negative takes an element out of the tab order while leaving it
   *  focusable in code. */
  tabIndex?: number | null;
  /** False when the element draws nothing, because a `display: none` ancestor
   *  is not visible to a selector. Measured by the caller, which is the only
   *  side of this that has a layout. */
  rendered?: boolean | null;
}

/** Whether Tab can actually land on this control. */
export function isTabbable(n: TabbableNode | null | undefined): boolean {
  if (!n) return false;
  if (n.disabled) return false;
  if (n.rendered === false) return false;
  return (n.tabIndex ?? 0) >= 0;
}

/** A scrollable region, reduced to what decides whether Tab stops on it.
 *
 *  Not every stop in a dialog is a control. Chrome (127 and up) and Firefox
 *  both put a scrollable region in the tab order when nothing inside it is
 *  focusable, because otherwise its content could only be scrolled with a
 *  mouse — and `.modal-body` is `overflow: auto`, so the tool modal's payload
 *  pane and the session summary's body are two of exactly that. A trap built
 *  from a control selector alone would quietly take them away, which is the
 *  opposite of what a trap is for: it exists to close the exit, not to make
 *  the dialog smaller than the browser says it is. */
export interface ScrollStop {
  /** Computed overflow — "auto" or "scroll" is a region the user scrolls. */
  overflow?: string | null;
  /** Whether the content is actually taller than the box. Measured by the
   *  caller, for the same reason `rendered` is: it needs a layout. */
  overflowing?: boolean | null;
  /** Whether the region holds a control of its own. Both browsers leave the
   *  scroller out when it does, since Tab reaching that control has already
   *  reached the region. */
  hasFocusable?: boolean | null;
}

export function isScrollStop(n: ScrollStop | null | undefined): boolean {
  if (!n || !n.overflowing || n.hasFocusable) return false;
  const overflow = String(n.overflow ?? "").toLowerCase();
  return overflow === "auto" || overflow === "scroll";
}

/** Where a Tab inside an open dialog goes. */
export type TabMove =
  /** Already heading for another stop in the dialog — leave the browser to it.
   *  Doing the move ourselves would only re-implement Tab, and badly: the
   *  browser knows about reading order, shadow roots and its own focusability
   *  rules in ways a selector sweep does not. */
  | { kind: "allow" }
  /** The wrap. preventDefault, then focus the control at this index. */
  | { kind: "focus"; index: number }
  /** Nowhere to send it, so the keystroke is swallowed and focus stays put.
   *  A dialog with no controls at all cannot happen today — every one of the
   *  six has at least its × — but letting Tab out of THAT one would be the
   *  same bug with a smaller audience. */
  | { kind: "hold" };

export interface TabState {
  /** How many stops the dialog holds right now — its controls, and any
   *  scrollable region the browser stops on. */
  count: number;
  /** Where the focused element sits among them, or -1 when focus is not on one
   *  — which is what clicking a paragraph of modal text leaves behind, since
   *  focus falls to <body> and the next Tab would start from the top of the
   *  document. */
  index: number;
  shiftKey: boolean;
}

export function trapTab({ count, index, shiftKey }: TabState): TabMove {
  if (count <= 0) return { kind: "hold" };
  // Focus is loose. Pull it back to the end the user was heading for, which is
  // also how the dialog collects a focus it never managed to take on open.
  if (index < 0 || index >= count) return { kind: "focus", index: shiftKey ? count - 1 : 0 };
  if (!shiftKey && index === count - 1) return { kind: "focus", index: 0 };
  if (shiftKey && index === 0) return { kind: "focus", index: count - 1 };
  return { kind: "allow" };
}
