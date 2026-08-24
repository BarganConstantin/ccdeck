// #516: one letter on a focused slot picker moved an account, and into an
// occupied slot it moved a second one nobody pointed at.
//
// `onChange` on a `<select>` is not a click. The value of a focused, closed
// select moves on any key that matches an option, and every option in this
// picker begins with the same word — `slot 2 · swap`, `slot 3 · free` — so
// type-ahead matched on `s`. Driven through CDP against the panel before the
// fix: focus the picker, press `s` once, and it sent
// `POST /api/claude-accounts/admin {action:"move",account:2,slot:3}` with slot 3
// occupied. Press it again and it cycled, one move per keystroke. The threshold
// picker was the same shape with a setting write on the other end.
//
// The fix is that neither picker sends anything. Each proposes; a control
// beside it commits, the way the alias field beside `save` in the same block
// always has. This file is the half of that a suite can hold on to.
//
// Two things are asserted, and both matter. That the decision a press carries —
// what it reads, whether it needs the server, and whether what it sends moves a
// SECOND account — is a pure function of the choice, checked against every
// choice slotChoices can produce rather than against a handful somebody typed
// out. And that the panel cannot reach the server from a `change` at all, read
// out of the markup, because the pure half passing while the JSX went on
// posting from onChange is precisely the failure this issue was.
//
// Plain node, no DOM — the panel cannot be rendered here — so the second half
// reads AccountsPanel.tsx as text the way manage-block.test.ts and
// landmark-outline.test.ts do.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { slotChoices } from "../account-move";
import { slotCommit, slotShowing, thresholdCommit } from "../picker-commit";
import { withoutComments } from "./tsx-scan";

const panel = readFileSync(fileURLToPath(new URL("../components/AccountsPanel.tsx", import.meta.url)), "utf8");

/** The same file with its comments gone. The prose here quotes the handler it
 *  retired — explaining why `onChange` could not be the commit needs the old
 *  shape on the page — so a search for it has to read the markup only.
 *
 *  #513: shared with control-edges.test.ts rather than written out again. The
 *  line filter this used to be kept a comment written AFTER code on the same
 *  line, and `handlers` below is the same character walk that file had — brace
 *  counting with quote tracking and no notion of a comment — so an apostrophe
 *  in one of those trailing comments opens a string that nothing closes and the
 *  scan runs to the end of the file. `AccountsPanel.tsx` has exactly one such
 *  comment (`// unix ms — claude-swap's next planned read`) and it is harmless
 *  only because it sits above every handler in the file, which is a fact about
 *  today's markup rather than about this test. */
const panelCode = withoutComments(panel);

/**
 * The body of every `attr={…}` in the source, brace-matched.
 *
 * A lazy `[^}]*` stops at the first brace inside the handler, which for
 * `onChange={e => setSlotDraft(Number(e.target.value))}` is not the end of
 * anything. Quotes are tracked so a brace inside a string does not count.
 */
function handlers(source: string, attr: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(new RegExp(`${attr}=\\{`, "g"))) {
    const start = m.index + m[0].length;
    let depth = 1, quote = "";
    for (let i = start; i < source.length; i++) {
      const c = source[i];
      if (quote) { if (c === quote && source[i - 1] !== "\\") quote = ""; continue; }
      if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) { out.push(source.slice(start, i)); break; }
    }
  }
  return out;
}

/** Every roster the panel can hand the picker, small enough to enumerate and
 *  wide enough to include the one-account case, where no swap exists at all. */
const ROSTERS = [[1], [1, 2], [1, 2, 3], [1, 2, 3, 4], [1, 2, 3, 4, 5, 6]];

