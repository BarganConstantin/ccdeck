// Every way out of the rating question dropped keyboard focus on <body>.
//
// A number pressed from the keyboard took itself away — the row became the
// thanks — and focus went with it. "Not now" and the thanks' × took the whole
// row. The thanks went by itself after 8 seconds, or 30 for a low score, with
// its offer focused. And the offer closed the thanks before it opened the
// feedback dialog, so the dialog's opener was a button already gone and
// closing it left focus nowhere. The thanks was also the question's own row
// turned into a live region in the same render as its words, which a screen
// reader is apt to say nothing about.
//
// Run, not read: the hook and the row are called on fake-react.ts's React,
// against a document whose focused element the test holds and which drops
// focus when a render takes the focused button away, as a browser does.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { all, flush, mount, one, textOf, type Drawn } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);

const { useRatingAsk } = await import("../use-rating-ask");
const { default: RatingBanner } = await import("../components/RatingBanner");
const { default: DeckBanner } = await import("../components/DeckBanner");

type Rating = ReturnType<typeof useRatingAsk>;

/** A focusable thing on the page, named by what the reader would hear. */
interface Node { name: string; tagName: string; focus(): void; matches(sel: string): boolean; contains(n: unknown): boolean }
let page: { activeElement: Node; hidden: boolean; getElementById(id: string): Node | null };
/** Whether the last focus came from the keyboard, for :focus-visible. */
let keyboard = false;
const make = (name: string, tagName = "BUTTON"): Node => {
  const n: Node = {
    name, tagName,
    focus: () => { page.activeElement = n; },
    matches: sel => sel === ":focus-visible" && keyboard && page.activeElement === n,
    contains: other => other === n,
  };
  return n;
};
const BODY = make("body", "BODY");
const CANVAS = make("canvas", "MAIN");

/** What a button in the row is called: its label, or its words. */
const nameOf = (el: Drawn) => String(el.props["aria-label"] ?? textOf(el));

const modalOpenRef = { current: false };

