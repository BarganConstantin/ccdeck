// Sessions still running on an older session host (Windows): the keys bar's
// line, the Review dialog, and what End and Keep them running do.
//
// What is pinned: the line is said only when there is something to say — a
// host the engine moved on from, a security update waiting, or new sessions
// refused — and is gone on any failure to read (the panel off, a deck with no
// session host); End sends exactly the ids the dialog listed with that host's
// generation, once; a refusal because the list changed or the host went reads
// the list again, any other is said and not asked again; Keep them running is
// the dialog's first answer and changes nothing but the line.
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { all, one, textOf, type Drawn } from "./fake-react";
import { withoutComments } from "./tsx-scan";
import type { ApiFailure, HostsAnswer, OlderHost } from "../terminal-api";
import {
  REFUSED_UNTIL_THEY_END,
  endHost,
  endLabel,
  hostReason,
  hostsConsequences,
  hostsFingerprint,
  hostsLine,
  readHosts,
  type HostsApi,
  type HostsView,
} from "../components/terminal/older-hosts";
import { HostsReview, type HostsReviewProps } from "../components/terminal/HostsDialog";
import KeysBar, { HostsNote, type KeysBarProps } from "../components/terminal/KeysBar";

const id = (n: number) => n.toString(16).padStart(32, "0");
const NOW = 1_700_000_000_000;
const session = (n: number, agent: "claude" | "codex" = "claude") =>
  ({ id: id(n), name: `proj-${n}`, agent, cwd: `C:\\work\\proj-${n}`, conversation: "", started: NOW - 2 * 3600_000 });
const host = (generation: number, state: OlderHost["state"], ...sessions: ReturnType<typeof session>[]): OlderHost => ({ generation, state, sessions });
const view = (hosts: OlderHost[], launchesRefused: string | null = null): HostsView => ({ hosts, launchesRefused });
const REFUSED = "Sessions still run on two older session hosts. End or restart them to start new sessions.";
const OUTDATED: ApiFailure = { ok: false, status: 409, error: "The sessions on that session host changed. Review them again.", code: "consent-outdated" };
const GONE: ApiFailure = { ok: false, status: 409, error: "That session host is no longer running.", code: "host-gone" };

/** An api whose reads answer `reads` in turn (the last one again after), and
 *  whose ends answer `ends` in turn; every call recorded. */
function api(reads: Array<HostsAnswer | ApiFailure>, ends: Array<{ ok: true; ended: number } | ApiFailure> = []) {
  const calls: string[] = [];
  const orders: unknown[] = [];
  let r = 0, e = 0;
  const a: HostsApi = {
    read: async () => { calls.push("read"); return reads[Math.min(r++, reads.length - 1)]; },
    end: async order => { calls.push("end"); orders.push(order); return ends[e++]; },
  };
  return { api: a, calls, orders };
}
const answer = (hosts: OlderHost[], launchesRefused: string | null = null): HostsAnswer => ({ ok: true, hosts, launchesRefused });

describe("the keys bar's line", () => {
  it("counts the sessions a host the engine moved on from still runs", () => {
    expect(hostsLine(view([host(1, "stranded", session(1))]), false)).toBe("1 session still runs on an older session host.");
    expect(hostsLine(view([host(1, "stranded", session(1), session(2)), host(2, "stranded", session(3))]), false))
      .toBe("3 sessions still run on older session hosts.");
  });

  it("names a security update waiting on them as one", () => {
    expect(hostsLine(view([host(1, "security", session(1), session(2))]), false))
      .toBe("A security update is waiting on 2 sessions on an older session host.");
  });

  it("adds that new sessions are refused, and says the engine's own sentence when that is all there is", () => {
    expect(hostsLine(view([host(1, "stranded", session(1))], REFUSED), false))
      .toBe(`1 session still runs on an older session host. ${REFUSED_UNTIL_THEY_END}`);
    expect(REFUSED_UNTIL_THEY_END).toBe("New sessions are refused until they end.");
    expect(hostsLine(view([], REFUSED), false)).toBe(REFUSED);
  });

  it("says nothing for a host that closes once its sessions end, nor for nothing", () => {
    expect(hostsLine(view([host(1, "draining", session(1))]), false)).toBeNull();
    expect(hostsLine(null, false)).toBeNull();
  });

  it("says what keeping them running means once the reader chose it", () => {
    expect(hostsLine(view([host(1, "stranded", session(1))]), true)).toBe("Kept running: the Command Panel cannot open that session here.");
    expect(hostsLine(view([host(1, "security", session(1), session(2))], REFUSED), true))
      .toBe(`Kept running: the Command Panel cannot open those 2 sessions here. ${REFUSED_UNTIL_THEY_END}`);
  });
});

