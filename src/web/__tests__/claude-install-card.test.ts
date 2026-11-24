// Install Claude Code, as the session pane and the sign-in dialog draw it
// (ClaudeInstall.tsx): which screen the deck's status gives (claudeInstallView),
// what each screen says and offers, and the pane's card for a Claude session
// that could not start because Claude Code is missing. The deck's side is
// claude-install.test.ts; the card's own timing (poll, done, one retry) is
// claude-install-flow.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { all, textOf, type Drawn } from "./fake-react";
import { sheetText } from "./sheet-source";
import { CODEX_REASON_KEYS, claudeInstallStatusOf, type ClaudeInstallStatus } from "../claude-install-api";
import { claudeInstallView, type ClaudeInstall as Install, type ClaudeInstallView } from "../use-claude-install";
import ClaudeInstall, { commandEnd } from "../components/ClaudeInstall";
import { StateCard, type StageBodyProps } from "../components/terminal/StageBody";
import { CLAUDE_MISSING_MSG, CODEX_MISSING_MSG, stageAnnouncement, type StagePhase } from "../components/terminal/stage-model";
import { en } from "../i18n/en";
import { resetLanguageForTest } from "../i18n";

// The card reads the deck's status through its hook; drawn here server-side,
// the hook hands it the screen a test sets.
const held = vi.hoisted(() => ({ install: null as unknown }));
vi.mock("../use-claude-install", async orig => ({
  ...(await orig<typeof import("../use-claude-install")>()),
  useClaudeInstall: () => held.install,
}));

const POSIX = "curl -fsSL https://claude.ai/install.sh | bash";
const WINDOWS = "irm https://claude.ai/install.ps1 | iex";

function status(over: Partial<ClaudeInstallStatus> = {}): ClaudeInstallStatus {
  return { state: "idle", id: null, reason: null, detail: null, command: POSIX, shell: "terminal", blocked: false, ...over };
}

function showing(view: ClaudeInstallView, pending = false): Install {
  const install: Install = { view, pending, install: vi.fn(async () => {}) };
  held.install = install;
  return install;
}

const html = (el: ReactElement) => renderToStaticMarkup(el);
const ask = (over: Partial<Extract<ClaudeInstallView, { state: "ask" }>> = {}): ClaudeInstallView =>
  ({ state: "ask", command: POSIX, shell: "terminal", download: true, ...over });

function bodyProps(phase: StagePhase): StageBodyProps {
  return {
    hostRef: { current: null }, phase, context: null,
    onAdopt: vi.fn(), onNotNow: vi.fn(), onRetry: vi.fn(), onNewSession: vi.fn(),
  };
}

beforeEach(() => resetLanguageForTest());

