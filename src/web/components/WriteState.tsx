import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { useWaitingLoader } from "../use-waiting-loader";
import { Loader } from "./Loader";

/** Where a write stands, as a row says it. */
export type WriteStateKind = "idle" | "saving" | "saved" | "failed" | "uncertain";

/** How long "Saved" stands before it fades (V4's motion rules). */
export const SAVED_STANDS_MS = 1_500;

/** The short word a row shows for a write: Saving beside the Loader (after the
 *  Loader's own 150 ms wait), Saved crossfading in and fading out after 1.5 s,
 *  Failed and Uncertain crossfading in and staying. `sentence` is the full line
 *  a screen reader gets for Failed or Uncertain; the visible word is short. */
export function WriteState({ state, sentence, role = "status" }: { state: WriteStateKind; sentence?: string; role?: "status" | "alert" }) {
  const t = useT();
  const wait = useWaitingLoader(state === "saving");
  const [gone, setGone] = useState(false);
  useEffect(() => {
    setGone(false);
    if (state !== "saved") return;
    const id = setTimeout(() => setGone(true), SAVED_STANDS_MS);
    return () => clearTimeout(id);
  }, [state]);
  const word = state === "saving" ? t("settings.write.saving")
    : state === "saved" ? t("settings.write.saved")
    : state === "failed" ? t("settings.write.failed")
    : state === "uncertain" ? t("settings.write.uncertain") : "";
  const quiet = state === "idle" || (state === "saving" && !wait.draw);
  return (
    <span className="wstate" role={role} data-state={state} data-gone={gone || undefined} data-quiet={quiet || undefined}>
      {/* keyed on the state, so a change of state is a new element that fades in */}
      <span className="wstate-word" key={state}>
        {state === "saving" && <Loader timed leaving={wait.leaving} idle={!wait.draw} />}
        {word}
      </span>
      {sentence && (state === "failed" || state === "uncertain") && <span className="vis-hidden">{` ${sentence}`}</span>}
    </span>
  );
}
