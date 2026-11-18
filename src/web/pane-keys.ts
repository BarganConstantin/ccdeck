// Who holds the keys across the Workspace's panes (internal #102).
//
// Each pane says whether its terminal has the keyboard. The desktop app
// (desktop-keys.ts) and the quiet page (quiet-page.ts) hear one answer for all
// of them: held while any pane holds them. When the keys move from one pane to
// the next, the pane they left can say so after the pane they reached has, and
// its "no longer mine" must not hand the desktop app's shortcuts back while the
// other pane types. One pane says what it always said.
import { tellDesktopKeys } from "./desktop-keys";
import { QUIET_RESCAN_MS, quietPage } from "./quiet-page";

export interface PaneKeysDeps {
  tell(owned: boolean): void;
  quiet(on: boolean): void;
  /** Runs `run` every `ms` until the returned stop is called. */
  every(run: () => void, ms: number): () => void;
}

const realDeps: PaneKeysDeps = {
  tell: tellDesktopKeys,
  quiet: on => quietPage(on),
  every: (run, ms) => {
    const id = setInterval(run, ms);
    return () => clearInterval(id);
  },
};

const holders = new Set<object>();
let stopRescan: (() => void) | null = null;

/** Pane `pane` holds the keys, or no longer does (and on its way out). */
export function paneHoldsKeys(pane: object, held: boolean, deps: PaneKeysDeps = realDeps): void {
  const before = holders.size > 0;
  if (held) holders.add(pane);
  else holders.delete(pane);
  const now = holders.size > 0;
  deps.tell(now);
  if (now && !before) {
    // The rest of the page holds still while a pane types: its endless
    // animations kept every echo waiting a frame. Looked at again now and then
    // for a loop that started meanwhile.
    deps.quiet(true);
    stopRescan = deps.every(() => deps.quiet(true), QUIET_RESCAN_MS);
  } else if (!now && before) {
    stopRescan?.();
    stopRescan = null;
    deps.quiet(false);
  }
}

/** Tests: no pane holds the keys. */
export function resetPaneKeys(): void {
  holders.clear();
  stopRescan?.();
  stopRescan = null;
}
