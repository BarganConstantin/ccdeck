// Clear is the only irreversible control on the deck, and it had no guard.
//
// The toolbar button called handleClear directly and a bare "c" on window
// called the same function. handleClear POSTs /api/clear, which empties the
// server's ring buffer and truncates events.jsonl — the file replayLog()
// rebuilds the canvas from after a restart — and then throws away the stored
// layout, the pins and the selection. One mistyped letter with the canvas
// focused destroyed every session the deck had recorded, with no prompt and no
// undo, in an app that already arms-then-confirms the far cheaper "remove
// account" button.
//
// Half of this was fixed in v1.33.89: ownsKeystroke() in shortcuts.ts keeps a
// bare letter to whichever button, select or contenteditable has focus. Focus
// on the canvas is the normal state, though, so the destructive half survived
// untouched — that is what the gate below is for.
//
// The shortcut stays a bare "c" to match r/f/l/h/u/a/j/k/t. A modifier looks
// like extra safety and buys none: Ctrl+C and Cmd+C are copy on Linux/Windows
// and macOS respectively, and isBrowserChord() hands both back to the browser
// before the letter is ever read, while Shift+C is what a Caps-locked keyboard
// sends for the same bare letter. The guard that actually holds is this one,
// where no keystroke can reach anything destructive.
//
// Kept out of App.tsx so the rule can be tested without React or a DOM, and so
// a confirmation the button honours but the shortcut skips is not expressible.

/** Where a request to clear came from. `confirmation` is the dialog's own
 *  confirm button — the one source allowed to destroy anything. */
export type ClearSource = "button" | "shortcut" | "confirmation";

/** What else is on screen when the request arrives. */
export interface ClearContext {
  /** The clear dialog is mounted and waiting for an answer. */
  confirmOpen: boolean;
  /** One of the deck's other modals is up. */
  modalOpen: boolean;
}

/** The outcome of a clear request: wipe, ask first, or drop it. */
export type ClearAction = "clear" | "confirm" | "ignore";

export function clearActionFor(source: ClearSource, ctx: ClearContext): ClearAction {
  if (source === "confirmation") {
    // Answering a question nobody asked. A second click landing after the
    // dialog has already closed would otherwise wipe a canvas that has since
    // refilled.
    return ctx.confirmOpen ? "clear" : "ignore";
  }
  // A clear dialog stacked on top of another modal is a second thing on screen
  // competing for the same keys — before modal-dismiss.ts a single Escape took
  // both down together — and the user who typed "c" into an open tool modal
  // never meant to reach Clear at all.
  if (ctx.modalOpen) return "ignore";
  // Holding "c" repeats the keydown and the button is still under the pointer
  // for a double click: neither may answer the prompt it has just raised.
  if (ctx.confirmOpen) return "ignore";
  return "confirm";
}

// ─── What clearing actually destroys, and whose it is ─────────────────────
//
// The gate above asks the right question of the wrong world. It was written for
// a deck that owns its own log, and the deck does not: events.jsonl is one file
// every deck on the machine shares by default, so the dialog's "this deletes the
// server's event log" was true in the sense that misleads — not THIS deck's log,
// everyone's (#698). The number the dialog counted made it worse: agents on this
// canvas is the figure that understates it most, because the scoped deck showing
// three agents is exactly the one whose Clear was taking out the machine-wide
// deck's three weeks.
//
// The server now refuses to empty a log this deck is not the elected writer of,
// and `GET /api/clear` says which case the user is in before they press
// anything. This turns that answer into the sentence the dialog shows. The rule
// it encodes, and the reason the copy is a function rather than a template
// inside the component: the user is never told less than what the press will
// destroy. An answer that has not arrived yet, or one that could not be read, is
// the cautious sentence — it names the shared file — because over-warning costs
// a cancelled click and under-warning costs someone's history.

/** What `GET /api/clear` says a POST to it would do. */
export interface ClearPlan {
  /** Absolute path of the log this deck would empty, or null under --no-persist. */
  path: string | null;
  /** Live decks sharing that file, this one included. */
  decks: number;
  /** Is this deck the elected writer — the one whose log it is to empty? */
  mine: boolean;
  /** The port of the deck that owns it, when that is not this one. */
  ownerPort: number | null;
}

