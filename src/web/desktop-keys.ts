// The desktop app's half of the pane's keys (desktop/preload.cjs,
// installTerminalKeysIpc in desktop/main.mjs): while the pane has the keys,
// the app's menu stops taking Ctrl+R, Ctrl+W, Ctrl+C and the rest before the
// page sees them. In a browser there is no such bridge and this does nothing.

declare global {
  interface Window {
    ccdeckTerminal?: { keys(owned: boolean): Promise<unknown> | unknown };
  }
}

/** Tell the desktop app whether the pane has the keys. Never throws. */
export function tellDesktopKeys(owned: boolean): void {
  try {
    const answer = typeof window === "undefined" ? undefined : window.ccdeckTerminal?.keys(owned === true);
    void Promise.resolve(answer).catch(() => {});
  } catch {
    // An app older than the bridge, or none: the menu keeps its keys.
  }
}
