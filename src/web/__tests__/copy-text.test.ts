// #1174: the clipboard helper behind every Copy button the deck has.
//
// The upgrade command, the Browser Watch killswitch, the LAN fingerprint, a
// tool's output and the account share — whose text is the sign-in for every
// account in it — all go through copyText, and every one of those callers says
// "copied" only when it returns true. It had no test at all. Two regressions
// are the expensive ones: returning true on the timeout, or skipping the
// fallback, puts "copied" on screen while the clipboard holds nothing or the
// previous thing, and the user pastes that on the other machine; awaiting the
// clipboard instead of racing it leaves the button dead for good behind a
// permission prompt the browser never shows.
//
// Plain node: navigator, window and the three pieces of document the fallback
// touches are stubbed, and the 500ms race runs on fake timers.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { copyText } from "../copy-text";

const WEB = fileURLToPath(new URL("../", import.meta.url));

interface FakeTextarea {
  value: string;
  attrs: Record<string, string>;
  style: { cssText?: string };
  steps: string[];
  setAttribute(k: string, v: string): void;
  select(): void;
  remove(): void;
}

/**
 * A page whose clipboard does what `writeText` says — or has no clipboard at
 * all when it is left out, which is what an http:// LAN origin gets — and
 * whose `execCommand("copy")` answers `execResult`.
 */
function page({ writeText, execResult = true, createElement }: {
  writeText?: (text: string) => Promise<void>;
  execResult?: boolean;
  createElement?: () => FakeTextarea;
} = {}) {
  const textareas: FakeTextarea[] = [];
  const write = writeText ? vi.fn(writeText) : undefined;
  const execCommand = vi.fn((_cmd: string) => {
    textareas.at(-1)?.steps.push("execCommand");
    return execResult;
  });
  const appendChild = vi.fn((ta: FakeTextarea) => { ta.steps.push("appendChild"); });
  vi.stubGlobal("navigator", { clipboard: write ? { writeText: write } : undefined });
  // Read through at call time, so the fake timers installed below are the
  // ones the race gets.
  vi.stubGlobal("window", { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) });
  vi.stubGlobal("document", {
    createElement: createElement ?? ((_tag: string) => {
      const ta: FakeTextarea = {
        value: "", attrs: {}, style: {}, steps: [],
        setAttribute(k, v) { this.attrs[k] = v; },
        select() { this.steps.push("select"); },
        remove() { this.steps.push("remove"); },
      };
      textareas.push(ta);
      return ta;
    }),
    body: { appendChild },
    execCommand,
  });
  return { write, execCommand, textareas };
}

/** The call, and whether it has settled yet — read before awaiting it, so a
 *  race that was taken out fails the assertion instead of hanging the case. */
function start(text: string) {
  const state = { settled: false, value: undefined as boolean | undefined };
  const promise = copyText(text).then(v => { state.settled = true; state.value = v; return v; });
  return { state, promise };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("copyText", () => {
  it("copies nothing for an empty string, and says so", async () => {
    const { write, execCommand, textareas } = page({ writeText: async () => {} });
    expect(await copyText("")).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(execCommand).not.toHaveBeenCalled();
    expect(textareas).toEqual([]);
  });

  it("is done when the clipboard takes it, and never reaches for the fallback", async () => {
    const { write, execCommand } = page({ writeText: async () => {} });
    expect(await copyText("npx ccdeck@latest")).toBe(true);
    expect(write).toHaveBeenCalledWith("npx ccdeck@latest");
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("stops waiting on a clipboard that never answers after 500ms, and falls back", async () => {
    // A permission prompt the browser is still deciding on. Awaited rather than
    // raced, this is a button that never answers again.
    const { execCommand } = page({ writeText: () => new Promise<void>(() => {}) });
    const { state, promise } = start("token");
    await vi.advanceTimersByTimeAsync(499);
    expect(state.settled).toBe(false);
    expect(execCommand).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(state.settled).toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(await promise).toBe(true);
  });

  it("reports the fallback's own answer after a timeout, not the timeout's", async () => {
    // The timer resolves the race with false. If that ever read as success, or
    // the fallback's refusal were dropped, the button would say "copied" over
    // a clipboard holding whatever was there before.
    page({ writeText: () => new Promise<void>(() => {}), execResult: false });
    const { state } = start("token");
    await vi.advanceTimersByTimeAsync(500);
    expect(state).toEqual({ settled: true, value: false });
  });

  it("falls back when the clipboard refuses", async () => {
    const { execCommand } = page({ writeText: () => Promise.reject(new Error("NotAllowedError")) });
    expect(await copyText("token")).toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("falls back when writeText throws before it returns a promise", async () => {
    const { execCommand } = page({ writeText: () => { throw new TypeError("Illegal invocation"); } });
    expect(await copyText("token")).toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("falls back when there is no clipboard at all, which is an http:// LAN origin", async () => {
    const { execCommand } = page();
    expect(await copyText("token")).toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("selects exactly the text in a hidden readonly field, and takes the field away after", async () => {
    const { textareas } = page();
    await copyText("line one\nline two");
    expect(textareas).toHaveLength(1);
    const [ta] = textareas;
    expect(ta.value).toBe("line one\nline two");
    // readonly, so a phone does not raise its keyboard for a field nobody sees.
    expect(ta.attrs.readonly).toBe("");
    expect(ta.style.cssText).toMatch(/opacity:0/);
    expect(ta.steps).toEqual(["appendChild", "select", "execCommand", "remove"]);
  });

  it("answers false rather than throwing when the fallback cannot run either", async () => {
    // Every caller leaves the text on screen to select by hand on a false. A
    // rejection would take the button's handler down with it instead.
    page({ createElement: () => { throw new Error("no DOM"); } });
    await expect(copyText("token")).resolves.toBe(false);
  });

  it("answers false when execCommand itself throws", async () => {
    const { textareas } = page();
    (globalThis as unknown as { document: { execCommand: () => never } }).document.execCommand =
      () => { throw new Error("SecurityError"); };
    await expect(copyText("token")).resolves.toBe(false);
    expect(textareas).toHaveLength(1);
  });
});

describe("one copy of the ladder", () => {
  const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? (e.name === "__tests__" ? [] : sources(join(dir, e.name)))
      : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []);

  it("is the only place in the client that falls back to execCommand", () => {
    // copy-text.ts says ONE COPY OF THIS. The accounts panel carried a private
    // duplicate anyway, and it was the one deciding whether the share dialog —
    // the copy that carries sign-in tokens — said "copied".
    const found = sources(WEB)
      .filter(path => /\bexecCommand\(/.test(readFileSync(path, "utf8")))
      .map(path => path.slice(WEB.length).replace(/\\/g, "/"));
    expect(found).toEqual(["copy-text.ts"]);
  });

  it("is what the accounts panel copies a share with", () => {
    const panel = readFileSync(join(WEB, "components", "AccountsPanel.tsx"), "utf8");
    expect(panel).not.toMatch(/async function copyText/);
    expect(panel).toMatch(/^import \{ copyText \} from "\.\.\/copy-text";$/m);
    expect(panel).toMatch(/copyText=\{copyText\}/);
  });
});
