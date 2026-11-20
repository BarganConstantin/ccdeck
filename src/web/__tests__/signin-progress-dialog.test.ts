// The sign-in dialog, driven through a whole sign-in on fake-react.ts's React:
// a press, the server's answers one poll at a time, and what the dialog draws
// at each — the stage list, the Cancel that is offered only while there is
// something to cancel, the ring closing into the success card, the failure on
// the row it happened at with its Try again, and the import's one live line.
//
// The server is a stub answering what cswap-admin.mjs would; nothing here
// starts a real sign-in or touches a credential.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { all, flush, mount, one, textOf, type Drawn } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);
vi.mock("react-dom", async orig => ({ ...(await orig<typeof import("react-dom")>()), createPortal: (node: unknown) => node }));
vi.mock("../components/use-modal-dismiss", async orig => ({
  ...(await orig<typeof import("../components/use-modal-dismiss")>()),
  useModalDismiss: () => ({ current: null }),
}));
vi.mock("../components/SuccessMark", () => ({ default: () => null }));
vi.mock("../feature-use", () => ({ useFeatureUse: () => {} }));

const { default: AddAccountDialog } = await import("../components/AddAccountDialog");
const { default: SignInProgress } = await import("../components/SignInProgress");
const { default: Confetti } = await import("../components/Confetti");
const { HANDOFF_MS } = await import("../signin-stages");
const { default: ClaudeInstall } = await import("../components/ClaudeInstall");

const URL_ = "https://claude.com/cai/oauth/authorize?code=true&state=test";
const EMAIL = "personal@example.com";

type Answer = Record<string, unknown>;
/** Admin posts, in order, each answered when the test says. */
let posts: Array<{ body: Answer; answer: (a: Answer | null) => void }>;
/** What GET /api/claude-accounts/login answers. */
let polled: Answer;
/** Every timer the dialog asked for. Nothing fires on its own. */
let timers: Array<{ fn: () => void; ms: number; repeat: boolean; live: boolean }>;
let clock: number;

const flowAt = (state: string, extra: Answer = {}): Answer => ({
  ok: true, state, url: URL_, error: null, account: null, expiresAt: clock + 300_000, step: null,
  restored: true, activeAccount: null, ...extra,
});

beforeEach(() => {
  posts = [];
  timers = [];
  clock = 1_000_000;
  polled = { ok: true, state: "idle" };
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    if (url === "/api/claude-accounts/login") return Promise.resolve({ ok: true, json: async () => polled });
    return new Promise(resolve => {
      posts.push({
        body: JSON.parse(String(init?.body ?? "{}")),
        answer: a => resolve({ ok: true, json: async () => a }),
      });
    });
  }));
  const add = (repeat: boolean) => (fn: () => void, ms: number) => timers.push({ fn, ms, repeat, live: true });
  const clear = (id: number) => { if (timers[id - 1]) timers[id - 1].live = false; };
  vi.stubGlobal("window", { setInterval: add(true), clearInterval: clear, setTimeout: add(false), clearTimeout: clear });
  vi.stubGlobal("document", { body: null, activeElement: null });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function open(props: Partial<Parameters<typeof AddAccountDialog>[0]> = {}) {
  return mount(AddAccountDialog, { onClose: vi.fn(), onChanged: vi.fn(), ...props });
}

const button = (tree: unknown, words: string) =>
  one(tree, el => el.type === "button" && textOf(el).trim() === words);
const progress = (tree: unknown) => one(tree, el => el.type === SignInProgress);
const statuses = (tree: unknown) => (progress(tree)!.props.rows as Array<{ status: string }>).map(r => r.status);
const labels = (tree: unknown) => (progress(tree)!.props.rows as Array<{ label: string }>).map(r => r.label);
const said = (tree: unknown) => textOf(one(tree, el => el.props.role === "status" && el.props["aria-live"] === "polite"));
/** The detail and the actions are props of the list, not its children. */
const detail = (tree: unknown) => progress(tree)!.props.detail;
const actions = (tree: unknown) => progress(tree)!.props.actions as Drawn | null;

/** The live repeating timer the poll runs on, and how often. */
const poll = () => timers.filter(t => t.live && t.repeat && t.ms !== 1000).at(-1)!;
async function answerPoll(next: Answer) {
  polled = next;
  poll().fn();
  await flush();
}

