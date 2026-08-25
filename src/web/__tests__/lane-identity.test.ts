// The accounts panel remembered which rows had their model lanes expanded as a
// list of SLOT NUMBERS, and a slot number is not a name for an account.
//
// `cswap move` into an occupied slot is a swap: the two accounts trade places,
// and every number the panel is holding changes hands underneath it.
// account-move.ts was written for exactly that and states the rule in its
// header — "everything the accounts panel remembers about its open manage block
// is keyed by slot number … after a swap every one of those numbers names the
// OTHER account" — and `manageAfterMove` relocates the four fields the manage
// block holds. `openLanes` was not one of them. It is written only by its own
// toggle and no move has ever touched it, so pressing `2 more` on slot 1 and
// then swapping that account into slot 2 left the account the user was reading
// collapsed, and stood a DIFFERENT account's row open, with `aria-expanded` set
// true on a disclosure nobody pressed, reporting per-model quota windows for an
// account that was never asked about (#542).
//
// The obvious repair — a fifth field on ManageState — was rejected here, and
// the last three cases below are why. A swap is the only one of three failures
// that goes anywhere near a move. An account REMOVED while expanded leaves its
// number in the set with nothing left to ever take it out, and claude-swap
// reuses slots: the server says so itself where it guards its usage rows, "a
// removed account leaves its row behind and slots get reused". Whoever landed
// on that number next opened pre-expanded, from a press aimed at an account
// that no longer exists. Relocating on move cannot see either one.
//
// So the set names accounts. Identity is email plus organization, the same pair
// claude-swap matches a usage row to an account by, and the set is filtered
// against the roster on every load so a name nobody answers to is dropped
// instead of lying in wait for its slot.
//
// Plain node, no DOM, so the rule is pinned on the pure function and the panel
// is read as text — the same two halves lane-binding.test.ts uses, and for the
// same reason: a pure function that is right about accounts it is never handed
// is the failure mode this file exists because of.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { knownLanes, laneKey, toggleLane, type LaneOwner } from "../lane-open";

const panel = readFileSync(fileURLToPath(new URL("../components/AccountsPanel.tsx", import.meta.url)), "utf8");

/** The panel with its comments gone, so the prose above cannot satisfy a match. */
const panelCode = panel
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");

/** Two accounts in one organization, sitting in slots 1 and 2. */
const alice: LaneOwner = { num: 1, email: "alice@example.com", org: "Acme" };
const bob: LaneOwner   = { num: 2, email: "bob@example.com",   org: "Acme" };

/** Which rows of a roster a given set would render expanded. */
const expanded = (open: string[], roster: LaneOwner[]) =>
  roster.filter(a => open.includes(laneKey(a))).map(a => a.num);

describe("the row an expanded disclosure belongs to", () => {
  it("stays with the account when a move swaps it into another slot", () => {
    // The reported failure, start to finish. Alice is in slot 1 with her model
    // lanes open; the user picks `slot 2 · swap` and the two accounts trade
    // places.
    const open = toggleLane([], alice);
    const after = [{ ...bob, num: 1 }, { ...alice, num: 2 }];
    // Alice is in slot 2 now and that is the row that is open.
    expect(expanded(open, after)).toEqual([2]);
    // Which is the same as saying the row the user never touched is shut. Under
    // the slot-keyed set this was the assertion that failed: slot 1 held the
    // number, so Bob's per-model quota stood open on Bob's row.
    expect(open.includes(laneKey(after[0]))).toBe(false);
  });

  it("does not move to the other account when THAT one is the open one", () => {
    // The same swap read from the other side, because a fix that merely
    // renumbered by one would pass the case above and fail this one.
    const open = toggleLane([], bob);
    const after = [{ ...bob, num: 1 }, { ...alice, num: 2 }];
    expect(expanded(open, after)).toEqual([1]);
  });

  it("survives a plain relocation into a free slot as well", () => {
    // Nobody is displaced here, so nothing else on the roster changes — and the
    // set still has to follow the one account that did move.
    const open = toggleLane([], alice);
    expect(expanded(open, [{ ...alice, num: 5 }, bob])).toEqual([5]);
  });

  it("closes again when the same row is pressed a second time, wherever it is", () => {
    const open = toggleLane([], alice);
    const moved = { ...alice, num: 7 };
    expect(toggleLane(open, moved)).toEqual([]);
  });

  it("keeps every open row open, because more than one may be", () => {
    // Comparing two accounts is what the panel is for, so the set is a set.
    const open = toggleLane(toggleLane([], alice), bob);
    expect(expanded(open, [{ ...bob, num: 1 }, { ...alice, num: 2 }]).sort()).toEqual([1, 2]);
  });
});

