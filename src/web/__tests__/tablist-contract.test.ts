// #581: the sign-in dialog announced a tab widget and implemented none of it.
//
// `<span className="aa-tabs" role="tablist">` held two `<button role="tab"
// aria-selected>` — Sign in, Paste a share — and that was the entire widget.
// A screen-reader user opening the accounts panel and pressing + heard "tab
// list, Sign in, tab, selected, 1 of 2", pressed Left or Right because that is
// the one gesture the role exists to advertise, and nothing happened: the only
// onKeyDown anywhere in the file were the two Enter handlers on the code field
// and the share field. There was no aria-controls on either tab and no
// role="tabpanel" anywhere, so each tab announced as controlling nothing and
// there was no way to get from the selected tab to the region it had selected.
// And neither button carried a tabIndex, so both were ordinary tab stops and
// Tab walked into the strip and then through it, which is precisely the thing
// a tablist is defined not to do. A sighted keyboard user was fine only by
// accident, because both members were still real <button>s: the role was doing
// nothing at all except mis-describing them.
//
// The deck had already answered this question once, on the other side of the
// app, and answered it the other way. UsageHistoryModal's range strip (#381)
// wrote the contract out in full — one tab stop for the set, arrows between the
// members, a tabpanel each — found it kept none of the three, and deleted the
// role in favour of role="group" + aria-pressed. That was right there and is
// wrong here, and the difference is the third clause rather than the keyboard
// one: the range strip controls no panel at all, only the same chart redrawn
// over a different number of days, so no amount of arrow-key code could have
// made role="tab" true of it. These two swap two genuinely different journeys
// through one dialog — a conversation with Anthropic, and a one-shot paste from
// another deck — which is the thing a tab widget is the name for. A role that
// can never be honoured is a role to delete; a role that fits and is unpaid for
// is a bill. So this strip kept the role and paid it.
//
// Why the suite did not catch the original. It is not that nothing looked.
// landmark-outline.test.ts looked straight at it and asserted role="tablist"
// was present in this file and in no other, under a comment calling the absent
// arrow keys, aria-controls and tabpanels "a change to make deliberately and
// not as the tail of a landmarks issue. Pinned so the scope-out stays a
// decision." That assertion asked WHERE the role was and never whether it was
// honoured, which left a green test sitting on top of the defect for as long as
// nobody opened the issue. That test has been rewritten to hand the question
// here, and this file is shaped so the same thing cannot happen again: nothing
// below pins today's markup. The sweep says that ANY file in this client
// carrying role="tab" must carry the whole keyboard model beside it, so a
// second strip written next year fails the moment it announces more than it
// does — and a file that carries no role="tab" at all passes, because dropping
// the role is the other honest end and the suite must not forbid it.
//
// Plain node, no DOM — nothing in this suite renders React — so the markup half
// reads the components as text the way landmark-outline.test.ts and
// modal-focus-trap.test.ts do, and the behaviour half is a real unit test of a
// real function, because the arrow rule was written as one for exactly that
// reason (see tablist-keys.ts, and shortcuts.ts and canvas-keys.ts before it).
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tabStripMove } from "../tablist-keys";

const web = fileURLToPath(new URL("..", import.meta.url));

/** Every .tsx that ends up in the bundle. The suite's own files are not markup. */
function components(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : components(path);
    return path.endsWith(".tsx") ? [path] : [];
  });
}

/** The same text with its comments gone. This repo's comments quote the markup
 *  they replaced, so a sweep that read them would find the sentence explaining
 *  why a shape is retired and count it as the shape. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");
}

/** Every opening tag in a component, whole, as written.
 *
 *  Brace-aware rather than a single regex, because a JSX attribute value is
 *  arbitrary JavaScript and this widget's attributes contain both `=>` and
 *  nested braces — `ref={el => { … }}` would end a naive tag match at the arrow
 *  and hand back half an element. Depth counts the braces; only a `>` outside
 *  them closes the tag. */
function openingTags(src: string): string[] {
  const tags: string[] = [];
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== "<" || !/[a-zA-Z]/.test(src[i + 1] ?? "")) continue;
    let depth = 0;
    let end = -1;
    for (let j = i + 1; j < src.length; j++) {
      const c = src[j];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (depth === 0 && (c === ">" || c === "<")) { if (c === ">") end = j; break; }
    }
    if (end === -1) continue;
    tags.push(src.slice(i, end + 1));
    i = end;
  }
  return tags;
}

const FILES = components(web);
/** [name, comment-stripped text] for the whole client. The separator is
 *  normalised because the names below name files inside components/, and
 *  join() spells that with a backslash on Windows. */
const BUNDLE: Array<[string, string]> = FILES.map(p =>
  [p.slice(web.length).replace(/\\/g, "/"), code(readFileSync(p, "utf8"))]);

