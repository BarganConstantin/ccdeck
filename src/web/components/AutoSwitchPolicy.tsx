// The auto-switch policy's row in the accounts panel, and the popover it opens.
//
// The panel draws the policy from two places — inside the fold, or under a
// roster with nothing to fold — and it was already one value there for that
// reason; this is what the value renders. The draft the picker proposes, the
// `saved` after a store, and the two elements focus moves between stay in the
// panel and are handed in, because the row unmounts whenever the fold is shut
// and a pick nobody saved must outlive that.
//
// V4's Figma draws it as ONE ROW — "Auto-switch · at 90%" and the switch — and
// the two settings in a popover from that row: where it trips, as chips, and
// where it goes, as two options. The settings and the writes are the ones the
// selects had; a chip or an option is a deliberate press, so it stores at once
// (the select's save step existed because a keystroke could pick an option).
import { type KeyboardEvent, type Ref, useId, useState } from "react";

import { NEXT_OPTIONS, type NextChoice, nextOptionLabel, weeklyHint } from "../auto-choice";
import { Rich } from "../accounts-rich";
import { useT } from "../i18n";
import { customHint, CUSTOM_PICK, thresholdChoices } from "../auto-switch-threshold";
import { type AutoStatus } from "../claude-accounts";
import { type PickerCommit, thresholdCommit } from "../picker-commit";
import { type useRequestSlot } from "../use-request-slot";
import AnchoredPopover from "./AnchoredPopover";
import { KitStateGlyph } from "./kit-icons";

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
  /** What the policy does, in a line under its name in the popover. Absent for
   *  a provider whose sessions it does not move. */
  blurb?: string;
}

/**
 * ONE POLICY: its name, where it trips and its switch on one 28-high row, and
 * under the name in a popover its two settings. The live percentage it used to
 * print beside the threshold is the active row's own number, one glance up.
 */
function AutoSwitchToggle({ auto, pressProps, post, load }: Pick<Props, "auto" | "pressProps" | "post" | "load">) {
  const t = useT();
  return (
    <button
      type="button"
      className="switch ap-auto-state"
      role="switch"
      aria-checked={auto.enabled}
      aria-label={t("accounts.policy.title")}
      {...pressProps("enable")}
      onClick={() => post({ action: "enable", enabled: !auto.enabled }, "enable").then(() => load(true))}
      title={auto.enabled
        ? t("accounts.policy.stopTip")
        : t("accounts.policy.startTip")}
    >
      <span className="switch-knob" />
    </button>
  );
}

export default function AutoSwitchPolicy(props: Props) {
  const { auto, threshold, pressProps, post, load } = props;
  const t = useT();
  const popId = useId();
  const [open, setOpen] = useState(false);
  const anchorId = `ap-auto-open-${popId.replace(/:/g, "")}`;
  const titleId = `${anchorId}-title`;
  const toggle = <AutoSwitchToggle auto={auto} pressProps={pressProps} post={post} load={load} />;
  return (
    <div className="ap-policy-block">
      <div className="ap-policy">
        {/* A real h3, under the panel header's h2: a reader walking headings
            should find the policy. The button inside it opens the settings. */}
        <h3 className="ap-auto-title">
          <button type="button" id={anchorId} className="ap-auto-open"
            aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? popId : undefined}
            title={t("accounts.policy.settingsTip")}
            onClick={() => setOpen(o => !o)}>
            <span className="ap-auto-name">{t("accounts.policy.title")}</span>
            <span className="ap-auto-at">{t("accounts.policy.atPct", { pct: threshold })}</span>
          </button>
        </h3>
        {/* Always a control, never a read-out: a terminal loop's state is
            said beside it, not instead of it. Named in aria-label because
            the contents cannot carry it (#546). */}
        {toggle}
      </div>

      {open && (
        <AnchoredPopover anchorId={anchorId} boundaryId="ap-scroll" id={popId} className="ap-pop ap-auto-pop"
          role="dialog" labelledBy={titleId} align="start" onClose={() => setOpen(false)}>
          <AutoSwitchSettings {...props} titleId={titleId} />
        </AnchoredPopover>
      )}

      {/* Which engine is actually switching right now. The deck stands down
          while a terminal loop runs, and says so. */}
      {auto.external && (
        <p className="ap-auto-note">
          <i className="ap-pulse" aria-hidden />{" "}
          <Rich text={t(auto.enabled ? "accounts.policy.externalOn" : "accounts.policy.externalOff", { note: t("accounts.policy.externalBefore") })} />
        </p>
      )}
    </div>
  );
}

/**
 * THE POLICY'S SETTINGS, the popover's content: its switch, what it does, where
 * it trips and where it goes. Its own component so the popover's portal is not
 * needed to read what it says.
 */