beforeEach(() => {
  vi.useFakeTimers();
  keyboard = false;
  modalOpenRef.current = false;
  page = { activeElement: BODY, hidden: false, getElementById: id => (id === "canvas" ? CANVAS : null) };
  vi.stubGlobal("document", page);
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("fetch", async (_url: string, init?: { method?: string }) =>
    ({ ok: true, json: async () => (init?.method === "POST" ? { ok: true } : { ok: true, ask: true }) }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

/** The deck's question, asked: the hook, and the row DeckBanner draws for it
 *  while it is not hidden, kept in step with the hook the way React would. */
async function asked() {
  const hook = mount(useRatingAsk, { modalOpenRef });
  const rating = () => hook.tree as Rating;
  const nodes = new Map<string, Node>();
  const nodeFor = (name: string) => nodes.get(name) ?? (nodes.set(name, make(name)), nodes.get(name)!);
  let banner: ReturnType<typeof mount<Parameters<typeof RatingBanner>[0]>> | null = null;
  const tree = () => banner?.tree as Drawn | null;
  // The row: not inside an .app here, so it writes no height.
  const row = Object.assign(make("row", "DIV"), { closest: () => null });
  row.contains = n => n === row || (tree() != null && all(tree(), el => el.type === "button").some(el => nodeFor(nameOf(el)) === n));
  const props = () => {
    const r = rating();
    return {
      phase: r.ratingPhase, score: r.ratingScore, onAnswer: r.answerRating, onLater: r.rateLater, onClose: r.closeRating,
      onFeedback: () => {}, ...("holdThanks" in r ? { onHold: (r as Rating & { holdThanks: unknown }).holdThanks } : {}),
    } as Parameters<typeof RatingBanner>[0];
  };
  const commit = (t: unknown) => {
    const root = t as Drawn | null;
    if (root?.ref && typeof root.ref === "object") (root.ref as { current: unknown }).current = row;
    for (const el of all(root, e => e.type === "button" && e.ref != null && typeof e.ref === "object")) {
      (el.ref as { current: unknown }).current = nodeFor(nameOf(el));
    }
    // A focused button the render took away takes focus with it.
    if (page.activeElement !== BODY && page.activeElement !== CANVAS && !row.contains(page.activeElement)) page.activeElement = BODY;
  };
  const sync = () => {
    const shown = rating().ratingPhase !== "hidden";
    if (shown && !banner) banner = mount(RatingBanner, props(), { commit });
    else if (shown) banner!.rerender(props());
    else if (banner) {
      banner.unmount();
      banner = null;
      commit(null);
    }
  };
  const button = (name: string) => one(tree(), el => el.type === "button" && nameOf(el) === name);
  /** Tab to a button in the row: focus moves, and the row hears it. */
  const tab = (name: string) => {
    const from = page.activeElement;
    keyboard = true;
    nodeFor(name).focus();
    (tree()?.props.onFocus as ((e: unknown) => void) | undefined)?.({ target: nodeFor(name), currentTarget: row, relatedTarget: from });
    sync();
  };
  /** Focus leaves the row for the canvas. */
  const tabOut = () => {
    const from = page.activeElement;
    CANVAS.focus();
    (tree()?.props.onBlur as ((e: unknown) => void) | undefined)?.({ target: from, currentTarget: row, relatedTarget: CANVAS });
    sync();
  };
  /** Enter on the focused button, or a click on one. */
  const press = (name: string) => {
    const el = button(name);
    if (!el) throw new Error(`no ${name} button`);
    (el.props.onClick as (e: unknown) => void)({ detail: keyboard ? 0 : 1, currentTarget: nodeFor(name) });
    sync();
  };
  const wait = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); await flush(); sync(); };
  await wait(5 * 60 * 1000);
  expect(rating().ratingPhase).toBe("asking");
  return { rating, tree, tab, tabOut, press, wait, nodeFor };
}

describe("where focus goes when the question changes under it", () => {
  it("a number pressed from the keyboard hands focus to the thanks: the offer for a low score", async () => {
    const q = await asked();
    q.tab("3 out of 10");
    q.press("3 out of 10");
    expect(q.rating().ratingPhase).toBe("thanks");
    expect(page.activeElement.name).toBe("Tell us what would make it better");
  });

  it("and the × for any other", async () => {
    const q = await asked();
    q.tab("9 out of 10");
    q.press("9 out of 10");
    expect(page.activeElement.name).toBe("Dismiss");
  });

  it("'Not now' from the keyboard hands focus to the board", async () => {
    const q = await asked();
    q.tab("Not now");
    q.press("Not now");
    expect(q.rating().ratingPhase).toBe("hidden");
    expect(page.activeElement).toBe(CANVAS);
  });

  it("so does the thanks' ×", async () => {
    const q = await asked();
    q.tab("8 out of 10");
    q.press("8 out of 10");
    q.press("Dismiss");
    expect(q.rating().ratingPhase).toBe("hidden");
    expect(page.activeElement).toBe(CANVAS);
  });
});

describe("the thanks, while somebody is in it", () => {
  it("stays as long as focus is in it, and goes by itself once focus has left", async () => {
    const q = await asked();
    q.tab("2 out of 10");
    q.press("2 out of 10");
    q.tab("Tell us what would make it better");
    await q.wait(60_000);
    expect(q.rating().ratingPhase).toBe("thanks");
    q.tabOut();
    await q.wait(30_000);
    expect(q.rating().ratingPhase).toBe("hidden");
    expect(page.activeElement).toBe(CANVAS);
  });

  it("waits out a dialog that is open when its time is up — the feedback dialog it offered hands focus back to it", async () => {
    const q = await asked();
    q.press("1 out of 10");
    modalOpenRef.current = true;
    await q.wait(90_000);
    expect(q.rating().ratingPhase).toBe("thanks");
    modalOpenRef.current = false;
    await q.wait(30_000);
    expect(q.rating().ratingPhase).toBe("hidden");
  });

  it("still goes by itself for a mouse, which keeps no focus in it", async () => {
    const q = await asked();
    q.press("10 out of 10, extremely useful");
    expect(page.activeElement).toBe(BODY);
    await q.wait(8_000);
    expect(q.rating().ratingPhase).toBe("hidden");
  });
});

describe("the strip around it", () => {
  const noop = () => {};
  const strip = (rating: Partial<Rating>, onFeedback = noop) => DeckBanner({
    restart: { restartedTo: null } as never,
    versionCheck: { notice: null, noticeOpen: false } as never,
    upgrade: {} as never,
    oldNameNotice: { oldName: null, oldNameOpen: false } as never,
    rating: { ratingPhase: "hidden", ratingScore: null, answerRating: noop, rateLater: noop, closeRating: noop, ...rating } as Rating,
    onFeedback, everConnected: true, live: true, paused: false,
  });
  const live = (tree: unknown) => all(tree, el => el.props.role === "status" && String(el.props.className).includes("vis-hidden"));

  it("opens the feedback dialog from the offer with the thanks still up, so the dialog has somewhere to give focus back", () => {
    const closeRating = vi.fn();
    const onFeedback = vi.fn();
    const tree = strip({ ratingPhase: "thanks", ratingScore: 3, closeRating }, onFeedback);
    const row = one(tree, el => el.type === RatingBanner)!;
    (row.props.onFeedback as () => void)();
    expect(onFeedback).toHaveBeenCalledTimes(1);
    expect(closeRating).not.toHaveBeenCalled();
  });

  it("says the thanks in a live region that was there before it", () => {
    for (const phase of ["hidden", "asking"] as const) {
      const regions = live(strip({ ratingPhase: phase }));
      expect(regions, phase).toHaveLength(1);
      expect(textOf(regions[0]), phase).toBe("");
    }
    const regions = live(strip({ ratingPhase: "thanks", ratingScore: 9 }));
    expect(regions).toHaveLength(1);
    expect(textOf(regions[0])).toBe("Thanks — that helps.");
  });
});
