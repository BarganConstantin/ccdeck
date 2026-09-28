// The auto-switch policy's row in the accounts panel.
//
// Lifted out of AccountsPanel.tsx unchanged. The panel draws the policy from
// two places — inside the fold, or under a roster with nothing to fold — and it
// was already one value there for that reason; this is what the value renders.
// The draft the picker proposes, the `saved` after a store, and the two
// elements focus moves between stay in the panel and are handed in, because
// the row unmounts whenever the fold is shut and a pick nobody saved must
// outlive that.
import { type Ref } from "react";

import { thresholdChoices } from "../auto-switch-threshold";
import { type AutoStatus } from "../claude-accounts";
import { type PickerCommit } from "../picker-commit";
import { type useRequestSlot } from "../use-request-slot";

interface Props {
  auto: AutoStatus;
  /** Where auto-switch trips, as the store holds it. */
  threshold: string;
  /** What the picker is showing, which is a proposal until it is saved. */
  thresholdPick: string;
  thresholdCtl: PickerCommit;
  thresholdSaved: boolean;
  thresholdRef: Ref<HTMLSelectElement>;
  thresholdSaveRef: Ref<HTMLButtonElement>;
  proposeThreshold: (pick: string) => void;
  doThreshold: (pick: string, commit: PickerCommit) => void;
  pressProps: ReturnType<typeof useRequestSlot>["pressProps"];
  post: (body: Record<string, unknown>, tag: string) => Promise<unknown>;
  load: (force?: boolean) => Promise<void>;
}

/**
 * ONE POLICY, ONE ROW: its name, where it trips, and whether it is armed. The
 * live percentage it used to print beside the threshold is the active row's
 * own number, one glance up, and the clock of its last check under a rule was
 * diagnostics — the switch being on is the state, and a terminal loop taking
 * over is the one thing still said under it.
 */
export default function AutoSwitchPolicy({
  auto, threshold, thresholdPick, thresholdCtl, thresholdSaved, thresholdRef, thresholdSaveRef,
  proposeThreshold, doThreshold, pressProps, post, load,
}: Props) {
  return (
    <div className="ap-policy-block">
      <div className="ap-policy">
        {/* A real h3, under the panel header's h2: a reader walking headings
            should find the policy. It says what the switch's name says
            (#546), so what is heard and what a voice-control user has to
            pronounce are the words on the screen. */}
        <h3 className="ap-auto-title">Auto-switch</h3>
        {/* The picker proposes and `save` stores (#516): a select fires
            `change` on a keystroke, and one letter used to write a setting.
            A value set from the terminal that is not one of the five is kept
            as an option of its own, so the picker never shows a number the
            store does not hold. */}
        <span className="ap-field" title="Switch once the active account passes this much of its limit">
          <select
            ref={thresholdRef}
            aria-label="Switch threshold"
            value={thresholdPick}
            {...pressProps("threshold")}
            onChange={e => proposeThreshold(e.target.value)}
          >
            {thresholdChoices(threshold).map(t => <option key={t} value={t}>{t}%</option>)}
          </select>
        </span>
        {/* ONLY WHILE THERE IS SOMETHING TO SAVE, after the picker so that
            arriving moves nothing the reader just pressed. `saved` only
            while the pick is the stored one. */}
        {(thresholdCtl.sends || thresholdSaved) && (
          <button ref={thresholdSaveRef} type="button" className="ap-manage-btn" {...pressProps("threshold")}
            title={thresholdCtl.title}
            onClick={() => doThreshold(thresholdPick, thresholdCtl)}
          >{thresholdSaved && !thresholdCtl.sends ? thresholdCtl.done : thresholdCtl.label}</button>
        )}
        {/* Always a control, never a read-out: a terminal loop's state is
            said beside it, not instead of it. Named in aria-label because
            the contents cannot carry it (#546). */}
        <button
          type="button"
          className="switch ap-auto-state"
          role="switch"
          aria-checked={auto.enabled}
          aria-label="Auto-switch"
          {...pressProps("enable")}
          onClick={() => post({ action: "enable", enabled: !auto.enabled }, "enable").then(() => load(true))}
          title={auto.enabled
            ? "Stop switching accounts automatically"
            : "Switch accounts automatically when the active one nears its limit"}
        >
          <span className="switch-knob" />
        </button>
      </div>

      {/* Which engine is actually switching right now. The deck stands down
          while a terminal loop runs, and says so. */}
      {auto.external && (
        <p className="ap-auto-note">
          <i className="ap-pulse" aria-hidden /> A <code>cswap auto</code> loop in your terminal is
          doing the switching. The deck stands down while it runs
          {auto.enabled ? " — this toggle takes over when you stop it." : "."}
        </p>
      )}
    </div>
  );
}