describe("which screen the install shows", () => {
  const view = (s: ClaudeInstallStatus | null | undefined, watched: string[] = [], refused: string | null = null) =>
    claudeInstallView({ status: s, watched: new Set(watched), refused });

  it("offers Install with the command, and only the command where the deck may not download", () => {
    expect(view(undefined)).toEqual({ state: "loading" });
    expect(view(null), "the deck could not say: the host's own card").toEqual({ state: "unavailable" });
    expect(view(status())).toEqual(ask());
    expect(view(status({ blocked: true, command: WINDOWS, shell: "powershell" })))
      .toEqual({ state: "ask", command: WINDOWS, shell: "powershell", download: false });
  });

  it("shows any install that runs, and an outcome only to the card that watched it", () => {
    expect(view(status({ state: "running", id: "a1" }))).toEqual({ state: "running", command: POSIX, shell: "terminal" });
    expect(view(status({ state: "done", id: "a1" }), ["a1"])).toEqual({ state: "done" });
    expect(view(status({ state: "done", id: "a1" })), "an earlier done is no reason to start anything").toEqual(ask());
    const failed = status({ state: "failed", id: "a1", reason: "exit-failed", detail: "error: no space left" });
    expect(view(failed, ["a1"])).toEqual({ state: "failed", reason: "exit-failed", detail: "error: no space left", command: POSIX, shell: "terminal", download: true });
    expect(view(failed), "an earlier card's failure is not this card's first screen").toEqual(ask());
  });

  it("calls a start the deck refused for a reason of its own a failure, but not one already running", () => {
    expect(view(status(), [], "failed")).toMatchObject({ state: "failed", reason: "failed", detail: null });
    expect(view(status(), [], "unreachable")).toMatchObject({ state: "failed", reason: "failed" });
    expect(view(status(), [], "running")).toEqual(ask());
    expect(view(status({ blocked: true }), [], "download-disabled")).toEqual(ask({ download: false }));
  });

  it("reads only what it knows from the deck's answer", () => {
    expect(claudeInstallStatusOf({ ok: true, state: "failed", id: "x", reason: "made-up", detail: "  ", command: POSIX, shell: "terminal" }))
      .toEqual(status({ state: "failed", id: "x", reason: "failed" }));
    expect(claudeInstallStatusOf({ ok: true, state: "idle", command: WINDOWS, shell: "powershell", blocked: "download-disabled" }))
      .toEqual(status({ command: WINDOWS, shell: "powershell", blocked: true }));
    for (const bad of [null, [], { ok: false, state: "idle", command: POSIX }, { ok: true, state: "stuck", command: POSIX }, { ok: true, state: "idle" }]) {
      expect(claudeInstallStatusOf(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("what the install says and offers", () => {
  const draw = (view: ClaudeInstallView, place: "stage" | "dialog" = "stage", extra: Record<string, unknown> = {}) => {
    showing(view);
    return html(createElement(ClaudeInstall, { place, actions: createElement("button", { type: "button", className: "btn" }, "Not now"), ...extra }));
  };

  it("offers Install Claude Code first, the host's button beside it, and the command by hand under them", () => {
    const out = draw(ask());
    expect(out).toContain(en["accounts.claudeInstall.install"]);
    expect(out.indexOf(en["accounts.claudeInstall.install"])).toBeLessThan(out.indexOf("Not now"));
    expect(out).toContain(en["accounts.claudeInstall.byHand"]);
    // CHANGED ON PURPOSE: the command was one <code>. It is cut before its end,
    // which stays on one line with Copy, so a narrow card never leaves the pipe
    // dangling at the end of a line and "bash" alone under it.
    expect(out).toContain('<span class="ci-cmd"><code>curl -fsSL https://claude.ai/install.sh </code><span class="ci-end"><code>| bash</code><button type="button" class="glyph-btn"');
    expect(out).toContain(`aria-label="${en["board.stage.copyCommand"]}"`);
    expect(out).toMatch(/class="ts-note ci-manual"/);
  });

  it("names PowerShell and its command on a Windows deck", () => {
    const out = draw(ask({ command: WINDOWS, shell: "powershell" }), "dialog");
    expect(out).toContain(en["accounts.claudeInstall.byHandPowerShell"]);
    // CHANGED ON PURPOSE: cut before its end, as the POSIX command is.
    expect(out).toContain('<code>irm https://claude.ai/install.ps1 </code><span class="ci-end"><code>| iex</code>');
    expect(out).not.toContain("install.sh");
    expect(out).toMatch(/class="aa-note ci-manual"/);
  });

  it("offers only the command where the deck may not download it", () => {
    const out = draw(ask({ download: false }));
    expect(out).not.toContain(en["accounts.claudeInstall.install"]);
    expect(out).toContain(POSIX.split(" | ")[0]);
    expect(out).toContain("Not now");
  });

  it("keeps Install where it was pressed while it runs, busy, with the loader and its line, and no command to run twice", () => {
    // CHANGED ON PURPOSE: the button gave way to a loader line, and the focus
    // a press had put on it fell to the page (#518). The same button stays,
    // busy, the loader beside what it is doing; a hidden status line, there
    // before its words, says it to a screen reader.
    const out = draw({ state: "running", command: POSIX, shell: "terminal" });
    expect(out).toContain('<button type="button" class="btn primary" data-stage-land="true" aria-busy="true"><span class="ci-busy"><span class="loader"');
    expect(out).toContain(`<span>${en["accounts.claudeInstall.installing"]}</span></span></button>`);
    expect(out).toContain(`<span class="vis-hidden" role="status">${en["accounts.claudeInstall.installing"]}</span>`);
    expect(draw(ask()), "the status line is there before it speaks").toContain('<span class="vis-hidden" role="status"></span>');
    expect(out).not.toContain(en["accounts.claudeInstall.install"] + "<");
    expect(out).not.toContain("<code>");
    expect(out).toContain("Not now");
  });

  it("says why it failed, the installer's last lines, Install again, and keeps the command", () => {
    const failed: ClaudeInstallView = { state: "failed", reason: "installed-but-not-found", detail: "Installed to ~/.local/bin/claude", command: POSIX, shell: "terminal", download: true };
    const stage = draw(failed);
    expect(stage).toContain(en["accounts.claudeInstall.fail.notFound"]);
    expect(stage).toContain('role="alert"');
    expect(stage).toContain('<pre class="ci-detail">Installed to ~/.local/bin/claude</pre>');
    // CHANGED ON PURPOSE: the pane said Try again here, for installing again.
    // The pane now offers its own Try again (start the session), so the
    // install's says Install again in both places and no card has two Try again.
    expect(stage).toContain(`>${en["accounts.claudeInstall.again"]}</button>`);
    expect(stage).not.toContain(`>${en["board.stage.tryAgain"]}</button>`);
    expect(stage).toContain("<code>");
    const dialog = draw(failed, "dialog");
    expect(dialog).toContain(`>${en["accounts.claudeInstall.again"]}</button>`);
    expect(dialog).toMatch(/class="aa-err"/);
  });

  it("draws the host's sentence first and its small print last, and drops both once installed", () => {
    const extra = { lead: createElement("p", null, "LEAD"), note: createElement("p", null, "NOTE") };
    const asked = draw(ask(), "dialog", extra);
    expect(asked.startsWith("<p>LEAD</p>")).toBe(true);
    expect(asked.endsWith("<p>NOTE</p>")).toBe(true);
    const failed = draw({ state: "failed", reason: "exit-failed", detail: null, command: POSIX, shell: "terminal", download: true }, "dialog", extra);
    expect(failed.startsWith("<p>LEAD</p>")).toBe(true);
    expect(failed.endsWith("<p>NOTE</p>")).toBe(true);
    const running = draw({ state: "running", command: POSIX, shell: "terminal" }, "dialog", extra);
    expect(running.startsWith("<p>LEAD</p>")).toBe(true);
    expect(running, "no small print for a command no longer offered").not.toContain("NOTE");
    // Not "not installed" beside "installed": once it is, neither the
    // sentence nor the small print is true any more.
    const done = draw({ state: "done" }, "dialog", extra);
    expect(done).toContain(en["accounts.claudeInstall.done"]);
    expect(done).not.toContain("LEAD");
    expect(done).not.toContain("NOTE");
    expect(draw({ state: "unavailable" }, "stage", { ...extra, fallback: createElement("p", null, "old") })).toBe("<p>LEAD</p><p>old</p>");
  });

  it("asks the host for its buttons by what the card shows, and draws no empty row", () => {
    const seen: string[] = [];
    const actions = (state: string) => {
      seen.push(state);
      return state === "running" ? null : createElement("button", { type: "button", className: "btn" }, `host:${state}`);
    };
    expect(draw(ask(), "stage", { actions })).toContain(">host:ask</button>");
    const running = draw({ state: "running", command: POSIX, shell: "terminal" }, "stage", { actions });
    expect(running).not.toContain("host:");
    // CHANGED ON PURPOSE: the running row was empty and not drawn. It holds
    // Install, busy (#518), and nothing of the host's.
    expect(running).toMatch(/<div class="ts-acts ci-acts"><button type="button" class="btn primary"[^>]*aria-busy="true"><span class="ci-busy">.*?<\/button><\/div>/);
    expect(draw({ state: "done" }, "dialog", { actions })).toContain(">host:done</button>");
    expect(seen).toEqual(["ask", "running", "done"]);
    expect(draw({ state: "done" }, "stage", { actions: () => null }), "no empty row").not.toContain("ci-acts");
  });

  it("wraps whole buttons at a narrow width and keeps Copy with the command's end", () => {
    expect(draw(ask())).toContain('<div class="ts-acts ci-acts">');
    expect(draw(ask(), "dialog")).toContain('<div class="aa-actions ci-acts">');
    // CHANGED ON PURPOSE: Copy sat beside the whole command; it is inside its
    // end now, after "| bash", and the two never part.
    expect(draw(ask())).toMatch(/<span class="ci-cmd"><code>[^<]+<\/code><span class="ci-end"><code>\| bash<\/code><button type="button" class="glyph-btn"/);
  });

  it("cuts the command before its end, the pipe kept with what it feeds", () => {
    expect(commandEnd(POSIX)).toEqual(["curl -fsSL https://claude.ai/install.sh ", "| bash"]);
    expect(commandEnd(WINDOWS)).toEqual(["irm https://claude.ai/install.ps1 ", "| iex"]);
    expect(commandEnd("claude install")).toEqual(["claude ", "install"]);
    expect(commandEnd("claude")).toEqual(["", "claude"]);
    for (const c of [POSIX, WINDOWS, "a | b | c", "x y", "x"]) expect(commandEnd(c).join(""), c).toBe(c);
  });

  // Found in the browser: in the pane at 360px, Copy's target (a 32px square
  // under a fingertip, and 4px more above and below) reached into the line
  // above, so a click on the URL copied instead of selecting the command. The
  // words are drawn over that reach, raised only within the line.
  it("draws the command's words over Copy's reach, so a click on a word selects the command", () => {
    // Every block written for exactly this selector, read together.
    const rule = (selector: string) => {
      const blocks = [...sheetText().matchAll(new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "gm"))];
      expect(blocks.length, `${selector} has a rule`).toBeGreaterThan(0);
      return blocks.map(m => m[1]).join(";");
    };
    expect(rule(".ci-manual code")).toMatch(/position:\s*relative;/);
    expect(rule(".ci-manual code")).toMatch(/z-index:\s*1;/);
    expect(rule(".ci-manual"), "raised within the line, never over anything outside it").toMatch(/isolation:\s*isolate;/);
  });

  it("has a sentence for every failure the deck names", () => {
    for (const reason of ["download-failed", "start-failed", "exit-failed", "timed-out", "installed-but-not-found", "failed"] as const) {
      const out = draw({ state: "failed", reason, detail: null, command: POSIX, shell: "terminal", download: true });
      expect(out, reason).not.toContain("accounts.claudeInstall");
      expect(out, reason).not.toContain("ci-detail");
    }
  });

  it("draws the host's own fallback where the deck cannot say anything of the install", () => {
    const out = draw({ state: "unavailable" }, "stage", { fallback: createElement("p", null, "the old card") });
    expect(out).toBe("<p>the old card</p>");
  });
});

describe("the pane's card for a Claude session with no Claude Code", () => {
  const phase: StagePhase = { kind: "error", message: "Claude Code is not installed on this machine.", missing: "claude" };

  it("says so in the reader's language, offers Install Claude Code, Try again and Not now, and the command by hand", () => {
    showing(ask());
    const out = html(createElement(StateCard, bodyProps(phase)));
    expect(out).toContain(en[CLAUDE_MISSING_MSG]);
    expect(out).toContain(en["accounts.claudeInstall.install"]);
    expect(out).toContain(`>${en["common.notNow"]}</button>`);
    expect(out).toContain(POSIX.split(" | ")[0]);
    // CHANGED ON PURPOSE: Try again was not offered beside Install. Someone
    // who ran the command by hand, or whose deck may not download, had no way
    // to start the session again from the card.
    expect(out).toContain(`>${en["board.stage.tryAgain"]}</button>`);
    const at = (s: string) => out.indexOf(s);
    expect(at(en["accounts.claudeInstall.install"])).toBeLessThan(at(`>${en["board.stage.tryAgain"]}<`));
    expect(at(`>${en["board.stage.tryAgain"]}<`)).toBeLessThan(at(`>${en["common.notNow"]}<`));
    expect(out.match(/class="ts-card/g), "one card").toHaveLength(1);
    expect(out.split(en[CLAUDE_MISSING_MSG])).toHaveLength(2);
  });

  it("hands the card the stage's retry for once Claude Code is installed, Try again while none runs, and Not now always", () => {
    const props = bodyProps(phase);
    const card = StateCard(props) as unknown as Drawn;
    const install = all(card, el => el.type === ClaudeInstall)[0];
    expect(install.props.place).toBe("stage");
    expect(install.props.onInstalled).toBe(props.onRetry);
    expect(textOf(install.props.lead)).toBe(en[CLAUDE_MISSING_MSG]);
    // CHANGED ON PURPOSE: `actions` was the one Not now button; it is now
    // the buttons for what the card shows.
    const actions = install.props.actions as (state: string) => Drawn;
    const offered = all(actions("ask"), el => el.type === "button");
    expect(offered.map(b => textOf(b))).toEqual(["Try again", "Not now"]);
    (offered[1].props.onClick as () => void)();
    expect(props.onNotNow).toHaveBeenCalled();
    expect(props.onRetry).not.toHaveBeenCalled();
    (offered[0].props.onClick as () => void)();
    expect(props.onRetry).toHaveBeenCalledTimes(1);
    for (const state of ["failed", "unavailable", "loading"]) {
      expect(all(actions(state), el => el.type === "button").map(b => textOf(b)), state).toEqual(["Try again", "Not now"]);
    }
    // Starting Claude Code while it installs would fail the same way, and
    // once installed the card starts the session itself.
    for (const state of ["running", "done"]) {
      expect(all(actions(state), el => el.type === "button").map(b => textOf(b)), state).toEqual(["Not now"]);
    }
  });

  it("keeps Try again and Not now under the same sentence where the deck cannot say, in one card", () => {
    showing({ state: "unavailable" });
    const out = html(createElement(StateCard, bodyProps(phase)));
    expect(out).toContain(en[CLAUDE_MISSING_MSG]);
    expect(out).toContain(`>${en["board.stage.tryAgain"]}</button>`);
    expect(out).toContain(`>${en["common.notNow"]}</button>`);
    expect(out.match(/class="ts-card/g), "one card, not one in another").toHaveLength(1);
    expect(out.split(en[CLAUDE_MISSING_MSG])).toHaveLength(2);
  });

  // CHANGED ON PURPOSE (Install Codex): this said "Codex's, and any without
  // the mark", and Codex's refusal was never marked. It is now (missing:
  // "codex"), with a card of its own below; what stays plain is a refusal
  // without the mark, whatever its words.
  it("leaves every refusal without the mark as it was", () => {
    showing(ask());
    for (const message of ["Codex is not installed on this machine.", "Claude Code is not installed on this machine."]) {
      const card = StateCard(bodyProps({ kind: "error", message }));
      expect(all(card, el => el.type === ClaudeInstall), message).toHaveLength(0);
      expect(all(card, el => el.type === "button").map(b => textOf(b)), message).toEqual(["Try again", "Not now"]);
      const out = html(createElement(StateCard, bodyProps({ kind: "error", message })));
      expect(out).not.toContain(en["accounts.claudeInstall.install"]);
      expect(out).not.toContain(en["accounts.codexInstall.install"]);
    }
  });
});

describe("the pane's card for a Codex session with no Codex", () => {
  const NPM = "npm install -g @openai/codex";
  const phase: StagePhase = { kind: "error", message: "Codex is not installed on this machine.", missing: "codex" };
  const askCodex = (over: Partial<Extract<ClaudeInstallView, { state: "ask" }>> = {}): ClaudeInstallView =>
    ({ state: "ask", command: NPM, shell: "terminal", download: true, ...over });
  const draw = (view: ClaudeInstallView) => {
    showing(view);
    return html(createElement(ClaudeInstall, { place: "stage", agent: "codex", actions: createElement("button", { type: "button", className: "btn" }, "Not now") }));
  };

  it("says so in the reader's language, offers Install Codex, Try again and Not now, and npm's command by hand", () => {
    showing(askCodex());
    const out = html(createElement(StateCard, bodyProps(phase)));
    expect(out).toContain('data-missing="codex"');
    expect(out).toContain(en[CODEX_MISSING_MSG]);
    expect(out).not.toContain(en[CLAUDE_MISSING_MSG]);
    expect(out).toContain(`>${en["accounts.codexInstall.install"]}</button>`);
    expect(out).not.toContain(en["accounts.claudeInstall.install"]);
    expect(out).toContain(`>${en["board.stage.tryAgain"]}</button>`);
    expect(out).toContain(`>${en["common.notNow"]}</button>`);
    expect(out).toContain('<code>npm install -g </code><span class="ci-end"><code>@openai/codex</code>');
    expect(out).toContain(en["accounts.claudeInstall.byHand"]);
    const at = (s: string) => out.indexOf(s);
    expect(at(en["accounts.codexInstall.install"])).toBeLessThan(at(`>${en["board.stage.tryAgain"]}<`));
    expect(at(`>${en["board.stage.tryAgain"]}<`)).toBeLessThan(at(`>${en["common.notNow"]}<`));
    expect(out.match(/class="ts-card/g), "one card").toHaveLength(1);
  });

  it("hands the card Codex, the stage's retry for once it is installed, and the same buttons as Claude's", () => {
    const props = bodyProps(phase);
    const card = StateCard(props) as unknown as Drawn;
    const install = all(card, el => el.type === ClaudeInstall)[0];
    expect(install.props.agent).toBe("codex");
    expect(install.props.onInstalled).toBe(props.onRetry);
    expect(textOf(install.props.lead)).toBe(en[CODEX_MISSING_MSG]);
    const actions = install.props.actions as (state: string) => Drawn;
    for (const state of ["ask", "failed", "unavailable", "loading"]) {
      expect(all(actions(state), el => el.type === "button").map(b => textOf(b)), state).toEqual(["Try again", "Not now"]);
    }
    for (const state of ["running", "done"]) {
      expect(all(actions(state), el => el.type === "button").map(b => textOf(b)), state).toEqual(["Not now"]);
    }
    // Try again, for Codex installed by hand or a PATH fixed since: what was refused, asked again.
    (all(actions("failed"), el => el.type === "button")[0].props.onClick as () => void)();
    expect(props.onRetry).toHaveBeenCalledTimes(1);
  });

  it("keeps Try again and Not now under the same sentence where the deck cannot say", () => {
    showing({ state: "unavailable" });
    const out = html(createElement(StateCard, bodyProps(phase)));
    expect(out).toContain(en[CODEX_MISSING_MSG]);
    expect(out).toContain(`>${en["board.stage.tryAgain"]}</button>`);
    expect(out).toContain(`>${en["common.notNow"]}</button>`);
    expect(out).not.toContain(en["accounts.codexInstall.install"]);
  });

  it("says Installing Codex… on the busy button while it runs, and that Codex is installed once done", () => {
    const running = draw({ state: "running", command: NPM, shell: "terminal" });
    expect(running).toContain(`<span>${en["accounts.codexInstall.installing"]}</span></span></button>`);
    expect(running).toContain(`<span class="vis-hidden" role="status">${en["accounts.codexInstall.installing"]}</span>`);
    expect(running).not.toContain(en["accounts.claudeInstall.installing"]);
    const done = draw({ state: "done" });
    expect(done).toContain(en["accounts.codexInstall.done"]);
    expect(done).not.toContain(en["accounts.claudeInstall.done"]);
  });

  it("says why it failed, npm's last lines, Install again, and keeps the command", () => {
    const failed = draw({ state: "failed", reason: "exit-failed", detail: "npm error code EACCES", command: NPM, shell: "terminal", download: true });
    expect(failed).toContain(en["accounts.claudeInstall.fail.exit"]);
    expect(failed).toContain('<pre class="ci-detail">npm error code EACCES</pre>');
    expect(failed).toContain(`>${en["accounts.claudeInstall.again"]}</button>`);
    expect(failed).toContain("<code>npm install -g </code>");
  });

  it("says there is no npm, with the command to run where there is one", () => {
    const out = draw({ state: "failed", reason: "npm-missing", detail: null, command: NPM, shell: "terminal", download: true });
    expect(out).toContain(en["accounts.codexInstall.fail.npm"]);
    expect(out).toContain('role="alert"');
    expect(out).toContain("<code>npm install -g </code>");
  });

  it("says it installed but ccdeck cannot find it", () => {
    const out = draw({ state: "failed", reason: "installed-but-not-found", detail: null, command: NPM, shell: "terminal", download: true });
    expect(out).toContain(en["accounts.codexInstall.fail.notFound"]);
    expect(out).not.toContain("Claude Code");
  });

  it("has a sentence of Codex's for every failure the deck names, none of them Claude Code's", () => {
    for (const reason of ["download-failed", "start-failed", "exit-failed", "timed-out", "installed-but-not-found", "npm-missing", "failed"] as const) {
      expect(en[CODEX_REASON_KEYS[reason]], reason).toBeTruthy();
      expect(en[CODEX_REASON_KEYS[reason]], reason).not.toContain("Claude");
      const out = draw({ state: "failed", reason, detail: null, command: NPM, shell: "terminal", download: true });
      expect(out, reason).not.toContain("accounts.");
    }
  });

  it("is announced in the deck's own words", () => {
    expect(stageAnnouncement("demo", phase)).toBe(en[CODEX_MISSING_MSG]);
    expect(stageAnnouncement("demo", { ...phase, missing: "claude" })).toBe(en[CLAUDE_MISSING_MSG]);
  });
});
