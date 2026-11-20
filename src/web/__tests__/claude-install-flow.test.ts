// Install Claude Code, pressed: the card asks the deck, shows the install
// running while it reads the status again, and once an install it watched is
// done tells its host exactly once (in the session pane that is the launch,
// asked for again). Driven on fake-react.ts's React with the deck stubbed;
// nothing here downloads or runs anything.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { all, flush, mount, one, textOf, type Drawn } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);
const copied = vi.hoisted(() => [] as string[]);
vi.mock("../copy-text", () => ({ copyText: async (text: string) => { copied.push(text); return true; } }));

const { default: ClaudeInstall, INSTALLED_HOLD_MS } = await import("../components/ClaudeInstall");
const { CLAUDE_INSTALL_POLL_MS } = await import("../use-claude-install");
const { en } = await import("../i18n/en");

const POSIX = "curl -fsSL https://claude.ai/install.sh | bash";

type Answer = Record<string, unknown>;
/** What GET /api/claude-install answers next. */
let deck: Answer;
/** What POST /api/claude-install answers. */
let started: Answer;
let gets: number;
let posts: number;

const idle = (over: Answer = {}): Answer => ({ ok: true, state: "idle", command: POSIX, shell: "terminal", ...over });

beforeEach(() => {
  vi.useFakeTimers();
  copied.length = 0;
  gets = 0;
  posts = 0;
  deck = idle();
  started = { ok: true, id: "job1" };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toBe("/api/claude-install");
    if (init?.method === "POST") {
      posts++;
      return { ok: started.ok === true, json: async () => started };
    }
    gets++;
    return { ok: true, json: async () => deck };
  }));
  vi.stubGlobal("window", { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const button = (tree: unknown, words: string) =>
  one(tree, el => el.type === "button" && textOf(el).trim() === words);
/** The command line, drawn by a component of the card's own (this React
 *  draws no child component, so it is read by its props). */
const byHand = (tree: unknown) => all(tree, el => typeof el.type === "function" && (el.type as { name: string }).name === "ByHand")[0] ?? null;
const command = (tree: unknown) => (byHand(tree)?.props.command as string | undefined) ?? null;
const press = (el: Drawn | null) => {
  expect(el, "the control is drawn").not.toBeNull();
  (el!.props.onClick as () => void)();
};
/** Where the card's own button is: its row's place among the card's parts,
 *  and the type and class of the first thing in that row — what React matches
 *  an element on from one render to the next, and keeps it (and the focus on
 *  it) for. */
const ownPlace = (tree: unknown) => {
  const parts = (tree as Drawn).props.children as unknown[];
  const rowAt = parts.findIndex(p => !!p && typeof p === "object" && String((p as Drawn).props.className ?? "").includes("ci-acts"));
  const first = ((parts[rowAt] as Drawn).props.children as unknown[])[0] as Drawn;
  return { parts: parts.length, rowAt, type: first.type, className: first.props.className };
};

async function open(onInstalled = vi.fn(), place: "stage" | "dialog" = "stage") {
  const view = mount(ClaudeInstall, {
    place, onInstalled,
    actions: { type: "button", props: { type: "button", className: "btn", children: "Not now" } } as unknown as Drawn,
  });
  await flush();
  return { view, onInstalled };
}

describe("an install, pressed", () => {
  it("runs, reads the deck again while it runs, and once it is done asks for the session again, once", async () => {
    const { view, onInstalled } = await open();
    expect(gets, "the deck is asked where the install stands").toBe(1);
    expect(command(view.tree)).toBe(POSIX);

    deck = idle({ state: "running", id: "job1" });
    press(button(view.tree, en["accounts.claudeInstall.install"]));
    await flush();
    expect(posts).toBe(1);
    expect(textOf(view.tree)).toContain(en["accounts.claudeInstall.installing"]);
    expect(button(view.tree, en["accounts.claudeInstall.install"]), "no second Install while it runs").toBeNull();
    expect(command(view.tree), "no command to run twice").toBeNull();

    await vi.advanceTimersByTimeAsync(CLAUDE_INSTALL_POLL_MS);
    await flush();
    expect(gets, "read again while it runs").toBe(3);
    expect(textOf(view.tree)).toContain(en["accounts.claudeInstall.installing"]);

    deck = idle({ state: "done", id: "job1" });
    await vi.advanceTimersByTimeAsync(CLAUDE_INSTALL_POLL_MS);
    await flush();
    expect(textOf(view.tree)).toContain(en["accounts.claudeInstall.done"]);
    expect(onInstalled, "the word is on screen before anything moves").not.toHaveBeenCalled();
    const polled = gets;

    await vi.advanceTimersByTimeAsync(INSTALLED_HOLD_MS);
    await flush();
    expect(onInstalled).toHaveBeenCalledTimes(1);

    // Nothing more: no second retry, no more reads of a finished install.
    view.rerender();
    await vi.advanceTimersByTimeAsync(INSTALLED_HOLD_MS * 5 + CLAUDE_INSTALL_POLL_MS * 5);
    await flush();
    expect(onInstalled).toHaveBeenCalledTimes(1);
    expect(gets).toBe(polled);
  });

  it("says why it failed, keeps the command, and installs again from Install again", async () => {
    const { view, onInstalled } = await open();
    deck = idle({ state: "failed", id: "job1", reason: "installed-but-not-found", detail: "Installed to ~/.local/bin/claude" });
    press(button(view.tree, en["accounts.claudeInstall.install"]));
    await flush();
    expect(textOf(view.tree)).toContain(en["accounts.claudeInstall.fail.notFound"]);
    expect(textOf(one(view.tree, el => el.type === "pre"))).toBe("Installed to ~/.local/bin/claude");
    expect(command(view.tree)).toBe(POSIX);
    await vi.advanceTimersByTimeAsync(INSTALLED_HOLD_MS * 2);
    expect(onInstalled, "a failure starts nothing").not.toHaveBeenCalled();

    started = { ok: true, id: "job2" };
    deck = idle({ state: "running", id: "job2" });
    // CHANGED ON PURPOSE: the pane's install retry said Try again; the pane's
    // Try again now starts the session, so this one says Install again.
    press(button(view.tree, en["accounts.claudeInstall.again"]));
    await flush();
    expect(posts).toBe(2);
    expect(textOf(view.tree)).toContain(en["accounts.claudeInstall.installing"]);
  });

  // Found in the browser: once Install was pressed, focus fell to the page, in
  // the pane and in the dialog, and stayed there after a failed install, since
  // the pressed button gave way to a loader line. A press never takes away the
  // control it came from (#518), and React keeps a drawn element, and the
  // focus on it, while one of the same type stays at the same place among its
  // siblings: so that place is read here at each step.
  it("keeps the pressed button, in its place, from Install to Installing… to Install again", async () => {
    for (const place of ["stage", "dialog"] as const) {
      deck = idle();
      started = { ok: true, id: "job1" };
      const { view } = await open(vi.fn(), place);
      const asked = ownPlace(view.tree);
      const before = posts;

      deck = idle({ state: "running", id: "job1" });
      press(button(view.tree, en["accounts.claudeInstall.install"]));
      await flush();
      expect(ownPlace(view.tree), place).toEqual(asked);
      const busy = button(view.tree, en["accounts.claudeInstall.installing"]);
      expect(busy?.props["aria-busy"], `${place}: the button says it is working`).toBe(true);
      press(busy);
      await flush();
      expect(posts, `${place}: a press while it runs asks nothing`).toBe(before + 1);

      deck = idle({ state: "failed", id: "job1", reason: "exit-failed" });
      await vi.advanceTimersByTimeAsync(CLAUDE_INSTALL_POLL_MS);
      await flush();
      expect(button(view.tree, en["accounts.claudeInstall.again"]), place).not.toBeNull();
      expect(ownPlace(view.tree), place).toEqual(asked);
    }
  });

  it("shows an install another card started as running, and its done there as this card's too", async () => {
    deck = idle({ state: "running", id: "other" });
    const { view, onInstalled } = await open();
    expect(textOf(view.tree)).toContain(en["accounts.claudeInstall.installing"]);
    deck = idle({ state: "done", id: "other" });
    await vi.advanceTimersByTimeAsync(CLAUDE_INSTALL_POLL_MS);
    await flush();
    await vi.advanceTimersByTimeAsync(INSTALLED_HOLD_MS);
    expect(onInstalled).toHaveBeenCalledTimes(1);
  });

  it("never takes an earlier install's outcome for its own", async () => {
    deck = idle({ state: "done", id: "before" });
    const first = await open();
    await vi.advanceTimersByTimeAsync(INSTALLED_HOLD_MS * 2);
    expect(first.onInstalled).not.toHaveBeenCalled();
    expect(button(first.view.tree, en["accounts.claudeInstall.install"])).not.toBeNull();

    deck = idle({ state: "failed", id: "before", reason: "exit-failed" });
    const second = await open();
    expect(textOf(second.view.tree)).not.toContain(en["accounts.claudeInstall.fail.exit"]);
  });

  it("shows one already running when the deck refuses a second start", async () => {
    const { view } = await open();
    started = { ok: false, code: "running" };
    deck = idle({ state: "running", id: "elsewhere" });
    press(button(view.tree, en["accounts.claudeInstall.install"]));
    await flush();
    expect(textOf(view.tree)).toContain(en["accounts.claudeInstall.installing"]);
  });

  it("does not ask the deck twice for two quick presses", async () => {
    let answer: (a: Answer) => void = () => {};
    const { view } = await open();
    vi.mocked(fetch).mockImplementationOnce(async () => {
      posts++;
      const body = await new Promise<Answer>(resolve => { answer = resolve; });
      return { ok: true, json: async () => body } as unknown as Response;
    });
    press(button(view.tree, en["accounts.claudeInstall.install"]));
    await flush();
    const busy = button(view.tree, en["accounts.claudeInstall.install"])!;
    expect(busy.props["aria-busy"]).toBe(true);
    press(busy);
    await flush();
    expect(posts).toBe(1);
    answer({ ok: true, id: "job1" });
    await flush();
  });

  it("copies the command", async () => {
    const { view } = await open();
    const line = byHand(view.tree)!;
    const drawn = mount(line.type as (p: unknown) => unknown, line.props);
    expect(textOf(drawn.tree)).toContain(en["accounts.claudeInstall.byHand"]);
    // CHANGED ON PURPOSE: the command was one <code>; it is two now, cut before
    // "| bash" so that end stays on one line with Copy. Read together, they
    // are still the command, and Copy still copies all of it.
    expect(all(drawn.tree, el => el.type === "code").map(textOf).join("")).toBe(POSIX);
    press(one(drawn.tree, el => el.type === "button" && el.props["aria-label"] === en["board.stage.copyCommand"]));
    await flush();
    expect(copied).toEqual([POSIX]);
    expect(all(drawn.tree, el => el.props["aria-label"] === en["board.stage.copied"])).toHaveLength(1);
  });
});
