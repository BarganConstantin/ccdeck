// The auto-switch policy's row in the accounts panel.
//
// Lifted out of AccountsPanel.tsx unchanged. The panel draws the policy from
// two places — inside the fold, or under a roster with nothing to fold — and it
// was already one value there for that reason; this is what the value renders.
// The draft the picker proposes, the `saved` after a store, and the two
// elements focus moves between stay in the panel and are handed in, because
// the row unmounts whenever the fold is shut and a pick nobody saved must
// outlive that.
import { type KeyboardEvent, type Ref, useId } from "react";

import { CUSTOM_HINT, CUSTOM_PICK, thresholdChoices } from "../auto-switch-threshold";
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
  /** Whether the custom field stands in for the picker. */
  thresholdCustom: boolean;
  /** Why the field's last commit was refused, or null. */
  thresholdRefusal: string | null;
  thresholdFieldRef: Ref<HTMLInputElement>;
  proposeThreshold: (pick: string) => void;
  typeThreshold: (text: string) => void;
  cancelThreshold: (e: KeyboardEvent) => void;
  leaveThreshold: () => void;
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
  thresholdCustom, thresholdRefusal, thresholdFieldRef,
  proposeThreshold, typeThreshold, cancelThreshold, leaveThreshold, doThreshold, pressProps, post, load,
}: Props) {
  const noteId = useId();
  return (
    <div className="ap-policy-block">
      {/* Escape is the row's while the field is open, so it reaches the field
          and the `save` beside it alike. */}
      <div className="ap-policy" onKeyDown={thresholdCustom ? cancelThreshold : undefined}>
        {/* A real h3, under the panel header's h2: a reader walking headings
            should find the policy. It says what the switch's name says
            (#546), so what is heard and what a voice-control user has to
            pronounce are the words on the screen. */}
        <h3 className="ap-auto-title">Auto-switch</h3>
        {/* The picker proposes and `save` stores (#516): a select fires
            `change` on a keystroke, and one letter used to write a setting.
            A value set from the terminal or the custom field that is not one
            of the five is kept as an option of its own, so the picker never
            shows a number the store does not hold, and `Custom…` stays last
            to change it again. */}
        {thresholdCustom ? (
          /* `Custom…` puts a field in the picker's place, the same size, its
             unit where the chevron was. A form, so Enter is `save` and never
             fires mid-composition; the press is doThreshold either way, so
             there is one path to the store. Named as the picker is, since it
             is the same setting and a voice-control user says the same words. */
          <form className="ap-threshold-form" noValidate
            onSubmit={e => { e.preventDefault(); doThreshold(thresholdPick, thresholdCtl); }}
          >
            <span className="ap-threshold-field" title="Switch once the active account passes this much of its limit">
              <input
                ref={thresholdFieldRef}
                className="ap-manage-input ap-threshold-input"
                type="text"
                inputMode="numeric"
                aria-label="Switch threshold"
                aria-describedby={noteId}
                aria-invalid={thresholdRefusal ? true : undefined}
                value={thresholdPick}
                {...pressProps("threshold")}
                onChange={e => typeThreshold(e.target.value)}
                onBlur={() => leaveThreshold()}
                autoComplete="off"
                spellCheck={false}
              />
              <span className="ap-threshold-unit" aria-hidden>%</span>
            </span>
          </form>
        ) : (
          <span className="ap-field" title="Switch once the active account passes this much of its limit">
            <select
              ref={thresholdRef}
              aria-label="Switch threshold"
              value={thresholdPick}
              {...pressProps("threshold")}
              onChange={e => proposeThreshold(e.target.value)}
            >
              {thresholdChoices(threshold).map(t => <option key={t} value={t}>{t}%</option>)}
              <option value={CUSTOM_PICK}>Custom…</option>
            </select>
          </span>
        )}
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

      {/* What the field takes, under it while it is open, and in its place
          why a value was refused. Two keyed nodes rather than one whose text
          changes, so the refusal arrives as a new alert and is read out. */}
      {thresholdRefusal ? (
        <p key="refusal" id={noteId} className="ap-threshold-note" role="alert" data-tone="err">{thresholdRefusal}</p>
      ) : thresholdCustom ? (
        <p key="hint" id={noteId} className="ap-threshold-note">{CUSTOM_HINT}</p>
      ) : null}

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
