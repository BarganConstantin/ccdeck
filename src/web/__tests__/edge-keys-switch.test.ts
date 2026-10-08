// The chrome's keys and Settings › General's "Single-key shortcuts" switch
// (WCAG 2.1.4, Character Key Shortcuts).
//
// Every control on the deck's chrome names the key that reaches it twice: in
// the hint's keycap ("Session list  L", use-hint.tsx) and in aria-keyshortcuts,
// for a screen reader. Both are a promise, and with the switch off a single
// character does nothing (use-deck-shortcuts.ts), so neither may name one —
// on the stripes, in the phone's dock, on the waiting count or on the queue's
// "+N more". A chord is not a single-key shortcut: the gear's Cmd/Ctrl+,
// keeps its keycap and its aria-keyshortcuts whichever way the switch is set.
//
// Drawn with renderToStaticMarkup; no DOM.
import { afterEach, describe, expect, it } from "vitest";
import { isCharacterKey, setSingleKeyShortcuts } from "../single-key-shortcuts";
import { EdgeDock, EdgeRail, UtilityRun, liveKey, railHint, type RailItem } from "../components/EdgeRails";
import { WaitingStat } from "../components/TopbarReadouts";
import { attr, buttons, createElement, draw, items } from "./edge-keys-rails";
import { sourceOf } from "./client-source";

afterEach(() => { setSingleKeyShortcuts(true); });

const noop = () => {};
const every = (): RailItem[] => { const c = items(); return [...c.left, ...c.right.flat(), ...c.utilities]; };

/** Every placement the chrome draws its controls in, by data-rail-item: the
 *  stripes and the topbar's utilities on a desktop, the dock on a phone. */
function chrome(): { desktop: Map<string, string>; phone: Map<string, string> } {
  const c = items();
  return {
    desktop: buttons(draw(createElement("div", null,
      createElement(EdgeRail, { side: "left", label: "Left column", groups: [c.left] }),
      createElement(EdgeRail, { side: "right", label: "Right panels", groups: c.right }),
      createElement(UtilityRun, { items: c.utilities }),
    ))),
    phone: buttons(draw(createElement(EdgeDock, {
      items: [...c.left, ...c.right[0], c.utilities[0]], more: [...c.right[1], c.utilities[1]],
    }))),
  };
}

/** The waiting count, drawn, with a stand-in data-rail-item so `buttons` finds it. */
function count(): string {
  const waitingSessions = [{ id: "s1", label: "api", waiting: { kind: "permission", since: 0, message: "Run tests?" } }];
  const html = draw(createElement(WaitingStat, {
    waitingSessions, waitingCursorRef: { current: null }, focusSession: noop, now: 1_000, named: 0,
  } as unknown as Parameters<typeof WaitingStat>[0]));
  return /<button\b[^>]*>/.exec(html)![0];
}

describe("which of the chrome's keys the switch silences", () => {
  it("marks the six panel letters single and the gear's chord not, the way the handler tells them apart", () => {
    // isCharacterKey is the handler's own test (single-key-shortcuts.ts); a
    // key the chrome calls single is exactly one the handler mutes.
    for (const item of every().filter(i => i.key)) {
      const k = item.key!;
      expect(k.single, item.id).toBe(item.id !== "settings");
      if (k.single) expect(isCharacterKey(k.cap.toLowerCase()), item.id).toBe(true);
    }
    expect(every().find(i => i.id === "feedback")!.key, "Feedback has no key to name").toBeUndefined();
  });

  it("lets liveKey through only while it does something", () => {
    for (const item of every().filter(i => i.key)) {
      expect(liveKey(item.key, true), item.id).toEqual(item.key);
      expect(liveKey(item.key, false), item.id).toEqual(item.key!.single ? undefined : item.key);
    }
  });
});

