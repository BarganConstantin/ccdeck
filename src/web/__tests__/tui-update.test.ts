// `ccdeck tui` and the deck's updates: said in the title bar, taken with u
// through the deck's own routes, and followed onto the new code.
//
// What is pinned here, in the order it can go wrong:
//
//   the report    GET /api/version kept as the little the screen says and acts
//                 on, and nothing from it printed that is not a version;
//   the words     the page's chip in the title bar — "4.3.11 is out", "4.3.11
//                 is ready" — given up before the version on a narrow screen,
//                 never the tabs; u in the footer while one stands, and in ?
//                 always; ASCII and no colour read the same;
//   the key       u from every tab and never from a form; what it refuses
//                 before asking anything; what a check with npm found;
//   the loop      a fake terminal and a fake deck: the check, the restart, the
//                 install then the restart, a failed install, npx's relaunch,
//                 the deck's refusals, one update at a time;
//   the reopen    the screen hands itself over to the new code only when the
//                 deck runs it, this install's package says it, and nobody is
//                 in the middle of anything — and the new screen opens on the
//                 same tab and says the update took.
import { describe, it, expect } from "vitest";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

// @ts-expect-error — plain .mjs module, no types
const view = await import("../../server/tui-view.mjs");
// @ts-expect-error — plain .mjs module, no types
const { textWidth } = await import("../../server/cli-lines.mjs");
// @ts-expect-error — plain .mjs module, no types
const { glyphs, palette, stripAnsi } = await import("../../server/term.mjs");
// @ts-expect-error — plain .mjs module, no types
const { ALT_SCREEN_ON, ALT_SCREEN_OFF } = await import("../../server/tui-screen.mjs");
// @ts-expect-error — plain .js module, no types
const { runTui, tuiEntry, resumedFrom, REST_MS } = await import("../../../bin/cli/tui.js");

type Row = Record<string, unknown>;
type State = Record<string, unknown>;
type Asked = { method?: string; path: string; body?: unknown };
type Answer = { ok: boolean; status: number; body: unknown };

const NOW = 1_800_000_000_000;
const U = glyphs(true);
const A = glyphs(false);
const PKG_ROOT = realpathSync(fileURLToPath(new URL("../../../", import.meta.url)));

const lane = (id: string, label: string, pct: number) => ({ id, label, pct, resetAt: NOW / 1000 + 3600 });
function row(num: number, email: string, over: Row = {}): Row {
  return {
    num, email, alias: null, org: null, orgUuid: `org-${num}`, alive: true, active: false, disabled: false,
    lanes: [lane("five_hour", "5h", 10 * num), lane("seven_day", "7d", 20 + num)],
    headroom: 90 - 10 * num, fetchedAt: NOW - 60_000, stale: false, error: null, staleCopy: false, stopped: false,
    ...over,
  };
}
const ROWS = [row(1, "alice@corp.example", { active: true }), row(2, "bob@home.example")];

/** What GET /api/version answers on a global install with 4.3.11 out. */
function report(over: Row = {}): Row {
  return {
    name: "ccdeck", running: "4.3.10", installed: "4.3.10", latest: "4.3.11",
    checkedAt: NOW - 60_000, checkFailedAt: null, latestPending: null, checkDisabled: false,
    notice: { kind: "upgrade", from: "4.3.10", to: "4.3.11" },
    command: "npm i -g ccdeck@latest", upgradeBlocked: null, upgradeMode: "install",
    upgrade: { state: "idle", command: null, error: null, at: 0 },
    canRestart: true, invokedAs: "ccdeck", renameFix: null, terminalCli: null,
    ...over,
  };
}
const READY = { installed: "4.3.11", notice: { kind: "restart", from: "4.3.10", to: "4.3.11" } };
const NEWEST = { latest: "4.3.10", notice: null };

function deckState(over: State = {}): State {
  const s = { ...view.initialState(), own: "4.3.10", deck: { port: 4317, version: "4.3.10" }, source: "deck", readAt: NOW - 2_000 };
  return { ...view.withRoster(s, { ok: true, activeNum: 1, accounts: ROWS }), ...over };
}
const withReport = (over: Row = {}, s: State = deckState()) => view.withUpdate(s, report(over));
const frame = (s: State, columns = 80, rows = 24, unicode = true, profile = unicode ? "ansi16" : "none") =>
  view.tuiFrame(s, { columns, rows, tone: palette(profile), g: unicode ? U : A, unicode, now: NOW, profile });
const text = (lines: string[]) => lines.map((l: string) => stripAnsi(l));
const key = (s: State, str: string | undefined, k: Row = {}) => view.tuiKey(s, str, { name: str, ...k }, { now: NOW, g: U });

// ── the report ──────────────────────────────────────────────────────────────

