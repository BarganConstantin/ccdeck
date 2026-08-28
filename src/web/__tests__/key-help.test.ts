// #511: three keys with no control and no mention, one control with no key, and
// one recovery gesture with none of the three.
//
// The deck bound F, J and K and said so nowhere a user could reach. That is a
// documentation defect on any week; it became a navigation defect this one,
// because the things that used to compensate had all been removed — the
// `/`-search in 1.38.0, the sessions counter in 1.39.0, the sessions-list button
// in 1.41.0. Each removal was right. What they add up to is a deck whose only
// way to walk a forty-node canvas agent by agent is a pair of keys nothing
// mentions, which makes the sheet that lists them load-bearing rather than a
// convenience.
//
// A list that has to be complete cannot be kept complete by hand — it already
// was not. So this file holds the table in key-help.ts against the handler in
// App.tsx and fails when the two disagree. The rule it enforces is small and
// exact: every literal App.tsx compares `e.key` against is written down.
//
// It also pins the other two halves of the issue, because both are the same
// shape of promise: the sound switch's key, and the shift-click that puts the
// user's parked hooks back — which had no key, no control of its own, and a
// mention in one tooltip that only appears once something is already parked.
//
// Plain node, no DOM: this reads the components as text, the way
// landmark-outline.test.ts and toggle-state.test.ts do.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { KEY_HELP, KEY_HELP_NOTE, documentedKeys } from "../key-help";
import { finishSoundTitle } from "../provider-copy";
import { ASSUMED } from "../providers";

const web = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFileSync(join(web, rel), "utf8");
const app = read("App.tsx");
const sheet = read("components/KeyboardHelp.tsx");

/** The body of the deck's one window keydown handler. Sliced rather than
 *  regex-matched over the whole file so a stray `e.key` in a component below —
 *  the alias field answers Enter, the sign-in dialog answers Enter — cannot be
 *  mistaken for a shortcut this handler binds. */
const HANDLER = (() => {
  const start = app.indexOf("const onKey = (e: KeyboardEvent) => {");
  const end = app.indexOf('window.addEventListener("keydown", onKey);', start);
  if (start < 0 || end < start) throw new Error("the keydown handler moved — this file cannot read it");
  return app.slice(start, end);
})();

/** Every literal the handler compares `e.key` against, in source order. */
const BOUND = [...HANDLER.matchAll(/e\.key === "((?:[^"\\]|\\.)*)"/g)].map(m => m[1]);

/** The keys that have one spelling rather than two. Every letter is bound as
 *  both cases, because a Caps-locked keyboard sends the upper one for the same
 *  press; Space, `?` and Escape have no other case to bind. */
const SINGLE_CASE = [" ", "?", "escape"];

const lower = (s: string) => s.toLowerCase();

describe("every key the deck binds is written down where a user can find it", () => {
  it("found the handler and the keys in it, so the sweep is not vacuous", () => {
    expect(BOUND.length).toBeGreaterThan(20);
    // One from each shape: the wordless one, the punctuation one, a letter, and
    // the one that is spelled out.
    for (const key of [" ", "?", "m", "Escape"]) expect(BOUND, key).toContain(key);
  });

  it("documents every literal the handler answers", () => {
    // The whole issue as one assertion. F, J and K passed this file's ancestors
    // for thirty releases by not existing.
    const documented = documentedKeys();
    expect(BOUND.filter(k => !documented.has(lower(k)))).toEqual([]);
  });

  it("is the complete set, so a new key cannot be added quietly", () => {
    expect([...new Set(BOUND.map(lower))].sort())
      .toEqual([" ", "?", "a", "c", "escape", "f", "h", "j", "k", "l", "m", "r", "t", "u"]);
  });

  it("binds each of them exactly once, which is what makes M and ? free", () => {
    // A second branch answering a letter already taken is the collision this
    // change had to avoid, and it does not look like a failure anywhere else:
    // both handlers simply run. Counting the literals catches it.
    const counts = new Map<string, number>();
    for (const k of BOUND) counts.set(lower(k), (counts.get(lower(k)) ?? 0) + 1);
    const wrong = [...counts].filter(([k, n]) => n !== (SINGLE_CASE.includes(k) ? 1 : 2));
    expect(wrong).toEqual([]);
  });

  it("carries the three keys the issue counted, by name", () => {
    const caps = KEY_HELP.flatMap(g => g.rows.map(r => r.cap));
    for (const cap of ["F", "J", "K"]) expect(caps, cap).toContain(cap);
    // And says what they are for, since a cap on its own documents nothing.
    const rows = KEY_HELP.flatMap(g => g.rows);
    expect(rows.find(r => r.cap === "J")!.action).toMatch(/next agent/);
    expect(rows.find(r => r.cap === "K")!.action).toMatch(/previous agent/);
    expect(rows.find(r => r.cap === "F")!.action).toMatch(/fit/);
  });

  it("gives every row a cap and an action, in groups that are not empty", () => {
    expect(KEY_HELP.length).toBeGreaterThan(3);
    for (const group of KEY_HELP) {
      expect(group.rows.length, group.title).toBeGreaterThan(0);
      for (const row of group.rows) {
        expect(row.cap.trim(), group.title).not.toBe("");
        expect(row.action.trim(), row.cap).not.toBe("");
      }
    }
  });
});

