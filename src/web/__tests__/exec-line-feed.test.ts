// How runInteractive cuts a child's output into lines for `onLine`.
//
// The accounts panel drives two prompts through this — `claude auth login`
// waiting for a pasted code, `cswap remove` waiting for its `[y/N]` — and
// neither prompt ends in a newline. So the rule is not "one callback per line":
// a complete line is delivered once, and the unterminated tail is offered again
// on every chunk as it grows, flagged `partial`, so a reader waiting for
// "Paste code here if prompted > " sees it without waiting for a newline that
// never comes.
//
// Three fakes in this suite restate that rule by hand to stand in for
// runInteractive (cswap-admin, login-completes-itself-708,
// restore-active-verdict-951). This runs the one they copy.
import { describe, it, expect } from "vitest";

// @ts-expect-error — .mjs server module, no types
import { lineFeed } from "../../server/exec.mjs";

type Heard = [string, boolean];

/** A feed with one subscriber that records what it was handed. */
function feed() {
  const heard: Heard[] = [];
  const subs = [(text: string, partial: boolean) => { heard.push([text, partial]); }];
  return { heard, subs, lines: lineFeed(subs) as { push(t: string): void; reset(): void } };
}

describe("lineFeed", () => {
  it("hands each complete line over once, without its line ending", () => {
    const { heard, lines } = feed();
    lines.push("one\r\ntwo\n");
    expect(heard).toEqual([["one", false], ["two", false]]);
  });

  it("re-offers the unterminated tail as it grows, then completes it once", () => {
    // The prompt shape: no newline until the user answers.
    const { heard, lines } = feed();
    lines.push("Paste code ");
    lines.push("here > ");
    lines.push("\n");
    expect(heard).toEqual([
      ["Paste code ", true],
      ["Paste code here > ", true],
      ["Paste code here > ", false],
    ]);
  });

  it("carries a line split across chunks, including a CRLF split between them", () => {
    const { heard, lines } = feed();
    lines.push("ab");
    lines.push("c\r");
    lines.push("\nd");
    expect(heard).toEqual([
      ["ab", true],
      ["abc\r", true],
      ["abc", false],
      ["d", true],
    ]);
  });

  it("keeps an empty line as a line", () => {
    const { heard, lines } = feed();
    lines.push("\n\nx\n");
    expect(heard).toEqual([["", false], ["", false], ["x", false]]);
  });

  it("does not let a throwing subscriber stop the others or escape the push", () => {
    const heard: Heard[] = [];
    const subs = [
      () => { throw new Error("a subscriber must not kill the child"); },
      (text: string, partial: boolean) => { heard.push([text, partial]); },
    ];
    const lines = lineFeed(subs) as { push(t: string): void };
    expect(() => lines.push("done\ntail")).not.toThrow();
    expect(heard).toEqual([["done", false], ["tail", true]]);
  });

  it("reads the subscriber list live, so a late onLine hears what comes next", () => {
    // runInteractive hands its own array over at the start and `onLine` pushes
    // into it afterwards, from the caller that received the handle.
    const subs: Array<(t: string, p: boolean) => void> = [];
    const lines = lineFeed(subs) as { push(t: string): void };
    lines.push("before\n");
    const heard: Heard[] = [];
    subs.push((text, partial) => { heard.push([text, partial]); });
    lines.push("after\n");
    expect(heard).toEqual([["after", false]]);
  });

  it("forgets the carried tail on reset, which a retry under the next spelling needs", () => {
    const { heard, lines } = feed();
    lines.push("'cswap.cmd' is not recog");
    lines.reset();
    lines.push("ok\n");
    expect(heard.at(-1)).toEqual(["ok", false]);
    expect(heard.filter(([, partial]) => !partial)).toEqual([["ok", false]]);
  });

  it("says nothing for a push of nothing", () => {
    const { heard, lines } = feed();
    lines.push("");
    expect(heard).toEqual([]);
  });
});