async function started(view: ReturnType<typeof open>) {
  (button(view.tree, "Open the sign-in page")!.props.onClick as () => void)();
  await flush();
  expect(posts.at(-1)!.body.action).toBe("login");
  posts.at(-1)!.answer(flowAt("awaiting_code"));
  await flush();
}

describe("a sign-in, stage by stage", () => {
  it("shows the link being asked for while the start is out, with Cancel", async () => {
    const view = open();
    (button(view.tree, "Open the sign-in page")!.props.onClick as () => void)();
    await flush();
    expect(statuses(view.tree)).toEqual(["active", "pending", "pending", "pending"]);
    expect(labels(view.tree)[0]).toBe("Opening the sign-in page");
    expect(textOf(actions(view.tree))).toBe("Cancel");
  });

  it("waits on the browser with the page's link, the code behind its disclosure, and Cancel", async () => {
    const view = open();
    await started(view);
    expect(statuses(view.tree)).toEqual(["done", "active", "pending", "pending"]);
    const link = one(detail(view.tree), el => el.type === "a")!;
    expect(link.props.href).toBe(URL_);
    expect(textOf(link)).toContain("claude.com");
    const disclosure = one(detail(view.tree), el => el.type === "details")!;
    expect(disclosure.props.open).toBe(false);
    expect(textOf(one(disclosure, el => el.type === "summary"))).toBe("Paste a code, if the page shows one");
    expect(textOf(actions(view.tree))).toBe("Cancel");
    expect(said(view.tree)).toBe("Waiting for you to approve the sign-in in your browser.");
  });

  it("says nothing about a slow browser for ten seconds, then points back at the link", async () => {
    const view = open();
    await started(view);
    const tick = timers.find(t => t.live && t.repeat && t.ms === 1000)!;
    clock += 9_000;
    tick.fn();
    expect(textOf(detail(view.tree))).not.toContain("Still waiting");
    clock += 2_000;
    tick.fn();
    expect(textOf(detail(view.tree))).toContain("Still waiting for the browser.");
    expect(textOf(detail(view.tree))).toContain("stays open 5 more minutes");
  });

  it("ticks the browser off when the server starts confirming, and asks it more often", async () => {
    const view = open();
    await started(view);
    expect(poll().ms).toBe(1500);
    await answerPoll(flowAt("registering", { step: "confirm" }));
    expect(statuses(view.tree)).toEqual(["done", "done", "active", "pending"]);
    expect(poll().ms).toBeLessThan(500);
    expect(said(view.tree)).toBe("Approved. Confirming who signed in.");
  });

  it("offers no Cancel once the account is being recorded", async () => {
    const view = open();
    await started(view);
    await answerPoll(flowAt("registering", { step: "save" }));
    expect(statuses(view.tree)).toEqual(["done", "done", "done", "active"]);
    expect(actions(view.tree)).toBeNull();
    expect(textOf(detail(view.tree))).toBe("claude-swap is recording the account.");
    await answerPoll(flowAt("registering", { step: "restore" }));
    expect(textOf(detail(view.tree))).toBe("Switching this machine back to the account you were using.");
    // The restore is a step inside save, not a stage — nothing new is said.
    expect(said(view.tree)).toBe("Saving the credentials.");
  });
});