describe("what a press of the slot control does is decided by the choice alone", () => {
  it("sends exactly when the pick is somewhere else, and swaps exactly when that somewhere is taken", () => {
    for (const used of ROSTERS) {
      for (const current of used) {
        const choices = slotChoices(used, current);
        for (const c of choices) {
          const commit = slotCommit(choices, c.slot, current);
          expect(commit.sends, `${used} @${current} → ${c.slot} (${c.kind})`).toBe(c.kind !== "here");
          expect(commit.swaps, `${used} @${current} → ${c.slot} (${c.kind})`).toBe(c.kind === "swap");
        }
      }
    }
  });

  it("says `swap` on the button for exactly the options that say `· swap`", () => {
    // The whole severity of this issue is that the consequence was readable on
    // the option and a keystroke skipped the reading. The commit control is
    // where the reading happens now, so the two have to agree by construction
    // rather than by somebody keeping two lists in step.
    for (const used of ROSTERS) {
      for (const current of used) {
        const choices = slotChoices(used, current);
        for (const c of choices) {
          const commit = slotCommit(choices, c.slot, current);
          expect(commit.label === "swap", c.label).toBe(c.label.endsWith("· swap"));
          expect(commit.swaps, c.label).toBe(c.label.endsWith("· swap"));
        }
      }
    }
  });

  it("names the displaced slot in the sentence, because that account is the one nobody pointed at", () => {
    const choices = slotChoices([1, 2, 3], 2);
    const swap = slotCommit(choices, 3, 2);
    expect(swap.title).toContain("slot 3");
    expect(swap.title).toContain("slot 2");
    expect(swap.title).toMatch(/trade places/);
    // A free slot moves one account, and saying so is the point of the split.
    const free = slotCommit(choices, 4, 2);
    expect(free.title).toMatch(/no other account moves/);
    expect(free.title).not.toMatch(/trade places/);
  });

  it("keeps the account's own slot live rather than disabled, and confirms instead of sending", () => {
    // `save` one row up is never disabled by its draft matching the store —
    // that was the block's resting state and it rendered at 1.98:1, which is
    // the finding manage-block.test.ts holds. The resting state of THIS control
    // is the same shape and gets the same answer: a press with nothing to send
    // is not a failure and not a dead button, it is a confirmation.
    for (const used of ROSTERS) {
      for (const current of used) {
        const here = slotCommit(slotChoices(used, current), current, current);
        expect(here.sends).toBe(false);
        expect(here.swaps).toBe(false);
        expect(here.label).toBe("move");
        expect(here.done).toBe("here");
      }
    }
  });

  it("treats a pick that is no longer a choice as the account staying put", () => {
    // The roster reloads every fifteen seconds and a pick now outlives a poll,
    // so an account removed elsewhere can take the picked slot out of the list.
    const choices = slotChoices([1, 2, 3], 2);
    expect(slotShowing(choices, 9, 2)).toBe(2);
    expect(slotShowing(choices, null, 2)).toBe(2);
    expect(slotShowing(choices, 4, 2)).toBe(4);
    const stale = slotCommit(choices, 9, 2);
    expect(stale.sends).toBe(false);
    expect(stale.swaps).toBe(false);
  });

  it("finds no swap at all on a one-account store", () => {
    const choices = slotChoices([1], 1);
    expect(choices.map(c => c.kind)).toEqual(["here", "free"]);
    expect(choices.map(c => slotCommit(choices, c.slot, 1).swaps)).toEqual([false, false]);
  });
});

describe("the threshold control answers the same question with a smaller blast radius", () => {
  it("sends only when the pick differs from what the store holds", () => {
    expect(thresholdCommit("80", "90").sends).toBe(true);
    expect(thresholdCommit("90", "90").sends).toBe(false);
  });

  it("is never destructive, because a setting write replaces itself", () => {
    for (const pick of ["70", "80", "85", "90", "95"]) {
      expect(thresholdCommit(pick, "90").swaps).toBe(false);
    }
  });

  it("borrows the words the alias field already uses for a stored value", () => {
    const commit = thresholdCommit("80", "90");
    expect(commit.label).toBe("save");
    expect(commit.done).toBe("saved");
    expect(commit.title).toContain("80%");
  });
});

