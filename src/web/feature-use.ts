// Telling the deck which of its panels and dialogs this page showed today, for
// the usage reports' `features` (src/server/feature-use.mjs). A name and nothing
// else: never which account, which session or what was typed.
//
// Once per name per UTC day per tab, as a beacon: fire and forget, never
// awaited, and never mixed into the fetches a panel makes for its own work. A
// beacon the browser would not queue is forgotten here, so the next opening
// tries again; the server keeps each name once a day however often it hears it.
// The deck's gates read the beacon's Origin and Sec-Fetch-Site like any POST.
import { useEffect } from "react";

/** The page's half of the server's FEATURES (usage-day.mjs); the server drops
 *  any name not on its own list. */
export type PageFeature =
  | "usage-panel" | "machine-panel" | "detail-panel" | "accounts-panel"
  | "tool-detail" | "session-summary" | "context-window" | "usage-history" | "browser-watch"
  | "feedback" | "keyboard-help" | "share-accounts" | "account-projects" | "add-account"
  | "process-list" | "lan-setup" | "claude-fm";

const said = new Set<string>();
let saidDay = "";

/** Say that `name` was used, unless this tab already said so today. */
export function noteFeature(name: PageFeature): void {
  const day = new Date().toISOString().slice(0, 10);
  if (day !== saidDay) {
    said.clear();
    saidDay = day;
  }
  if (said.has(name)) return;
  said.add(name);
  try {
    const nav = typeof navigator === "undefined" ? undefined : navigator;
    if (!nav || typeof nav.sendBeacon !== "function" || !nav.sendBeacon("/api/feature", JSON.stringify({ name }))) {
      said.delete(name);
    }
  } catch {
    said.delete(name);
  }
}

const DAY_MS = 86_400_000;
/** How long after midnight UTC the new day's note waits: a page whose clock runs
 *  a little ahead of the deck's would otherwise say it while the deck is still
 *  on the day before, which already has it. */
const PAST_MIDNIGHT_MS = 60_000;

/** `noteFeature(name)` whenever `on` turns true — on mount, for a component that
 *  is only mounted while it is open — and again after every midnight UTC it is
 *  still true at. The reports keep a feature per UTC day, and a panel left open
 *  in a window nobody reloads is shown on each of those days, not only the one
 *  it opened on. */
export function useFeatureUse(name: PageFeature, on = true): void {
  useEffect(() => {
    if (!on) return;
    noteFeature(name);
    let timer: ReturnType<typeof setTimeout>;
    const atNextDay = () => {
      timer = setTimeout(() => {
        noteFeature(name);
        atNextDay();
      }, DAY_MS - (Date.now() % DAY_MS) + PAST_MIDNIGHT_MS);
    };
    atNextDay();
    return () => clearTimeout(timer);
  }, [name, on]);
}