describe("the report", () => {
  it("keeps the little the screen says and acts on", () => {
    const u = withReport({ upgrade: { state: "failed", error: "npm ERR! code EACCES\nnpm ERR! syscall mkdir", at: 5 } }).update;
    expect(u).toMatchObject({
      notice: { kind: "upgrade", from: "4.3.10", to: "4.3.11" }, mode: "install", blocked: null, state: "failed",
      error: "npm ERR! code EACCES npm ERR! syscall mkdir", at: 5, canRestart: true, command: "npm i -g ccdeck@latest",
      checkDisabled: false, latest: "4.3.11", running: "4.3.10",
    });
  });

  it("is null for no answer, and says nothing it cannot print", () => {
    expect(view.withUpdate(deckState(), null).update).toBeNull();
    expect(view.withUpdate(deckState(), [1, 2]).update).toBeNull();
    expect(view.withUpdate(deckState(), "not an answer").update).toBeNull();
    // A notice whose version is not one is no notice at all.
    expect(withReport({ notice: { kind: "upgrade", from: "4.3.10", to: "\x1b[31m4.3.11" } }).update.notice).toBeNull();
    expect(withReport({ notice: { kind: "downgrade", to: "4.3.9" } }).update.notice).toBeNull();
    expect(withReport({ upgradeMode: "sudo" }).update.mode).toBeNull();
    expect(withReport({ upgrade: { state: "exploded" } }).update.state).toBe("idle");
    // A deck that does not say whether it can restart is left to refuse for itself.
    const { canRestart: _gone, ...rest } = report();
    expect(view.withUpdate(deckState(), rest).update.canRestart).toBe(true);
    expect(withReport({ canRestart: false }).update.canRestart).toBe(false);
  });
});

// ── the words ───────────────────────────────────────────────────────────────

describe("the words", () => {
  it("names the update after the version, in the page's chip's words and the warning's colour", () => {
    expect(text(frame(withReport()).lines)[0]).toMatch(/^ {2}ccdeck 4\.3\.10 · 4\.3\.11 is out {2}Claude accounts +● live · deck 4317 {2}$/);
    expect(text(frame(withReport(READY)).lines)[0]).toMatch(/^ {2}ccdeck 4\.3\.10 · 4\.3\.11 is ready {2}Claude accounts /);
    expect(frame(withReport()).lines[0]).toContain(`${palette("ansi16").warn}4.3.11 is out`);
    // None named, or no deck to name one: the version alone.
    expect(text(frame(withReport(NEWEST)).lines)[0]).toMatch(/^ {2}ccdeck 4\.3\.10 {2}Claude accounts /);
    expect(text(frame(deckState()).lines)[0]).toMatch(/^ {2}ccdeck 4\.3\.10 {2}Claude accounts /);
    const gone = { ...withReport(), deck: null, source: "local" };
    expect(text(frame(gone).lines)[0]).toMatch(/^ {2}ccdeck 4\.3\.10 {2}Claude accounts /);
    // The deck back on it, the report not yet read again: nothing to take.
    const back = withReport(READY, deckState({ deck: { port: 4317, version: "4.3.11" } }));
    expect(text(frame(back).lines)[0]).toMatch(/^ {2}ccdeck 4\.3\.11 {2}Claude accounts /);
    expect(text(frame(back).lines).at(-1)).not.toMatch(/u +update/);
  });

  it("reads the same in ASCII and with no colour, with not one escape", () => {
    const plain = frame(withReport(), 80, 24, false, "none").lines;
    expect(plain[0]).toMatch(/^ {2}ccdeck 4\.3\.10 - 4\.3\.11 is out {2}Claude accounts /);
    expect(plain.join("")).not.toContain("\x1b");
    expect(plain.at(-1)).toMatch(/u +update/);
  });

  it("gives the words up first on a narrow screen, then the version, and never the tabs", () => {
    const narrow = text(frame(withReport(), 40, 12).lines)[0];
    expect(narrow).toMatch(/^ {2}ccdeck 4\.3\.10 {2}Claude accounts/);
    expect(narrow).not.toContain("is out");
    expect(textWidth(narrow)).toBeLessThanOrEqual(39);
    // A long version does not fit either: the name and the tabs stay.
    const long = withReport({}, deckState({ deck: { port: 4317, version: "10.20.30-beta.4" } }));
    const tight = text(frame(long, 40, 12).lines)[0];
    expect(tight).toMatch(/^ {2}ccdeck {2}Claude accounts/);
    // At every width the row stays inside it.
    for (const columns of [40, 50, 60, 70, 80, 100, 160]) {
      const line = text(frame(withReport(READY), columns, 24).lines)[0];
      expect(textWidth(line), `${columns}`).toBeLessThanOrEqual(columns - 1);
      expect(line, `${columns}`).toContain("Claude accounts");
    }
  });

  it("offers u in the footer only while an update is named", () => {
    expect(text(frame(withReport()).lines).at(-1)).toMatch(/u +update/);
    expect(text(frame(withReport(READY)).lines).at(-1)).toMatch(/u +update/);
    expect(text(frame(withReport(NEWEST)).lines).at(-1)).not.toMatch(/u +update/);
    expect(text(frame(deckState()).lines).at(-1)).not.toMatch(/u +update/);
    // ? and q are the last to go on a narrow screen, and u stays past the moves.
    const narrow = text(frame(withReport(), 60, 24).lines).at(-1);
    expect(narrow).toMatch(/u +update/);
    expect(narrow).toMatch(/q +quit/);
  });

  it("lists u in ? always: a check with none named, the update with one", () => {
    const none = text(frame(deckState({ help: true }), 80, 24, true, "truecolor").lines);
    expect(none.some(l => /r {2}u +read the usage again {2}· {2}check for an update/.test(l))).toBe(true);
    const out = text(frame({ ...withReport(), help: true }, 80, 24, true, "truecolor").lines);
    expect(out.some(l => /r {2}u +read the usage again {2}· {2}update to 4\.3\.11/.test(l))).toBe(true);
    // The box still closes at 80 by 24: u took no row of its own.
    const top = none.findIndex(l => l.includes("╭─ Keys "));
    const bottom = none.findIndex(l => l.includes("any key closes ─╯"));
    expect(bottom).toBeGreaterThan(top);
    expect(none.slice(top, bottom).some(l => l.includes("session uses the new account from its next message"))).toBe(true);
  });
});