describe("the handoff into the success card", () => {
  const added = { num: "3", email: EMAIL, added: true };

  it("holds the finished list while the ring closes, then draws the card with the tick alone", async () => {
    const view = open();
    await started(view);
    await answerPoll(flowAt("registering", { step: "save" }));
    await answerPoll(flowAt("done", { step: "restore", account: added }));

    expect(progress(view.tree)!.props.phase).toBe("resolving");
    expect(statuses(view.tree)).toEqual(["done", "done", "done", "done"]);
    const hold = timers.find(t => t.live && !t.repeat && t.ms === HANDOFF_MS)!;
    expect(hold).toBeDefined();

    hold.fn();
    expect(progress(view.tree)).toBeNull();
    const card = one(view.tree, el => typeof el.props.className === "string" && el.props.className.startsWith("aa-done"))!;
    expect(card.props.className).toBe("aa-done from-orbit");
    expect(textOf(one(card, el => el.type === "h4"))).toBe("Account 3 added");
    expect(one(card, el => el.type === Confetti)).not.toBeNull();
    expect(button(view.tree, "Done")).not.toBeNull();
    expect(said(view.tree)).toBe("Account 3 added.");
  });

  it("goes straight to a still card under reduced motion, with no confetti", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce") }));
    const view = open();
    await started(view);
    await answerPoll(flowAt("done", { account: added }));

    expect(progress(view.tree)).toBeNull();
    expect(timers.some(t => t.live && t.ms === HANDOFF_MS)).toBe(false);
    const card = one(view.tree, el => el.props.className === "aa-done")!;
    expect(textOf(one(card, el => el.type === "h4"))).toBe("Account 3 added");
    expect(all(card, el => el.type === Confetti)).toHaveLength(0);
  });

  it("calls a re-sign-in a refresh, and keeps the confetti for accounts that are new", async () => {
    const view = open({ email: EMAIL });
    await started(view);
    await answerPoll(flowAt("done", { account: { num: "2", email: EMAIL, added: false } }));
    timers.find(t => t.live && !t.repeat && t.ms === HANDOFF_MS)!.fn();
    expect(textOf(one(view.tree, el => el.type === "h4"))).toBe("Credentials refreshed");
    expect(textOf(one(view.tree, el => el.type === "p" && textOf(el).includes(EMAIL))))
      .toBe(`${EMAIL} was already in the rotation, so its stored login was replaced with this one.`);
    expect(all(view.tree, el => el.type === Confetti)).toHaveLength(0);
  });
});