describe("the short list in the detail rail and the sheet agree", () => {
  /** The rail's rows. `<kbd>` appears nowhere else in App.tsx — the sheet's own
   *  rows are rendered from the table, in KeyboardHelp.tsx. */
  const RAIL = [...app.matchAll(/<kbd>([^<]*)<\/kbd>/g)].map(m => m[1]);

  it("reads the rail at all", () => {
    expect(RAIL.length).toBeGreaterThan(10);
  });

  it("puts nothing in the rail that the sheet does not carry", () => {
    // Two rendered lists, one table behind them. The rail is deliberately the
    // shorter one — it is what a new deck needs to move around, not the
    // reference — but it may not name a key the reference has never heard of,
    // which is how the two would drift into contradicting each other.
    const caps = new Set(KEY_HELP.flatMap(g => g.rows.map(r => lower(r.cap))));
    expect(RAIL.filter(c => !caps.has(lower(c)))).toEqual([]);
  });

  it("opens the rail with the row that makes the rest of it findable", () => {
    expect(app).toMatch(/<div className="sc"><kbd>\?<\/kbd><span>all shortcuts<\/span><\/div>/);
  });
});

describe("the way in", () => {
  it("binds ? to the sheet, and the sheet to ?", () => {
    expect(app).toMatch(/if \(e\.key === "\?"\) setKeyHelpOpen\(o => !o\);/);
    expect(app).toMatch(/\{keyHelpOpen && <KeyboardHelp onClose=\{\(\) => setKeyHelpOpen\(false\)\}/);
  });

  it("keeps a control on screen for the deck a user actually works in", () => {
    // The rail's list draws only while nothing is selected and the rail is
    // open. That is the first ten seconds of a deck and none of the rest of it,
    // so `?` needs an affordance that does not disappear the moment somebody
    // clicks an agent. It is in the canvas control stack, beside Recenter,
    // Re-arrange and Clear — where this deck put its commands when the topbar
    // was cut back — and not in the topbar, which is the thing that was cut.
    expect(app).toMatch(/title="Keyboard shortcuts \(\?\)"/);
    expect(app).toMatch(/aria-label="Open the keyboard shortcuts"/);
    expect(app).not.toMatch(/className="btn icon-btn"[\s\S]{0,200}Keyboard shortcuts/);
  });

  it("is a dialog built out of the six that came before it", () => {
    // Not a fourth spelling of anything: the shared scrim and surface carry the
    // entrance and the reduced-motion answer, and the shared hook carries
    // Escape, the focus trap and the hand-back.
    expect(sheet).toMatch(/const dialogRef = useModalDismiss\(onClose\);/);
    expect(sheet).toMatch(/<div className="modal-backdrop" onClick=\{onClose\} role="presentation">/);
    expect(sheet).toMatch(/className="modal key-help"/);
    expect(sheet).toMatch(/aria-modal="true"/);
  });

  it("says what a focused control does to the keys it is advertising", () => {
    // The small lie this sheet had to avoid. `KEY_OWNING_TAGS` in shortcuts.ts
    // puts BUTTON on the list of elements that own their own keys, so every
    // letter in the sheet is inert for as long as any control holds focus — and
    // the sheet itself takes focus when it opens. Printing "Re-layout (R)" in
    // that state would be promising something the next keystroke will not do.
    expect(KEY_HELP_NOTE).toMatch(/focus/i);
    expect(KEY_HELP_NOTE).toMatch(/Esc/);
    expect(sheet).toContain("{KEY_HELP_NOTE}");
  });
});

describe("the sound switch, which had a control and no key", () => {
  it("names its key the way every other control on the bar does", () => {
    for (const on of [true, false]) {
      expect(finishSoundTitle(ASSUMED, { on, clash: 0, parked: 0 })).toContain("(M)");
    }
  });

  it("sends both ways to the switch through one door", () => {
    // requestClear's shape, for the one other control that answers to two
    // devices: a modifier the mouse honours and the keyboard does not is
    // exactly how the shift-click ended up undocumented in the first place.
    //
    // WHICH two devices changed in #711 and the rule did not. The topbar button
    // stopped toggling — it opens the menu — so the two routes to the switch
    // are now M and the menu's own control, and both still land on toggleSound.
    // A second setter, on either of them, is what this refuses.
    expect(app).toMatch(/activateSoundRef\.current\(e\.shiftKey\)/);
    expect(app).toMatch(/const activateSound = useCallback\(\(_withShift: boolean\) => \{ toggleSound\(\); \}/);
    expect(app).toMatch(/onToggleSound=\{toggleSound\}/);
    // Two writers of the flag and no more: the effect that reads the stored
    // value back on mount, and the toggle itself. A third would be a second
    // door — the exact thing this case exists to refuse.
    expect([...app.matchAll(/setSoundOn\(/g)]).toHaveLength(2);
    expect(app).toMatch(/const toggleSound = useCallback\(\(\) => \{\s*\n\s*setSoundOn\(prev => \{/);
  });

  it("keeps a one-press route to silence now that the click opens a menu", () => {
    // The half of #711 that had to survive the redesign: a keyboard user must
    // still be able to shut the deck up without opening anything. M is that,
    // and the sheet is where it is promised.
    const row = KEY_HELP.flatMap(g => g.rows).find(r => /^m$/i.test(r.cap));
    expect(row!.action).toMatch(/sound on or off/);
    // And the divergence is written down rather than left to be discovered,
    // which is the whole reason #709 removed Shift+M: the click and M no longer
    // agree, so the sheet says what each one does.
    const mouse = KEY_HELP.find(g => g.title === "Mouse")!;
    expect(mouse.rows.some(r => /speaker/i.test(r.action) && /settings/i.test(r.action))).toBe(true);
  });

  it("guards M the way it guards A, plus the state the button waits for", () => {
    // No Claude Code, no button to draw; no sound state read back out of
    // localStorage yet, no state to invert. The button is not drawn in either
    // case and the key must not fire in either case.
    expect(app).toMatch(/providersRef\.current\.claude && soundOnRef\.current !== null/);
  });
});

describe("the sound gestures that outlived their mechanism", () => {

  it("no longer lists a key for a recovery that no longer exists", () => {
    // Shift+M and the shift-click row put back sound hooks the switch had
    // parked in settings.json. #704 deleted the parking, so both rows describe
    // a gesture that does nothing. A sheet that lists a key which does nothing
    // is worse than one that lists fewer keys.
    const rows = KEY_HELP.flatMap(g => g.rows);
    expect(rows.find(r => /^shift \+ m$/i.test(r.cap)), "Shift+M outlived its mechanism").toBeUndefined();
    expect(
      rows.find(r => /shift-click/i.test(r.cap) && /sound/i.test(r.action)),
      "the sound shift-click row outlived its mechanism",
    ).toBeUndefined();
    // And the unrelated one is untouched: "shift-click" is a gesture, not a
    // feature, and selection still uses it.
    expect(rows.find(r => /shift-click/i.test(r.cap) && /selection/i.test(r.action))).toBeDefined();
    expect(rows.some(r => /sound hooks back/i.test(r.action))).toBe(false);
  });

  it("still lists the plain key, and stops calling the sound Claude-only", () => {
    // The tone follows the event now, and a Codex Stop is a Stop.
    const row = KEY_HELP.flatMap(g => g.rows).find(r => /^m$/i.test(r.cap));
    expect(row, "M is not in the sheet").toBeDefined();
    // "finish sound" became "sound" in #711: the key covers both tones and the
    // menu it sits beside names them separately, so the narrower word was the
    // one that had gone stale.
    expect(row!.action).toMatch(/sound on or off/);
    expect(row!.action).not.toMatch(/Claude Code/);
  });
});
