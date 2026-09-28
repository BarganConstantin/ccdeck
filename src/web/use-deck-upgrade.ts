// Upgrading the deck from its banner: the press, the faster poll while npm runs,
// and copying the command for anyone who would rather type it.
//
// Lifted out of App.tsx's `Inner`. It takes the version check's answer and its
// loader, and owns everything about acting on them.
//
// `cmdCopied` moved here from use-version-check.ts on the way, because its only
// writer was ever `copyCommand`. It had been declared beside the version state
// and exported from there purely so that one callback, sitting in `Inner`, could
// flip it — which is state living one hook away from the only thing that uses it.
// Its setter and the press's in-flight ref are private now.
import { useCallback, useEffect, useRef, useState } from "react";

import { copyText } from "./copy-text";
import { selfPressAccepted } from "./panel-press";
import { upgradeFailureId } from "./restart";
import type { VersionCheck, VersionInfo } from "./use-version-check";

export interface DeckUpgradeDeps {
  version: VersionInfo | null;
  loadVersion: VersionCheck["loadVersion"];
}

export function useDeckUpgrade({ version, loadVersion }: DeckUpgradeDeps) {
  const [cmdCopied, setCmdCopied] = useState(false);
  // Installing runs on the server and reports back through /api/version, so the
  // only thing the click owns is starting it and polling a little faster while
  // it runs — an npm install is a minute, not five.
  const upgradeState = version?.upgrade?.state ?? "idle";
  // A string, not the object, so an effect can key off it: /api/version answers
  // with a fresh object every poll, and only its identity would ever change.
  const upgradeFailure = upgradeFailureId(version?.upgrade);
  // The press's own in-flight flag, and the only one this button has: `running`
  // is the SERVER's answer and does not arrive until the next /api/version, so
  // between the click and that poll there is nothing else saying a run started.
  // Released once the poll has been asked for — from then on `upgradeState`
  // carries the fact, and a POST that changed nothing leaves the button usable
  // rather than locked out for the life of the page.
  const upgradeAskedRef = useRef(false);
  const startUpgrade = useCallback(async () => {
    if (!selfPressAccepted(upgradeAskedRef.current || upgradeState === "running")) return;
    upgradeAskedRef.current = true;
    try { await fetch("/api/upgrade", { method: "POST" }); } catch { /* reported via /api/version */ }
    await loadVersion();
    upgradeAskedRef.current = false;
  }, [upgradeState, loadVersion]);
  useEffect(() => {
    if (upgradeState !== "running") return;
    const iv = window.setInterval(loadVersion, 3000);
    return () => window.clearInterval(iv);
  }, [upgradeState, loadVersion]);

  const copyCommand = useCallback(async () => {
    const cmd = version?.command;
    if (!cmd) return;
    // The ladder — secure-context clipboard raced against a timer, then the
    // selection trick — moved to copy-text.ts when the Browser Watch killswitch
    // became the second caller showing the user a command to paste.
    const ok = await copyText(cmd);
    if (!ok) return; // the command stays on screen and selectable
    setCmdCopied(true);
    window.setTimeout(() => setCmdCopied(false), 1600);
  }, [version?.command]);

  return { upgradeState, upgradeFailure, startUpgrade, copyCommand, cmdCopied };
}
