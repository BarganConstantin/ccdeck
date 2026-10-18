// One read of the deck's server-side prefs answers three switches, and each
// hook is handed its part: auto-update to loadAutoRestartPrefs
// (use-auto-restart.ts), notifications to loadNotifyPrefs
// (use-os-notifications.ts), and usage reports to loadReportsPrefs
// (use-reports.ts, #1853). Split, it would be three requests for one answer.
// The terminal flag rides the same answer (`terminalOn`, prefs-routes.mjs) to
// use-stage.ts, so knowing whether the terminal is on costs no request either.
//
// Moved out of App.tsx unchanged, and called there where it was, once the
// hooks have handed their loaders over.
import { useEffect } from "react";
import type { useAutoRestart } from "./use-auto-restart";
import type { useOsNotifications } from "./use-os-notifications";
import type { useReports } from "./use-reports";
import type { TerminalPrefsAnswer } from "./use-stage";

export function usePrefsRead({ loadAutoRestartPrefs, loadNotifyPrefs, loadReportsPrefs, loadTerminalPrefs }: {
  loadAutoRestartPrefs: ReturnType<typeof useAutoRestart>["loadAutoRestartPrefs"];
  loadNotifyPrefs: ReturnType<typeof useOsNotifications>["loadNotifyPrefs"];
  loadReportsPrefs: ReturnType<typeof useReports>["loadReportsPrefs"];
  loadTerminalPrefs?: (d: TerminalPrefsAnswer) => void;
}): void {
  useEffect(() => {
    let alive = true;
    fetch("/api/prefs").then(r => (r.ok ? r.json() : null)).then(d => {
      if (!alive || !d?.ok) return;
      loadAutoRestartPrefs(d);
      loadNotifyPrefs(d);
      loadReportsPrefs(d);
      loadTerminalPrefs?.(d);
    }).catch(() => {});
    return () => { alive = false; };
  }, []);
}