describe("a failure, on the row it happened at", () => {
  it("marks save when claude-swap could not record the account, and offers Try again", async () => {
    const view = open();
    await started(view);
    await answerPoll(flowAt("failed", { step: "save", error: "cswap: could not read the credential" }));
    expect(progress(view.tree)!.props.phase).toBe("failed");
    expect(statuses(view.tree)).toEqual(["done", "done", "done", "failed"]);
    expect(labels(view.tree)[3]).toBe("claude-swap could not save the account");
    expect(textOf(one(detail(view.tree), el => el.type === "p"))).toBe("cswap: could not read the credential.");
    // Past the first stage a retry is the whole sign-in again, and says so.
    expect(button(detail(view.tree), "Start over")).not.toBeNull();
    expect(actions(view.tree)).toBeNull();
    expect(said(view.tree)).toBe("claude-swap could not save the account. cswap: could not read the credential.");
  });

  it("marks the browser when the window ran out there", async () => {
    const view = open();
    await started(view);
    await answerPoll(flowAt("failed", { error: "the sign-in window expired" }));
    expect(statuses(view.tree)).toEqual(["done", "failed", "pending", "pending"]);
    expect(labels(view.tree)[1]).toBe("The sign-in did not finish in the browser");
    expect(textOf(detail(view.tree))).toContain("The sign-in window expired.");
  });

  it("marks the link when the start itself was refused", async () => {
    const view = open();
    (button(view.tree, "Open the sign-in page")!.props.onClick as () => void)();
    await flush();
    posts.at(-1)!.answer({ ok: false, reason: "no_url", state: "failed", url: null });
    await flush();
    expect(statuses(view.tree)).toEqual(["failed", "pending", "pending", "pending"]);
    expect(labels(view.tree)[0]).toBe("The sign-in page did not open");
    expect(button(detail(view.tree), "Try again")).not.toBeNull();
  });

  // User feedback: in the desktop app the start failed with "not on PATH. Set
  // AGENTS_DECK_CLAUDE…", in English, with nothing to do about it.
  const NOT_ON_PATH = "the claude CLI could not be run: not on PATH. Set AGENTS_DECK_CLAUDE to its full path.";
  const MISSING = "Claude Code is not installed on this machine, or ccdeck cannot find it.";

  it("says plainly that Claude Code is missing, offers to install it beside Try again, and names the variable last", async () => {
    const view = open();
    (button(view.tree, "Open the sign-in page")!.props.onClick as () => void)();
    await flush();
    posts.at(-1)!.answer({ ok: false, reason: "no_url", state: "failed", url: null, detail: NOT_ON_PATH });
    await flush();
    expect(statuses(view.tree)).toEqual(["failed", "pending", "pending", "pending"]);
    const shown = detail(view.tree);
    const install = one(shown, el => el.type === ClaudeInstall)!;
    expect(install.props.place).toBe("dialog");
    expect(install.props.onInstalled, "a sign-in opens a browser tab: only a press starts it").toBeUndefined();
    // CHANGED ON PURPOSE: the sentence, Try again and the small print were
    // drawn by the dialog around the card. The card draws them now, so that
    // once Claude Code is installed the "not installed" sentence and the
    // variable go, and Try again is the one button.
    const lead = install.props.lead as Drawn;
    expect(lead.props.className).toBe("aa-note aa-reason");
    expect(textOf(lead)).toBe(MISSING);
    expect(textOf(shown) + textOf(lead), "the variable is not the sentence").not.toContain("not on PATH");
    expect(textOf(install.props.note)).toBe("Installed it somewhere unusual? Set AGENTS_DECK_CLAUDE to its full path.");
    const actions = install.props.actions as (state: string) => Drawn | null;
    const again = actions("ask")!;
    expect(textOf(again)).toBe("Try again");
    expect(again.props.className).toBe("btn");
    expect(textOf(actions("failed"))).toBe("Try again");
    expect(actions("running"), "no sign-in while Claude Code installs: it would end the same way").toBeNull();
    const installed = actions("done")!;
    expect(textOf(installed)).toBe("Try again");
    expect(installed.props.className).toBe("btn primary");
    expect(installed.props.autoFocus, "the keys go to the one thing left to do").toBe(true);
    expect(said(view.tree)).toContain(MISSING);

    // Try again is the sign-in again, as it was.
    (again.props.onClick as () => void)();
    await flush();
    expect(posts.at(-1)!.body).toEqual({ action: "login" });
    posts.at(-1)!.answer(flowAt("awaiting_code"));
    await flush();
    expect(all(view.tree, el => el.type === ClaudeInstall), "gone once the sign-in runs").toHaveLength(0);
  });

  it("offers the install too when the CLI went missing during the sign-in", async () => {
    const view = open();
    await started(view);
    await answerPoll(flowAt("failed", { error: NOT_ON_PATH }));
    const shown = detail(view.tree);
    const install = one(shown, el => el.type === ClaudeInstall);
    expect(install).not.toBeNull();
    // CHANGED ON PURPOSE: the sentence is the card's lead now, not the dialog's.
    expect(textOf(install!.props.lead)).toBe(MISSING);
  });

  it("offers no install for any other failure", async () => {
    const view = open();
    (button(view.tree, "Open the sign-in page")!.props.onClick as () => void)();
    await flush();
    posts.at(-1)!.answer({ ok: false, reason: "no_url", state: "failed", url: null });
    await flush();
    expect(all(detail(view.tree), el => el.type === ClaudeInstall)).toHaveLength(0);
  });

  it("calls a sign-in the server forgot ended, where it was last seen", async () => {
    const view = open();
    await started(view);
    await answerPoll({ ok: true, state: "idle" });
    expect(statuses(view.tree)).toEqual(["done", "failed", "pending", "pending"]);
    expect(labels(view.tree)[1]).toBe("Sign-in ended");
  });

  it("starts the whole sign-in again from Start over", async () => {
    const view = open();
    await started(view);
    await answerPoll(flowAt("failed", { error: "the sign-in window expired" }));
    (button(detail(view.tree), "Start over")!.props.onClick as () => void)();
    await flush();
    expect(posts.at(-1)!.body).toEqual({ action: "login" });
    expect(statuses(view.tree)).toEqual(["active", "pending", "pending", "pending"]);
  });
});

