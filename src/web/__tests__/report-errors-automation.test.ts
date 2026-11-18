// An error a script driving the page raised is not a bug anyone using the deck
// hits. Puppeteer (which chrome-devtools-mcp drives the browser with) dispatched
// a synthetic keydown on `document`, React Flow's keydown handler read the
// event's target as an element, and the forwarder sent `n.hasAttribute is not a
// function` on as a ccdeck error; an earlier one came from code typed into
// DevTools' console. Both stacks end — where the chain of calls began — in code
// evaluated from outside the bundle: `pptr:…` frames, or `<anonymous>:1:221`.
// Such an error is left out the way an extension's is (#2163). A chain that
// began in the deck is still sent, whatever ran above it.
import { describe, it, expect } from "vitest";
import { forwardPageErrors } from "../report-errors";

function page() {
  const listeners = new Map<string, (event: any) => void>();
  return {
    addEventListener: (type: string, fn: (event: any) => void) => listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
    fire: (type: string, event: unknown) => listeners.get(type)?.(event),
  };
}

function forwarded() {
  const target = page();
  const sent: { message: string; stack?: string }[] = [];
  forwardPageErrors(() => true, target, body => sent.push(body));
  return { target, sent };
}

/** An Error with the stack a browser wrote for it. */
function thrown(message: string, stack: string): Error {
  const error = new Error(message);
  error.stack = stack;
  return error;
}

const DECK = "http://127.0.0.1:4317/assets/app-C1uOpxre.js";
const MESSAGE = "n.hasAttribute is not a function";
const DECK_FRAMES = [`    at pj (${DECK}:57:57093)`, `    at HTMLDocument.h (${DECK}:57:79554)`];
// Puppeteer's name for the code it evaluated, as the report had it, with a
// made-up user name in the encoded call site.
const PPTR =
  "pptr:evaluateHandle;performEvaluation%20(file%3A%2F%2F%2FUsers%2Falice%2F.npm%2F_npx%2Fba38acecdf97096f%2Fnode_modules%2Fchrome-devtools-mcp%2Fbuild%2Fsrc%2Ftools%2Fscript.js%3A182%3A69)";

const stack = (...frames: string[]) => [`TypeError: ${MESSAGE}`, ...frames].join("\n");
const PPTR_STACK = stack(...DECK_FRAMES, `    at ${PPTR}:1:276`, `    at ${PPTR}:1:294`);
const CONSOLE_STACK = stack(...DECK_FRAMES, "    at <anonymous>:1:221");

describe("an error a script driving the page raised", () => {
  it("is not sent from a window error, when Puppeteer evaluated the code it began in", () => {
    const { target, sent } = forwarded();
    target.fire("error", { message: `Uncaught TypeError: ${MESSAGE}`, filename: DECK, error: thrown(MESSAGE, PPTR_STACK) });
    expect(sent).toEqual([]);
  });

  it("is not sent from a rejected promise, when Puppeteer evaluated the code it began in", () => {
    const { target, sent } = forwarded();
    target.fire("unhandledrejection", { reason: thrown(MESSAGE, PPTR_STACK) });
    expect(sent).toEqual([]);
  });

  it("is not sent when DevTools' console or a CDP evaluate ran the code it began in", () => {
    const { target, sent } = forwarded();
    target.fire("error", { message: `Uncaught TypeError: ${MESSAGE}`, filename: DECK, error: thrown(MESSAGE, CONSOLE_STACK) });
    target.fire("unhandledrejection", { reason: thrown(MESSAGE, CONSOLE_STACK) });
    expect(sent).toEqual([]);
  });

  it("is not sent from Playwright's evaluate, nor an older Puppeteer's", () => {
    const { target, sent } = forwarded();
    target.fire("error", { error: thrown(MESSAGE, stack(...DECK_FRAMES, "    at UtilityScript.evaluate (<anonymous>:234:30)", "    at UtilityScript.<anonymous> (<anonymous>:1:44)")) });
    target.fire("error", { error: thrown(`${MESSAGE} again`, stack(...DECK_FRAMES, "    at __puppeteer_evaluation_script__:3:10")) });
    expect(sent).toEqual([]);
  });

  it("does not use up the page's ten, nor the message, for an error of the deck's own", () => {
    const { target, sent } = forwarded();
    for (let i = 0; i < 12; i++) target.fire("error", { error: thrown(`${MESSAGE} ${i}`, PPTR_STACK) });
    target.fire("error", { error: thrown(MESSAGE, PPTR_STACK) });
    const ours = thrown(MESSAGE, stack(...DECK_FRAMES));
    target.fire("error", { error: ours });
    expect(sent).toEqual([{ message: MESSAGE, stack: ours.stack }]);
  });
});

describe("an error whose chain of calls began in the deck", () => {
  it("is still sent with a native frame in the middle of it", () => {
    const { target, sent } = forwarded();
    const native = stack(`    at Xe (${DECK}:40:1234)`, "    at Array.map (<anonymous>)", "    at new Promise (<anonymous>)", `    at Ze (${DECK}:41:99)`);
    target.fire("error", { error: thrown(MESSAGE, native) });
    expect(sent.map(s => s.message)).toEqual([MESSAGE]);
  });

  it("is still sent when its last frame is a native one", () => {
    const { target, sent } = forwarded();
    target.fire("unhandledrejection", { reason: thrown(MESSAGE, stack(`    at Xe (${DECK}:40:1234)`, "    at Array.forEach (<anonymous>)")) });
    expect(sent.map(s => s.message)).toEqual([MESSAGE]);
  });

  it("is still sent when evaluated code ran above the deck's own frame", () => {
    const { target, sent } = forwarded();
    target.fire("error", { error: thrown(MESSAGE, stack(`    at ${PPTR}:1:294`, ...DECK_FRAMES)) });
    target.fire("unhandledrejection", { reason: thrown("wrapped", ["TypeError: wrapped", "    at <anonymous>:1:221", `    at async Xe (${DECK}:40:1234)`].join("\n")) });
    expect(sent.map(s => s.message)).toEqual([MESSAGE, "wrapped"]);
  });

  it("is still sent when the deck evaluated the code it began in", () => {
    const { target, sent } = forwarded();
    target.fire("error", { error: thrown(MESSAGE, stack(`    at Xe (${DECK}:40:1234)`, `    at eval (eval at compile (${DECK}:12:345), <anonymous>:3:4)`)) });
    expect(sent.map(s => s.message)).toEqual([MESSAGE]);
  });
});