describe("nothing in the accounts panel acts on a `change`", () => {
  it("reads enough handlers for the sweep to mean anything", () => {
    // The alias field, the slot picker and the threshold picker. If this drops,
    // the assertion below is passing over markup it never found.
    expect(handlers(panelCode, "onChange").length).toBeGreaterThanOrEqual(3);
  });

  it("leaves every onChange setting state and nothing else", () => {
    // This is the assertion the issue is actually about. A `change` fires for a
    // keystroke, so no onChange in this panel may reach the server — not the
    // admin route, not the auto route, not fetch, and not the two helpers that
    // wrap them.
    for (const body of handlers(panelCode, "onChange")) {
      expect(body, body).not.toMatch(/\b(admin|post|doMove|doSlot|doThreshold|doAlias|doSwitch|load|fetch)\s*\(/);
      expect(body, body).toMatch(/\bset[A-Z]/);
    }
  });

  it("commits both pickers from a press instead", () => {
    const clicks = handlers(panelCode, "onClick").join("\n");
    expect(clicks).toMatch(/doSlot\(a\.num, picked, commit\)/);
    expect(clicks).toMatch(/doThreshold\(thresholdPick, thresholdCtl\)/);
    // And the move has exactly one caller, which is that press. `doMove` is
    // declared as `const doMove = async (…)`, so the only `doMove(` in the file
    // is the call — one of them, inside doSlot, reachable from nowhere a
    // keystroke can get to.
    expect([...panelCode.matchAll(/doMove\(/g)]).toHaveLength(1);
    expect(panelCode).toMatch(/const doSlot = async[\s\S]*?doMove\(from, to\)/);
  });

  it("keeps the picked slot in state rather than in the request", () => {
    // The retired shape, which must not come back in either picker.
    expect(panelCode).not.toMatch(/onChange=\{e => doMove\(/);
    expect(panelCode).not.toMatch(/onChange=\{e => post\(/);
    expect(panelCode).toMatch(/onChange=\{e => setSlotDraft\(Number\(e\.target\.value\)\)\}/);
    expect(panelCode).toMatch(/onChange=\{e => setThresholdDraft\(e\.target\.value\)\}/);
  });

  it("shows the pending pick in the picker, so the button and the box agree", () => {
    expect(panelCode).toMatch(/const picked = slotShowing\(choices, slotDraft, a\.num\)/);
    expect(panelCode).toMatch(/value=\{String\(picked\)\}/);
    expect(panelCode).toMatch(/value=\{thresholdPick\}/);
  });

  it("drops the pending pick when the block moves or is opened afresh", () => {
    // A draft left standing would arm the next block the user opens with a slot
    // they chose for somebody else — the shape #327 fixed for the alias draft,
    // the armed remove and the share blob.
    expect(panelCode).toMatch(/setSlotDraft\(null\)/);
    expect([...panelCode.matchAll(/setSlotDraft\(null\)/g)].length).toBeGreaterThanOrEqual(2);
  });
});

describe("both commit controls are reachable and named", () => {
  it("writes its word as the button's own text, never only as a title", () => {
    // 2.5.3 and voice control both read the visible label, and a name carried
    // only by `title` is one a touch user never sees — the defect the #381
    // sweep found twice in this same panel.
    expect(panelCode).toMatch(/>\{slotDone === a\.num \? commit\.done : commit\.label\}<\/button>/);
    expect(panelCode).toMatch(/>\{thresholdSaved \? thresholdCtl\.done : thresholdCtl\.label\}<\/button>/);
  });

  it("keeps the picker itself named by the hidden label it has always had", () => {
    expect(panelCode).toMatch(/<label className="vis-hidden" htmlFor=\{`ap-slot-\$\{a\.num\}`\}>Slot<\/label>/);
    expect(panelCode).toMatch(/aria-label="Switch threshold"/);
  });

  it("dims both only while a request is out, never at rest", () => {
    // The whole point of the pairing is a control the user can press. One that
    // greys out whenever the pick matches the store would spend the block's
    // opening state disabled, which is the 1.98:1 finding manage-block.test.ts
    // exists to hold down.
    //
    // `disabled={busy != null}` is how that was written until #518, and it is
    // not how it is written now: that expression disabled the control the press
    // had come from, and Chrome drops focus when the focused element becomes
    // disabled. `pressProps` is the one place the panel decides — inert while
    // somebody else is working, `aria-busy` while the request is your own — so
    // what is asserted is that both commit controls take it from there and that
    // neither of them has grown an opinion about `sends`.
    for (const attrs of panelCode.split("<button").slice(1)) {
      if (!/commit\.label|thresholdCtl\.label/.test(attrs.slice(0, 600))) continue;
      expect(attrs.slice(0, 600)).toMatch(/\{\.\.\.pressProps\(/);
      expect(attrs.slice(0, 600)).not.toMatch(/disabled=/);
      expect(attrs.slice(0, 600)).not.toMatch(/aria-busy=/);
      expect(attrs.slice(0, 600)).not.toMatch(/\{\.\.\.pressProps\([^)]*sends/);
    }
  });
});