describe("reading the hosts", () => {
  it("keeps the hosts with sessions, and is nothing when there is nothing to say", async () => {
    const empty = host(3, "stranded");
    expect(await readHosts(api([answer([host(1, "stranded", session(1)), empty])]).api)).toEqual(view([host(1, "stranded", session(1))]));
    expect(await readHosts(api([answer([empty])]).api)).toBeNull();
    expect(await readHosts(api([answer([], REFUSED)]).api)).toEqual(view([], REFUSED));
  });

  it("is nothing on any failure: the panel off, a deck with no session host, no answer", async () => {
    const failures: ApiFailure[] = [
      { ok: false, status: 404, error: "The Command Panel is not switched on for this deck." },
      { ok: false, status: 409, error: "No terminal.", code: "no-terminal" },
      { ok: false, status: null, error: "The deck did not answer." },
    ];
    for (const f of failures) expect(await readHosts(api([f]).api), f.error).toBeNull();
  });

  it("tells one list from another by its hosts and the ids on them", () => {
    const a = view([host(1, "stranded", session(1))]);
    expect(hostsFingerprint(a)).toBe(hostsFingerprint(view([host(1, "stranded", session(1))], REFUSED)));
    expect(hostsFingerprint(a)).not.toBe(hostsFingerprint(view([host(1, "stranded", session(1), session(2))])));
    expect(hostsFingerprint(a)).not.toBe(hostsFingerprint(view([host(2, "stranded", session(1))])));
  });
});

describe("End", () => {
  const listed = host(4, "stranded", session(1), session(2));

  it("asks once, with exactly the listed ids and that host's generation, then reads the list again", async () => {
    const a = api([answer([])], [{ ok: true, ended: 2 }]);
    expect(await endHost(a.api, listed)).toEqual({ ended: 2, view: null, said: null });
    expect(a.orders).toEqual([{ generation: 4, sessions: [id(1), id(2)] }]);
    expect(a.calls).toEqual(["end", "read"]);
  });

  it("reads the list again when it changed since the reader looked, or the host went, and says the engine's sentence", async () => {
    const changed = host(4, "stranded", session(1), session(2), session(3));
    const a = api([answer([changed])], [OUTDATED]);
    expect(await endHost(a.api, listed)).toEqual({ ended: 0, view: view([changed]), said: OUTDATED.error });
    const b = api([answer([])], [GONE]);
    expect(await endHost(b.api, listed)).toEqual({ ended: 0, view: null, said: GONE.error });
    expect([a.calls, b.calls]).toEqual([["end", "read"], ["end", "read"]]);
  });

  it("says any other refusal and asks nothing more: no retry, no read", async () => {
    const failures: ApiFailure[] = [
      { ok: false, status: 500, error: "The deck could not end those sessions. Try again.", code: "end-failed" },
      { ok: false, status: 400, error: "That is the current session host." },
      { ok: false, status: 500, error: "The deck answered in a form this page cannot read." },
    ];
    for (const failed of failures) {
      const a = api([answer([listed])], [failed]);
      expect(await endHost(a.api, listed), failed.error).toEqual({ ended: 0, said: failed.error });
      expect(a.calls, failed.error).toEqual(["end"]);
    }
  });
});

