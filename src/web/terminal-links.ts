// A link in the pane, and when pressing it opens anything.
//
// Two kinds reach the stage: OSC 8 hyperlinks, which Claude Code writes around
// its PR badge and file references, and plain URLs in the output, which the
// web-links addon finds. xterm's own handler for the first kind asks with a
// browser confirm() — a modal that freezes the page the deck drives, and one
// ux.md rules out — so the stage gives xterm this rule instead, for both.
//
// THE RULE IS A TERMINAL'S, NOT A PAGE'S. A plain click in a terminal selects
// or reaches the program; only Ctrl+click (Cmd+click on a Mac) follows a link,
// as in VS Code's terminal, iTerm2 and GNOME Terminal. A plain click that
// opened tabs would turn every click meant for Claude's prompt into a
// navigation. Hovering a link says so: its address and the gesture, in the
// pane's tooltip (linkHint).
//
// WHILE THE PROGRAM HAS THE MOUSE (Claude Code turns mouse reporting on) the
// link still opens here, and the press is kept from the program
// (keepsPressFromProgram). xterm reports the press to the program and still
// hands the release to the link; the stage used to leave such a link to the
// program, and a Ctrl+click on a merge request's address then opened nothing
// at all. Whatever a program does with a click happens on the deck's machine,
// not in the browser in front of the reader, and a Cmd+click reaches it as a
// plain click, since mouse reports carry no Cmd. Kept from it, the press opens
// one tab here and does nothing there. Every other press — a plain click, a
// drag, Shift or Option to select — goes where it went before.
//
// ONE PRESS, ONE TAB. xterm activates at most one link per release (the one
// under the pointer, an OSC 8 link before a plain URL over the same cells),
// and openLink also opens nothing a second time for the same press.
//
// THE ADDRESS, NOT THE SENTENCE AROUND IT. The web-links addon leaves out the
// ASCII punctuation a sentence puts after an address; URL_IN_OUTPUT is its
// rule with the typographic quotes and the CJK and full-width punctuation
// added, so `“https://…”` or `https://…。` opens the address and not a page
// with %E2%80%9D or %E3%80%82 on the end. None of them stands unencoded
// inside an address a program prints.
//
// ONLY THE WEB. http and https open in a new tab with no opener (the desktop
// app routes window.open to the system browser, desktop/main.mjs); file:,
// javascript:, data: and anything else open nothing.
import { t } from "./i18n";

/** A URL in the output: @xterm/addon-web-links' own rule, which also ends an
 *  address before quotes, brackets and the punctuation `,.:!?`, extended to
 *  “” ‘’ «» and the CJK and full-width brackets and punctuation. */
export const URL_IN_OUTPUT = /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\\^<>`“”‘’«»「」『』【】〈〉《》（）［］｛｝、。，．：；！？]*[^\s"':,.!?{}|\\\^~\[\]`()<>“”‘’«»「」『』【】〈〉《》（）［］｛｝、。，．：；！？]/;

/** The fields of a press the rule reads. */
export interface LinkPress {
  /** 0 for the primary button. */
  button: number;
  ctrlKey: boolean;
  metaKey: boolean;
}

/** The gesture that follows a link: the primary button with Ctrl, or with
 *  Cmd on a Mac, where Ctrl+click is the context menu. */
export function isLinkGesture(press: LinkPress, apple: boolean): boolean {
  return press.button === 0 && (apple ? press.metaKey : press.ctrlKey);
}

/** The URL a press on a link should open, or null for none. */
export function linkToOpen(press: LinkPress, uri: string, { apple }: { apple: boolean }): string | null {
  if (!isLinkGesture(press, apple)) return null;
  let url: URL;
  try { url = new URL(uri); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.href;
}

/** Whether a press is the link's alone, kept from the program: the gesture,
 *  on a link, while the program has the mouse. Without the mouse the program
 *  never sees a press, and xterm's selection keeps it as before. */
export function keepsPressFromProgram(press: LinkPress, { apple, overLink, programHasMouse }: { apple: boolean; overLink: boolean; programHasMouse: boolean }): boolean {
  return programHasMouse && overLink && isLinkGesture(press, apple);
}

/** What hovering a link shows: where it goes, and how to follow it. The
 *  Control key goes by its name in the reader's language (Strg in German). */
export function linkHint(uri: string, { apple }: { apple: boolean }): string {
  return `${uri}\n${t("board.stage.linkOpen", { key: apple ? "⌘" : t("board.stage.textKeyCtrl") })}`;
}

// The presses that have opened a tab, so one press never opens a second.
const opened = new WeakSet<object>();

/** Opens what linkToOpen allows, once per press. True when it opened one. */
export function openLink(press: LinkPress, uri: string, how: { apple: boolean }): boolean {
  if (opened.has(press)) return false;
  const url = linkToOpen(press, uri, how);
  if (!url) return false;
  opened.add(press);
  window.open(url, "_blank", "noopener,noreferrer");
  return true;
}
