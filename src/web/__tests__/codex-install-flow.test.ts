// Install Codex, pressed: the same card as Install Claude Code (ClaudeInstall.tsx
// with `agent: "codex"`), asking Codex's own route on the deck, never Claude
// Code's. It shows the install running while it reads the status again, and
// once an install it watched is done tells its host exactly once (in the
// session pane that is the launch or the open that was refused, asked for
// again). Driven on fake-react.ts's React with the deck stubbed; nothing here
// runs npm or anything else.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { flush, mount, one, textOf, type Drawn } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);
vi.mock("../copy-text", () => ({ copyText: async () => true }));

const { default: ClaudeInstall, INSTALLED_HOLD_MS } = await import("../components/ClaudeInstall");
const { CLAUDE_INSTALL_POLL_MS } = await import("../use-claude-install");
const { en } = await import("../i18n/en");

const NPM = "npm install -g @openai/codex";

type Answer = Record<string, unknown>;
/** What GET /api/codex-install answers next. */
let deck: Answer;
/** What POST /api/codex-install answers. */
let started: Answer;
let gets: number;
let posts: number;
let asked: string[];

const idle = (over: Answer = {}): Answer => ({ ok: true, state: "idle", command: NPM, shell: "terminal", ...over });

beforeEach(() => {
  vi.useFakeTimers();
  gets = 0;
  posts = 0;
  asked = [];
  deck = idle();
  started = { ok: true, id: "job1" };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    asked.push(url);
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
const press = (el: Drawn | null) => {
  expect(el, "the control is drawn").not.toBeNull();
  (el!.props.onClick as () => void)();
};
/** The command line's command, read off the card's own ByHand by its props. */
const command = (tree: unknown) => {
  const line = one(tree, el => typeof el.type === "function" && (el.type as { name: string }).name === "ByHand");
  return (line?.props.command as string | undefined) ?? null;
};

async function open(onInstalled = vi.fn()) {
  const view = mount(ClaudeInstall, {
    place: "stage", agent: "codex", onInstalled,
    actions: { type: "button", props: { type: "button", className: "btn", children: "Not now" } } as unknown as Drawn,
  });
  await flush();
  return { view, onInstalled };
}

describe("Install Codex, pressed", () => {
  it("asks Codex's route, runs, reads it again while it runs, and once done asks for what was refused again, once", async () => {
    const { view, onInstalled } = await open();
    expect(gets).toBe(1);
    expect(command(view.tree)).toBe(NPM);
    expect(button(view.tree, en["accounts.claudeInstall.install"]), "not Claude Code's button").toBeNull();

    deck = idle({ state: "running", id: "job1" });
    press(button(view.tree, en["accounts.codexInstall.install"]));
    await flush();
    expect(posts).toBe(1);
    expect(textOf(view.tree)).toContain(en["accounts.codexInstall.installing"]);
    expect(command(view.tree), "no command to run twice").toBeNull();

    await vi.advanceTimersByTimeAsync(CLAUDE_INSTALL_POLL_MS);
    await flush();
    expect(gets, "read again while it runs").toBe(3);

    deck = idle({ state: "done", id: "job1" });
    await vi.advanceTimersByTimeAsync(CLAUDE_INSTALL_POLL_MS);
    await flush();
    expect(textOf(view.tree)).toContain(en["accounts.codexInstall.done"]);
    expect(onInstalled, "the word is on screen before anything moves").not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(INSTALLED_HOLD_MS);
    await flush();
    expect(onInstalled).toHaveBeenCalledTimes(1);

    view.rerender();
    await vi.advanceTimersByTimeAsync(INSTALLED_HOLD_MS * 5 + CLAUDE_INSTALL_POLL_MS * 5);
    await flush();
    expect(onInstalled, "and no more").toHaveBeenCalledTimes(1);
    // Every request was Codex's own.
    expect(new Set(asked)).toEqual(new Set(["/api/codex-install"]));
  });

  it("says npm is missing, keeps the command to run by hand, starts nothing, and installs again from Install again", async () => {
    const { view, onInstalled } = await open();
    deck = idle({ state: "failed", id: "job1", reason: "npm-missing" });
    press(button(view.tree, en["accounts.codexInstall.install"]));
    await flush();
    expect(textOf(view.tree)).toContain(en["accounts.codexInstall.fail.npm"]);
    expect(command(view.tree)).toBe(NPM);
    await vi.advanceTimersByTimeAsync(INSTALLED_HOLD_MS * 2);
    expect(onInstalled, "a failure starts nothing").not.toHaveBeenCalled();

    started = { ok: true, id: "job2" };
    deck = idle({ state: "running", id: "job2" });
    press(button(view.tree, en["accounts.claudeInstall.again"]));
    await flush();
    expect(posts).toBe(2);
    expect(textOf(view.tree)).toContain(en["accounts.codexInstall.installing"]);
  });

  it("shows npm's last lines when it stopped, and says so when it installed but ccdeck cannot find it", async () => {
    const first = await open();
    deck = idle({ state: "failed", id: "job1", reason: "exit-failed", detail: "npm error code EACCES" });
    press(button(first.view.tree, en["accounts.codexInstall.install"]));
    await flush();
    expect(textOf(first.view.tree)).toContain(en["accounts.claudeInstall.fail.exit"]);
    expect(textOf(one(first.view.tree, el => el.type === "pre"))).toBe("npm error code EACCES");

    started = { ok: true, id: "job3" };
    deck = idle({ state: "failed", id: "job3", reason: "installed-but-not-found" });
    const second = await open();
    press(button(second.view.tree, en["accounts.codexInstall.install"]));
    await flush();
    expect(textOf(second.view.tree)).toContain(en["accounts.codexInstall.fail.notFound"]);
    expect(command(second.view.tree)).toBe(NPM);
  });
});
