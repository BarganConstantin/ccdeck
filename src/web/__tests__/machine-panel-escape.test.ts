// The machine panel's × said "Close (Esc)" while nothing on the deck listened
// for that press on its behalf.
//
// SystemPanel is deliberately not a dialog — no scrim, no focus trap, docked in
// the right rail beside the usage panel — and it followed that idiom so closely
// that it also registered no dismisser with modalStack. So the × named a key
// the panel could not answer. App.tsx's handler asked escapeOutcome, got no
// overlay on the stack, and fell through to its last case: it blurred the
// focused element and called clearSelection(). The panel stayed open and the
// canvas selection — which on a forty-node deck is built one shift-click at a
// time — was gone, with no undo and no relation to anything the user had asked
// for. Pressing the advertised key destroyed work and left the thing it
// promised to close still on screen.
//
// Every other non-modal surface on the deck names the key it really answers:
// the sidebar's close says "Hide sidebar (L)", the usage panel's says
// "Close (U)", the accounts panel's says "Close (A)". The machine meter has no
// letter of its own, which is exactly why its × reached for Esc — and why the
// honest repair is to make Esc true rather than to strike it off the label.
//
// So the panel now registers a dismisser like the dialogs do, but at
// PANEL_LAYER rather than their default, and escapeOutcome grew the one bit it
// needed to tell a docked panel from a dialog. This file pins the whole order
// the key resolves in, because the failure mode of a fix like this is not "the
// panel does not close" — it is "the panel closes and takes the tool modal's
// Escape with it", which is a worse bug than the one that was reported.
//
// Shaped the way the rest of the keyboard suite is shaped, and for the same
// reason: there is no DOM in this suite, so the decision lives in a pure
// function and a plain list, and the half that cannot be pure — that the
// component registers at all, and that its tooltip still promises what the
// handler now delivers — is checked by reading the source as text. A tooltip
// assertion is not cosmetic here. The promise on the control and the behaviour
// behind it were the two halves of this bug, so a test that pins one without
// the other would let it come straight back.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createDismissStack,
  escapeOutcome,
  CONFIRM_LAYER,
  PANEL_LAYER,
  type EscapeContext,
  type EscapeOutcome,
} from "../modal-dismiss";

const web = fileURLToPath(new URL("..", import.meta.url));
const app = readFileSync(`${web}/App.tsx`, "utf8");
const meter = readFileSync(`${web}/components/SystemMeter.tsx`, "utf8");
const usagePanel = readFileSync(`${web}/components/UsagePanel.tsx`, "utf8");
const sessionList = readFileSync(`${web}/components/SessionList.tsx`, "utf8");
const accountsPanel = readFileSync(`${web}/components/AccountsPanel.tsx`, "utf8");

/** One row of the precedence table: what is on screen, and what the one press
 *  is allowed to mean. Named, so a failure says which surface lost its key
 *  rather than which array index disagreed. */
interface Case {
  name: string;
  ctx: EscapeContext;
  want: EscapeOutcome;
}

// The surfaces Escape can be pressed over, strongest claim first. Exhaustive
// over the three inputs escapeOutcome reads, which is the point: the bug was a
// case nobody had enumerated.
const TABLE: readonly Case[] = [
  {
    name: "a tool modal is open",
    ctx: { overlayOpen: true, panelOnTop: false, typing: false },
    want: "dismiss",
  },
  {
    name: "the shortcuts sheet is open — a dialog like any other, on the same layer",
    ctx: { overlayOpen: true, panelOnTop: false, typing: false },
    want: "dismiss",
  },
  {
    name: "a dialog is open and focus is in its own text field, the way the sign-in dialog always closed",
    ctx: { overlayOpen: true, panelOnTop: false, typing: true },
    want: "dismiss",
  },
  {
    name: "the machine panel is open and a modal is raised over it",
    ctx: { overlayOpen: true, panelOnTop: false, typing: false },
    want: "dismiss",
  },
  {
    name: "the machine panel is the only thing open — #545",
    ctx: { overlayOpen: true, panelOnTop: true, typing: false },
    want: "dismiss",
  },
  {
    name: "the machine panel is open and the user is typing an account alias",
    ctx: { overlayOpen: true, panelOnTop: true, typing: true },
    want: "blur",
  },
  {
    name: "nothing is open and the user is typing",
    ctx: { overlayOpen: false, panelOnTop: false, typing: true },
    want: "blur",
  },
  {
    name: "nothing is open and the canvas holds a selection",
    ctx: { overlayOpen: false, panelOnTop: false, typing: false },
    want: "clear-selection",
  },
];