describe("an account that leaves while its lanes are open", () => {
  it("is forgotten as soon as the roster no longer lists it", () => {
    // Removal is the case a relocate-on-move fix cannot reach: nothing moved,
    // so nothing asks the question. The roster is the only thing that knows.
    const open = toggleLane([], bob);
    expect(knownLanes(open, [alice])).toEqual([]);
  });

  it("does not hand its expanded state to whoever takes the vacated slot", () => {
    // claude-swap reuses slots. Under the slot-keyed set, signing a new account
    // in after removing an expanded one opened it pre-expanded on a press that
    // was aimed at somebody else.
    const open = toggleLane([], bob);
    const carol: LaneOwner = { num: 2, email: "carol@example.com", org: "Acme" };
    expect(knownLanes(open, [alice, carol])).toEqual([]);
    // And belt and braces: even an unpruned set does not open Carol's row,
    // because her name was never in it.
    expect(expanded(open, [alice, carol])).toEqual([]);
  });

  it("does not resurrect when the same address is signed back in", () => {
    // The other half of the same rule. Dropping the key on removal is what
    // makes the state last exactly as long as the account does — without the
    // prune, an identity-keyed set would simply wait for its account instead of
    // for its slot.
    const open = knownLanes(toggleLane([], bob), [alice]);
    expect(expanded(open, [alice, bob])).toEqual([]);
  });

  it("forgets nobody when the roster could not be read", () => {
    // A failed poll or an unreadable store is not evidence that anyone left,
    // and closing every open row on a transient server error would be a second
    // bug wearing the first one's clothes.
    const open = toggleLane([], alice);
    expect(knownLanes(open, undefined)).toEqual(open);
    expect(knownLanes(open, null)).toEqual(open);
  });

  it("hands back the very same array when nobody left", () => {
    // Identity, not equality: the panel polls every fifteen seconds and feeds
    // this straight into setState, so an equal-but-new array would re-render
    // the whole roster four times a minute for no change at all.
    const open = toggleLane([], alice);
    expect(knownLanes(open, [alice, bob])).toBe(open);
  });
});

describe("what counts as the same account", () => {
  it("is the email and the organization, which no move can change", () => {
    expect(laneKey({ num: 1, email: "a@b.c", org: "Acme" }))
      .toBe(laneKey({ num: 9, email: "a@b.c", org: "Acme" }));
  });

  it("separates one address signed into two organizations", () => {
    // claude-swap holds these as two accounts and guards its own usage rows on
    // exactly this pair, so the panel must not merge them into one open row.
    expect(laneKey({ num: 1, email: "a@b.c", org: "Acme" }))
      .not.toBe(laneKey({ num: 2, email: "a@b.c", org: "Other" }));
  });

  it("tells two accounts apart even when neither has an organization", () => {
    expect(laneKey({ num: 1, email: "a@b.c", org: null }))
      .not.toBe(laneKey({ num: 2, email: "d@e.f", org: null }));
  });

  it("cannot be forged by an address that spells the separator", () => {
    // Two halves joined into one string is a collision waiting to happen unless
    // the joiner cannot occur in either half. The joiner is a NUL, which no
    // address contains — so even handed one deliberately, the pair below stays
    // two accounts rather than collapsing into one open row.
    const nul = String.fromCharCode(0);
    expect(laneKey({ num: 1, email: "a@b.c", org: "x" }))
      .not.toBe(laneKey({ num: 2, email: `a@b.c${nul}x`, org: "" }));
    expect(laneKey({ num: 1, email: "a@b.c", org: "" }))
      .not.toBe(laneKey({ num: 2, email: "a@b.c", org: nul }));
  });

  it("falls back to the slot only for an account with no address at all", () => {
    // claude-swap can hold a row it has never resolved an email for. There is
    // nothing stable to follow those by, so they keep the old behaviour rather
    // than collapsing onto one shared empty key — which would open every
    // unidentified row at once, worse than the bug being fixed.
    expect(laneKey({ num: 3, email: null, org: null })).toBe("slot:3");
    expect(laneKey({ num: 4, email: "   ", org: "Acme" })).toBe("slot:4");
    expect(laneKey({ num: 3, email: null })).not.toBe(laneKey({ num: 4, email: null }));
  });

  it("never lets a slot fallback collide with a real identity", () => {
    const owners: LaneOwner[] = [
      { num: 1, email: null, org: null },
      { num: 2, email: "slot:1", org: null },
      { num: 3, email: "a@b.c", org: "slot:1" },
    ];
    expect(new Set(owners.map(laneKey)).size).toBe(3);
  });
});

describe("the panel holds the set the way this module says", () => {
  it("names rows by account and never by slot number", () => {
    expect(panelCode).toMatch(/const lanesOpen = openLanes\.includes\(laneKey\(a\)\);/);
    expect(panelCode).toMatch(/setOpenLanes\(open => toggleLane\(open, a\)\)/);
    // The two shapes the bug was made of.
    expect(panelCode).not.toMatch(/openLanes\.includes\(a\.num\)/);
    expect(panelCode).not.toMatch(/\[\.\.\.open, a\.num\]/);
  });

  it("trims the set against every roster it loads", () => {
    // Where it has to happen: the load is the only place an account's departure
    // is observable, and doMove cannot see a removal at all.
    expect(panelCode).toMatch(/setOpenLanes\(open => knownLanes\(open, fresh\.accounts\)\)/);
  });

  it("takes all three from the module rather than re-deriving them", () => {
    expect(panelCode).toMatch(/import \{ knownLanes, laneKey, toggleLane \} from "\.\.\/lane-open";/);
  });
});
