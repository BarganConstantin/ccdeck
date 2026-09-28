// Saying, once per old name, that this deck was started under one of the npm
// names it used to have.
//
// Three npm names reach this same deck, every surface it draws says ccdeck,
// and the name most people type is one of the other two. So it is said here
// once per old name — in the shape of the version banner, never as an error.
// Nothing is broken and nothing is being taken away, and a red alarm over a
// name preference would be a lie about severity.
//
// The server reports `invokedAs` only where it can prove what was typed, so
// this stays silent for a global install on Windows and for a git checkout
// instead of guessing at either. Seeing this over a deck you started as
// `ccdeck` is the one failure that would make it worth ignoring.
//
// Lifted out of App.tsx's `Inner`, where its banner comment also sat on top of
// the upgrade flow, the command copy and the side panels — none of which it
// describes. The dismissal and the key it is remembered under are private now.
import { useCallback, useState } from "react";

import { PRODUCT } from "./brand";
import type { VersionInfo } from "./use-version-check";

// Which old command the name notice has already been dismissed for — the name
// itself, not a boolean. Somebody who dismisses it under `agent-dag` and later
// starts the deck as `agents-deck` is a second install that has not heard this
// yet, and a flag would silence it. In the agent-dag.* namespace like every
// other key here; brand.ts explains why the rename stops at the storage layer.
const OLD_NAME_DISMISSED_KEY = "agent-dag.oldNameNoticeDismissed";

export interface OldNameNotice {
  /** The old name the deck was started under, or null — including whenever the
   *  server cannot prove what was typed. */
  oldName: string | null;
  oldNameOpen: boolean;
  dismissOldName: () => void;
}

export function useOldNameNotice(version: VersionInfo | null): OldNameNotice {
  const [oldNameDismissed, setOldNameDismissed] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    try { return window.localStorage.getItem(OLD_NAME_DISMISSED_KEY) ?? ""; } catch { return ""; }
  });
  // PRODUCT is both halves of the comparison on purpose: the name the deck
  // calls itself and the command we ask people to type are the same string
  // since the rename (#324), and display-name.test.ts is what holds them there.
  const oldName = version?.invokedAs && version.invokedAs !== PRODUCT ? version.invokedAs : null;
  const oldNameOpen = oldName != null && oldNameDismissed !== oldName;
  const dismissOldName = useCallback(() => {
    if (!oldName) return;
    setOldNameDismissed(oldName);
    try { window.localStorage.setItem(OLD_NAME_DISMISSED_KEY, oldName); } catch { /* private mode */ }
  }, [oldName]);

  return { oldName, oldNameOpen, dismissOldName };
}
