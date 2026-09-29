// #1746: saving or cancelling a rename in a deck's dialog dropped keyboard
// focus to the page.
//
// The pencil swaps the dialog's title for a form. `save` (or Enter in the
// field), `cancel` and `use this name` all end it with `setDraft(null)`, which
// takes the form away — and the control that had focus with it. Nothing moved
// focus to the pencil that comes back in its place, so it fell to <body>
// behind the scrim and the next Tab started again at the top of the dialog.
//
// The dialog now hands focus back to the pencil when renaming ends, and only
// when focus fell with the form: whoever clicked somewhere else in the dialog
// while a save was out is left there.
//
// Read from the source because the suite has no DOM to mount the dialog in —
// the same way #1411 and #1540 pin where focus goes.
import { describe, expect, it } from "vitest";

import { sourceOf } from "./client-source";

const modal = sourceOf("components/LanPeerModal.tsx");
/** The pencil's opening tag, up to its accessible name. */
const pencil = /<button type="button" className="glyph-btn lan-peer-rename"[\s\S]*?aria-label=\{`Rename \$\{row\.name\} on this deck`\}/.exec(modal)?.[0] ?? "";
/** The effect that answers `editing` turning false. */
const handBack = /const wasEditing = useRef\(false\);\s*useEffect\(\(\) => \{[\s\S]*?\}, \[editing\]\);/.exec(modal)?.[0] ?? "";

describe("focus after a rename in a deck's dialog (#1746)", () => {
  it("finds the pencil and the effect, so the cases below are about them", () => {
    expect(pencil).not.toBe("");
    expect(handBack).not.toBe("");
  });

  it("holds the pencil, which is what replaces the form", () => {
    expect(pencil).toMatch(/\bref=\{renameRef\}/);
    expect(modal).toMatch(/const renameRef = useRef<HTMLButtonElement>\(null\);/);
  });

  it("gives it focus when renaming ends, if focus fell with the form", () => {
    expect(handBack).toMatch(/if \(wasEditing\.current && !editing && focusDropped\(document\.activeElement\?\.tagName \?\? null\)\)/);
    expect(handBack).toMatch(/renameRef\.current\?\.focus\(\);/);
    expect(handBack).toMatch(/wasEditing\.current = editing;/);
    expect(modal).toMatch(/import \{[^}]*\bfocusDropped\b[^}]*\} from "\.\.\/panel-press";/);
  });

  it("covers every way renaming ends, because each one is setDraft(null)", () => {
    // `editing` is `draft != null`, so the effect is keyed on the one thing
    // save, cancel and `use this name` all change.
    expect(modal).toMatch(/const editing = draft != null;/);
    expect(modal).toMatch(/if \(await run\(\(\) => onRename\(name\)\)\) setDraft\(null\);/);
    expect(modal).toMatch(/onClick=\{\(\) => setDraft\(null\)\}>cancel<\/button>/);
    expect(modal).toMatch(/onClick=\{\(\) => void saveName\(""\)\}>/);
  });
});
