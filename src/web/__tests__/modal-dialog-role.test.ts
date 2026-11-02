// ToolModal put role="dialog" aria-modal="true" on its click-to-close
// backdrop, so the dialog a screen reader drew included the dismiss scrim, and
// the surface inside it — the actual dialog — carried no role. Neither element
// carried a name either, so the whole thing announced as an unnamed "dialog"
// while the four siblings around it all named themselves. There is no DOM to
// render into here, so this reads the source the way ctx-path-bidi.test.ts
// reads styles.css: the shape is what the bug was, and the shape is what is
// pinned.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../components", import.meta.url));
const read = (f: string) => readFileSync(`${dir}/${f}`, "utf8");

/** The generic dialog markup is one file's now: the scrim and the surface that
 *  every dialog on the shell draws. The sweep reads it once, then reads each
 *  dialog's own use of it. */
const SHELL = read("Dialog.tsx");

/** The opening tag of the scrim in the shell — the element with the dismiss handlers. */
function backdropTag(src: string): string | null {
  const m = /<div\s(?:=>|[^>])*className=\{className \? `modal-backdrop(?:=>|[^>])*>/.exec(src);
  return m ? m[0] : null;
}

/** The `<Dialog ...>` tags a file draws: its use of the shell. */
function shellUses(src: string): string[] {
  return src.match(/<Dialog\s(?:=>|[^>])*>/g) ?? [];
}

/** Every element in the file that claims to be a dialog. The `=>` alternative
 *  is not decoration: the surface these modals put the role on is the one
 *  carrying `onClick={e => e.stopPropagation()}`, and a plain [^>] run stops
 *  dead on the arrow. */
function dialogTags(src: string): string[] {
  return src.match(/<div\s(?:=>|[^>])*role="dialog"(?:=>|[^>])*>/g) ?? [];
}

// Every dialog on the shell: a file that draws `<Dialog` (a surface on the
// shell) or `<DialogScrim` (the radio, whose panel is its own surface, in
// RadioPanel.tsx). QuickOpen is the one documented literal exception: it keeps
// its own `modal-backdrop qo-backdrop` div and its own keyframes.
const MODALS = readdirSync(dir)
  .filter(f => f.endsWith(".tsx") && f !== "Dialog.tsx")
  .filter(f => /<Dialog\s|<DialogScrim\s/.test(read(f)));
const ON_SURFACE = MODALS.filter(f => shellUses(read(f)).length > 0);

describe("the deck's modals", () => {
  it("has found all seventeen of them, so a new one cannot skip this file", () => {
    // Six until #511 added the shortcuts sheet, seven until #712 added the
    // release notes, nine until #723 added the share picker, ten until #738
    // added the section history and eleven until it added the process list. The
    // count is not an allowlist: raising it is how a dialog enters the sweep,
    // and every assertion below then applies to it unchanged.
    // The sixteenth is the guide — the two picture tours share one dialog —
    // and the seventeenth is a deck's own dialog, opened from its row in
    // Local network. The nineteenth is the accounts panel's Usage report
    // (#1707), which adds every account's 5h and 7d up. The twentieth is the
    // network map, opened from Local network's row and its view's header.
    // The twenty-first is the feedback dialog, opened from Appearance (#1853).
    // The same issue had a twenty-second for a week, a one-time question about
    // anonymous reports; it went when reports became on by default, with a
    // switch in place of the question. The twenty-second is the re-sign-in
    // prompt for an account the deck signed in whose login expired (#1893).
    // The twenty-third is the note that stands in for Usage history or Browser
    // Watch when its chunk did not arrive, a tab older than an upgrade.
    // The twenty-fourth is Settings, behind the gear and Cmd/Ctrl+,. The
    // Appearance modal it replaced was never counted here: its backdrop wore
    // two classes, which the sweep's one-class pattern does not match.
    // The twenty-eighth and twenty-ninth are Tool activity: the report, on the
    // shared scrim alone since it stopped being a page, and its details as a
    // sheet on phones. The thirtieth is a connected tracker's panel — Jira's
    // backlog and its issues — opened from its stripe control or I (#2178).
    // Explore integrations follows every shared dialog assertion below.
    // Thirty-one of them draw `<Dialog` and the radio draws `<DialogScrim`.
    expect(MODALS.length).toBe(32);
    expect(ON_SURFACE.length).toBe(31);
    expect(MODALS.filter(f => !ON_SURFACE.includes(f))).toEqual(["RadioExperience.tsx"]);
  });

  it("never calls the dismiss scrim a dialog", () => {
    const tag = backdropTag(SHELL)!;
    expect(tag).toBeTruthy();
    expect(/role="(?!presentation)/.test(tag)).toBe(false);
    expect(tag.includes("aria-modal")).toBe(false);
    // and no dialog file spells a scrim of its own beside the shell's
    for (const f of MODALS) {
      expect(`${f}: ${/className="modal-backdrop/.test(read(f))}`).toBe(`${f}: false`);
    }
  });

  it("marks the scrim as presentational, since it is a gesture and not content", () => {
    expect(backdropTag(SHELL)!.includes('role="presentation"')).toBe(true);
    // The shell is the only place the scrim is drawn; the radio goes through it too.
    expect(/<DialogScrim\s/.test(read("RadioExperience.tsx"))).toBe(true);
  });

  it("puts the dialog role on the surface inside the scrim, exactly once", () => {
    // The shell's surface carries it once, with aria-modal beside it.
    expect(dialogTags(SHELL)).toHaveLength(1);
    expect(dialogTags(SHELL)[0]).toContain('aria-modal="true"');
    for (const f of ON_SURFACE) {
      expect(`${f}: ${shellUses(read(f)).length >= 1}`).toBe(`${f}: true`);
      // and no second, hand-written dialog role beside the shell's
      expect(`${f}: ${dialogTags(read(f)).length}`).toBe(`${f}: 0`);
    }
    // The radio's panel is its own surface, the one other place.
    expect(dialogTags(read("RadioPanel.tsx"))).toHaveLength(1);
  });

  it("gives every dialog a name, so none of them announces as just 'dialog'", () => {
    for (const f of ON_SURFACE) {
      for (const tag of shellUses(read(f))) {
        expect(`${f}: ${/(aria-label(ledby)?|labelledBy)=("|\{t\()/.test(tag)}`).toBe(`${f}: true`);
      }
    }
    expect(dialogTags(read("RadioPanel.tsx"))[0]).toMatch(/aria-labelledby="radio-title"/);
  });
});

describe("ToolModal", () => {
  const src = read("ToolModal.tsx");

  it("names itself after the tool, the one thing that tells two of these apart", () => {
    expect(shellUses(src)[0]).toContain('labelledBy="tool-modal-title"');
    // The id has to be on something that renders, or the name resolves to
    // nothing and the dialog is unnamed again in a way no attribute shows.
    expect(src).toMatch(/<span id="tool-modal-title" className="modal-tool-name">\{tool\.name\}<\/span>/);
  });

  it("still closes on a backdrop click, which is what the scrim is for", () => {
    // A press of the scrim itself, not a selection let go over it — see
    // useScrimDismiss.
    expect(src).toContain("const scrimPress = useScrimDismiss(onClose);");
    expect(shellUses(src)[0]).toContain("scrim={scrimPress}");
    // and the shell is what puts the handlers on the scrim
    expect(SHELL).toMatch(/\{\.\.\.scrim\}/);
  });
});