describe("with the switch on", () => {
  it("names each control's key in aria-keyshortcuts, on a desktop and on a phone", () => {
    const { desktop, phone } = chrome();
    const want: Record<string, string> = {
      "session-list": "L", accounts: "A", usage: "U", machine: "S", history: "H", "browser-watch": "B",
      settings: "Control+, Meta+,",
    };
    for (const [id, keys] of Object.entries(want)) expect(attr(desktop.get(id)!, "aria-keyshortcuts"), id).toBe(keys);
    for (const id of ["session-list", "accounts", "usage", "machine", "settings"]) {
      expect(attr(phone.get(id)!, "aria-keyshortcuts"), `dock ${id}`).toBe(want[id]);
    }
    expect(attr(desktop.get("feedback")!, "aria-keyshortcuts")).toBeNull();
  });

  it("puts the key in every hint that has one", () => {
    for (const item of every().filter(i => i.key)) {
      expect(railHint(item, true, true)?.keys, item.id).toBe(item.key!.cap);
    }
  });

  it("names W on the waiting count, and L on the queue's \"+N more\"", () => {
    expect(attr(count(), "aria-keyshortcuts")).toBe("W");
    // "+N more" is drawn only once the queue has measured what fits, which a
    // static render cannot; its two halves are read from the source.
    const readouts = sourceOf("components/TopbarReadouts.tsx");
    expect(readouts).toMatch(/className="wait-more"[\s\S]{0,200}?aria-keyshortcuts=\{singleKeys \? "L" : undefined\}/);
    expect(readouts).toMatch(/label: "Open the session list",\s*keys: singleKeys \? "L" : undefined,/);
    expect(readouts).toMatch(/label: "Go to the longest wait",\s*keys: singleKeys \? "W" : undefined,/);
  });
});

describe("with the switch off", () => {
  it("names no single key anywhere on the chrome, and keeps the gear's chord", () => {
    setSingleKeyShortcuts(false);
    const { desktop, phone } = chrome();
    for (const [where, tags] of [["desktop", desktop], ["phone", phone]] as const) {
      for (const [id, tag] of tags) {
        const keys = attr(tag, "aria-keyshortcuts");
        if (id === "settings") expect(keys, `${where} ${id}`).toBe("Control+, Meta+,");
        else expect(keys, `${where} ${id}`).toBeNull();
      }
    }
  });

  it("drops the keycap from every hint, and keeps the chord's", () => {
    for (const item of every().filter(i => i.key)) {
      const hint = railHint(item, false, true);
      if (item.key!.single) expect(hint?.keys, item.id).toBeUndefined();
      else expect(hint?.keys, item.id).toBe(item.key!.cap);
    }
  });

  it("says nothing at all where the key was the only thing a hint added to the word", () => {
    // A stripe button already says its name along itself; with no key to add,
    // a hint would only repeat it. One that names more than the word — a
    // longer name, Browser watch's state — still speaks.
    for (const item of every().filter(i => i.key?.single)) {
      const more = (item.hint != null && item.hint !== item.label) || item.detail != null;
      expect(railHint(item, false, true) === null, item.id).toBe(!more);
    }
    // And a control whose word is not drawn has a hint either way: its name
    // is then the whole of what the hint is for.
    for (const item of every()) expect(railHint(item, false, false), item.id).not.toBeNull();
  });

  it("drops W from the waiting count", () => {
    setSingleKeyShortcuts(false);
    expect(attr(count(), "aria-keyshortcuts")).toBeNull();
    expect(count()).not.toMatch(/press W|title=/);
  });

  it("is read through the switch's own hook, so a flip reaches every control at once", () => {
    // The hook re-renders whoever asks when the switch flips, in this tab or
    // another (use-single-key-shortcuts.ts); the chrome reads nothing else.
    for (const rel of ["components/EdgeRails.tsx", "components/TopbarReadouts.tsx"]) {
      const src = sourceOf(rel);
      expect(src, rel).toContain('import { useSingleKeyShortcuts } from "../use-single-key-shortcuts";');
      expect(src, rel).not.toMatch(/agent-dag\.single-key-shortcuts|readStored/);
    }
  });
});
