// Leaving the sign-in dialog (#1175).
//
// `claude auth login` runs on the SERVER. The dialog only ever watches it, so
// closing the dialog is not closing the sign-in: the child goes on waiting for
// a code, holds the next attempt hostage for the rest of its five minutes, and
// — if it got as far as `cswap add` — has already moved this machine onto the
// account it created. The cancel is what kills the child and puts the previous
// account back, and until this rule was pulled out of the component nothing
// tested which exits send it.
//
// The dialog is at 3.2% of lines and 0% of functions, and `startedRef` appeared
// in no test at all, so both halves of the decision were unguarded: the one
// that must not reach the server (nothing was ever started) and the one that
// must (a code is still being awaited).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { exitRequest, type LoginServerState } from "../login-flow";
import { withoutComments } from "./tsx-scan";

const CANCEL = { action: "login-cancel" };

describe("exitRequest", () => {
  it("says nothing when no sign-in was ever started", () => {
    // The dialog opens on a primer and the sign-in begins on a press, so an
    // untouched dialog closing must not reach the server — where the flow it
    // would cancel could be another tab's.
    for (const state of [null, undefined, "idle", "awaiting_code"] as const) {
      expect(exitRequest({ started: false, state }), String(state)).toBeNull();
    }
  });

  it("cancels a sign-in that is still waiting for something", () => {
    for (const state of ["awaiting_url", "awaiting_code", "registering"] as LoginServerState[]) {
      expect(exitRequest({ started: true, state }), state).toEqual(CANCEL);
    }
  });

  it("cancels one the server has already lost, and one that failed", () => {
    // Both are cheap on the server — cancelLogin on a missing flow answers ok
    // at once — and both release a handle the dialog is the last thing holding.
    expect(exitRequest({ started: true, state: "idle" })).toEqual(CANCEL);
    expect(exitRequest({ started: true, state: "failed" })).toEqual(CANCEL);
  });

  it("cancels a started sign-in the dialog has heard nothing about yet", () => {
    // start() is a round-trip: the press sets `started` and the first state
    // arrives with the answer. Escape inside that window is the abandoned
    // sign-in this exists for, so the absence of a state is not an excuse.
    expect(exitRequest({ started: true, state: null })).toEqual(CANCEL);
    expect(exitRequest({ started: true, state: undefined })).toEqual(CANCEL);
  });

  it("says nothing on the success screen, where there is nothing left to undo", () => {
    // registerSignedIn puts the previous account back as its last act, so a
    // cancel here would queue a second `cswap switch` onto the account the
    // machine is already on, behind the store lock, for nothing.
    //
    // It is also the state where the two exits disagreed: × sent the cancel and
    // Done did not, so one success screen did two different things depending on
    // which control the reader reached for. They now agree, on this answer.
    expect(exitRequest({ started: true, state: "done" })).toBeNull();
  });
});

describe("every exit the dialog offers takes that rule", () => {
  const src = withoutComments(readFileSync(
    fileURLToPath(new URL("../components/AddAccountDialog.tsx", import.meta.url)), "utf8"));

  it("asks exitRequest once, and posts only what it answers", () => {
    expect(src).toMatch(
      /const req = exitRequest\(\{ started: startedRef\.current, state: login\?\.state \}\);\s*if \(req\) admin\(req\)/);
    // The literal is gone from the component: a second spelling of the cancel
    // is a second rule about when to send it.
    expect(src).not.toMatch(/admin\(\{ action: "login-cancel" \}\)/);
  });

  it("routes Escape, the backdrop, the × and Done through `close`", () => {
    // Escape and Tab reach the dialog through the hook, so the hook is the one
    // that has to be handed `close` rather than `onClose` — this is the exit a
    // reader takes without thinking, and the one a component is likeliest to
    // wire to the prop it was given.
    expect(src).toMatch(/useModalDismiss\(close, \{ focusRef: primerRef \}\)/);
    expect(src).toMatch(/className="modal-backdrop" onClick=\{close\}/);
    expect(src).toMatch(/onClick=\{close\} aria-label="Close \(Esc\)"/);
    // Both Done buttons — the sign-in's success screen and the import's.
    expect([...src.matchAll(/onClick=\{close\}>Done<\/button>/g)]).toHaveLength(2);
    // And no exit leaves through the raw prop, which is the shape × and Done
    // disagreed in.
    expect(src).not.toMatch(/onClick=\{onClose\}/);
  });
});