describe("what one press of Escape means, surface by surface", () => {
  it("resolves every surface on the deck to exactly one owner", () => {
    const got = TABLE.map(c => `${c.name}: ${escapeOutcome(c.ctx)}`);
    expect(got).toEqual(TABLE.map(c => `${c.name}: ${c.want}`));
  });

  it("never reaches the canvas selection while anything dismissible is open", () => {
    // The reported failure, stated as the thing that must stay untrue. The
    // machine panel being open is now enough on its own — before #545 it was
    // not, and the press wiped a selection built by hand.
    for (const c of TABLE.filter(c => c.ctx.overlayOpen)) {
      expect(escapeOutcome(c.ctx), c.name).not.toBe("clear-selection");
    }
  });

  it("gives the machine panel the key its × has always advertised", () => {
    expect(escapeOutcome({ overlayOpen: true, panelOnTop: true, typing: false })).toBe("dismiss");
  });

  it("does not let the panel take an Escape aimed at a dialog", () => {
    // The regression that would be worse than the bug. A dialog never sits at
    // PANEL_LAYER, so `panelOnTop` is false the moment one is on top, and the
    // press goes to the dialog whether or not the panel is also open.
    for (const typing of [true, false]) {
      expect(escapeOutcome({ overlayOpen: true, panelOnTop: false, typing })).toBe("dismiss");
    }
  });

  it("does not let the panel take an Escape aimed at a text field", () => {
    // A panel covers nothing — it is docked beside the canvas — so the field
    // the user's hands are in outranks it. The second press then closes the
    // panel, which is the staged behaviour a keyboard user expects.
    expect(escapeOutcome({ overlayOpen: true, panelOnTop: true, typing: true })).toBe("blur");
    expect(escapeOutcome({ overlayOpen: true, panelOnTop: true, typing: false })).toBe("dismiss");
  });

  it("reads an absent panelOnTop as a dialog, so every older caller keeps its answer", () => {
    // The flag is optional because every overlay on this stack was a dialog
    // until the machine panel joined it, and the two call sites that predate
    // #545 must not change meaning by omission.
    expect(escapeOutcome({ overlayOpen: true, typing: false })).toBe("dismiss");
    expect(escapeOutcome({ overlayOpen: true, typing: true })).toBe("dismiss");
    expect(escapeOutcome({ overlayOpen: false, typing: false })).toBe("clear-selection");
  });
});

describe("the queue ranks a docked panel below every dialog", () => {
  it("hands the press to a modal raised over the panel, not to the panel", () => {
    const stack = createDismissStack();
    const closed: string[] = [];
    stack.push(() => closed.push("panel"), PANEL_LAYER);
    stack.push(() => closed.push("modal"));
    expect(stack.topIsPanel()).toBe(false);
    expect(stack.dismissTop()).toBe(true);
    expect(closed).toEqual(["modal"]);
  });

  it("still does, when the panel is the one that opened last", () => {
    // Arrival order cannot settle this. The panel's open state is restored from
    // localStorage, so it is usually on the stack first — but the meter is a
    // topbar button, and a deck where the panel happened to open later must not
    // start answering the tool modal's key.
    const stack = createDismissStack();
    const closed: string[] = [];
    stack.push(() => closed.push("modal"));
    stack.push(() => closed.push("panel"), PANEL_LAYER);
    expect(stack.topIsPanel()).toBe(false);
    stack.dismissTop();
    expect(closed).toEqual(["modal"]);
  });

  it("keeps the clear prompt on top of both, the way CONFIRM_LAYER already promised", () => {
    const stack = createDismissStack();
    const closed: string[] = [];
    stack.push(() => closed.push("panel"), PANEL_LAYER);
    stack.push(() => closed.push("modal"));
    stack.push(() => closed.push("prompt"), CONFIRM_LAYER);
    stack.dismissTop();
    expect(closed).toEqual(["prompt"]);
  });

  it("gives the panel its key back the moment the dialog above it unmounts", () => {
    const stack = createDismissStack();
    const closed: string[] = [];
    stack.push(() => closed.push("panel"), PANEL_LAYER);
    const unmount = stack.push(() => closed.push("modal"));
    unmount();
    expect(stack.topIsPanel()).toBe(true);
    expect(stack.dismissTop()).toBe(true);
    expect(closed).toEqual(["panel"]);
  });

  it("reports no panel on an empty queue, so Escape still reaches the canvas", () => {
    const stack = createDismissStack();
    expect(stack.topIsPanel()).toBe(false);
    expect(stack.dismissTop()).toBe(false);
    expect(escapeOutcome({ overlayOpen: stack.depth() > 0, panelOnTop: stack.topIsPanel(), typing: false }))
      .toBe("clear-selection");
  });

  it("sorts the panel below the modals rather than beside them", () => {
    expect(PANEL_LAYER).toBeLessThan(0);
    expect(PANEL_LAYER).toBeLessThan(CONFIRM_LAYER);
  });
});

