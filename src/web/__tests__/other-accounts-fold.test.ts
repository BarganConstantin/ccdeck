// THE FOLD IN THE ACCOUNTS COLUMN.
//
// The panel drew every account at the same size: the one every session on this
// machine is running on, and the three that answer a question asked once a day.
// Four rows of slot numbers, manage menus and switch buttons stood between the
// reader and the three bars they opened the panel for, and on a store of any
// size the live account was wherever claude-swap happened to have put it.
//
// It opens on the live account now. The others stand behind one row in Local
// network's idiom — a count, a peek that names them, and a press that unfolds
// them in place. What that row may say, what the peek may hold, and which of
// the two surfaces each fact belongs on is what this file holds.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FOLD_NAMES, foldPeek, restLine, type Peer } from "../other-accounts";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const panel = read("../components/AccountsPanel.tsx");
const fold = read("../components/OtherAccounts.tsx");
const css = read("../styles.css").replace(/\/\*[\s\S]*?\*\//g, "");

const peer = (name: string, headroom: number | null, over: Partial<Peer> = {}): Peer =>
  ({ key: name, name, ready: true, why: null, warn: false, headroom, ...over });
const dead = (name: string) =>
  peer(name, 96, { ready: false, why: "Login expired", warn: true });
/** Nothing is switching by itself, and the live account has room. */
const BY_HAND = { strained: false, armed: false };
/** Armed at the stored threshold, which is what the tail then says. */
const ARMED = { strained: false, armed: true, threshold: "90" };

describe("what the row says", () => {
  it("counts the ones a switch would reach, out of how many there are", () => {
    expect(restLine([peer("a", 10), peer("b", 20)], BY_HAND)).toMatchObject({ text: "2 ready · auto off", tone: "ok" });
    expect(restLine([peer("a", 10), dead("b")], BY_HAND)).toMatchObject({ text: "1 of 2 ready · auto off", tone: "ok" });
    expect(restLine([dead("a"), dead("b")], BY_HAND)).toMatchObject({ text: "none of 2 ready · auto off", tone: "idle" });
  });

  it("says a set of one as a state, not as arithmetic", () => {
    // `none of 1 ready` is a sum over a set the reader can see the whole of.
    expect(restLine([dead("a")], BY_HAND).text).toBe("not ready · auto off");
    expect(restLine([peer("a", 4)], BY_HAND).text).toBe("1 ready · auto off");
  });

  it("counts no faults beside the count, because an account that cannot be reached is already missing from it", () => {
    // The rule `entryLine` wrote for Local network's row, for the same reason:
    // the amber would restate an absence the count had just stated, in the one
    // colour that means act on this, from a row whose only act is to unfold.
    // WHICH one, and why, is on the peek and on the row one press away.
    expect(restLine([peer("a", 10), dead("b")], BY_HAND).text).not.toMatch(/expired|1 ⚠|warn/i);
    expect(fold).not.toMatch(/WarnGlyph/);
  });

  it("prints the freest number only while the live account is past the threshold", () => {
    const peers = [peer("a", 40), peer("b", 96)];
    expect(restLine(peers, BY_HAND).text).toBe("2 ready · auto off");
    expect(restLine(peers, { strained: true, armed: false }))
      .toMatchObject({ text: "2 ready · 96% free · auto off", free: 96 });
  });

  it("looks for that number among the ones it could actually switch to", () => {
    // The emptiest account in the store is no answer at all when its login is
    // dead: the row would be sending the reader somewhere the switch refuses.
    const strained = { strained: true, armed: false };
    expect(restLine([peer("a", 40), dead("b")], strained).text).toBe("1 of 2 ready · 40% free · auto off");
    // And it says nothing rather than guessing when nothing has been read.
    expect(restLine([peer("a", null)], strained)).toMatchObject({ text: "1 ready · auto off", free: null });
    expect(restLine([dead("a")], strained).free).toBe(null);
  });
});

describe("what the row says once something else is doing the switching", () => {
  it("drops the freest number, because the reader is not the one picking", () => {
    // Armed, the question "where do I go" has already been delegated. Printing
    // a candidate beside a policy that will choose its own is a second opinion
    // nobody asked for, and the account it names may not be the one taken.
    const peers = [peer("a", 40), peer("b", 96)];
    expect(restLine(peers, { strained: true, armed: true, threshold: "90" }))
      .toMatchObject({ text: "2 ready · auto 90%", free: null });
  });

  it("says whether the policy is on, and at what, because the toggle is behind this row now", () => {
    // A control nobody can see is a control nobody can tell the state of, and
    // `off` has to be as sayable as `on`: a row that only spoke while armed
    // would leave a reader unable to tell a deck that will not switch from a
    // row that does not mention switching.
    expect(restLine([peer("a", 4)], ARMED).text).toBe("1 ready · auto 90%");
    expect(restLine([peer("a", 4)], BY_HAND).text).toBe("1 ready · auto off");
    // The threshold rides with `on` because it is the whole of what on means.
    expect(restLine([peer("a", 4)], { ...ARMED, threshold: "85" }).text).toBe("1 ready · auto 85%");
    // And a panel that has not read the setting yet says on without a number,
    // rather than a number it does not have.
    expect(restLine([peer("a", 4)], { strained: false, armed: true }).text).toBe("1 ready · auto on");
  });

  it("fits its widest line in the column, which is every clause at once", () => {
    // `10 of 12 ready · 91% free · auto off` measured 247px against 247px of
    // room at 11px — the glyph coming off this row is what paid for it.
    const wide = restLine(
      [...Array.from({ length: 10 }, (_, i) => peer(`a${i}`, 91 - i)), dead("x"), dead("y")],
      { strained: true, armed: false },
    );
    expect(wide.text).toBe("10 of 12 ready · 91% free · auto off");
    expect(wide.text.length).toBeLessThanOrEqual(40);
  });

  it("never names which one is next, because this side of the wire does not know", () => {
    // A tick shells out to `cswap auto --once` and claude-swap picks the
    // target; the deck only learns what happened afterwards. See cswap-auto.mjs.
    expect(restLine([peer("a", 40), peer("b", 96)], { ...ARMED, strained: true }).text)
      .not.toMatch(/next|will|→/);
  });

  it("raises the one alarm neither the bars nor the toggle can show: armed, with nowhere to go", () => {
    // Auto-switch reads as on, the live bar fills, and at the threshold nothing
    // happens — every other account is held out or its login is dead. The
    // control it names is the next row down.
    expect(restLine([dead("a"), dead("b")], ARMED))
      .toEqual({ text: "Auto-switch has nowhere to go", tone: "bad", free: null });
    // It replaces the tail rather than standing beside it: the sentence already
    // names the policy, and `… · auto 90%` after it would say the thing is on
    // twice in one line.
    expect(restLine([dead("a"), dead("b")], ARMED).text).not.toMatch(/auto 90%/);
    // Not gated on strain: signing an account back in takes minutes, and a
    // warning that waits for the wall arrives with the wall.
    expect(restLine([dead("a")], ARMED).tone).toBe("bad");
    // Nothing armed, nothing to say beyond the count — the reader can see the
    // same absence and there is no promise being broken.
    expect(restLine([dead("a"), dead("b")], BY_HAND).tone).toBe("idle");
    // And one account that can still be reached is not a policy with nowhere
    // to go, however full it is.
    expect(restLine([peer("a", 2), dead("b")], { ...ARMED, strained: true }).tone).toBe("ok");
  });

  it("is armed by a terminal loop too, not only by the deck's own toggle", () => {
    // `cswap auto` in a terminal does the switching while the deck stands down,
    // so the toggle can read off while something is very much switching.
    expect(panel).toMatch(/const autoArmed = auto\?\.ok === true && \(auto\.enabled \|\| auto\.external\);/);
    expect(panel).toMatch(/armed=\{autoArmed\}/);
  });

  it("paints that alarm in the ink the column's other warnings use", () => {
    expect(css).toMatch(/\.ap-nav-state\[data-tone="bad"\] \{ color: var\(--warn\); \}/);
  });
});

describe("what the peek names, and in what order", () => {
  it("leads with the account that has the most room, because that is the answer", () => {
    const { shown, title } = foldPeek([peer("a", 12), peer("b", 91), peer("c", 44)]);
    expect(shown.map(p => p.name)).toEqual(["b", "c", "a"]);
    expect(title).toBe("Where you could switch");
  });

  it("sorts an account nothing has been collected for under the ones that have", () => {
    // It may well be the emptiest there is. Saying so on no reading is how a
    // summary earns a reader who stops believing it.
    expect(foldPeek([peer("unread", null), peer("a", 3)]).shown.map(p => p.name)).toEqual(["a", "unread"]);
  });

  it("puts every account a switch would be refused under all of them, and says why instead of how full", () => {
    const { shown, title } = foldPeek([dead("z"), peer("a", 2), dead("b")]);
    expect(shown.map(p => p.name)).toEqual(["a", "b", "z"]);
    expect(shown[1].why).toBe("Login expired");
    expect(title).toBe("Where you could switch");
    expect(foldPeek([dead("b"), dead("a")]).title).toBe("Nothing to switch to");
  });

  it("names at most a handful, then counts the rest", () => {
    const many = Array.from({ length: FOLD_NAMES + 3 }, (_, i) => peer(`a${i}`, i));
    const { shown, rest } = foldPeek(many);
    expect(FOLD_NAMES).toBe(6);
    expect(shown).toHaveLength(FOLD_NAMES);
    expect(rest).toBe("and 3 more");
    expect(foldPeek(many.slice(0, FOLD_NAMES)).rest).toBe(null);
  });

  it("does not reorder the array it was handed", () => {
    const given = [peer("a", 1), peer("b", 99)];
    foldPeek(given);
    expect(given.map(p => p.name)).toEqual(["a", "b"]);
  });
});

describe("the row, in Local network's idiom and with its timings", () => {
  it("borrows that section's delay and grace rather than choosing its own", () => {
    // Two hover cards in one column opening on different delays would be two
    // behaviours to learn from one panel.
    expect(fold).toMatch(/import \{ PEEK_DELAY_MS, PEEK_GRACE_MS \} from "\.\/LanSyncSection"/);
    expect(fold).toMatch(/onPointerEnter=\{e => \{ if \(e\.pointerType === "mouse"\) openPeek\(PEEK_DELAY_MS\); \}\}/);
    expect(fold).toMatch(/window\.setTimeout\(\(\) => setPeek\(false\), PEEK_GRACE_MS\)/);
    expect(fold).toMatch(/onFocus=\{e => \{ if \(e\.target\.matches\(":focus-visible"\)\) openPeek\(0\); \}\}/);
    expect(fold).toMatch(/onBlur=\{shutPeek\}/);
    expect(fold).toMatch(/useEffect\(\(\) => \(\) => window\.clearTimeout\(peekTimer\.current\), \[\]\);/);
  });

  it("holds no control on the card, whatever the pointer does on it", () => {
    // The temptation this card has that Local network's does not: the reader
    // hovering it is choosing where to switch, and `Switch` is right there in
    // the sentence. A surface that shuts 140ms after the pointer leaves is a
    // way to lose a press, and the press it would offer restarts every session
    // on this machine.
    const peek = /function FoldPeek\(([\s\S]*?)\n\}\n/.exec(fold)?.[0] ?? "";
    expect(peek).toMatch(/className="ap-peek ap-fold-peek" role="tooltip"/);
    expect(peek).toMatch(/createPortal\(/);
    expect(peek).not.toMatch(/<button|onClick/);
    expect(peek).toMatch(/onPointerEnter=\{onHold\} onPointerLeave=\{onLet\}/);
  });

  it("shuts the card while the list is open, because the card would cover what it names", () => {
    expect(fold).toMatch(/useEffect\(\(\) => \{ if \(open\) \{ window\.clearTimeout\(peekTimer\.current\); setPeek\(false\); \} \}, \[open\]\);/);
    expect(fold).toMatch(/const openPeek = \(delay: number\) => \{\s*if \(open\) return;/);
    // And the press drops it with no grace: it would stand over the rows it had
    // just been naming.
    expect(fold).toMatch(/onClick=\{\(\) => \{ dropPeek\(\); onToggle\(\); \}\}/);
  });

  it("says which way it goes, to a screen reader and to an eye", () => {
    expect(fold).toMatch(/aria-expanded=\{open\}/);
    expect(fold).toMatch(/aria-controls=\{open \? "ap-rest-panel" : undefined\}/);
    expect(fold).toMatch(/aria-describedby=\{peek \? "ap-rest-peek" : undefined\}/);
    // A chevron that turns is the one thing that tells this row from Local
    // network's before either is pressed: that one leads away, this one opens
    // here. The turn beats the hover nudge — a `translateX` on a rotated box
    // would send it downward.
    expect(css).toMatch(/\.ap-nav\[aria-expanded="true"\] \.ap-nav-chev,\s*\n\.ap-nav\[aria-expanded="true"\]:hover \.ap-nav-chev \{ transform: rotate\(90deg\); \}/);
    // The box it names is everything the press reveals, not just the list.
    expect(fold).toMatch(/aria-controls=\{open \? "ap-rest-panel" : undefined\}/);
  });

  it("drops the freest number once the list is open, where every row says its own", () => {
    expect(fold).toMatch(/const line = restLine\(peers, \{ strained: strained && !open, armed, threshold \}\);/);
  });

  it("is not hover-only: every name on the card is in the list the row opens", () => {
    // The card is a shortcut past a press, never the only route to anything.
    expect(fold).toMatch(/\{peek && <FoldPeek anchorId="ap-rest-entry" id="ap-rest-peek" peers=\{peers\}/);
    expect(panel).toMatch(/\{rest\.length > 0 && restOpen && \(\s*<div className="ap-rest-panel" id="ap-rest-panel">/);
    expect(panel).toMatch(/<ul className="ap-list ap-others" id="ap-rest-list">/);
  });
});

describe("what the column folds, and when it does not", () => {
  it("keeps the live account whole above the fold and puts every other account behind it", () => {
    expect(panel).toMatch(/const rest = activeAcct \? roster\.filter\(a => !a\.active\) : \[\];/);
    expect(panel).toMatch(/const head = rest\.length \? roster\.filter\(a => a\.active\) : roster;/);
    // The row stands between the two lists, which is the only place an
    // accordion's handle can be.
    const entry = panel.indexOf("<OtherAccounts");
    expect(entry).toBeGreaterThan(panel.indexOf("{head.map(accountRow)}"));
    expect(entry).toBeLessThan(panel.indexOf("{rest.map(accountRow)}"));
  });

  it("folds nothing while nothing is live, and nothing when there is only the live one", () => {
    // A store between two switches has no row to stand above the fold, and a
    // single-account store has nothing to put behind it. Both fall back to the
    // list the panel has always drawn.
    expect(panel).toMatch(/\{rest\.length > 0 && \(\s*<OtherAccounts/);
  });

  it("draws one row from one function, whichever side of the fold it is on", () => {
    // Written twice, the live row and the folded ones would drift apart.
    expect(panel).toMatch(/const accountRow = \(a: Account\) => \{/);
    expect(panel.match(/\bmap\(accountRow\)/g)).toHaveLength(2);
    expect(panel).not.toMatch(/data\.accounts\?\.map\(a => \{/);
  });

  it("opens shut, every time, and stays open across a switch", () => {
    // A fold that remembered being open would give a reader who unfolded it
    // once a panel that never folds again. A switch is the one thing that does
    // not close it: the account just left is in that list, and it moved there
    // under the reader's own press.
    expect(panel).toMatch(/const \[restOpen, setRestOpen\] = useState\(false\);/);
    expect(panel).not.toMatch(/setRestOpen\(false\)/);
  });

  it("builds a peer from the same two refusals the row withholds its own Switch for", () => {
    // The count and the button cannot be allowed to disagree about who can be
    // reached: the row offers `Switch` when `!a.disabled && !issue?.blocksSwitch`.
    expect(panel).toMatch(/ready: !a\.disabled && !issue\?\.blocksSwitch,/);
    expect(panel).toMatch(/!a\.active && !a\.disabled && !issue\?\.blocksSwitch && \(/);
    // Identity, not slot: a `cswap move` must not hand one account's key to
    // another. lane-open.ts holds that rule for the rows; this reuses it.
    expect(panel).toMatch(/key: laneKey\(a\),/);
  });

  it("reads the live account's strain off the field the peers already carry", () => {
    expect(panel).toMatch(/const strained = activeAcct\?\.headroom != null && Number\.isFinite\(trip\)\s*\n\s*&& 100 - activeAcct\.headroom >= trip;/);
  });

  it("carries the panel's inset itself, because it stands in the scroll and not in the foot", () => {
    expect(css).toMatch(/\.ap-rest \{ padding: 4px var\(--panel-inset\) 0; \}/);
  });

  it("wears no glyph, so its name starts on the column's own left edge", () => {
    // An icon in this column means a DESTINATION — Local network wears one
    // because pressing it takes the column away. This row opens a list where it
    // stands. With the icon gone, `Claude accounts`, `Other accounts` and
    // `Auto-switch` share one left edge, which is the spine of the block.
    expect(fold).not.toMatch(/ap-nav-glyph/);
    expect(css).toMatch(/\.ap-rest \.ap-nav \{ gap: 0; \}/);
    // Local network keeps its own: it is the row that goes somewhere.
    expect(read("../components/LanSyncSection.tsx")).toMatch(/className="ap-nav-glyph"/);
  });

  it("puts a wider gap over the fold than under it, so the two rows read as one group", () => {
    // 4px over, 2px under — the account above is a different thing, the policy
    // below is the same one. Proximity does the grouping; no container does.
    const over = /\n\.ap-rest \{ padding: (\d+)px/.exec(css)?.[1];
    const under = /\n\.ap-policy-block \{ padding: (\d+)px/.exec(css)?.[1];
    expect(Number(over)).toBeGreaterThan(Number(under));
  });

  it("puts the policy inside the fold, and leaves it reachable when there is no fold", () => {
    // The user asked for it behind the disclosure. What pays for that is the
    // tail of the row's own line, which says `auto 90%` or `auto off` whether
    // the fold is open or shut — and the one store that has nothing to fold
    // keeps the policy in the open, or the setting would be unreachable.
    expect(panel).toMatch(/<div className="ap-rest-panel" id="ap-rest-panel">[\s\S]{0,400}\{policyBlock\}/);
    expect(panel).toMatch(/\{rest\.length === 0 && policyBlock\}/);
    // The refusal did NOT follow it in: one that a collapse could hide is one
    // the reader can lose.
    expect(panel.indexOf("{failure && failure.row == null && (")).toBeGreaterThan(panel.indexOf("{rest.length === 0 && policyBlock}"));
    // The box gives, so the list inside it can scroll and the policy cannot be
    // pushed off the bottom.
    const box = /\n\.ap-rest-panel \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(box).toMatch(/flex: 0 1 auto/);
    expect(box).toMatch(/min-height: 0/);
    expect(css).toMatch(/\.ap-rest-panel > \.ap-policy-block \{ flex: none; \}/);
  });

  it("keeps the policy's own spacing and draws no rule of its own", () => {
    // It was a pinned `.ap-foot` with a hairline, and both of those were about
    // standing apart from a roster it could not fit beside. It sits with the
    // roster now: same inset, space instead of a rule.
    expect(css).toMatch(/\.ap-policy-block \{ padding: 2px var\(--panel-inset\) 14px; \}/);
    // The hairline it does get is the fold's, and it belongs to the list above
    // it rather than to the policy itself — see the rule below.
    expect(/\n\.ap-policy-block \{([^}]*)\}/.exec(css)?.[1] ?? "").not.toMatch(/border/);
    // Drawn in the column, never back in the pinned foot.
    expect(panel.indexOf("{policyBlock}")).toBeLessThan(panel.indexOf("<LanSyncSection"));
    expect(panel).not.toMatch(/<div className="ap-foot">/);
  });

  it("gives the list the only room that flexes, so the policy under it cannot be pushed off", () => {
    // Auto-switch came back into this column, which put it under a list that
    // can be twenty accounts long. The list is what shrinks: it takes what is
    // left and scrolls inside it. Everything else is pinned to its own height,
    // or a tall list would squash the live account's bars instead.
    expect(/\n\.ap-scroll \{([^}]*)\}/.exec(css)?.[1] ?? "").toMatch(/display: flex;\s*flex-direction: column;/);
    expect(css).toMatch(/\.ap-scroll > \* \{ flex: none; \}/);
    const others = /\n\.ap-others \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(others).toMatch(/flex: 0 1 auto/);
    expect(others).toMatch(/min-height: 0/);
    expect(others).toMatch(/overflow-y: auto/);
    // Reaching the end of this list does not go on to scroll the column.
    expect(others).toMatch(/overscroll-behavior: contain/);
  });

  it("closes the open list with one hairline, and draws none when it is shut", () => {
    // A region that scrolls inside itself ends on a row cut in half, and at
    // 288px that reads as a glitch rather than a boundary. The rule exists for
    // exactly as long as there is a list to close.
    expect(css).toMatch(/\.ap-others \+ \.ap-policy-block \{[^}]*border-top: 1px solid var\(--line-soft\);/);
    expect(/\n\.ap-policy-block \{([^}]*)\}/.exec(css)?.[1] ?? "").not.toMatch(/border/);
  });

  it("closes a row's menu against the box that row actually scrolls in", () => {
    // Once the fold is open its list has a scroll of its own, and a menu
    // measured against the column would stay open over a row that had already
    // scrolled out of sight.
    expect(panel).toMatch(/const rowBoundary = \(num: number\) =>\s*\n\s*restOpen && rest\.some\(a => a\.num === num\) \? "ap-rest-list" : "ap-scroll";/);
    expect(panel).toMatch(/boundaryId=\{rowBoundary\(a\.num\)\}/);
    // The notice over the list never lives in the fold, so it keeps the column.
    expect(panel).toMatch(/boundaryId=\{issueOpen\.anchor === "ap-notice" \? "ap-scroll" : rowBoundary\(a\.num\)\}/);
  });

  it("gives the card the width a name and a number need, and the number the muted tier", () => {
    expect(css).toMatch(/\.ap-fold-peek \{ width: 244px; \}/);
    expect(/\n\.ap-fold-state \{([^}]*)\}/.exec(css)?.[1] ?? "").toMatch(/color: var\(--muted\)/);
    expect(/\n\.ap-fold-state \{([^}]*)\}/.exec(css)?.[1] ?? "").toMatch(/tabular-nums/);
    // A card may say less than the row it stands for; it may not say it more
    // quietly. An expired login is amber on both.
    expect(css).toMatch(/\.ap-fold-state\[data-tone="warn"\] \{ color: var\(--warn\); \}/);
  });
});
