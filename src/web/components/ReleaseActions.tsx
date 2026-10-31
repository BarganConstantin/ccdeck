// Update checks and their authenticated lifecycle handoff, shared by the reading sheet.
// The modal owns placement; the existing version, upgrade and restart hooks own actions.
import { useEffect, useId, useRef, useState } from "react";

import { desktopAppVersion, trayMenuName } from "../desktop-update";
import { inDesktopApp } from "../in-app";
import { selfPressAccepted } from "../panel-press";
import { checkWhy as checkWhyText, runDesktopUpdateCheck, runUpdateCheck, updateCheckState, type UpdateLine, type UpdateLineAction } from "../update-check";
import type { useAutoRestart } from "../use-auto-restart";
import type { useDeckUpgrade } from "../use-deck-upgrade";
import type { useDesktopUpdate } from "../use-desktop-update";
import { useNow } from "../use-now";
import type { useVersionCheck } from "../use-version-check";
import { useLanguage, t } from "../i18n";
import { useHint } from "./use-hint";
import { UPGRADE_BLOCK_TEXT } from "./VersionBanner";

/** The English line, for About (settings), which reads it as a constant; tourWhy() is the translated one. */
export const TOUR_WHY = "Eight pictures of what the deck shows.";
export const tourWhy = (): string => t("shell.notes.tourWhy");
export const restartWhy = (): string => t("shell.notes.restartWhy");

/** Everything the update check needs from the deck: the chip's check, the
 *  banner's install and copy, the restart npx's update is, and the app's
 *  updater. */
export interface UpdateCheckWiring {
  versionCheck: ReturnType<typeof useVersionCheck>;
  upgrade: ReturnType<typeof useDeckUpgrade>;
  restart: ReturnType<typeof useAutoRestart>;
  desktopUpdate: ReturnType<typeof useDesktopUpdate>;
  /** The version the chip wears. */
  running: string;
  /** Close the dialog: an install or an npx update is followed in the banner,
   *  the way Restart hands its restart over. */
  onHandOff: () => void;
}

/** The check's state for this dialog, and its two kinds of press. Null where
 *  there is nothing to say: no wiring, or the app's own update is ready. */
export function useReleaseUpdateCheck(wiring: UpdateCheckWiring | undefined) {
  useLanguage(); // the update lines are worded by helpers that read the language on show
  const versionChecking = wiring?.versionCheck.versionChecking ?? false;
  const now = useNow(30_000);
  const [pressing, setPressing] = useState(false);
  const pressingRef = useRef(false);
  const [unreachable, setUnreachable] = useState(false);
  // A check that answers while the dialog is up is one somebody asked for: the
  // chip starts one as it opens this dialog, and the button the rest.
  const [answered, setAnswered] = useState(false);
  const wasCheckingRef = useRef(versionChecking);
  useEffect(() => {
    if (wasCheckingRef.current && !versionChecking) setAnswered(true);
    wasCheckingRef.current = versionChecking;
  }, [versionChecking]);
  if (!wiring) return null;

  const { versionCheck, upgrade, restart, desktopUpdate, running, onHandOff } = wiring;
  // A new response may arrive before the 30-second display ticker advances.
  const state = updateCheckState({
    version: versionCheck.version, running, checking: pressing || versionChecking, answered, unreachable, now: Math.max(now, Date.now()),
    upgradeState: upgrade.upgradeState, copied: upgrade.cmdCopied, restarting: restart.restarting,
    app: { inApp: inDesktopApp(), update: desktopUpdate.appUpdate, version: desktopAppVersion(), menu: trayMenuName() },
  }, UPGRADE_BLOCK_TEXT);
  if (!state) return null;

  const nativeCheck = inDesktopApp() && versionCheck.version?.checkDisabled;
  const checkWhy = nativeCheck ? t("shell.update.checkWhyApp") : checkWhyText();
  const check = async () => {
    // Busy, never disabled (#620): a second press meets this ref, and one
    // made while the chip's check is out joins that check instead.
    if (!selfPressAccepted(pressingRef.current || versionChecking)) return;
    if (nativeCheck && desktopUpdate.appUpdate?.status === "checking") return;
    pressingRef.current = true;
    setPressing(true);
    const result = nativeCheck
      ? await runDesktopUpdateCheck()
      : await runUpdateCheck(versionCheck.loadVersion);
    pressingRef.current = false;
    setPressing(false);
    setUnreachable(result === "unreachable");
    setAnswered(true);
  };
  const act = (action: UpdateLineAction) => {
    if (action.kind === "copy") return void upgrade.copyCommand();
    onHandOff();
    versionCheck.showNotice();
    if (action.kind === "install") void upgrade.startUpgrade();
    else void restart.askRestart({ upgrade: true });
  };
  // Routine checks belong to the menu/live region, without shifting the digest.
  const needsAttention = state.line.tone === "warn" || !!state.line.action
    || !!versionCheck.version?.notice || desktopUpdate.appUpdate?.status === "downloading";
  return { state, check, act, checkWhy, needsAttention };
}