// ── the key ─────────────────────────────────────────────────────────────────

describe("the key", () => {
  it("asks for the update from every tab", () => {
    expect(key(withReport(), "u").effect).toEqual({ type: "update" });
    expect(key(withReport(NEWEST), "u").effect).toEqual({ type: "update" });
    expect(key({ ...withReport(), side: "codex" }, "u").effect).toEqual({ type: "update" });
    expect(key({ ...withReport(), side: "lan" }, "u").effect).toEqual({ type: "update" });
  });

  it("is a character in a form and a sign-in's code, and Ctrl+U is never it", () => {
    expect(key(withReport(), undefined, { name: "u", ctrl: true }).effect).toBeNull();
    const signin = key({ ...withReport(), signin: { ...view.openSignin(), started: true, login: { state: "awaiting_code", url: "https://claude.com/x" }, code: "" } }, "u");
    expect(signin.effect).toBeNull();
    expect(signin.state.signin.code).toBe("u");
    const menu = key({ ...withReport(), menu: { num: 2, id: null, view: "rename", at: 0, draft: "", error: null } }, "u");
    expect(menu.effect).toBeNull();
    expect(menu.state.menu.draft).toBe("u");
    // Help: the key closes it, as every key does.
    const help = key({ ...withReport(), help: true }, "u");
    expect(help.effect).toBeNull();
    expect(help.state.help).toBe(false);
  });

  it("says why not, at once, where the page has no button either", () => {
    const told = (s: State) => {
      const r = key(s, "u");
      expect(r.effect).toBeNull();
      return r.state.notice;
    };
    expect(told({ ...withReport(), deck: null }).text).toBe("updates come through the deck — d starts one");
    expect(told({ ...withReport(), busy: { text: "installing 4.3.11", since: NOW } }).text).toBe("installing 4.3.11 — one thing at a time");
    const blocked = told(withReport({ upgradeMode: null, upgradeBlocked: "git_checkout", command: "git pull && npm run build" }));
    expect(blocked).toMatchObject({ tone: "warn", text: "4.3.11 is out — this copy cannot update itself: git pull && npm run build" });
    expect(told(withReport({ upgradeMode: null, command: null })).text).toBe("4.3.11 is out — this copy cannot update itself");
    expect(told(withReport({ ...READY, canRestart: false }))).toMatchObject({ tone: "warn", text: "4.3.11 is installed — a restart from here would lose the canvas" });
    expect(told(withReport({ upgradeMode: "npx", canRestart: false })).text).toBe("4.3.11 is out — npx updates by a restart, which would lose the canvas");
    // An install restarts nothing yet: it goes ahead, and the restart is asked after.
    expect(key(withReport({ canRestart: false }), "u").effect).toEqual({ type: "update" });
  });

  it("keeps d from starting a second deck while one restarts into an update", () => {
    const away = { ...deckState(), deck: null, busy: { text: "restarting the deck on 4.3.11", since: NOW } };
    const r = key(away, "d");
    expect(r.effect).toBeNull();
    expect(r.state.notice.text).toBe("restarting the deck on 4.3.11 — one thing at a time");
  });

  it("says what a check with npm found, in the order the page's line takes it", () => {
    const said = (over: Row) => view.updateChecked(view.withUpdate(deckState(), report(over)).update, U);
    expect(said(NEWEST)).toEqual({ tone: "ok", text: "4.3.10 is the newest" });
    expect(said({})).toEqual({ tone: "info", text: "4.3.11 is out — u updates" });
    expect(said(READY)).toEqual({ tone: "info", text: "4.3.11 is ready — u restarts the deck on it" });
    expect(said({ ...NEWEST, checkFailedAt: NOW, checkedAt: NOW - 3_600_000 })).toEqual({ tone: "warn", text: "npm could not be reached — u asks again" });
    // A failure older than the last answer is not the answer.
    expect(said({ ...NEWEST, checkFailedAt: NOW - 3_600_000, checkedAt: NOW }).tone).toBe("ok");
    expect(said({ ...NEWEST, checkDisabled: true, latest: null })).toMatchObject({ tone: "info", short: "update checks are off on this deck" });
    expect(said({ ...NEWEST, latestPending: "4.3.12" }).text).toContain("4.3.12 is tagged on npm but cannot be installed yet");
    expect(said({ notice: { kind: "upgrade", to: "4.3.11" }, upgradeMode: null, command: "npm i -g ccdeck@latest" }).tone).toBe("warn");
    expect(view.updateChecked(null, U).tone).toBe("err");
  });
});

