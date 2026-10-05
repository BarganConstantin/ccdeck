// One read of the deck's server-side prefs answers four switches, and each
// hook is handed its part: auto-update to loadAutoRestartPrefs
// (use-auto-restart.ts), notifications to loadNotifyPrefs
// (use-os-notifications.ts), usage reports to loadReportsPrefs
// (use-reports.ts, #1853), and the git view to loadGitPrefs (git-pref.ts).
// Split, it would be four requests for one answer.
//
// Moved out of App.tsx unchanged, and called there where it was, once the
// hooks have handed their loaders over.
import { useEffect } from "react";
import type { useAutoRestart } from "./use-auto-restart";
import type { useOsNotifications } from "./use-os-notifications";
import type { useReports } from "./use-reports";
import { loadGitPrefs } from "./git-pref";

export function usePrefsRead({ loadAutoRestartPrefs, loadNotifyPrefs, loadReportsPrefs }: {
  loadAutoRestartPrefs: ReturnType<typeof useAutoRestart>["loadAutoRestartPrefs"];
  loadNotifyPrefs: ReturnType<typeof useOsNotifications>["loadNotifyPrefs"];
  loadReportsPrefs: ReturnType<typeof useReports>["loadReportsPrefs"];
}): void {
  useEffect(() => {
    let alive = true;
    fetch("/api/prefs").then(r => (r.ok ? r.json() : null)).then(d => {
      if (!alive || !d?.ok) return;
      loadAutoRestartPrefs(d);
      loadNotifyPrefs(d);
      loadReportsPrefs(d);
      loadGitPrefs(d);
    }).catch(() => {});
    return () => { alive = false; };
  }, []);
}
