// The desktop app's folder dialog, for the New session picker's "Choose
// another folder…" (internal #106; desktop/preload.cjs, installFolderPickerIpc
// in desktop/main.mjs). The system's own dialog: the page names no folder and
// reads none, it only hears which one the person chose. In a browser there is
// no such bridge, and the picker asks for the folder's full path instead — a
// browser's folder upload is files, never a path on the deck's machine.

declare global {
  interface Window {
    ccdeckFolder?: { choose(): Promise<unknown> | unknown };
  }
}

/** Whether this page runs in the desktop app, with its folder dialog. */
export function canChooseFolder(): boolean {
  try {
    return typeof window !== "undefined" && typeof window.ccdeckFolder?.choose === "function";
  } catch {
    return false;
  }
}

/**
 * The folder the person chose in the app's dialog: its path, null when they
 * closed it without one, undefined when there is no dialog to ask (a browser,
 * an app older than the bridge, or one that failed). Never throws.
 */
export async function chooseFolder(): Promise<string | null | undefined> {
  if (!canChooseFolder()) return undefined;
  try {
    const got = await window.ccdeckFolder!.choose();
    return typeof got === "string" && got ? got : null;
  } catch {
    return undefined;
  }
}
