// One read of the deck's server-side prefs answers two switches, and each hook
// is handed its half: auto-update to loadAutoRestartPrefs (use-auto-restart.ts),
// notifications to loadNotifyPrefs (use-os-notifications.ts). Split, it would be
// two requests for one answer.
//
// Moved out of App.tsx unchanged, and called there where it was, once both
// hooks have handed their halves over.
import { useEffect } from "react";
import type { useAutoRestart } from "./use-auto-restart";
import type { useOsNotifications } from "./use-os-notifications";

export function usePrefsRead({ loadAutoRestartPrefs, loadNotifyPrefs }: {
  loadAutoRestartPrefs: ReturnType<typeof useAutoRestart>["loadAutoRestartPrefs"];
  loadNotifyPrefs: ReturnType<typeof useOsNotifications>["loadNotifyPrefs"];
}): void {
  useEffect(() => {
    let alive = true;
    fetch("/api/prefs").then(r => (r.ok ? r.json() : null)).then(d => {
      if (!alive || !d?.ok) return;
      loadAutoRestartPrefs(d);
      loadNotifyPrefs(d);
    }).catch(() => {});
    return () => { alive = false; };
  }, []);
}
