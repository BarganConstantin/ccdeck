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

describe("what the row says", () => {
  it("counts the ones a switch would reach, out of how many there are", () => {
    expect(restLine([peer("a", 10), peer("b", 20)], BY_HAND)).toMatchObject({ text: "2 ready", tone: "ok" });
    expect(restLine([peer("a", 10), dead("b")], BY_HAND)).toMatchObject({ text: "1 of 2 ready", tone: "ok" });
    expect(restLine([dead("a"), dead("b")], BY_HAND)).toMatchObject({ text: "none of 2 ready", tone: "idle" });
  });

  it("says a set of one as a state, not as arithmetic", () => {
    // `none of 1 ready` is a sum over a set the reader can see the whole of.
    expect(restLine([dead("a")], BY_HAND).text).toBe("not ready");
    expect(restLine([peer("a", 4)], BY_HAND).text).toBe("1 ready");
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
    expect(restLine(peers, BY_HAND).text).toBe("2 ready");
    expect(restLine(peers, { strained: true, armed: false }))
      .toMatchObject({ text: "2 ready · 96% free", free: 96 });
  });

  it("looks for that number among the ones it could actually switch to", () => {
    // The emptiest account in the store is no answer at all when its login is
    // dead: the row would be sending the reader somewhere the switch refuses.
    const strained = { strained: true, armed: false };
    expect(restLine([peer("a", 40), dead("b")], strained).text).toBe("1 of 2 ready · 40% free");
    // And it says nothing rather than guessing when nothing has been read.
    expect(restLine([peer("a", null)], strained)).toMatchObject({ text: "1 ready", free: null });
    expect(restLine([dead("a")], strained).free).toBe(null);
  });
});

describe("what the row says once something else is doing the switching", () => {
  it("drops the freest number, because the reader is not the one picking", () => {
    // Armed, the question "where do I go" has already been delegated. Printing
    // a candidate beside a policy that will choose its own is a second opinion
    // nobody asked for, and the account it names may not be the one taken.
    const peers = [peer("a", 40), peer("b", 96)];
    expect(restLine(peers, { strained: true, armed: true }))
      .toMatchObject({ text: "2 ready", free: null });
  });

  it("never names which one is next, because this side of the wire does not know", () => {
    // A tick shells out to `cswap auto --once` and claude-swap picks the
    // target; the deck only learns what happened afterwards. See cswap-auto.mjs.
    const armed = { strained: true, armed: true };
    expect(restLine([peer("a", 40), peer("b", 96)], armed).text).not.toMatch(/next|will|→/);
  });

  it("raises the one alarm neither the bars nor the toggle can show: armed, with nowhere to go", () => {
    // Auto-switch reads as on, the live bar fills, and at the threshold nothing
    // happens — every other account is held out or its login is dead. The
    // control it names is the next row down.
    expect(restLine([dead("a"), dead("b")], { strained: false, armed: true }))
      .toEqual({ text: "Auto-switch has nowhere to go", tone: "bad", free: null });
    // Not gated on strain: signing an account back in takes minutes, and a
    // warning that waits for the wall arrives with the wall.
    expect(restLine([dead("a")], { strained: false, armed: true }).tone).toBe("bad");
    // Nothing armed, nothing to say beyond the count — the reader can see the
    // same absence and there is no promise being broken.
    expect(restLine([dead("a"), dead("b")], BY_HAND).tone).toBe("idle");
    // And one account that can still be reached is not a policy with nowhere
    // to go, however full it is.
    expect(restLine([peer("a", 2), dead("b")], { strained: true, armed: true }).tone).toBe("ok");
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
    expect(fold).toMatch(/aria-controls=\{open \? "ap-rest-list" : undefined\}/);
    expect(fold).toMatch(/aria-describedby=\{peek \? "ap-rest-peek" : undefined\}/);
    // A chevron that turns is the one thing that tells this row from Local
    // network's before either is pressed: that one leads away, this one opens
    // here. The turn beats the hover nudge — a `translateX` on a rotated box
    // would send it downward.
    expect(css).toMatch(/\.ap-nav\[aria-expanded="true"\] \.ap-nav-chev,\s*\n\.ap-nav\[aria-expanded="true"\]:hover \.ap-nav-chev \{ transform: rotate\(90deg\); \}/);
  });

  it("drops the freest number once the list is open, where every row says its own", () => {
    expect(fold).toMatch(/const line = restLine\(peers, \{ strained: strained && !open, armed \}\);/);
  });

  it("is not hover-only: every name on the card is in the list the row opens", () => {
    // The card is a shortcut past a press, never the only route to anything.
    expect(fold).toMatch(/\{peek && <FoldPeek anchorId="ap-rest-entry" id="ap-rest-peek" peers=\{peers\}/);
    expect(panel).toMatch(/\{rest\.length > 0 && restOpen && \(\s*<ul className="ap-list ap-others" id="ap-rest-list">/);
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
    expect(css).toMatch(/\.ap-rest \{ padding: 0 var\(--panel-inset\) 2px; \}/);
    expect(css).toMatch(/\.ap-others \{ padding-top: 2px; \}/);
  });

  it("puts the policy under the accounts it moves you between, and drops the rule over it", () => {
    // It was a pinned `.ap-foot` with a hairline, and both of those were about
    // standing apart from a roster it could not fit beside. It sits with the
    // roster now: same inset, space instead of a rule, and after the list the
    // fold opens so the block reads "…and do this automatically".
    expect(css).toMatch(/\.ap-policy-block \{ padding: 8px var\(--panel-inset\) 14px; \}/);
    expect(/\n\.ap-policy-block \{([^}]*)\}/.exec(css)?.[1] ?? "").not.toMatch(/border/);
    expect(panel.indexOf('className="ap-policy-block"')).toBeGreaterThan(panel.indexOf("{rest.map(accountRow)}"));
    // And it is inside the scroll, which is the whole of the move.
    expect(panel.indexOf('className="ap-policy-block"')).toBeLessThan(panel.indexOf("<LanSyncSection"));
    expect(panel).not.toMatch(/<div className="ap-foot">/);
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