describe("the panel's label and the panel's behaviour agree", () => {
  it("still promises Esc on the ×, which is the half of this that was never wrong", () => {
    expect(meter).toMatch(/aria-label="Close \(Esc\)" title="Close \(Esc\)"/);
  });

  it("now answers it, because the panel registers a dismisser while it is open", () => {
    // The half that was missing. A control that names a key and a file that
    // registers for that key are the two things this bug was the gap between,
    // so they are asserted together and in that order.
    expect(meter, "the machine panel's × names Esc but nothing registers for the key")
      .toMatch(/modalStack\.push\(/);
    expect(meter, "the panel registers as a dialog, so it would outrank a modal raised over it")
      .toMatch(/\}, PANEL_LAYER\);/);
  });

  it("registers only while the panel is on screen", () => {
    // An entry left behind by a closed panel would swallow the Escape that
    // belongs to the canvas — the reported bug, inverted. And the push has to
    // be returned from the effect, because that return IS the unregister.
    expect(meter, "the dismisser is not guarded on `open`, so a closed panel would still eat the key")
      .toMatch(/if \(!open\) return;\s*\n\s*return modalStack\.push\(/);
  });

  it("hand-rolls no Escape listener of its own", () => {
    // The rule modal-dismiss.test.ts already enforces across every component:
    // one place reads the key, and it is App.tsx.
    expect(meter).not.toMatch(/["']Escape["']/);
    expect(meter).not.toMatch(/addEventListener\(\s*["']keydown["']/);
  });
});

describe("the handler asks the new question", () => {
  it("passes the panel/dialog distinction through to escapeOutcome", () => {
    expect(app).toMatch(/escapeOutcome\(\{[^}]*panelOnTop: modalStack\.topIsPanel\(\)[^}]*\}\)/);
    expect(app).toMatch(/if \(outcome === "dismiss"\) modalStack\.dismissTop\(\);/);
  });

  it("still has the canvas branch the panel used to fall into, so this is not vacuous", () => {
    expect(app).toMatch(/if \(shouldReleaseFocusOnEscape\(target\)\) el\?\.blur\(\);\s*\n\s*clearSelection\(\);/);
  });
});

describe("the panels that advertise a letter are left alone", () => {
  // PANEL_LAYER has exactly one user, and that is the design rather than an
  // oversight: the session list, the usage panel and the accounts panel each
  // name a letter on their own close button, and sweeping them onto the stack
  // would give Escape three more owners nobody asked it to have.
  const others = [
    ["UsagePanel.tsx", usagePanel, "Close (U)"],
    ["SessionList.tsx", sessionList, "Hide sidebar (L)"],
    ["AccountsPanel.tsx", accountsPanel, "Close (A)"],
  ] as const;

  it("still names their own letter on their close button", () => {
    for (const [name, src, label] of others) {
      expect(`${name}: ${src.includes(label)}`).toBe(`${name}: true`);
    }
  });

  it("leaves them off the dismiss queue, so Escape over the canvas still clears it", () => {
    for (const [name, src] of others) {
      expect(`${name}: ${/modalStack|PANEL_LAYER/.test(src)}`).toBe(`${name}: false`);
    }
  });
});
