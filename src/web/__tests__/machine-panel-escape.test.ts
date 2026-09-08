// The machine panel's × named Escape, and Escape is not the panel's key.
//
// #545 found the half of this that was plainly broken: the × said "Close (Esc)"
// while nothing on the deck listened for that press on the panel's behalf, so
// App.tsx's handler fell through to its last case, blurred the focused element
// and called clearSelection(). The panel stayed open and the canvas selection —
// which on a forty-node deck is built one shift-click at a time — was gone. A
// control that names a key must answer that key or stop naming it, and #545
// took the first branch: the panel joined modalStack at PANEL_LAYER.
//
// This is the second branch, and it is the one the panel actually wanted.
//
// SystemPanel is not a dialog. It has no scrim, no focus trap, and it does not
// close when you click elsewhere, because it is an instrument docked beside the
// work rather than something raised over it. Escape pressed with only a panel
// on screen is a press over the canvas, aimed at the canvas: it is how the
// keyboard gets back out of a card, and it is what deselects. Answering it from
// the right rail takes a key away from the surface the user is looking at, in
// order to close a surface they were reading on purpose. The usage panel, the
// session list and the accounts panel never did that — they name their own
// letter and stay off the stack — and the machine panel is the same kind of
// thing, so it is the label that was wrong.
//
// So the two ways out are the two ways in: the × on its head, and the topbar
// meter that disclosed it, which is a toggle. The × says "Close" and promises
// nothing it cannot do.
//
// This file pins both halves, because they are the two halves the bug was the
// gap between: what the control says, and what the key does. The regression it
// exists to catch is not "the panel will not close" — it is "the panel starts
// eating the canvas's Escape again", which is where this began.
//
// Shaped the way the rest of the keyboard suite is shaped: there is no DOM in
// this suite, so the decision lives in a pure function and a plain list, and
// the half that cannot be pure — that the component registers nothing, and that
// its tooltip promises nothing — is checked by reading the source as text.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createDismissStack,
  escapeOutcome,
  CONFIRM_LAYER,
  type EscapeContext,
  type EscapeOutcome,
} from "../modal-dismiss";

const web = fileURLToPath(new URL("..", import.meta.url));
const app = readFileSync(`${web}/App.tsx`, "utf8");
const dismiss = readFileSync(`${web}/modal-dismiss.ts`, "utf8");
const meter = readFileSync(`${web}/components/MachinePanel.tsx`, "utf8");
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
// over the two inputs escapeOutcome reads — it read three until the panel came
// back off the stack, and the case that has to keep working is the last one.
const TABLE: readonly Case[] = [
  {
    name: "a tool modal is open",
    ctx: { overlayOpen: true, typing: false },
    want: "dismiss",
  },
  {
    name: "a dialog is open and focus is in its own text field, the way the sign-in dialog always closed",
    ctx: { overlayOpen: true, typing: true },
    want: "dismiss",
  },
  {
    name: "the machine panel is open and a dialog is raised over it — Busiest processes",
    ctx: { overlayOpen: true, typing: false },
    want: "dismiss",
  },
  {
    name: "nothing is open and the user is typing an account alias",
    ctx: { overlayOpen: false, typing: true },
    want: "blur",
  },
  {
    name: "the machine panel is the only thing open, so the press is the canvas's",
    ctx: { overlayOpen: false, typing: false },
    want: "clear-selection",
  },
];

describe("what one press of Escape means, surface by surface", () => {
  it("resolves every surface on the deck to exactly one owner", () => {
    const got = TABLE.map(c => `${c.name}: ${escapeOutcome(c.ctx)}`);
    expect(got).toEqual(TABLE.map(c => `${c.name}: ${c.want}`));
  });

  it("gives the press to a dialog whenever one is up, from anywhere on the page", () => {
    for (const typing of [true, false]) {
      expect(escapeOutcome({ overlayOpen: true, typing })).toBe("dismiss");
    }
  });

  it("reaches the canvas with the machine panel open, which is the whole of this change", () => {
    // The panel registers nothing, so `overlayOpen` is false with only the
    // panel on screen and the press lands where a press over the canvas has
    // always landed. Stated as its own case because it is the behaviour the
    // user asked for and the one a re-registration would silently take back.
    expect(escapeOutcome({ overlayOpen: false, typing: false })).toBe("clear-selection");
  });

  it("leaves a text field its own Escape", () => {
    expect(escapeOutcome({ overlayOpen: false, typing: true })).toBe("blur");
  });

  it("reads exactly two things, so no third can quietly re-rank the surfaces", () => {
    // #545's `panelOnTop` was that third thing. It is gone from the type, from
    // the function and from the one call site, and this is what keeps it gone.
    expect(dismiss).not.toMatch(/panelOnTop/);
    expect(dismiss).not.toMatch(/PANEL_LAYER/);
    expect(dismiss).not.toMatch(/topIsPanel/);
    expect(app).not.toMatch(/panelOnTop|topIsPanel|PANEL_LAYER/);
  });
});