/** `role="tab"` and not `role="tablist"` or `role="tabpanel"` — the closing
 *  quote is what separates the three. */
const IS_TAB = /\brole="tab"/;
const IS_TABLIST = /\brole="tablist"/;
const IS_TABPANEL = /\brole="tabpanel"/;

/** Every file that announces a tab widget, and every tag in it that is a tab.
 *  Empty is a legal answer: a deck with no role="tab" anywhere has kept the
 *  contract by not making the promise, which is what the range strip did. */
const STRIPS = BUNDLE
  .filter(([, src]) => IS_TAB.test(src))
  .map(([name, src]) => ({ name, src, tabs: openingTags(src).filter(t => IS_TAB.test(t)) }));

// ── the promise and the behaviour have to agree, wherever the role appears ──

describe("a role=\"tab\" in this client comes with the keyboard model it promises (#581)", () => {
  it("finds the tab strips by their role rather than by a file name", () => {
    // The guard on everything below: a sweep that silently matched nothing
    // would pass forever. This states what it is looking at, and it is allowed
    // to change — a strip added, a strip dropped — without anything here
    // needing to know, because every assertion after it is quantified over
    // whatever it found.
    for (const { name, src, tabs } of STRIPS) {
      // The tag parser has to recover every announcement the search found, or
      // the sweep below would quietly skip a tab it could not read.
      expect([name, tabs.length]).toEqual([name, [...src.matchAll(/\brole="tab"/g)].length]);
    }
  });

  it("gives every tab a panel to control, and the panel a tab to be named by", () => {
    // The clause the sign-in dialog broke most quietly. Its two tabs carried no
    // aria-controls and the body they swapped was an unroled <section>, so each
    // tab announced as controlling nothing and a screen-reader user who heard
    // "selected" had no route to the thing that had been selected.
    for (const { name, src, tabs } of STRIPS) {
      for (const tab of tabs) expect(`${name} ${tab}`).toMatch(/aria-controls=/);
      expect(`${name}: ${src}`).toMatch(IS_TABPANEL);
      const panel = openingTags(src).find(t => IS_TABPANEL.test(t))!;
      expect(`${name} ${panel}`).toMatch(/aria-labelledby=/);
      // Both halves of the pairing name the same thing. Textual, so it holds
      // for a literal id and for the shared constant this dialog uses, and
      // fails the moment a tab is pointed at a panel that is not there.
      const panelId = /\bid=(\{[^}]*\}|"[^"]*")/.exec(panel)?.[1];
      for (const tab of tabs) {
        const controls = /aria-controls=(\{[^}]*\}|"[^"]*")/.exec(tab)?.[1];
        expect([name, controls]).toEqual([name, panelId]);
      }
    }
  });

  it("makes the whole strip one tab stop instead of one stop per member", () => {
    // Neither button had a tabIndex, so Tab walked into the strip and then
    // through it. A roving tab stop is half of what the role means, and the
    // focus trap in modal-dismiss.ts already skips a negative tabIndex, so
    // saying it here is all it takes for Tab to go strip → panel and back.
    for (const { name, tabs } of STRIPS) {
      for (const tab of tabs) expect(`${name} ${tab}`).toMatch(/tabIndex=\{/);
    }
  });

  it("listens for the arrow keys the role told the user to press", () => {
    // The whole of the bug in one line: the role advertises Left and Right and
    // nothing in the file was listening. The listener goes on the tablist, not
    // on each tab, because the strip is the widget.
    for (const { name, src } of STRIPS) {
      const strip = openingTags(src).find(t => IS_TABLIST.test(t));
      expect(strip ?? `${name}: tabs with no role="tablist" around them`).toMatch(IS_TABLIST);
      expect(`${name} ${strip}`).toMatch(/onKeyDown=/);
    }
  });

  it("routes that listener through the one shared rule, not a second spelling", () => {
    // Same reason shortcuts.ts, canvas-keys.ts and modal-dismiss.ts exist: a
    // keyboard decision written inline in a component is a keyboard decision
    // no plain-node test can read, which is how this one went unwritten for as
    // long as it did.
    for (const { name, src } of STRIPS) {
      expect(`${name}: ${src}`).toMatch(/tabStripMove\(/);
      expect(`${name}: ${src}`).toMatch(/from "\.\.?\/(\.\.\/)?tablist-keys"/);
    }
  });
});

// ── the rule itself ─────────────────────────────────────────────────────────