describe("a sign-in again that came back as another account (user feedback)", () => {
  const OTHER = "someone.else@example.com";
  const wrong = (extra: Answer = {}) => flowAt("failed", {
    step: "confirm", error: "a different account signed in, so nothing was saved",
    wrongAccount: { signedIn: OTHER, wanted: EMAIL }, ...extra,
  });

  it("names who signed in and the account that still needs it, with Try again", async () => {
    const view = open({ email: EMAIL });
    await started(view);
    expect(posts.at(-1)!.body).toEqual({ action: "login", email: EMAIL });
    await answerPoll(wrong());
    expect(statuses(view.tree)).toEqual(["done", "done", "failed", "pending"]);
    const reason = `You signed in as ${OTHER}, so nothing was saved. ${EMAIL} still needs a new sign-in.`;
    expect(textOf(one(detail(view.tree), el => el.type === "p"))).toBe(reason);
    expect(said(view.tree)).toBe(`The sign-in could not be confirmed. ${reason}`);
    expect(button(detail(view.tree), "Start over")).toBeNull();
    expect(button(detail(view.tree), "Try again")).not.toBeNull();
  });

  it("starts the sign-in again for the account it was for", async () => {
    const view = open({ email: EMAIL });
    await started(view);
    await answerPoll(wrong());
    (button(detail(view.tree), "Try again")!.props.onClick as () => void)();
    await flush();
    expect(posts.at(-1)!.body).toEqual({ action: "login", email: EMAIL });
    expect(statuses(view.tree)).toEqual(["active", "pending", "pending", "pending"]);
  });

  it("says so when the machine could not be put back on the account it was on", async () => {
    const view = open({ email: EMAIL });
    await started(view);
    await answerPoll(wrong({ restored: false, activeAccount: { num: null, email: null } }));
    const warn = one(detail(view.tree), el => el.props.className === "aa-note aa-warn")!;
    expect(textOf(warn)).toMatch(/^The account you were using could not be put back/);
  });

  it("says it in the reader's language, never the server's English", async () => {
    const { setLanguage } = await import("../i18n");
    // setLanguage marks the document's language, which the stub above has none of.
    vi.stubGlobal("document", { body: null, activeElement: null, documentElement: {} });
    try {
      setLanguage("fr");
      const view = open({ email: EMAIL });
      (button(view.tree, "Ouvrir la page de connexion")!.props.onClick as () => void)();
      await flush();
      posts.at(-1)!.answer(flowAt("awaiting_code"));
      await flush();
      await answerPoll(wrong());
      const text = textOf(one(detail(view.tree), el => el.type === "p"));
      expect(text).toContain(OTHER);
      expect(text).toContain(EMAIL);
      expect(text).not.toMatch(/signed in|nothing was saved/);
    } finally {
      setLanguage("en");
    }
  });
});

describe("Cancel", () => {
  it("tells the server, and puts the dialog back at its start", async () => {
    const view = open();
    await started(view);
    (actions(view.tree)!.props.onClick as () => void)();
    await flush();
    expect(posts.at(-1)!.body).toEqual({ action: "login-cancel" });
    expect(progress(view.tree)).toBeNull();
    expect(button(view.tree, "Open the sign-in page")).not.toBeNull();
  });

  it("drops the answer to a start it cancelled, and frees the button at once", async () => {
    const view = open();
    (button(view.tree, "Open the sign-in page")!.props.onClick as () => void)();
    await flush();
    const start = posts.at(-1)!;
    (actions(view.tree)!.props.onClick as () => void)();
    await flush();
    start.answer(flowAt("awaiting_code"));
    await flush();
    expect(progress(view.tree)).toBeNull();
    expect(button(view.tree, "Open the sign-in page")!.props["aria-busy"]).toBe(false);
  });
});

describe("the import", () => {
  it("has one live line while the share is out, and says so when it is slow", async () => {
    const view = open();
    (one(view.tree, el => el.props.role === "tab" && textOf(el) === "Paste a share")!.props.onClick as () => void)();
    (one(view.tree, el => el.type === "input")!.props.onChange as (e: unknown) => void)({ target: { value: "ccdeck2:abc" } });
    (button(view.tree, "Import")!.props.onClick as () => void)();
    await flush();
    const line = () => one(view.tree, el => el.props.className === "aa-live-line");
    expect(textOf(line())).toBe("claude-swap is adding the accounts in this share. Any already here are left as they are.");
    expect(said(view.tree)).toBe("Importing the share.");
    clock += 11_000;
    timers.find(t => t.live && t.repeat && t.ms === 1000)!.fn();
    expect(textOf(line())).toMatch(/^Still importing\./);
    posts.at(-1)!.answer({ ok: true, results: [{ email: EMAIL, org: "", num: "4", state: "imported" }] });
    await flush();
    expect(line()).toBeNull();
    expect(said(view.tree)).toBe("1 of 1 imported.");
  });
});