describe("the screen at rest", () => {
  it("is nothing over the list and nothing under way", () => {
    expect(view.screenAtRest(deckState())).toBe(true);
    for (const over of [
      { help: true }, { busy: { text: "x", since: 0 } }, { starting: true }, { signin: view.openSignin() },
      { codexSignin: { id: null, started: false } }, { menu: { num: 1, view: "menu" } }, { lanForm: { view: "add" } },
    ]) expect(view.screenAtRest({ ...deckState(), ...over }), JSON.stringify(over)).toBe(false);
  });

  it("turns to a tab only once the deck serves it", () => {
    const s = deckState();
    expect(view.showSide(s, "codex")).toBe(s);
    expect(view.showSide(s, "lan")).toBe(s);
    expect(view.showSide(s, "claude")).toBe(s);
  });
});

// ── the reopen's pieces ─────────────────────────────────────────────────────

describe("the reopen's pieces", () => {
  it("starts the new screen from the entry this one was started from, inside the package", () => {
    const deck = join(PKG_ROOT, "bin", "deck.js");
    const supervisor = join(PKG_ROOT, "bin", "agent-dag.js");
    expect(tuiEntry({ argv1: deck, pkgRoot: PKG_ROOT })).toBe(deck);
    expect(tuiEntry({ argv1: supervisor, pkgRoot: PKG_ROOT })).toBe(supervisor);
    // A test runner, a script elsewhere, nothing at all: the worker that answers commands.
    expect(tuiEntry({ argv1: "/usr/lib/node_modules/vitest/vitest.mjs", pkgRoot: PKG_ROOT })).toBe(deck);
    expect(tuiEntry({ argv1: join(PKG_ROOT, "bin", "cli", "tui.js"), pkgRoot: PKG_ROOT })).toBe(deck);
    expect(tuiEntry({ argv1: undefined, pkgRoot: PKG_ROOT })).toBe(deck);
    // A link to the entry, as a global install's bin is, resolves to it.
    const linked = "/usr/local/bin/ccdeck";
    const real = (p: string) => (p === linked ? supervisor : realpathSync(p));
    expect(tuiEntry({ argv1: linked, pkgRoot: PKG_ROOT, real })).toBe(supervisor);
  });

  it("reads the note the screen before left, and nothing that is not one", () => {
    expect(resumedFrom(JSON.stringify({ side: "codex", from: "4.3.10" }))).toEqual({ side: "codex", from: "4.3.10" });
    expect(resumedFrom(JSON.stringify({ side: "lan" }))).toEqual({ side: "lan", from: null });
    expect(resumedFrom(JSON.stringify({ side: "nowhere", from: "\x1b]0;x" }))).toEqual({ side: "claude", from: null });
    expect(resumedFrom("{not json")).toBeNull();
    expect(resumedFrom("[]")).toBeNull();
    expect(resumedFrom("")).toBeNull();
    expect(resumedFrom(undefined)).toBeNull();
  });
});

// ── the loop, with a fake terminal and a fake deck ─────────────────────────

function fakeTerminal(columns = 100, rows = 30) {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode: (on: boolean) => void; raw: boolean[]; order: string[] };
  input.isTTY = true;
  input.isRaw = false;
  input.raw = [];
  input.order = [];
  input.setRawMode = (on: boolean) => { input.raw.push(on); input.order.push(`raw ${on}`); input.isRaw = on; };
  const pause = input.pause.bind(input);
  input.pause = () => { input.order.push("pause"); return pause(); };
  let written = "";
  const output = new Writable({ write(chunk, _enc, done) { written += String(chunk); done(); } }) as Writable & { isTTY: boolean; columns: number; rows: number };
  output.isTTY = true;
  output.columns = columns;
  output.rows = rows;
  return { input, output, written: () => written, screenText: () => stripAnsi(written) };
}

function quietOut() {
  return { json: false, say() {}, done: (_d: unknown, code = 0) => code, fail: (code: number) => code };
}

async function until(cond: () => boolean, ms = 5_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise(r => setTimeout(r, 10));
  }
}
const settle = (ms = 150) => new Promise(r => setTimeout(r, ms));

const CODEX = {
  profiles: [{
    id: "a".repeat(20), identityVersion: "v-a", label: "ann@openai.example", account: "ann@openai.example", active: true, available: true,
    signedIn: true, authSource: "native", metadataUnavailable: false, metadataReason: null, signedInFilePresent: true,
  }],
  revision: 1,
  live: { state: "idle", profileId: null, requestedProfileId: null, reason: null, continuation: "none", scope: "shared_native_server" },
};

/**
 * A deck on 4317 with an update report, a token that a restart replaces, and
 * the routes an update takes. Its clock is the test's: a wait moves it on, so
 * an install's two-second polls take no time at all.
 */
