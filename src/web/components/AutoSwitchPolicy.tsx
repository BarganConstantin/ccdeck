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

import { NEXT_OPTIONS, type NextChoice, WEEKLY_HINT } from "../auto-choice";
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
  /** How the next account is picked, as the panel holds the draft of it —
   *  see use-next-draft.ts. */
  nextPick: NextChoice;
  nextCtl: PickerCommit;
  nextSaved: boolean;
  nextRef: Ref<HTMLSelectElement>;
  nextSaveRef: Ref<HTMLButtonElement>;
  proposeNext: (pick: string) => void;
  doNext: () => void;
  pressProps: ReturnType<typeof useRequestSlot>["pressProps"];
  post: (body: Record<string, unknown>, tag: string) => Promise<unknown>;
  load: (force?: boolean) => Promise<void>;
}

/**
 * ONE POLICY: its name and its switch on one row, and under them its two
 * settings, each a label and a picker. The live percentage it used to print
 * beside the threshold is the active row's own number, one glance up, and the
 * clock of its last check under a rule was diagnostics — the switch being on is
 * the state, and a terminal loop taking over is the one thing still said under
 * it.
 *
 * THE SWITCH HAS THE ROW TO ITSELF. The threshold used to sit between the name
 * and the switch, unlabelled, and the next-account picker under it ran past
 * both, so the row's three controls met no common edge and `98%` had only a
 * tooltip to say what it was. Now every control ends at the same right edge,
 * every setting says its name in words, and the settings read the same with
 * the switch on or off, since they are set up before it is turned on.
 */
export default function AutoSwitchPolicy({
  auto, threshold, thresholdPick, thresholdCtl, thresholdSaved, thresholdRef, thresholdSaveRef,
  thresholdCustom, thresholdRefusal, thresholdFieldRef,
  proposeThreshold, typeThreshold, cancelThreshold, leaveThreshold, doThreshold,
  nextPick, nextCtl, nextSaved, nextRef, nextSaveRef, proposeNext, doNext, pressProps, post, load,
}: Props) {
  const noteId = useId();
  const thresholdId = useId();
  const nextId = useId();
  const hintId = useId();
  return (
    <div className="ap-policy-block">
      <div className="ap-policy">
        {/* A real h3, under the panel header's h2: a reader walking headings
            should find the policy. It says what the switch's name says
            (#546), so what is heard and what a voice-control user has to
            pronounce are the words on the screen. */}
        <h3 className="ap-auto-title">Auto-switch</h3>
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

      {/* WHERE IT TRIPS. Escape is the row's while the field is open, so it
          reaches the field and the `save` beside it alike. The label names
          the picker and the field alike (SC 2.5.3): a voice-control user says
          the words on the screen. */}
      <div className="ap-policy ap-setting" onKeyDown={thresholdCustom ? cancelThreshold : undefined}>
        <label className="ap-setting-label" htmlFor={thresholdId}
          title="Switch once the active account passes this much of its limit">Switch at</label>
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
             there is one path to the store. Named by the same label as the
             picker, since it is the same setting. */
          <form className="ap-threshold-form" noValidate
            onSubmit={e => { e.preventDefault(); doThreshold(thresholdPick, thresholdCtl); }}
          >
            <span className="ap-threshold-field" title="Switch once the active account passes this much of its limit">
              <input
                ref={thresholdFieldRef}
                id={thresholdId}
                className="ap-manage-input ap-threshold-input"
                type="text"
                inputMode="numeric"
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
              id={thresholdId}
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
      </div>

      {/* What the field takes, under it while it is open, and in its place
          why a value was refused. Two keyed nodes rather than one whose text
          changes, so the refusal arrives as a new alert and is read out. */}
      {thresholdRefusal ? (
        <p key="refusal" id={noteId} className="ap-threshold-note" role="alert" data-tone="err">{thresholdRefusal}</p>
      ) : thresholdCustom ? (
        <p key="hint" id={noteId} className="ap-threshold-note">{CUSTOM_HINT}</p>
      ) : null}

      {/* WHERE IT GOES, whether the switch is on or off: it is set up before
          it is turned on, like the threshold above it, and the rule waits in
          the store until a tick reads it. The same propose-then-save as the
          threshold (#516). Home is not here — it is a mark on its row and a
          word in that row's ⋯. */}
      <div className="ap-policy ap-setting ap-next">
        <label className="ap-setting-label" htmlFor={nextId}>Next account</label>
        <span className="ap-field">
          <select
            id={nextId}
            ref={nextRef}
            value={nextPick}
            aria-describedby={nextPick === "weekly" ? hintId : undefined}
            {...pressProps("next")}
            onChange={e => proposeNext(e.target.value)}
          >
            {NEXT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </span>
        {(nextCtl.sends || nextSaved) && (
          <button ref={nextSaveRef} type="button" className="ap-manage-btn" {...pressProps("next")}
            title={nextCtl.title}
            onClick={() => doNext()}
          >{nextSaved && !nextCtl.sends ? nextCtl.done : nextCtl.label}</button>
        )}
      </div>
      {/* The option that is not obvious says what it does, in one quiet
          line, and only while it is the one showing. */}
      {nextPick === "weekly" && (
        <p id={hintId} className="ap-threshold-note">{WEEKLY_HINT}</p>
      )}

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
