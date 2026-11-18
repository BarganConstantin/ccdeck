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
// navigation.
//
// WHILE THE PROGRAM HAS THE MOUSE (Claude Code's fullscreen view turns mouse
// reporting on), xterm has already sent the click to it, and Claude Code opens
// links itself on Ctrl+click there. Opening it here as well would open it
// twice, so the program keeps it.
//
// ONLY THE WEB. http and https open in a new tab with no opener (the desktop
// app routes window.open to the system browser, desktop/main.mjs); file:,
// javascript:, data: and anything else open nothing.

/** The fields of the click the rule reads. */
export interface LinkClick {
  ctrlKey: boolean;
  metaKey: boolean;
}

/** The URL a press on a link should open, or null for none. */
export function linkToOpen(click: LinkClick, uri: string, { apple, programHasMouse }: { apple: boolean; programHasMouse: boolean }): string | null {
  if (programHasMouse) return null;
  if (!(apple ? click.metaKey : click.ctrlKey)) return null;
  let url: URL;
  try { url = new URL(uri); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.href;
}

/** Opens what linkToOpen allows. */
export function openLink(click: LinkClick, uri: string, how: { apple: boolean; programHasMouse: boolean }): void {
  const url = linkToOpen(click, uri, how);
  if (url) window.open(url, "_blank", "noopener,noreferrer");
}
