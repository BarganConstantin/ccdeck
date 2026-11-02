// The topbar names who is waiting (2026-10-08; since V4's top bar it does so
// in the waiting pill's queue popover, not in a row of names on the bar). The count was the whole of what
// the bar said about the sessions stopped on you, and which ones lived in its
// tooltip; with the panel toggles gone to the window's edges, the room they
// held goes to the sessions themselves — "web-api  Bash · 6m" — longest wait
// first, a press from the card.
//
// What this file holds the queue to:
//   - the order is the count's and W's (#825): oldest first, so a click on a
//     name and the next W press agree on where W goes next;
//   - as many names as fit whole, then "+N more", and none at all rather than
//     a "+N more" standing alone when not even the first fits;
//   - the names fold before the count: the queue only takes what the bar has
//     left, so it is the first thing a narrowing bar takes back, and the count
//     stays the readout's last child, the last thing clipped (#849);
//   - neutral words — amber is the count's — and no placeholder when nothing
//     waits, which on a machine running Codex would be a claim the deck cannot
//     back (README, Blocked on you);
//   - a whole accessible name per name, and no live region of its own: the
//     count's region already speaks when a session starts waiting.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { blockedSessions, nextWaiting, type BlockedSession } from "../ambient-counts";
import { namesThatFit, queueEntryDetail, queueEntryName, queueName, QUEUE_NAME_CHARS, spokenWait, waitWhat } from "../waiting-queue";
import { WaitingStat } from "../components/TopbarReadouts";
import { sourceOf } from "./client-source";
import { sheetText } from "./sheet-source";
import type { AgentNodeData, WaitingBlock } from "../types";

const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
const ruleBody = (selector: string): string => {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, `no rule for ${selector}`).toBeGreaterThan(-1);
  return css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
};

const block = (over: Partial<WaitingBlock> = {}): WaitingBlock =>
  ({ kind: "permission", message: "Claude needs your permission to use Bash", since: 0, ...over }) as WaitingBlock;
const session = (id: string, label: string, since: number, over: Partial<WaitingBlock> = {}): BlockedSession =>
  ({ id, label, waiting: block({ since, ...over }) });

describe("which names fit (namesThatFit)", () => {
  const gap = 4;
  const more = 60;

  it("names every one when they all fit, with no '+N more'", () => {
    // 100 + 4 + 100 = 204, and nothing is left over to need the "+N more".
    expect(namesThatFit({ widths: [100, 100], room: 204, gap, more })).toBe(2);
  });

  it("names as many as fit whole, leaving room for '+N more' after them", () => {
    // Three of 100 would fit in 310 on their own (308), but then two are left
    // over and their "+2 more" needs 64 more: two names and the "+2 more" is
    // 100 + 4 + 100 + 4 + 60 = 268.
    expect(namesThatFit({ widths: [100, 100, 100, 100], room: 310, gap, more })).toBe(2);
    expect(namesThatFit({ widths: [100, 100, 100, 100], room: 371, gap, more })).toBe(2);
    expect(namesThatFit({ widths: [100, 100, 100, 100], room: 372, gap, more })).toBe(3);
  });

  it("does not need the '+N more' room for the last name", () => {
    // The last one fits in exactly its own width: nothing after it to count.
    expect(namesThatFit({ widths: [100, 100, 100], room: 308, gap, more })).toBe(3);
    // A pixel short of the third, and two of them and "+1 more" (268) fit.
    expect(namesThatFit({ widths: [100, 100, 100], room: 307, gap, more })).toBe(2);
  });

  it("names none when not even the first fits, rather than a '+N more' alone", () => {
    // The count beside the queue already says how many, and goes to the first.
    expect(namesThatFit({ widths: [100, 100], room: 99, gap, more })).toBe(0);
    expect(namesThatFit({ widths: [100], room: 0, gap, more })).toBe(0);
    expect(namesThatFit({ widths: [], room: 500, gap, more })).toBe(0);
  });

  it("keeps the order it is given: the first names are the first sessions", () => {
    // A wide second name does not let a narrow third one jump the queue.
    expect(namesThatFit({ widths: [80, 400, 80], room: 300, gap, more })).toBe(1);
  });
});