/** The dialog's two pieces of text for one plan. */
export interface ClearCopy {
  /** The paragraph under the title. */
  note: string;
  /** The danger button's label, which stops promising "everything" when the
   *  shared log is staying put. */
  confirm: string;
}

/**
 * Read a `GET /api/clear` body. Returns null for anything unusable — a deck too
 * old to answer the route (it 404s and serves the SPA's index.html instead), a
 * request that failed, a body missing the fields — and null is the cautious
 * copy, not a silent "nothing to worry about".
 */
export function readClearPlan(body: unknown): ClearPlan | null {
  if (!body || typeof body !== "object") return null;
  const d = body as Record<string, unknown>;
  if (typeof d.decks !== "number" || typeof d.mine !== "boolean") return null;
  const owner = d.owner && typeof d.owner === "object" ? (d.owner as Record<string, unknown>).port : null;
  return {
    path: typeof d.path === "string" && d.path !== "" ? d.path : null,
    decks: d.decks,
    mine: d.mine,
    ownerPort: typeof owner === "number" ? owner : null,
  };
}

/** "the one agent" / "all 4 agents", or null when the canvas is already empty. */
function agentsOn(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? "the one agent" : `all ${count} agents`;
}

/**
 * What the confirmation says, for the plan the server gave and the agents this
 * canvas is showing.
 *
 * Five cases, and the two that matter are the ones the old single-deck copy had
 * no words for: a log this deck shares with others and is about to empty, and a
 * log that is not this deck's to empty at all.
 */
export function clearCopy(agentCount: number, plan: ClearPlan | null): ClearCopy {
  const on = agentsOn(agentCount);
  const canvas = on ? `removes ${on} on the canvas` : null;
  const join = (log: string) => `This ${canvas ? `${canvas} and ${log}` : log}`;

  // The answer never came. Say the worst thing that may be true.
  if (!plan) {
    return {
      note: `${join("deletes the event log on disk")} — the file a restarted deck replays to rebuild what you see, and the file every deck on this machine shares unless one was told otherwise. Layout, pins and selection go with it. This cannot be undone.`,
      confirm: "Clear everything",
    };
  }

  // --no-persist: nothing of this deck outlives the process anyway.
  if (!plan.path) {
    return {
      note: `${join("leaves nothing on disk — this deck keeps no event log")}. Layout, pins and selection go with it. This cannot be undone.`,
      confirm: "Clear everything",
    };
  }

  // Not ours to empty. The canvas still clears; the file stays with the deck
  // that writes it, and the user is told where to go if the file is what they
  // actually meant.
  if (!plan.mine) {
    const owner = plan.ownerPort === null
      ? "another running deck owns that file"
      : `the deck on port ${plan.ownerPort} owns that file`;
    const shared = plan.decks > 2 ? `, one of ${plan.decks} decks sharing it` : "";
    return {
      note: `${join(`leaves the event log alone: ${owner}${shared}`)}. Clearing here empties this canvas only — restart this deck and the log replays back onto it. Layout, pins and selection go with it.`,
      confirm: "Clear this canvas",
    };
  }

  // Ours, and ours alone: the deck the old copy was written for.
  if (plan.decks <= 1) {
    return {
      note: `${join("deletes this deck's event log")} — the file a restarted deck replays to rebuild what you see. Layout, pins and selection go with it. This cannot be undone.`,
      confirm: "Clear everything",
    };
  }

  // Ours, and shared. The scary sentence, and the whole point: the history that
  // goes is not only this deck's.
  const others = plan.decks - 1;
  const theirs = others === 1
    ? "That deck keeps what is on its canvas until it restarts, and then it is gone there too."
    : "Those decks keep what is on their canvases until they restart, and then it is gone there too.";
  return {
    note: `${join(`deletes the event log ${others === 1 ? "1 other running deck shares" : `${others} other running decks share`} with this one`)} — every session recorded in it, not just the ones drawn here. ${theirs} This cannot be undone.`,
    confirm: "Clear everything",
  };
}