function updateDeck(over: Row = {}) {
  const clock = { t: Date.now() };
  const st = {
    token: "first",
    version: "4.3.10",
    report: report(over),
    asked: [] as string[],
    posts: [] as { path: string; body: unknown }[],
    codex: false,
    /** How many reports an install answers "running" before it lands. */
    installing: 2,
    /** What POST /api/upgrade and POST /api/restart answer, and what the
     *  install comes to. */
    upgradeAnswer: { ok: true, status: 200, body: { ok: true, command: "npm i -g ccdeck@latest" } } as Answer,
    restartAnswer: { ok: true, status: 200, body: { ok: true, mode: null } } as Answer,
    installEnds: { state: "done", error: null } as { state: string; error: string | null },
  };
  /** The deck brought back on `to`, with a new token, as its launcher does. */
  const restartOn = (to: string) => {
    st.token = "second";
    st.version = to;
    st.report = report({ running: to, installed: to, latest: to, notice: null });
  };
  const source = {
    find: async () => ({ port: 4317, version: st.version, token: st.token }),
    silent: async () => [],
    ask: async (d: { token?: string }, { method = "GET", path, body }: Asked): Promise<Answer> => {
      st.asked.push(`${method} ${path}`);
      if (d.token !== st.token) return { ok: false, status: 401, body: { error: "unauthenticated" } };
      if (method === "POST") st.posts.push({ path, body });
      if (path.startsWith("/api/version")) {
        const upgrade = (st.report.upgrade ?? {}) as Row;
        if (upgrade.state === "running" && st.installing-- <= 0) {
          st.report = st.installEnds.state === "done"
            ? report({ ...READY, upgrade: { state: "done", command: "npm i -g ccdeck@latest", error: null, at: clock.t } })
            : report({ upgrade: { state: st.installEnds.state, command: "npm i -g ccdeck@latest", error: st.installEnds.error, at: clock.t } });
        }
        return { ok: true, status: 200, body: st.report };
      }
      if (path === "/api/upgrade" && method === "POST") {
        if (st.upgradeAnswer.ok) st.report = { ...st.report, upgrade: { state: "running", command: "npm i -g ccdeck@latest", error: null, at: clock.t } };
        return st.upgradeAnswer;
      }
      if (path === "/api/restart" && method === "POST") {
        if (st.restartAnswer.ok) {
          const to = ((st.report.notice ?? {}) as Row).to as string;
          setTimeout(() => restartOn(to), 5);
        }
        return st.restartAnswer;
      }
      if (path.startsWith("/api/claude-accounts")) return { ok: true, status: 200, body: { ok: true, activeNum: 1, accounts: ROWS } };
      if (path === "/api/sessions") return { ok: true, status: 200, body: { ok: true, now: clock.t, sessions: [] } };
      if (st.codex && path === "/api/codex-profiles") return { ok: true, status: 200, body: CODEX };
      if (st.codex && path === "/api/codex-auto") return { ok: true, status: 200, body: { ok: true, enabled: false, choice: { next: "room", home: null }, heldOut: [] } };
      return { ok: false, status: 404, body: null };
    },
    localRoster: async () => ({ ok: false, reason: "no_cswap" }),
    switchDeck: async () => ({ ok: true, output: "switched" }),
    switchHere: async () => ({ ok: false, reason: "should_not_be_called" }),
    rules: async () => null,
    startDeck: () => { throw new Error("no deck is started in these tests"); },
    wait: async (ms: number) => { clock.t += ms; await new Promise(r => setTimeout(r, 2)); },
  };
  const posts = (path: string) => st.posts.filter(p => p.path === path);
  return { source, st, clock, posts, restartOn };
}

const LOOK = { unicode: true, g: glyphs(true), tone: palette("none"), profile: "none" };

/** The screen on `deck`, this screen's own code on 4.3.10 and its package on
 *  disk too, unless `deps` says otherwise. */
function open(deck: ReturnType<typeof updateDeck>, deps: Row = {}, term = fakeTerminal()) {
  const done = runTui({}, quietOut(), {
    input: term.input, output: term.output, source: deck.source, tickMs: 10, now: () => deck.clock.t,
    own: "4.3.10", versionOnDisk: () => "4.3.10", newCodeStarts: () => { throw new Error("not to be asked"); },
    reopen: async () => { throw new Error("not to be reopened"); },
    ...LOOK, ...deps,
  });
  return { term, done };
}

