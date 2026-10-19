// An error a browser extension throws in the deck's tab is not the deck's
// (#2163). A content script raises the same window `error` and
// `unhandledrejection` the page's own errors do, and the forwarder sent one on
// as a ccdeck error: a new kind in Errors that nobody here can fix. It is left
// out when every script its stack names is an extension's, or, with a stack
// that names none, when the event's script is. One frame of the deck's own
// keeps it: an extension calling into the page can still trip over our bug.
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

const EXTENSION = "chrome-extension://eppiocemhmnlbhjplcgkofciiegomcon/executors/200.js";
const DECK = "http://127.0.0.1:4317/assets/index-Bq3x1.js";
const M_ID = "Cannot read properties of undefined (reading 'M_ID')";
// The report the issue quotes, as Chrome wrote it.
const EXTENSION_STACK = [
  `TypeError: ${M_ID}`,
  `    at Y (${EXTENSION}:1:761)`,
  `    at E (${EXTENSION}:1:1442)`,
].join("\n");

describe("an error a browser extension threw in the deck's tab", () => {
  it("is not sent from a window error", () => {
    const { target, sent } = forwarded();
    target.fire("error", { message: `Uncaught TypeError: ${M_ID}`, filename: EXTENSION, error: thrown(M_ID, EXTENSION_STACK) });
    expect(sent).toEqual([]);
  });

  it("is not sent from a rejected promise", () => {
    const { target, sent } = forwarded();
    target.fire("unhandledrejection", { reason: thrown(M_ID, EXTENSION_STACK) });
    expect(sent).toEqual([]);
  });

  it("is not sent in Firefox's and Safari's stack format, nor from Safari's masked address", () => {
    const { target, sent } = forwarded();
    target.fire("error", {
      error: thrown("a is undefined", "Y@moz-extension://0f6c2b1e-3c4d-4e5f-8a9b-1c2d3e4f5a6b/content.js:1:761\nE@moz-extension://0f6c2b1e-3c4d-4e5f-8a9b-1c2d3e4f5a6b/content.js line 2 > eval:1:12\n"),
    });
    target.fire("error", {
      error: thrown("undefined is not an object (evaluating 'a.M_ID')", "Y@safari-web-extension://4B1E2C3D-5F6A-4B7C-8D9E-0F1A2B3C4D5E/content.js:1:761\nforEach@[native code]\nglobal code@safari-web-extension://4B1E2C3D-5F6A-4B7C-8D9E-0F1A2B3C4D5E/content.js:1:12"),
    });
    target.fire("unhandledrejection", { reason: thrown("M_ID is not defined", "Y@webkit-masked-url://hidden/:1:761\n@webkit-masked-url://hidden/:1:12") });
    expect(sent).toEqual([]);
  });

  it("is not sent when only the event names the script: a thrown string has no stack", () => {
    const { target, sent } = forwarded();
    target.fire("error", { message: "Uncaught executor failed", filename: EXTENSION, error: "executor failed" });
    target.fire("error", { message: "Uncaught executor gone", filename: "moz-extension://0f6c2b1e/content.js" });
    expect(sent).toEqual([]);
  });

  it("is not sent from code it evaluated, whose frames name no script but the extension's", () => {
    const { target, sent } = forwarded();
    const stack = [
      `TypeError: ${M_ID}`,
      `    at eval (eval at Y (${EXTENSION}:1:761), <anonymous>:1:5)`,
      "    at <anonymous>:1:20",
      `    at E (${EXTENSION}:1:1442)`,
    ].join("\n");
    target.fire("error", { error: thrown(M_ID, stack) });
    expect(sent).toEqual([]);
  });

  it("does not use up the page's ten, nor the message, for an error of the deck's own", () => {
    const { target, sent } = forwarded();
    for (let i = 0; i < 12; i++) target.fire("error", { error: thrown(`${M_ID} ${i}`, EXTENSION_STACK) });
    const ours = thrown(M_ID, `TypeError: ${M_ID}\n    at Xe (${DECK}:40:1234)`);
    target.fire("error", { error: ours });
    expect(sent).toEqual([{ message: M_ID, stack: ours.stack }]);
  });
});

describe("an error with a frame of the deck's own", () => {
  it("is still sent when an extension's frames come first, or last", () => {
    const { target, sent } = forwarded();
    const extensionAbove = [`TypeError: ${M_ID}`, `    at Y (${EXTENSION}:1:761)`, `    at Xe (${DECK}:40:1234)`].join("\n");
    const extensionBelow = ["TypeError: wrapped", `    at async Xe (${DECK}:40:1234)`, `    at E (${EXTENSION}:1:1442)`].join("\n");
    target.fire("error", { filename: EXTENSION, error: thrown(M_ID, extensionAbove) });
    target.fire("unhandledrejection", { reason: thrown("wrapped", extensionBelow) });
    target.fire("error", { error: thrown("in Firefox", `Y@${EXTENSION}:1:761\nXe@${DECK}:40:1234\n`) });
    expect(sent.map(s => s.message)).toEqual([M_ID, "wrapped", "in Firefox"]);
  });

  it("is still sent when only its message names an extension", () => {
    const { target, sent } = forwarded();
    const message = `Failed to fetch ${EXTENSION}`;
    target.fire("error", { error: thrown(message, `TypeError: ${message}\n    at Xe (${DECK}:40:1234)`) });
    expect(sent.map(s => s.message)).toEqual([message]);
  });

  it("is still sent with no stack at all, and from the page's own script", () => {
    const { target, sent } = forwarded();
    target.fire("error", { message: "Uncaught oops", filename: DECK, error: "oops" });
    target.fire("unhandledrejection", { reason: "plain string" });
    target.fire("unhandledrejection", { reason: { message: "no stack" } });
    expect(sent.map(s => s.message)).toEqual(["Uncaught oops", "plain string", "no stack"]);
  });
});
