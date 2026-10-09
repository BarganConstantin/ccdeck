// What's new's actions: Take the tour, Check for updates and Restart, as one
// strip of small buttons under the line that says which release this is, and
// the one line under them where an update check answers.
//
// They were full-width rows, each a sentence and a button, and three of them
// stood between the reader and the notes the dialog is for. The sentences now
// live in each button's hint, and in its description for a screen reader, so
// nothing they said is lost. Restart sits apart at the end: it is the one that
// takes the deck down, if only for a moment.
//
// The update line is a live region and is always there, one small line tall,
// so an answer arriving moves nothing above it. What it says, and which of the
// update banner's actions it offers on this install, is update-check.ts's.
import { useEffect, useId, useRef, useState } from "react";

import { desktopAppVersion, trayMenuName } from "../desktop-update";
import { inDesktopApp } from "../in-app";
import { selfPressAccepted } from "../panel-press";
import { CHECK_LABEL, CHECK_WHY, runDesktopUpdateCheck, runUpdateCheck, updateCheckState, type UpdateLine, type UpdateLineAction } from "../update-check";
import type { useAutoRestart } from "../use-auto-restart";
import type { useDeckUpgrade } from "../use-deck-upgrade";
import type { useDesktopUpdate } from "../use-desktop-update";
import { useNow } from "../use-now";
import type { useVersionCheck } from "../use-version-check";
import { RestartGlyph, TourGlyph, UpdateCheckGlyph } from "./rail-glyphs";
import { useHint } from "./use-hint";
import { UPGRADE_BLOCK_TEXT } from "./VersionBanner";

export const TOUR_WHY = "Eight pictures of what the deck shows.";
export const RESTART_WHY = "Restart the deck. Sessions, settings and pairings come back as they were.";

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
function useUpdateCheck(wiring: UpdateCheckWiring | undefined) {
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
  const state = updateCheckState({
    version: versionCheck.version, running, checking: pressing || versionChecking, answered, unreachable, now,
    upgradeState: upgrade.upgradeState, copied: upgrade.cmdCopied, restarting: restart.restarting,
    app: { inApp: inDesktopApp(), update: desktopUpdate.appUpdate, version: desktopAppVersion(), menu: trayMenuName() },
  }, UPGRADE_BLOCK_TEXT);
  if (!state) return null;

  const nativeCheck = inDesktopApp() && versionCheck.version?.checkDisabled;
  const checkWhy = nativeCheck ? "Ask the desktop app whether a newer ccdeck is out." : CHECK_WHY;
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
  return { state, check, act, checkWhy };
}

export default function ReleaseActions({ onTour, onRestart, updateCheck }: {
  onTour?: () => void;
  onRestart?: () => void;
  updateCheck?: UpdateCheckWiring;
}) {
  // Above the strip, never below it: under it is the line a press answers on,
  // and a hint left up by a keyboard press would sit over the answer.
  const hint = useHint("above", "dialog");
  const update = useUpdateCheck(updateCheck);
  const id = useId();
  const canCheck = update?.state.canCheck ?? false;
  // Restart stands down while the line offers an update. Both of those
  // restart too, and two restarts side by side, only one of which updates, is
  // a guess nobody should have to make — the reason the app's ready update
  // takes Restart's place at the top of the dialog.
  const updates = update?.state.line.action?.kind === "install" || update?.state.line.action?.kind === "npx";
  const restartDoor = updates ? undefined : onRestart;
  if (!onTour && !canCheck && !restartDoor && !update) return null;
  return (
    <div className="rn-actions">
      {(onTour || canCheck || restartDoor) && (
        <div className="rn-acts">
          {onTour && (
            <button type="button" className="btn rn-act" onClick={onTour}
              aria-describedby={`${id}-tour`} {...hint.bind({ label: TOUR_WHY })}>
              <TourGlyph />Take the tour
            </button>
          )}
          {update && canCheck && (
            <button type="button" className="btn rn-act" onClick={() => void update.check()}
              aria-busy={update.state.checking || undefined}
              aria-describedby={`${id}-check`} {...hint.bind({ label: update.checkWhy })}>
              <UpdateCheckGlyph />{CHECK_LABEL}
            </button>
          )}
          {restartDoor && (
            <button type="button" className="btn rn-act rn-act-restart" onClick={restartDoor}
              aria-describedby={`${id}-restart`} {...hint.bind({ label: RESTART_WHY })}>
              <RestartGlyph />Restart
            </button>
          )}
        </div>
      )}
      {update && <UpdateLineView line={update.state.line} onAct={update.act} bindHint={hint.bind} whyId={`${id}-act`} />}
      {/* What each hint says, for a reader who never sees a hint. */}
      <span hidden id={`${id}-tour`}>{TOUR_WHY}</span>
      <span hidden id={`${id}-check`}>{update?.checkWhy ?? CHECK_WHY}</span>
      <span hidden id={`${id}-restart`}>{RESTART_WHY}</span>
      {hint.node}
    </div>
  );
}

type BindHint = ReturnType<typeof useHint>["bind"];

/** The line under the actions, from its state alone. Its words are a polite
 *  live region, mounted empty with the dialog so an answer is news rather
 *  than part of the opening. When it was had sits outside that region: read
 *  where it stands, never read out as a minute goes by. */
export function UpdateLineView({ line, onAct, bindHint, whyId }: {
  line: UpdateLine;
  onAct: (action: UpdateLineAction) => void;
  bindHint?: BindHint;
  /** The id the update action's sentence is drawn under, for its description. */
  whyId?: string;
}) {
  const { action } = line;
  const act = action && <LineAction action={action} onAct={onAct} bindHint={bindHint} whyId={whyId} />;
  return (
    <p className="rn-update-line" data-tone={line.tone}>
      <span className="rn-update-what" role="status">{line.said}</span>
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