describe("the loop", () => {
  it("reads the report once a deck is found, says it in the title bar, and asks npm nothing", async () => {
    const deck = updateDeck();
    const { term, done } = open(deck);
    await until(() => term.screenText().includes("ccdeck 4.3.10 · 4.3.11 is out"));
    expect(term.screenText()).toContain("u update");
    // Every ten minutes, never ?refresh=1 on its own.
    const reads = () => deck.st.asked.filter(a => a === "GET /api/version").length;
    expect(reads()).toBe(1);
    deck.clock.t += 600_000;
    await until(() => reads() === 2);
    expect(deck.st.asked.some(a => a.includes("/api/version?refresh=1"))).toBe(false);
    term.input.write("q");
    expect(await done).toBe(0);
  });

  it("says nothing at all about a deck from before the report", async () => {
    const deck = updateDeck();
    const ask = deck.source.ask;
    deck.source.ask = async (d: { token?: string }, o: Asked) => {
      if (!o.path.startsWith("/api/version")) return ask(d, o);
      deck.st.asked.push(`GET ${o.path}`);
      return { ok: false, status: 404, body: null };
    };
    const { term, done } = open(deck);
    await until(() => term.screenText().includes("bob@home.example") && deck.st.asked.includes("GET /api/version"));
    await settle();
    expect(term.screenText()).not.toMatch(/is out|is ready|could not|answered 404/);
    term.input.write("q");
    expect(await done).toBe(0);
  });

  it("u with none named asks npm now, and says this is the newest", async () => {
    const deck = updateDeck(NEWEST);
    const { term, done } = open(deck);
    await until(() => term.screenText().includes("bob@home.example") && deck.st.asked.includes("GET /api/version"));
    const refreshed = () => deck.st.asked.filter(a => a.startsWith("GET /api/version?"));
    expect(refreshed()).toEqual([]);
    term.input.write("u");
    await until(() => term.screenText().includes("4.3.10 is the newest"));
    expect(refreshed()).toEqual(["GET /api/version?refresh=1"]);
    expect(term.screenText()).toContain("checking for an update");
    expect(deck.st.posts).toEqual([]);
    term.input.write("q");
    expect(await done).toBe(0);
  });

  it("u with none named finds one, says it, and takes it only on the next u", async () => {
    const deck = updateDeck(NEWEST);
    const ask = deck.source.ask;
    deck.source.ask = async (d: { token?: string }, o: Asked) => {
      if (o.path === "/api/version?refresh=1") deck.st.report = report();
      return ask(d, o);
    };
    const { term, done } = open(deck);
    await until(() => term.screenText().includes("bob@home.example") && deck.st.asked.includes("GET /api/version"));
    term.input.write("u");
    await until(() => term.screenText().includes("4.3.11 is out — u updates"));
    expect(term.screenText()).toContain("ccdeck 4.3.10 · 4.3.11 is out");
    expect(deck.st.posts).toEqual([]);
    term.input.write("q");
    expect(await done).toBe(0);
  });

  it("u says npm could not be reached when the lookup failed", async () => {
    const deck = updateDeck({ ...NEWEST, checkFailedAt: NOW, checkedAt: NOW - 3_600_000 });
    const { term, done } = open(deck);
    await until(() => term.screenText().includes("bob@home.example") && deck.st.asked.includes("GET /api/version"));
    term.input.write("u");
    await until(() => term.screenText().includes("npm could not be reached — u asks again"));
    term.input.write("q");
    expect(await done).toBe(0);
  });

  it("u restarts the deck onto an update already installed, and follows it back", async () => {
    const deck = updateDeck(READY);
    const { term, done } = open(deck);
    await until(() => term.screenText().includes("4.3.11 is ready"));
    term.input.write("u");
    await until(() => term.screenText().includes("the deck runs 4.3.11"));
    expect(term.screenText()).toContain("restarting the deck on 4.3.11");
    expect(deck.posts("/api/restart")).toEqual([{ path: "/api/restart", body: undefined }]);
    expect(deck.posts("/api/upgrade")).toEqual([]);
    // The deck found again is asked for its report, and names nothing now.
    await until(() => deck.st.asked.includes("GET /api/version") && deck.st.asked.lastIndexOf("GET /api/version") > deck.st.asked.indexOf("POST /api/restart"));
    const mark = term.written().length;
    term.output.emit("resize");
    await until(() => stripAnsi(term.written().slice(mark)).includes("bob@home.example"));
    const now = stripAnsi(term.written().slice(mark));
    expect(now).toContain("ccdeck 4.3.11");
    expect(now).not.toContain("is ready");
    term.input.write("q");
    expect(await done).toBe(0);
  });

  it("u installs through the deck, then restarts onto what it installed", async () => {
    const deck = updateDeck();
    const { term, done } = open(deck);
    await until(() => term.screenText().includes("4.3.11 is out"));
    term.input.write("u");
    await until(() => term.screenText().includes("the deck runs 4.3.11"));
    expect(term.screenText()).toContain("installing 4.3.11");
    expect(deck.st.posts.map(p => p.path)).toEqual(["/api/upgrade", "/api/restart"]);
    expect(deck.posts("/api/restart")[0].body).toBeUndefined();
    term.input.write("q");
    expect(await done).toBe(0);
  });

  it("an install that fails says npm's reason, on one line, and restarts nothing", async () => {
    const deck = updateDeck();
    deck.st.installEnds = { state: "failed", error: "npm ERR! code EACCES\nnpm ERR! syscall mkdir" };
    const { term, done } = open(deck);
    await until(() => term.screenText().includes("4.3.11 is out"));
    term.input.write("u");
    await until(() => term.screenText().includes("could not install 4.3.11 — npm ERR! code EACCES npm ERR! syscall mkdir"));
    expect(deck.posts("/api/restart")).toEqual([]);
    term.input.write("q");
    expect(await done).toBe(0);
  });

  it("an install the deck refuses says why, with the command", async () => {
    const deck = updateDeck();
    deck.st.upgradeAnswer = { ok: false, status: 409, body: { ok: false, reason: "not_writable", command: "npm i -g ccdeck@latest" } };
    for (const [columns, said] of [
      [140, "✗  could not install 4.3.11 — the install directory is not writable by this user: npm i -g ccdeck@latest"],
      [90, "✗  the install directory is not writable by this user: npm i -g ccdeck@latest"],
    ] as [number, string][]) {
      const { term, done } = open(deck, {}, fakeTerminal(columns, 30));
      await until(() => term.screenText().includes("4.3.11 is out"));
      term.input.write("u");
      await until(() => term.screenText().includes(said));
      expect(deck.posts("/api/restart")).toEqual([]);
      term.input.write("q");
      expect(await done).toBe(0);
    }
  });

  it("u on an npx deck asks the deck to relaunch through npx", async () => {
    const deck = updateDeck({ upgradeMode: "npx", upgradeBlocked: "npx", command: "npx -y ccdeck@latest" });
    const { term, done } = open(deck);
    await until(() => term.screenText().includes("4.3.11 is out"));
    term.input.write("u");
    await until(() => term.screenText().includes("the deck runs 4.3.11"));
    expect(deck.st.posts).toEqual([{ path: "/api/restart", body: { upgrade: true } }]);
    term.input.write("q");
    expect(await done).toBe(0);
  });

  it("a copy that cannot update itself is told the command, and nothing is asked", async () => {
    const deck = updateDeck({ upgradeMode: null, upgradeBlocked: "git_checkout", command: "git pull && npm run build" });
    const { term, done } = open(deck);
    await until(() => term.screenText().includes("4.3.11 is out"));
    term.input.write("u");
    await until(() => term.screenText().includes("4.3.11 is out — this copy cannot update itself: git pull && npm run build"));
    expect(deck.st.posts).toEqual([]);
    expect(deck.st.asked.some(a => a.startsWith("GET /api/version?"))).toBe(false);
    term.input.write("q");
    expect(await done).toBe(0);
  });

  it("a restart that would lose the canvas is not asked for", async () => {
    const deck = updateDeck({ ...READY, canRestart: false });
    const { term, done } = open(deck);
    await until(() => term.screenText().includes("4.3.11 is ready"));
    term.input.write("u");
    await until(() => term.screenText().includes("4.3.11 is installed — a restart from here would lose the canvas"));
    expect(deck.st.posts).toEqual([]);
    term.input.write("q");
    expect(await done).toBe(0);
  });

  it("says the deck's own refusals in a line: no event log, and no launcher", async () => {
    for (const [answer, said] of [
      [{ ok: false, status: 409, body: { ok: false, reason: "no_persist" } }, "a restart would lose the canvas — this deck runs with --no-persist"],
      [{ ok: false, status: 409, body: { ok: false, reason: "log_unwritable" } }, "a restart would lose the canvas — the deck cannot write its event log"],
      [{ ok: false, status: 501, body: { ok: false, reason: "unsupervised" } }, "the deck was started without its launcher — it cannot restart itself"],
    ] as [Answer, string][]) {
      const deck = updateDeck(READY);
      deck.st.restartAnswer = answer;
      const { term, done } = open(deck);
      await until(() => term.screenText().includes("4.3.11 is ready"));
      term.input.write("u");
      await until(() => term.screenText().includes(said));
      expect(deck.posts("/api/restart").length).toBe(1);
      // Still the deck it was, on the version it ran.
      expect(deck.st.token).toBe("first");
      term.input.write("q");
      expect(await done).toBe(0);
    }
  });

  it("takes one update at a time", async () => {
    const deck = updateDeck();
    deck.st.installing = 1_000;
    const { term, done } = open(deck);
    await until(() => term.screenText().includes("4.3.11 is out"));
    term.input.write("u");
    await until(() => deck.posts("/api/upgrade").length === 1);
    term.input.write("u");
    term.input.write("u");
    await settle();
    expect(deck.posts("/api/upgrade").length).toBe(1);
    expect(deck.posts("/api/restart")).toEqual([]);
    term.input.write("q");
    expect(await done).toBe(0);
  });
});