describe("the queue still ranks the dialogs against each other", () => {
  it("hands the press to the dialog raised most recently", () => {
    const stack = createDismissStack();
    const closed: string[] = [];
    stack.push(() => closed.push("summary"));
    stack.push(() => closed.push("modal"));
    expect(stack.dismissTop()).toBe(true);
    expect(closed).toEqual(["modal"]);
  });

  it("keeps the clear prompt on top of them, the way CONFIRM_LAYER already promised", () => {
    const stack = createDismissStack();
    const closed: string[] = [];
    stack.push(() => closed.push("summary"));
    const unmount = stack.push(() => closed.push("prompt"), CONFIRM_LAYER);
    stack.push(() => closed.push("modal"));
    stack.dismissTop();
    expect(closed).toEqual(["prompt"]);
    unmount();
  });

  it("closes the dialog opened from inside the panel and leaves the panel standing", () => {
    // Busiest processes opens from the panel's own footer and covers it. Only
    // the dialog is on the stack, so one press closes one thing — and the
    // instruments the dialog was covering are still there when it goes.
    const stack = createDismissStack();
    const closed: string[] = [];
    const unmount = stack.push(() => closed.push("processes"));
    stack.dismissTop();
    expect(closed).toEqual(["processes"]);
    // The dismisser runs the dialog's own onClose; React then unmounts it and
    // the unregister that push() handed back is what leaves the queue. Called
    // here for the same reason the hook calls it, so the next press is read
    // against a queue that matches the screen.
    unmount();
    expect(stack.depth()).toBe(0);
    expect(escapeOutcome({ overlayOpen: stack.depth() > 0, typing: false })).toBe("clear-selection");
  });

  it("reports an empty queue as no overlay, so Escape still reaches the canvas", () => {
    const stack = createDismissStack();
    expect(stack.dismissTop()).toBe(false);
    expect(escapeOutcome({ overlayOpen: stack.depth() > 0, typing: false })).toBe("clear-selection");
  });
});

describe("the panel's label and the panel's behaviour agree", () => {
  it("names no key on its ×, because it answers none", () => {
    expect(meter).toMatch(/className="glyph-btn sd-close" onClick=\{onClose\} aria-label="Close" title="Close"/);
    // Asked of what the control SAYS, not of the file: the prose above quotes
    // the label this used to carry, and a rule that could not tell a comment
    // from a tooltip would forbid writing down why it changed.
    expect(meter, "the machine panel advertises a key again").not.toMatch(/aria-label="[^"]*\(Esc\)/);
    expect(meter).not.toMatch(/title="[^"]*\(Esc\)/);
  });

  it("registers nothing on the dismiss queue", () => {
    // The half that would take the canvas's key back. Asserted on the file
    // rather than on the effect that used to be here, so any new spelling of
    // the same registration fails too.
    expect(meter).not.toMatch(/modalStack/);
    expect(meter).not.toMatch(/PANEL_LAYER/);
  });

  it("hand-rolls no Escape listener of its own", () => {
    // The rule modal-dismiss.test.ts already enforces across every component:
    // one place reads the key, and it is App.tsx.
    expect(meter).not.toMatch(/["']Escape["']/);
    expect(meter).not.toMatch(/addEventListener\(\s*["']keydown["']/);
  });

  it("keeps the two ways out that are the two ways in", () => {
    // The topbar button is a toggle, so the control that opened the panel
    // closes it — and the panel's × calls the same setter. Read from App.tsx
    // because that is where the button and the open state live: the meter that
    // used to own both is gone, and the panel is a controlled component now.
    expect(app, "the topbar button no longer toggles")
      .toMatch(/onClick=\{\(\) => setMachinePanelOpen\(o => !o\)\}/);
    expect(app, "the button does not say whether the panel is open")
      .toMatch(/aria-expanded=\{machinePanelOpen\}/);
    expect(app, "the panel is on screen with nothing mounting it")
      .toMatch(/\{machinePanelOpen && \(\s*<MachinePanel usageOpen=\{usagePanelOpen\} onClose=\{\(\) => setMachinePanelOpen\(false\)\} \/>/);
  });
});

describe("the handler asks the shorter question", () => {
  it("passes the stack's depth and nothing about panels", () => {
    expect(app).toMatch(/escapeOutcome\(\{ overlayOpen: modalStack\.depth\(\) > 0, typing: isTypingTarget\(target\) \}\)/);
    expect(app).toMatch(/if \(outcome === "dismiss"\) modalStack\.dismissTop\(\);/);
  });

  it("still has the canvas branch the press now lands in, so this is not vacuous", () => {
    expect(app).toMatch(/if \(shouldReleaseFocusOnEscape\(target\)\) el\?\.blur\(\);\s*\n\s*clearSelection\(\);/);
  });
});

describe("the four docked panels are one idiom again", () => {
  // Three of them already named their own gesture and stayed off the stack.
  // The machine panel is the fourth now, which is the point: a reader who
  // learns how one of these closes has learned how all of them close.
  const panels = [
    ["UsagePanel.tsx", usagePanel, "Close (U)"],
    ["SessionList.tsx", sessionList, "Hide sidebar (L)"],
    ["AccountsPanel.tsx", accountsPanel, "Close (A)"],
    ["MachinePanel.tsx", meter, 'aria-label="Close" title="Close"'],
  ] as const;

  it("names on its close button only what that button really does", () => {
    for (const [name, src, label] of panels) {
      expect(`${name}: ${src.includes(label)}`).toBe(`${name}: true`);
    }
  });

  it("leaves every one of them off the dismiss queue, so Escape over the canvas clears it", () => {
    for (const [name, src] of panels) {
      expect(`${name}: ${/modalStack|PANEL_LAYER/.test(src)}`).toBe(`${name}: false`);
    }
  });
});
