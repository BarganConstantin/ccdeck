// The keys a browser tab keeps from the pane, and the two answers to that.
//
// IN A TAB, Chrome, Edge and Firefox on Windows and Linux take Ctrl+W, Ctrl+T
// and Ctrl+N for themselves before the page sees them — the "reserved"
// shortcuts, there so a page cannot trap anyone in it. Ctrl+W is also readline's
// delete-a-word, the one a reader of a terminal reaches for most, and in a tab
// it closes the deck. The desktop app has no such shortcuts while the pane has
// the keys (desktop-keys.ts); a tab needs these two.
//
// THE GUARD (leave-guard.ts) asks before the page goes while the pane has the
// keys, and a leave called off is answered with the sentence below: how to
// give those keys to the session.
//
// FULL SCREEN. In full screen Chromium reserves only its exit key and F11, and
// passes every other shortcut to the page (IsReservedCommandOrKey in
// browser_command_controller.cc), so Ctrl+W reaches the session. Esc, which
// the TUI needs, would still end full screen — unless it is locked with the
// Keyboard Lock API, which then asks for Esc to be held (1.5 s) to leave.
// Offered only where both exist and help: Chromium (Firefox and Safari have
// no keyboard lock, so Esc would throw the reader out on every press), not
// macOS (Chrome there reserves no Ctrl shortcut a terminal uses; ⌘W closing
// the tab is the Mac's own grammar), not Android, and not the desktop app.
import { inDesktopApp } from "./in-app";
import { isApplePlatform, platformName } from "./platform";

interface KeyboardLock {
  lock(codes?: string[]): Promise<void>;
  unlock(): void;
}

const keyboard = (): Partial<KeyboardLock> | undefined =>
  typeof navigator === "undefined" ? undefined : (navigator as Navigator & { keyboard?: Partial<KeyboardLock> }).keyboard;

/** Said in the keys bar after a leave the reader called off. */
export const KEPT_KEYS_FULL = "The browser keeps Ctrl+W, Ctrl+T and Ctrl+N in a tab — ⤢ full screen gives them to the session.";
export const KEPT_KEYS_APP = "The browser keeps Ctrl+W, Ctrl+T and Ctrl+N in a tab — the desktop app gives them to the session.";

/** Whether ⤢ here means full screen, the browser's shortcuts the session's. */
export function canFullStage(platform: string = platformName(), ua?: string): boolean {
  if (typeof document === "undefined" || inDesktopApp(ua) || isApplePlatform(platform)) return false;
  const agent = ua ?? (typeof navigator === "undefined" ? "" : navigator.userAgent);
  if (/android/i.test(platform) || /\bAndroid\b/.test(agent)) return false;
  return document.fullscreenEnabled === true && typeof keyboard()?.lock === "function";
}

/** What to say after a called-off leave, or null where there is nothing to
 *  add: on a Mac the shortcut was the Mac's own, and in full screen the
 *  browser already keeps none of them. */
export function keptKeysNotice(canFull: boolean, platform: string = platformName()): string | null {
  if (isApplePlatform(platform)) return null;
  if (typeof document !== "undefined" && document.fullscreenElement) return null;
  return canFull ? KEPT_KEYS_FULL : KEPT_KEYS_APP;
}

/** The whole deck in full screen, and Esc asked for the pane. False when
 *  the browser said no — the stage is then only as wide as it goes. */
export async function enterFullStage(): Promise<boolean> {
  try {
    await document.documentElement.requestFullscreen({ navigationUI: "hide" });
  } catch {
    return false;
  }
  // Asked, never awaited: where Chrome puts the lock behind a permission
  // prompt (an experiment some builds run), the answer may never come, and
  // full screen already hands over Ctrl+W without it — Esc then ends it.
  try { void keyboard()?.lock?.(["Escape"])?.catch(() => {}); } catch { /* no lock: Esc leaves */ }
  return true;
}

/** Out of full screen, if the page is in it. Never throws. */
export function leaveFullStage(): void {
  try { keyboard()?.unlock?.(); } catch { /* nothing locked */ }
  if (typeof document === "undefined" || !document.fullscreenElement) return;
  document.exitFullscreen().catch(() => {});
}