export function AutoSwitchSettings({
  auto, threshold, thresholdPick, thresholdCtl, thresholdSaved, thresholdSaveRef,
  thresholdCustom, thresholdRefusal, thresholdFieldRef,
  proposeThreshold, typeThreshold, cancelThreshold, leaveThreshold, doThreshold,
  nextPick, pressProps, post, load, blurb, titleId,
}: Props & { titleId: string }) {
  const t = useT();
  const noteId = useId();
  const thresholdId = useId();
  const hintId = useId();
  const chosen = Number(threshold);
  return (
          <div className="ap-auto-form">
            <div className="ap-auto-head">
              <p className="ap-pop-title" id={titleId}>{t("accounts.policy.title")}</p>
              <AutoSwitchToggle auto={auto} pressProps={pressProps} post={post} load={load} />
            </div>
            {blurb && <p className="ap-auto-blurb">{blurb}</p>}

            {/* WHERE IT TRIPS, as chips: a press stores it. Escape is the
                field's while `Custom…` has one open. The label names the
                chips and the field alike (SC 2.5.3). */}
            <div className="ap-auto-group" onKeyDown={thresholdCustom ? cancelThreshold : undefined}>
              <span className="ap-auto-label" id={thresholdId} title={t("accounts.policy.switchAtTip")}>{t("accounts.policy.switchAt")}</span>
              <div className="ap-auto-chips" role="group" aria-labelledby={thresholdId}>
                {thresholdChoices(threshold).map(n => (
                  <button key={n} type="button" className="ap-chip" aria-pressed={!thresholdCustom && chosen === n}
                    {...pressProps("threshold")}
                    title={t("accounts.pick.thresholdTip", { picked: String(n) })}
                    onClick={() => { proposeThreshold(String(n)); doThreshold(String(n), thresholdCommit(String(n), threshold)); }}>
                    {n}%
                  </button>
                ))}
                <button type="button" className="ap-chip" aria-pressed={thresholdCustom}
                  {...pressProps("threshold")}
                  onClick={() => proposeThreshold(CUSTOM_PICK)}>
                  {t("accounts.policy.custom")}
                </button>
              </div>
              {/* `Custom…` puts a field in the chips' place, its unit where
                  the chevron was. A form, so Enter is `save` and never fires
                  mid-composition; the press is doThreshold either way, so
                  there is one path to the store. */}
              {thresholdCustom && (
                <form className="ap-threshold-form" noValidate
                  onSubmit={e => { e.preventDefault(); doThreshold(thresholdPick, thresholdCtl); }}>
                  <span className="ap-threshold-field" title={t("accounts.policy.switchAtTip")}>
                    <input
                      ref={thresholdFieldRef}
                      className="ap-manage-input ap-threshold-input"
                      type="text"
                      inputMode="numeric"
                      aria-labelledby={thresholdId}
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
                  {(thresholdCtl.sends || thresholdSaved) && (
                    <button ref={thresholdSaveRef} type="button" className="ap-manage-btn" {...pressProps("threshold")}
                      title={thresholdCtl.title}
                      onClick={() => doThreshold(thresholdPick, thresholdCtl)}
                    >{thresholdSaved && !thresholdCtl.sends ? thresholdCtl.done : thresholdCtl.label}</button>
                  )}
                </form>
              )}
              {/* What the field takes, and in its place why a value was refused.
                  Two keyed nodes rather than one whose text changes, so the
                  refusal arrives as a new alert and is read out. */}
              {thresholdRefusal ? (
                <p key="refusal" id={noteId} className="ap-threshold-note" role="alert" data-tone="err">{thresholdRefusal}</p>
              ) : thresholdCustom ? (
                <p key="hint" id={noteId} className="ap-threshold-note">{customHint(t)}</p>
              ) : null}
            </div>

            {/* WHERE IT GOES, whether the switch is on or off: it is set up
                before it is turned on, and the rule waits in the store until a
                tick reads it. Home is not here — it is a mark on its row and a
                word in that row's ⋯, and the line at the foot says so. */}
            <div className="ap-auto-group">
              <span className="ap-auto-label" id={`${hintId}-label`}>{t("accounts.policy.next")}</span>
              <div className="ap-auto-options" role="radiogroup" aria-labelledby={`${hintId}-label`}>
                {NEXT_OPTIONS.map(o => (
                  <button key={o.value} type="button" role="radio" aria-checked={nextPick === o.value}
                    className="ap-auto-option" data-selected={nextPick === o.value ? "" : undefined}
                    {...pressProps("next")}
                    onClick={() => { if (nextPick !== o.value) post({ action: "next", value: o.value }, "next").then(() => load(true)); }}>
                    <KitStateGlyph name={nextPick === o.value ? "done" : "idle"} />
                    <span className="ap-auto-option-text">
                      <span className="ap-auto-option-name">{nextOptionLabel(o.value, t)}</span>
                      {o.value === "weekly" && <span className="ap-auto-option-note">{weeklyHint(t)}</span>}
                    </span>
                  </button>
                ))}
              </div>
            </div>
            <p className="ap-auto-blurb">{t("accounts.policy.homeNote")}</p>
          </div>
  );
}