describe("the order is the count's and W's (#825)", () => {
  const agents = [
    { id: "a", sessionId: "a", kind: "root", label: "newest", waiting: block({ since: 3_000 }) },
    { id: "b", sessionId: "b", kind: "root", label: "oldest", waiting: block({ since: 1_000 }) },
    { id: "c", sessionId: "c", kind: "root", label: "middle", waiting: block({ since: 2_000, kind: "asked" }) },
  ] as unknown as AgentNodeData[];
  const queue = blockedSessions(agents);

  it("lists the rows oldest first, the order the count and W walk", () => {
    expect(queue.map(w => w.label)).toEqual(["oldest", "middle", "newest"]);
    // The popover is portalled (no static render); its rows are the pill's own
    // queue, mapped in order, one per waiting session, none cut to "fit".
    const src = sourceOf("components/TopbarReadouts.tsx");
    expect(src).toMatch(/sessions=\{waitingSessions\}/);
    expect(src).toMatch(/\{sessions\.map\(w => \(\s*<button\s+key=\{w\.id\}\s+type="button"\s+role="menuitem"/);
  });

  it("puts W's cursor on the name pressed, so the next W goes to the one after it", () => {
    // What a press on a name does: the cursor, then the camera — the count's
    // own two steps, for a session that is not necessarily the first.
    const src = sourceOf("components/TopbarReadouts.tsx");
    expect(src).toMatch(/onPick=\{id => \{\s*waitingCursorRef\.current = id;\s*close\(\);\s*focusSession\(id\);/);
    expect(src).toMatch(/className="queue-row"\s*onClick=\{\(\) => onPick\(w\.id\)\}/);
    for (const [pressed, next] of [["b", "c"], ["c", "a"], ["a", "b"]]) {
      expect(nextWaiting(queue, pressed)!.id, `after ${pressed}`).toBe(next);
    }
  });

  it("goes to the same session from the first row and from W", () => {
    // The pill no longer jumps straight to the longest wait: its first row is
    // that wait, and W (use-deck-shortcuts.ts) still starts there.
    expect(nextWaiting(queue, null)!.id).toBe(queue[0].id);
  });
});

describe("what each name says", () => {
  it("says what the session is stopped on in a word: the tool, else the kind", () => {
    expect(waitWhat(block({ tool: { name: "Bash" } as WaitingBlock["tool"] }))).toBe("Bash");
    expect(waitWhat(block())).toBe("permission");
    expect(waitWhat(block({ kind: "asked" }))).toBe("question");
  });

  it("speaks the wait in words, not the eye's 6m", () => {
    expect(spokenWait(0)).toBe("less than a minute");
    expect(spokenWait(59_999)).toBe("less than a minute");
    expect(spokenWait(60_000)).toBe("1 minute");
    expect(spokenWait(6 * 60_000)).toBe("6 minutes");
    expect(spokenWait(60 * 60_000)).toBe("1 hour");
    expect(spokenWait(65 * 60_000)).toBe("1 hour 5 minutes");
    expect(spokenWait(-5_000)).toBe("less than a minute");
  });

  it("cuts a long name in its middle, where folder names differ least", () => {
    expect(queueName("web-api")).toBe("web-api");
    expect(queueName("a".repeat(QUEUE_NAME_CHARS))).toBe("a".repeat(QUEUE_NAME_CHARS));
    const long = "checkout-service-payments-reconciliation-worker";
    const cut = queueName(long);
    expect(cut).toHaveLength(QUEUE_NAME_CHARS);
    expect(cut).toBe("checkout-ser…-worker");
    expect(cut.endsWith("-worker")).toBe(true);
    expect(cut).toContain("…");
    // Two that share their first half still read apart.
    expect(queueName("checkout-service-payments-reconciliation-api")).not.toBe(cut);
  });

  it("names each one whole: who, how long, on what, and what a press does", () => {
    expect(queueEntryName("web-api", block({ tool: { name: "Bash" } as WaitingBlock["tool"] }), 6 * 60_000))
      .toBe("web-api, waiting 6 minutes on Bash; go to session");
    expect(queueEntryName("data-pipeline", block(), 60_000))
      .toBe("data-pipeline, waiting 1 minute for permission; go to session");
    expect(queueEntryName("auth", block({ kind: "asked" }), 120_000))
      .toBe("auth, waiting 2 minutes for an answer; go to session");
  });

  it("hedges the inferred tool in the hint, under Claude Code's own sentence", () => {
    const guessed = block({ message: "Claude needs your permission", tool: { name: "Bash", preview: "npm test" } as WaitingBlock["tool"] });
    expect(queueEntryDetail(guessed)).toBe("Claude needs your permission\nLikely on: Bash · npm test");
    expect(queueEntryDetail(block())).toBe("Claude needs your permission to use Bash");
  });

  it("draws each row as the old name's words, as a menu item with the whole name", () => {
    const src = sourceOf("components/TopbarReadouts.tsx");
    expect(src).toContain("aria-label={queueEntryName(w.label, w.waiting, now - w.waiting.since, t)}");
    // The session list row's order, "waiting 6m · Bash": name, wait, what on.
    expect(src).toMatch(/<span className="we-name">\{queueName\(w\.label\)\}<\/span>\s*<span className="we-wait">[^]*?<span className="we-what">· \{waitWhat\(w\.waiting, t\)\}<\/span>/);
  });
});

describe("the queue popover keeps the bar's colours and its silence", () => {
  it("draws no amber in its rows: --warn is the count's alone", () => {
    for (const sel of [".queue-row", ".queue-row .we-name", ".queue-row .we-wait", ".queue-row .we-what"]) {
      const at = css.indexOf(`\n${sel} {`);
      if (at > -1) expect(css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at)), sel).not.toContain("--warn");
    }
    expect(ruleBody(".topbar .count-pill.waiting-stat")).toContain("var(--warn)");
  });

  it("says nothing when nothing waits: a quiet 0 pill, no placeholder, no popover", () => {
    const src = sourceOf("components/TopbarReadouts.tsx");
    expect(src).not.toMatch(/Nothing waiting/i);
    const html = renderToStaticMarkup(createElement(WaitingStat, {
      waitingSessions: [], waitingCursorRef: { current: null }, focusSession: () => {}, now: 0,
    }));
    expect(html).toContain("<b>0</b>");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("aria-haspopup");
  });

  it("speaks through the count's region only", () => {
    const src = sourceOf("components/TopbarReadouts.tsx");
    const at = src.indexOf("function QueuePopover");
    const popover = src.slice(at, src.indexOf("export function CountPill", at));
    expect(popover).not.toMatch(/role="status"|aria-live/);
  });

  it("keeps the count's name and its key, while the keys are on", () => {
    const html = renderToStaticMarkup(createElement(WaitingStat, {
      waitingSessions: [session("s1", "api", 0)], waitingCursorRef: { current: null }, focusSession: () => {},
      now: 1_000,
    }));
    expect(html).toContain('aria-label="1 session waiting for you"');
    expect(html).toContain('aria-keyshortcuts="W"');
    expect(html).toContain('<b>1</b><span class="count-word">waiting</span>');
  });
});