describe("the Review dialog", () => {
  const props = (over: Partial<HostsReviewProps> = {}): HostsReviewProps => ({
    view: view([host(1, "stranded", session(1), session(2, "codex"))]),
    now: NOW, busy: null, said: null, onEnd: vi.fn(), onKeep: vi.fn(), ...over,
  });
  const buttons = (tree: unknown) => all(tree, el => el.type === "button");
  const press = (el: Drawn | null) => { expect(el).not.toBeNull(); (el!.props.onClick as () => void)(); };

  it("lists each session with its agent, folder and age, why its host is listed, and what ending costs", () => {
    const html = renderToStaticMarkup(createElement(HostsReview, props()));
    expect(html).toContain("proj-1");
    expect(html).toContain("Claude Code · proj-1 · started 2h ago");
    expect(html).toContain("Codex · proj-2 · started 2h ago");
    expect(html).toContain(hostReason(host(1, "stranded")));
    expect(hostReason(host(1, "stranded"))).toBe("The Command Panel has moved to a newer session host and cannot open these here.");
    expect(hostReason(host(1, "security"))).toBe("A security update replaces this session host once these end.");
    expect(hostReason(host(1, "draining"))).toBe("This session host closes once these end.");
    expect(textOf(HostsReview(props()))).toContain("Those agents, at once. Work they have not saved is lost.");
    expect(textOf(HostsReview(props()))).toContain("Each conversation, in Claude's and Codex's own history. On Windows the Command Panel cannot reopen it.");
  });

  it("names whose history keeps the conversations", () => {
    expect(hostsConsequences(view([host(1, "stranded", session(1))])).stays).toBe("Each conversation, in Claude's own history. On Windows the Command Panel cannot reopen it.");
    expect(hostsConsequences(view([host(1, "stranded", session(1, "codex"))])).stays).toContain("in Codex's own history");
  });

  it("offers Keep them running first, and one End per host for exactly its sessions", () => {
    const p = props({ view: view([host(1, "stranded", session(1), session(2)), host(2, "security", session(3))], REFUSED) });
    const tree = HostsReview(p);
    expect(buttons(tree).map(textOf)).toEqual(["End 2 sessions", "End 1 session", "Keep them running"]);
    expect(endLabel(host(2, "security", session(3)))).toBe("End 1 session");
    press(one(tree, el => el.type === "button" && textOf(el) === "End 1 session"));
    expect(p.onEnd).toHaveBeenCalledWith(p.view.hosts[1]);
    press(one(tree, el => el.type === "button" && textOf(el) === "Keep them running"));
    expect(p.onKeep).toHaveBeenCalledTimes(1);
    expect(textOf(tree)).toContain(REFUSED);
  });

  it("holds the other End while one is on its way, keeps the pressed one focusable (#518), and says a refusal as a status", () => {
    const tree = HostsReview(props({ view: view([host(1, "stranded", session(1)), host(2, "stranded", session(2))]), busy: 2, said: OUTDATED.error }));
    const ends = buttons(tree).filter(b => textOf(b).startsWith("End"));
    expect(ends.map(b => [b.props.disabled, b.props["aria-busy"]])).toEqual([[true, undefined], [false, true]]);
    expect(textOf(one(tree, el => el.props.role === "status"))).toBe(OUTDATED.error);
  });

  it("is a dialog on the confirm layer, in <body>, with Keep them running focused and ✕ as cancel", () => {
    const src = withoutComments(readFileSync(fileURLToPath(new URL("../components/terminal/HostsDialog.tsx", import.meta.url)), "utf8"));
    expect(src).toMatch(/return createPortal\(\s*<div className="modal-backdrop"[\s\S]*?,\s*document\.body,?\s*\);/);
    expect(src).toMatch(/useModalDismiss\(p\.onCancel, \{ focusRef: keepRef, layer: CONFIRM_LAYER \}\)/);
    expect(src).toMatch(/useScrimDismiss\(p\.onCancel\)/);
    expect(src).toMatch(/onClick=\{p\.onCancel\} aria-label="Cancel \(Esc\)"/);
    expect(src).toMatch(/role="dialog"\s+aria-modal="true"/);
  });
});

describe("the line in the keys bar", () => {
  const bar = (over: Partial<KeysBarProps> = {}): KeysBarProps => ({
    owner: "board", name: "paycore", chordLabel: "Ctrl+Shift+X", canType: true, asksWaiting: false,
    firstRun: false, onFirstRunDone: vi.fn(), onTypeHere: vi.fn(), ...over,
  });
  const said = "1 session still runs on an older session host.";

  it("says the line with Review, which opens the dialog", () => {
    const onReview = vi.fn();
    const html = renderToStaticMarkup(createElement(KeysBar, bar({ hosts: { said, onReview } })));
    expect(html).toContain(said);
    expect(html).toContain(">Review</button>");
    const note = HostsNote({ hosts: { said, onReview } });
    (one(note, el => el.type === "button")!.props.onClick as () => void)();
    expect(onReview).toHaveBeenCalledTimes(1);
  });

  it("offers no Review when there is nothing to review", () => {
    const html = renderToStaticMarkup(createElement(KeysBar, bar({ hosts: { said: REFUSED, onReview: null } })));
    expect(html).toContain(REFUSED);
    expect(html).not.toContain(">Review<");
  });

  it("gives way to an ask, and stays beside an end bar", () => {
    const asks = { segments: ["now" as const], position: { index: 0, total: 1 } };
    expect(renderToStaticMarkup(createElement(KeysBar, bar({ hosts: { said, onReview: vi.fn() }, asks })))).not.toContain(said);
    expect(renderToStaticMarkup(createElement(KeysBar, bar({ hosts: { said, onReview: vi.fn() }, arrival: { name: "api" } })))).not.toContain(said);
    const end = { sentence: "The session ended — this is its last frame.", action: "Reopen here", onAction: vi.fn() };
    expect(renderToStaticMarkup(createElement(KeysBar, bar({ hosts: { said, onReview: vi.fn() }, end })))).toContain(said);
  });
});