/** Update state and the existing check action, without competing navigation buttons. */
export default function ReleaseActions({ update }: {
  update: ReturnType<typeof useReleaseUpdateCheck>;
}) {
  const hint = useHint("above", "dialog");
  const id = useId();
  useLanguage();
  return <div className="rn-status-row">
    {update ? <UpdateLineView line={update.state.line} onAct={update.act} bindHint={hint.bind} whyId={`${id}-action`} announce={false} />
      : <p className="rn-update-line"><span role="status">{t("shell.notes.statusUnavailable")}</span></p>}
    {hint.node}
  </div>;
}

type BindHint = ReturnType<typeof useHint>["bind"];

/** The line under the actions, from its state alone. Its words are a polite
 *  live region, mounted empty with the dialog so an answer is news rather
 *  than part of the opening. When it was had sits outside that region: read
 *  where it stands, never read out as a minute goes by. */
export function UpdateLineView({ line, onAct, bindHint, whyId, announce = true }: {
  line: UpdateLine;
  announce?: boolean;
  onAct: (action: UpdateLineAction) => void;
  bindHint?: BindHint;
  /** The id the update action's sentence is drawn under, for its description. */
  whyId?: string;
}) {
  const { action } = line;
  const act = action && <LineAction action={action} onAct={onAct} bindHint={bindHint} whyId={whyId} />;
  return (
    <p className="rn-update-line" data-tone={line.tone}>
      <span className="rn-update-what" role={announce ? "status" : undefined}>{line.said}</span>
      {line.age && <span className="rn-update-age">{line.age}</span>}
      {line.command ? (
        // The command and its Copy wrap as one, so Copy never lands alone on
        // a line away from what it copies.
        <span className="rn-update-cmd">
          <code className="rn-code">{line.command}</code>
          {act}
        </span>
      ) : act}
    </p>
  );
}

/** The banner's action. The two that update are the line's primary, with the
 *  banner's sentence for what they do as their hint and description: a press
 *  closes this dialog, and the deck restarts at the end of it. */
function LineAction({ action, onAct, bindHint, whyId }: {
  action: UpdateLineAction;
  onAct: (action: UpdateLineAction) => void;
  bindHint?: BindHint;
  whyId?: string;
}) {
  const why = action.kind === "copy" ? null : action.why;
  return (
    <>
      <button type="button" className={why ? "btn primary rn-line-act" : "btn rn-line-act"} onClick={() => onAct(action)}
        aria-busy={action.busy || undefined} aria-describedby={why && whyId ? whyId : undefined}
        {...(why && bindHint ? bindHint({ label: why }) : {})}>
        {action.label}
      </button>
      {why && whyId && <span hidden id={whyId}>{why}</span>}
    </>
  );
}