// ── the reopen ──────────────────────────────────────────────────────────────

describe("following the update onto the new code", () => {
  /** A deck already on 4.3.11 under a screen still on 4.3.10's code. */
  function ahead(over: Row = {}) {
    const deck = updateDeck({ running: "4.3.11", installed: "4.3.11", latest: "4.3.11", notice: null });
    deck.st.version = "4.3.11";
    const reopened: Row[] = [];
    const started: string[] = [];
    const deps = {
      versionOnDisk: () => "4.3.11",
      newCodeStarts: (v: string) => { started.push(v); return true; },
      reopen: async (args: Row) => { reopened.push(args); return 7; },
      ...over,
    };
    return { deck, reopened, started, deps };
  }

  it("reopens at rest once the deck and this install's package both say the newer version", async () => {
    const { deck, reopened, started, deps } = ahead();
    const { term, done } = open(deck, deps);
    await until(() => term.screenText().includes("bob@home.example"));
    await settle();
    expect(reopened).toEqual([]);           // the screen just opened: not at rest yet
    deck.clock.t += REST_MS;
    // The new screen's exit code is this one's.
    expect(await done).toBe(7);
    expect(started).toEqual(["4.3.11"]);
    expect(reopened).toEqual([{ port: 4317, side: "claude", from: "4.3.10", to: "4.3.11" }]);
    // The terminal handed back exactly as q hands it back, for the new screen to take.
    expect(term.written().endsWith(ALT_SCREEN_OFF)).toBe(true);
    expect(term.input.order.slice(-2)).toEqual(["pause", "raw false"]);
    expect(term.input.raw).toEqual([true, false]);
  });

  it("waits for a key's few seconds to pass", async () => {
    const { deck, reopened, deps } = ahead();
    const { term, done } = open(deck, deps);
    await until(() => term.screenText().includes("bob@home.example"));
    deck.clock.t += REST_MS - 1_000;
    term.input.write("j");
    deck.clock.t += REST_MS - 1_000;
    await settle();
    expect(reopened).toEqual([]);
    deck.clock.t += 1_000;
    expect(await done).toBe(7);
    expect(reopened.length).toBe(1);
  });

  it("does not reopen over a page, a menu, help or work under way", async () => {
    for (const keys of ["+", "m", "?"]) {
      const { deck, reopened, deps } = ahead();
      const { term, done } = open(deck, deps);
      await until(() => term.screenText().includes("bob@home.example"));
      term.input.write(keys);
      deck.clock.t += REST_MS * 4;
      await settle();
      expect(reopened, keys).toEqual([]);
      term.input.write("\x03");
      expect(await done).toBe(0);
    }
    // A switch the deck has not answered: busy, and a key's request still out.
    const { deck, reopened, deps } = ahead();
    deck.source.switchDeck = () => new Promise(() => {});
    const { term, done } = open(deck, deps);
    await until(() => term.screenText().includes("bob@home.example"));
    term.input.write("\x1b[B");
    term.input.write("\r");
    await until(() => term.screenText().includes("switching to #2 bob@home.example"));
    deck.clock.t += REST_MS * 4;
    await settle();
    expect(reopened).toEqual([]);
    term.input.write("q");
    expect(await done).toBe(0);
  });

  it("does not follow an install that is not the deck's, and says so once", async () => {
    const { deck, reopened, deps } = ahead({ versionOnDisk: () => "4.3.12" });
    const { term, done } = open(deck, deps);
    await until(() => term.screenText().includes("ccdeck 4.3.12 is installed — q, then open the tui again"));
    deck.clock.t += REST_MS * 4;
    await settle();
    expect(reopened).toEqual([]);
    // Taken down by a key, it does not come back.
    term.input.write("j");
    deck.clock.t += 60_000;
    await settle();
    const mark = term.written().length;
    term.output.emit("resize");
    await until(() => stripAnsi(term.written().slice(mark)).includes("bob@home.example"));
    expect(stripAnsi(term.written().slice(mark))).not.toContain("is installed");
    term.input.write("q");
    expect(await done).toBe(0);
  });

  it("says nothing while the deck is about to restart onto what is on disk", async () => {
    const deck = updateDeck(READY);
    const { term, done } = open(deck, { versionOnDisk: () => "4.3.11" });
    await until(() => term.screenText().includes("4.3.11 is ready"));
    deck.clock.t += REST_MS * 4;
    await settle();
    expect(term.screenText()).not.toContain("is installed — q");
    term.input.write("q");
    expect(await done).toBe(0);
  });

  it("stays, and says so once, when the new code does not start", async () => {
    const { deck, reopened, started, deps } = ahead({ newCodeStarts: (v: string) => { started.push(v); return false; } });
    const { term, done } = open(deck, deps);
    await until(() => term.screenText().includes("bob@home.example"));
    deck.clock.t += REST_MS;
    await until(() => term.screenText().includes("could not open the new screen — q, then open the tui again"));
    deck.clock.t += REST_MS * 10;
    await settle();
    expect(started).toEqual(["4.3.11"]);
    expect(reopened).toEqual([]);
    term.input.write("q");
    expect(await done).toBe(0);
  });

  it("follows an update taken with u onto the new code", async () => {
    const deck = updateDeck(READY);
    const reopened: Row[] = [];
    // This install is the deck's: what the restart lands on is what is on disk.
    const { term, done } = open(deck, {
      versionOnDisk: () => deck.st.report.installed,
      newCodeStarts: () => true,
      reopen: async (args: Row) => { reopened.push(args); return 0; },
    });
    await until(() => term.screenText().includes("4.3.11 is ready"));
    term.input.write("u");
    await until(() => term.screenText().includes("the deck runs 4.3.11"));
    deck.clock.t += REST_MS;
    expect(await done).toBe(0);
    expect(reopened).toEqual([{ port: 4317, side: "claude", from: "4.3.10", to: "4.3.11" }]);
  });

  it("opens the new screen on the tab the old one was on, and says the update took", async () => {
    const deck = updateDeck({ running: "4.3.11", installed: "4.3.11", latest: "4.3.11", notice: null });
    deck.st.version = "4.3.11";
    deck.st.codex = true;
    const { term, done } = open(deck, {
      own: "4.3.11", versionOnDisk: () => "4.3.11", resumed: JSON.stringify({ side: "codex", from: "4.3.10" }),
    });
    await until(() => term.screenText().includes("Claude [Codex]") && term.screenText().includes("ann@openai.example"));
    expect(term.screenText()).toContain("updated to 4.3.11");
    expect(term.written()).toContain(ALT_SCREEN_ON);
    deck.clock.t += REST_MS * 4;
    await settle();
    term.input.write("q");
    expect(await done).toBe(0);
  });
});