describe("tabStripMove decides where an arrow lands", () => {
  const key = (k: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey", boolean>> = {}) =>
    ({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods });

  it("walks right and left through the members", () => {
    expect(tabStripMove(key("ArrowRight"), 0, 2)).toEqual({ kind: "select", index: 1 });
    expect(tabStripMove(key("ArrowLeft"), 1, 2)).toEqual({ kind: "select", index: 0 });
    expect(tabStripMove(key("ArrowRight"), 1, 3)).toEqual({ kind: "select", index: 2 });
  });

  it("wraps at both ends, so two members are never a dead end", () => {
    // With two tabs Left and Right are the same gesture, and a user who has to
    // find Home to get back to the first tab has been given a dead end.
    expect(tabStripMove(key("ArrowRight"), 1, 2)).toEqual({ kind: "select", index: 0 });
    expect(tabStripMove(key("ArrowLeft"), 0, 2)).toEqual({ kind: "select", index: 1 });
  });

  it("sends Home and End to the ends of the strip", () => {
    expect(tabStripMove(key("Home"), 1, 2)).toEqual({ kind: "select", index: 0 });
    expect(tabStripMove(key("End"), 0, 2)).toEqual({ kind: "select", index: 1 });
    // Home while already first still belongs to the strip: it means "the first
    // tab", and answering it is not the same as doing nothing.
    expect(tabStripMove(key("Home"), 0, 2)).toEqual({ kind: "select", index: 0 });
  });

  it("starts from an end when nothing is selected yet", () => {
    expect(tabStripMove(key("ArrowRight"), -1, 2)).toEqual({ kind: "select", index: 0 });
    expect(tabStripMove(key("ArrowLeft"), -1, 2)).toEqual({ kind: "select", index: 1 });
    // An index the strip does not have is the same situation, not a crash.
    expect(tabStripMove(key("ArrowRight"), 9, 2)).toEqual({ kind: "select", index: 0 });
  });

  it("leaves Tab and Escape alone, because the dialog owns both", () => {
    // Tab is how focus LEAVES the strip for the panel, and Escape belongs to
    // the dismiss stack in modal-dismiss.ts, which closes the dialog from
    // anywhere inside it. A widget that preventDefaults either one has trapped
    // the user in a header.
    expect(tabStripMove(key("Tab"), 0, 2)).toEqual({ kind: "pass" });
    expect(tabStripMove(key("Escape"), 0, 2)).toEqual({ kind: "pass" });
    expect(tabStripMove(key("Enter"), 0, 2)).toEqual({ kind: "pass" });
  });

  it("leaves the vertical arrows to the browser, which scrolls the dialog with them", () => {
    // A horizontal tablist owns the horizontal arrows and no others. Taking Up
    // and Down would cost a keyboard user the only way to read a panel taller
    // than the modal.
    expect(tabStripMove(key("ArrowDown"), 0, 2)).toEqual({ kind: "pass" });
    expect(tabStripMove(key("ArrowUp"), 0, 2)).toEqual({ kind: "pass" });
  });

  it("stands aside for the browser's own chords on all three platforms", () => {
    // Ctrl+Right jumps a word on Linux and Windows, Cmd+Left goes back a page
    // on macOS, Alt+Home is the browser's home. One rule for all of them —
    // isBrowserChord, the same one the focus trap and the canvas shortcuts ask.
    expect(tabStripMove(key("ArrowRight", { ctrlKey: true }), 0, 2)).toEqual({ kind: "pass" });
    expect(tabStripMove(key("ArrowRight", { metaKey: true }), 0, 2)).toEqual({ kind: "pass" });
    expect(tabStripMove(key("Home", { altKey: true }), 0, 2)).toEqual({ kind: "pass" });
    // Shift is deliberately not one of them, so Shift+Arrow is still ours.
    expect(tabStripMove(key("ArrowRight"), 0, 2)).toEqual({ kind: "select", index: 1 });
  });

  it("has nowhere to go in an empty strip and says so rather than dividing by zero", () => {
    expect(tabStripMove(key("ArrowRight"), 0, 0)).toEqual({ kind: "pass" });
    expect(tabStripMove(key("End"), -1, 0)).toEqual({ kind: "pass" });
  });
});

// ── the one place the widget meets code that was written before it ──────────

describe("the sign-in dialog's arrow keys do not fight its own autofocus", () => {
  const dialog = BUNDLE.find(([name]) => name.endsWith("AddAccountDialog.tsx"))![1];

  it("keeps focus on the tab an arrow selected, and only on it", () => {
    // The share tab focuses its field on arrival, which is right for a pointer
    // user — they are past the choosing and the field is where they were going
    // — and ruinous for the keyboard model: arrowing to that tab would throw
    // focus straight into the panel, the roving stop would be somewhere the
    // user is not, and the arrows could be used exactly once. So the switch
    // records how it happened and the effect reads it.
    expect(dialog).toMatch(/arrowedRef\.current = true;/);
    expect(dialog).toMatch(/tab === "paste" && !arrowedRef\.current/);
    // And the arrow puts focus on the member it selected, because the browser
    // will not: the tab focus just left is the one about to go tabIndex={-1}.
    expect(dialog).toMatch(/tabRefs\.current\[move\.index\]\?\.focus\(\)/);
  });
});
